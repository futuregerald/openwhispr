const { BrowserWindow, shell } = require("electron");
const debugLogger = require("./debugLogger");
const { getMeetingJoinUrl } = require("./meetingJoinUrl");
const health = require("./meetingDetectionHealth");
const { resetAutomationDenied } = require("./browserMeetingUrlChecker");
const { i18nMain } = require("./i18nMain");
const { CAP_MS, WARN_LEAD_MS, CALL_ENDED_NOTICE_MS } = require("./recordingLimits");

const IMMINENT_THRESHOLD_MS = 5 * 60 * 1000;
const POST_RECORDING_COOLDOWN_MS = 2500;
// Backstop only: the latch is cleared where the session ends. Long enough not to
// interrupt a meeting being set up, short enough that a missed clear costs one
// coffee break rather than the rest of the day.
const MEETING_MODE_WATCHDOG_MS = 15 * 60 * 1000;
// An unanswered prompt keeps its detection id reserved; without an expiry that id
// is blocked for the life of the process.
const DETECTION_TTL_MS = 30 * 60 * 1000;

const PLACEHOLDER_PREFIX = { __detected__: "detected", __manual__: "manual" };

function placeholderEvent(calendarId) {
  const now = Date.now();
  return {
    id: `${PLACEHOLDER_PREFIX[calendarId]}-${now}`,
    calendar_id: calendarId,
    summary: "New note",
    start_time: new Date(now).toISOString(),
    end_time: new Date(now + 3600000).toISOString(),
    is_all_day: 0,
    status: "confirmed",
    hangout_link: null,
    conference_data: null,
    organizer_email: null,
    attendees_count: 0,
  };
}

class MeetingDetectionEngine {
  constructor(
    googleCalendarManager,
    meetingProcessDetector,
    audioActivityDetector,
    windowManager,
    databaseManager,
    callStateDetector = null
  ) {
    this.googleCalendarManager = googleCalendarManager;
    this.meetingProcessDetector = meetingProcessDetector;
    this.audioActivityDetector = audioActivityDetector;
    this.windowManager = windowManager;
    this.databaseManager = databaseManager;
    this.callStateDetector = callStateDetector;
    this.activeDetections = new Map();
    this.preferences = { processDetection: true, audioDetection: true, autoStartRecording: false };
    this._userRecording = false;
    this._dictationActive = false;
    this._meetingRecording = null;
    this._meetingModeActive = false;
    this._autoStarted = false;
    this._capWarnTimer = null;
    this._capStopTimer = null;
    this._detectorStartedForRecording = false;
    this._requestedStopReason = null;
    this._pendingStopReason = null;
    this._stopInFlight = false;
    this._callEndedNotice = null;
    this._notificationQueue = [];
    this._postRecordingCooldown = null;
    this._bindListeners();
  }

  // Assignment publishes the latch, so a future call site cannot quietly skip
  // telemetry for the two flags that can silently disable detection.
  get _meetingModeActive() {
    return this.__meetingModeActive ?? false;
  }

  set _meetingModeActive(value) {
    this.__meetingModeActive = value;
    health.setLatches({ meetingModeActive: value });
    if (value) this._armMeetingModeWatchdog();
    else this._clearMeetingModeWatchdog();
  }

  get _userRecording() {
    return this.__userRecording ?? false;
  }

  set _userRecording(value) {
    this.__userRecording = value;
    health.setLatches({ userRecording: value });
  }

  _bindListeners() {
    // Process detection is context-only — track running apps but don't trigger notifications.
    // This avoids false positives from apps like FaceTime running in the background.
    this.meetingProcessDetector.on("meeting-process-detected", (data) => {
      debugLogger.info(
        "Meeting app running (context only)",
        { processKey: data.processKey, appName: data.appName },
        "meeting"
      );
    });

    this.meetingProcessDetector.on("meeting-process-ended", (data) => {
      this.activeDetections.delete(`process:${data.processKey}`);
    });

    this.audioActivityDetector.on("sustained-audio-detected", (data) => {
      this._handleDetection("audio", "sustained-audio", data);
    });

    // Camera/mic device-in-use — the "actually in a call" signal used for
    // opt-in auto-start. Fires even when muted; ignores idle meeting tabs.
    if (this.callStateDetector) {
      this.callStateDetector.on("call-active", (data) => this._handleCallActive(data));
      this.callStateDetector.on("call-ended", () => this._handleCallEnded());
    }
  }

  _handleCallActive(data) {
    if (!this.preferences.autoStartRecording) return;
    if (this._meetingModeActive || this._userRecording) {
      debugLogger.debug(
        "Call active but a recording/meeting is already in progress",
        {},
        "meeting"
      );
      return;
    }
    // Confirm it's really a meeting, not incidental camera/mic use (Photo Booth,
    // a voice memo). A browser meeting-URL match confirms it; if Automation is
    // denied we can't check, so we trust the device-in-use signal.
    const urlMatch = data?.urlMatch;
    // Three outcomes:
    // 1. matched=true → definitely a meeting → auto-start
    // 2. denied/unavailable/null → can't check → trust device signal → auto-start
    // 3. matched=false (confident) → no meeting → skip
    const urlCheckRan = urlMatch && !urlMatch.denied && !urlMatch.unavailable;
    const noMeetingFound = urlCheckRan && !urlMatch.matched;

    if (noMeetingFound) {
      debugLogger.info(
        "Camera/mic in use but browser check found no meeting URL; not auto-starting",
        { devices: data?.devices },
        "meeting"
      );
      return;
    }

    if (!urlMatch?.matched) {
      debugLogger.info(
        "Camera/mic in use; URL check unavailable — trusting device signal for auto-start",
        {
          devices: data?.devices,
          reason: urlMatch?.denied
            ? "denied"
            : urlMatch?.unavailable
              ? "unavailable"
              : "no-checker",
        },
        "meeting"
      );
    }
    debugLogger.info(
      "Auto-starting meeting recording (call detected)",
      { devices: data?.devices, url: urlMatch?.url, browser: urlMatch?.browser },
      "meeting"
    );
    this._autoStarted = true;
    this._beginMeetingSession(placeholderEvent("__detected__"), "auto-start")
      .then((ok) => {
        if (!ok) this._autoStarted = false;
      })
      .catch((error) => {
        this._autoStarted = false;
        // The latch is set before the navigation is awaited, so a rejection here
        // would otherwise disable detection for the rest of the process.
        this._meetingModeActive = false;
        debugLogger.error("Auto-start meeting failed", { error: error?.message }, "meeting");
      });
  }

  _handleCallEnded() {
    if (!this._meetingRecording) return;
    debugLogger.info(
      "Call ended — requesting recording stop",
      {
        autoStarted: this._autoStarted,
        noteId: this._meetingRecording.noteId,
        callObserved: this.callStateDetector?.hasObservedCall?.() ?? null,
      },
      "meeting"
    );
    this._requestStop("call-ended");
  }

  _requestStop(reason) {
    this._requestedStopReason = reason;
    this.broadcastToWindows("meeting-auto-stop-request", { reason });
  }

  _armMeetingModeWatchdog() {
    this._clearMeetingModeWatchdog();
    if (this._userRecording) return; // a live recording is a legitimate reason to stay latched
    this._meetingModeWatchdog = setTimeout(() => {
      this._meetingModeWatchdog = null;
      if (!this.__meetingModeActive || this._userRecording) return;
      debugLogger.warn(
        "Meeting mode was still latched with no recording; clearing",
        { afterMs: MEETING_MODE_WATCHDOG_MS },
        "meeting"
      );
      health.recordSuppression("watchdog-cleared-meeting-mode", {});
      this.setMeetingModeActive(false);
    }, MEETING_MODE_WATCHDOG_MS);
    this._meetingModeWatchdog?.unref?.();
  }

  _clearMeetingModeWatchdog() {
    if (this._meetingModeWatchdog) {
      clearTimeout(this._meetingModeWatchdog);
      this._meetingModeWatchdog = null;
    }
  }

  _sweepStaleDetections() {
    const now = Date.now();
    for (const [detectionId, detection] of this.activeDetections) {
      if (typeof detection?.at === "number" && now - detection.at >= DETECTION_TTL_MS) {
        this.activeDetections.delete(detectionId);
        health.recordSuppression("detection-expired", { detectionId });
      }
    }
  }

  // Ask every detector to prove it is still working — used after the machine
  // wakes, when a child may have died while we were asleep.
  revalidate(reason = "revalidate") {
    debugLogger.info("Revalidating meeting detection", { reason }, "meeting");
    // Automation denial is cached for the process; the user may have granted it
    // since, and the URL check is what separates a meeting from Photo Booth.
    resetAutomationDenied();
    this.audioActivityDetector?.revalidate?.(reason);
    this.callStateDetector?.revalidate?.(reason);
  }

  _armCap(fromMs) {
    this._clearCap();
    this._capWarnTimer = setTimeout(() => {
      this._capWarnTimer = null;
      debugLogger.info(
        "Recording nearing the cap; warning",
        { endsAt: fromMs + CAP_MS },
        "meeting"
      );
      this.windowManager?.showRecordingNotice?.({ kind: "cap-warning", endsAt: fromMs + CAP_MS });
    }, CAP_MS - WARN_LEAD_MS);
    this._capStopTimer = setTimeout(() => {
      this._capStopTimer = null;
      debugLogger.warn("Recording hit the cap; requesting stop", { capMs: CAP_MS }, "meeting");
      this._requestStop("cap");
    }, CAP_MS);
    this._capWarnTimer?.unref?.();
    this._capStopTimer?.unref?.();
  }

  _clearCap() {
    if (this._capWarnTimer) {
      clearTimeout(this._capWarnTimer);
      this._capWarnTimer = null;
    }
    if (this._capStopTimer) {
      clearTimeout(this._capStopTimer);
      this._capStopTimer = null;
    }
  }

  keepRecording() {
    if (!this._meetingRecording) return;
    debugLogger.info("Recording kept past the cap warning", {}, "meeting");
    this._armCap(Date.now());
    this.windowManager?.dismissRecordingNotice?.();
  }

  handleRecordingNoticeResponse(action) {
    debugLogger.info("Recording notice response", { action }, "meeting");
    if (action === "keep") {
      this.keepRecording();
    } else if (action === "stop") {
      this._requestStop("cap-user");
      this.windowManager?.dismissRecordingNotice?.();
    } else if (action === "resume") {
      return this.resumeAfterCallEnded();
    } else {
      this.windowManager?.dismissRecordingNotice?.();
    }
    return undefined;
  }

  async resumeAfterCallEnded() {
    const notice = this._callEndedNotice;
    if (!notice || this._stopInFlight || this._meetingRecording) return false;
    if (Date.now() >= notice.until) {
      this._callEndedNotice = null;
      return false;
    }
    const source = notice.noteId == null ? null : this.databaseManager.getNote(notice.noteId);
    if (!source) return false;
    this._callEndedNotice = null;
    this.windowManager?.dismissRecordingNotice?.();

    const suffix = i18nMain.t("recordingNotice.continuedSuffix", { defaultValue: "(continued)" });
    const summary = `${source.title || "New note"} ${suffix}`;
    debugLogger.info("Resuming after call ended", { fromNoteId: notice.noteId }, "meeting");
    let created;
    try {
      created = await this._beginMeetingSession(
        { ...placeholderEvent("__manual__"), summary },
        "resume"
      );
    } catch (error) {
      this._meetingModeActive = false;
      debugLogger.error("Resume after call ended failed", { error: error?.message }, "meeting");
      return false;
    }
    if (!created) return false;

    const carried = {};
    for (const field of ["calendar_event_id", "participants", "meeting_type_id"]) {
      if (source[field] != null) carried[field] = source[field];
    }
    if (Object.keys(carried).length > 0) {
      const result = this.databaseManager.updateNote(created.id, carried);
      if (result?.success && result?.note) this.broadcastToWindows("note-updated", result.note);
    }
    return true;
  }

  // Shared "begin a meeting recording" path used by both the notification
  // "start" action and auto-start: create the meeting note and navigate the
  // renderer, which then starts the actual recording.
  async _beginMeetingSession(event, trigger) {
    const eventSummary = event?.summary || "New note";
    const noteResult = this.databaseManager.saveNote(eventSummary, "", "meeting");
    const meetingsFolder = this.databaseManager.getMeetingsFolder();

    if (!noteResult?.note?.id || !meetingsFolder?.id) {
      debugLogger.error(
        "Meeting note creation failed",
        { noteId: noteResult?.note?.id, folderId: meetingsFolder?.id },
        "meeting"
      );
      return false;
    }

    this._meetingModeActive = true;
    this.broadcastToWindows("note-added", noteResult.note);

    const isRealEvent =
      event?.calendar_id &&
      event.calendar_id !== "__detected__" &&
      event.calendar_id !== "__manual__";

    if (isRealEvent) {
      const calEvent = this.databaseManager.getCalendarEventById(event.id);
      const updates = { calendar_event_id: event.id };
      if (calEvent?.attendees) {
        updates.participants = calEvent.attendees;
      }
      const meetingTypeId = this.databaseManager.autoMapMeetingType(eventSummary);
      if (meetingTypeId) {
        updates.meeting_type_id = meetingTypeId;
      }
      const updateResult = this.databaseManager.updateNote(noteResult.note.id, updates);
      if (updateResult?.success && updateResult?.note) {
        this.broadcastToWindows("note-updated", updateResult.note);
      }
    }

    await this.windowManager.queueMeetingNoteNavigation({
      noteId: noteResult.note.id,
      folderId: meetingsFolder.id,
      event,
      trigger,
    });

    this.audioActivityDetector.resetPrompt();
    return noteResult.note;
  }

  // Calendar reminders enter the same pipeline as mic detections, so they share
  // the recording gates, queueing, cooldowns, and the overlay window.
  handleCalendarReminder(event) {
    this._handleDetection("calendar", event.id, { event, detectedAt: Date.now() });
  }

  _suppress(reason, detectionId, source) {
    health.recordSuppression(reason, { detectionId, source });
    debugLogger.info("Detection suppressed", { reason, detectionId, source }, "meeting");
  }

  _handleDetection(source, key, data) {
    const detectionId = `${source}:${key}`;
    this._sweepStaleDetections();

    if (source === "audio" && !this.preferences.audioDetection) {
      this._suppress("audio-detection-disabled", detectionId, source);
      return;
    }

    if (!this._notificationsEnabledFor(source)) {
      this._suppress("notifications-disabled", detectionId, source);
      return;
    }

    if (this.activeDetections.has(detectionId)) {
      this._suppress("already-active", detectionId, source);
      return;
    }

    if (this._meetingModeActive) {
      this._suppress("meeting-mode-active", detectionId, source);
      return;
    }

    if (this._userRecording || this._postRecordingCooldown) {
      debugLogger.info("Detection queued — user is recording", { detectionId, source }, "meeting");
      health.recordSuppression("queued-user-recording", { detectionId, source });
      this._notificationQueue.push({ source, key, data });
      this.activeDetections.set(detectionId, {
        source,
        key,
        data,
        dismissed: false,
        at: Date.now(),
      });
      return;
    }

    debugLogger.info("Meeting detection triggered", { detectionId, source }, "meeting");
    this.activeDetections.set(detectionId, { source, key, data, dismissed: false, at: Date.now() });
    this._showPrompt(detectionId, source, key, data);
  }

  _notificationsEnabledFor(source) {
    const nPrefs = this.windowManager.notificationPrefs || {};
    if (nPrefs.notificationsEnabled === false) return false;
    const prefKey = source === "calendar" ? "notifyCalendarReminders" : "notifyMeetingDetection";
    return nPrefs[prefKey] !== false;
  }

  // activeMeeting only means the event's scheduled window is open — actual meeting
  // recordings are tracked by _meetingModeActive.
  _findCalendarEvent() {
    const calendarState = this.googleCalendarManager?.getActiveMeetingState?.();
    if (!calendarState) return null;
    if (calendarState.activeMeeting) return calendarState.activeMeeting;

    const now = Date.now();
    return (
      calendarState.upcomingEvents?.find((evt) => {
        const start = new Date(evt.start_time).getTime();
        return start - now <= IMMINENT_THRESHOLD_MS && start > now;
      }) ?? null
    );
  }

  _showPrompt(detectionId, source, key, data) {
    const calendarEvent = data?.event ?? this._findCalendarEvent();
    const event = calendarEvent ?? placeholderEvent("__detected__");

    let variant = "detected";
    if (calendarEvent) {
      const started = new Date(calendarEvent.start_time).getTime() <= Date.now();
      variant = started ? "underway" : "starting";
    }
    const joinUrl = source === "calendar" ? getMeetingJoinUrl(calendarEvent) : null;

    debugLogger.info(
      "Showing notification",
      {
        detectionId,
        source,
        variant,
        title: calendarEvent?.summary ?? null,
        hasJoinUrl: !!joinUrl,
      },
      "meeting"
    );

    const detection = this.activeDetections.get(detectionId);
    if (detection) {
      detection.event = event;
    }

    health.recordEvent("engine");
    this.windowManager.showMeetingNotification({
      detectionId,
      source,
      key,
      event,
      variant,
      joinUrl,
    });
  }

  async handleNotificationResponse(detectionId, action) {
    debugLogger.info("Notification response", { detectionId, action }, "meeting");
    try {
      const detection = this.activeDetections.get(detectionId);

      if ((action === "start" || action === "join") && detection) {
        if (action === "join") {
          const joinUrl = getMeetingJoinUrl(detection.event);
          if (joinUrl) {
            shell
              .openExternal(joinUrl)
              .catch((error) =>
                debugLogger.error(
                  "Failed to open meeting link",
                  { error: error.message, joinUrl },
                  "meeting"
                )
              );
          }
        }

        await this._beginMeetingSession(
          detection.event,
          action === "join" ? "calendar-join" : "notification-start"
        );
      } else if (action === "dismiss") {
        if (detection) {
          this._dismiss();
        }
      }
    } catch (error) {
      this._meetingModeActive = false;
      debugLogger.error(
        "Error handling notification response",
        { error: error?.message, detectionId, action },
        "meeting"
      );
    } finally {
      // One overlay at a time — a response settles every pending detection,
      // including any the responded prompt replaced.
      this.activeDetections.clear();
      this.windowManager.dismissMeetingNotification();
    }
  }

  async startManualMeeting() {
    debugLogger.info("Starting manual meeting", {}, "meeting");

    const activeEvents = this.databaseManager.getActiveEvents();
    if (activeEvents?.length > 0) {
      return this.joinCalendarMeeting(activeEvents[0].id, "hotkey");
    }

    this._meetingModeActive = true;

    const event = placeholderEvent("__manual__");

    const noteResult = this.databaseManager.saveNote(event.summary, "", "meeting");
    const meetingsFolder = this.databaseManager.getMeetingsFolder();

    if (!noteResult?.note?.id || !meetingsFolder?.id) {
      debugLogger.error(
        "Manual meeting failed — missing note or folder",
        { noteId: noteResult?.note?.id, folderId: meetingsFolder?.id },
        "meeting"
      );
      this._meetingModeActive = false;
      return;
    }

    this.broadcastToWindows("note-added", noteResult.note);

    try {
      await this.windowManager.queueMeetingNoteNavigation({
        noteId: noteResult.note.id,
        folderId: meetingsFolder.id,
        event,
        trigger: "hotkey",
      });
    } catch (error) {
      this._meetingModeActive = false;
      debugLogger.error("Manual meeting navigation failed", { error: error?.message }, "meeting");
    }
  }

  async joinCalendarMeeting(eventId, trigger = "calendar-join") {
    this._meetingModeActive = true;
    debugLogger.info("Joining calendar meeting", { eventId, trigger }, "meeting");

    const calEvent = this.databaseManager.getCalendarEventById(eventId);
    if (!calEvent) {
      debugLogger.error("Calendar event not found", { eventId }, "meeting");
      this._meetingModeActive = false;
      return;
    }

    const noteResult = this.databaseManager.saveNote(calEvent.summary || "New note", "", "meeting");
    const meetingsFolder = this.databaseManager.getMeetingsFolder();

    if (!noteResult?.note?.id || !meetingsFolder?.id) {
      debugLogger.error(
        "Join calendar meeting failed — missing note or folder",
        { noteId: noteResult?.note?.id, folderId: meetingsFolder?.id },
        "meeting"
      );
      this._meetingModeActive = false;
      return;
    }

    const updates = { calendar_event_id: calEvent.id };
    if (calEvent.attendees) {
      updates.participants = calEvent.attendees;
    }
    const meetingTypeId = this.databaseManager.autoMapMeetingType(calEvent.summary);
    if (meetingTypeId) {
      updates.meeting_type_id = meetingTypeId;
    }
    const updateResult = this.databaseManager.updateNote(noteResult.note.id, updates);

    this.broadcastToWindows("note-added", updateResult?.note || noteResult.note);

    try {
      await this.windowManager.queueMeetingNoteNavigation({
        noteId: noteResult.note.id,
        folderId: meetingsFolder.id,
        event: calEvent,
        trigger,
      });
    } catch (error) {
      this._meetingModeActive = false;
      debugLogger.error("Calendar join navigation failed", { error: error?.message }, "meeting");
    }
  }

  handleNotificationTimeout() {
    for (const [detectionId, detection] of this.activeDetections) {
      if (!detection.dismissed) {
        this._dismiss();
        detection.dismissed = true;
      }
    }
    this.activeDetections.clear();
    debugLogger.info("Notification auto-dismissed, detections cleared", {}, "meeting");
  }

  _flushNotificationQueue() {
    if (this._notificationQueue.length === 0) return;

    if (this._meetingModeActive) {
      debugLogger.info("Dropping queued notifications — meeting mode active", {}, "meeting");
      for (const { source, key } of this._notificationQueue) {
        this.activeDetections.delete(`${source}:${key}`);
      }
      this._notificationQueue = [];
      return;
    }

    debugLogger.info(
      "Flushing notification queue",
      { count: this._notificationQueue.length },
      "meeting"
    );

    const best = this._notificationQueue[0];
    const detectionId = `${best.source}:${best.key}`;

    // Only one overlay is shown; the rest are dropped here, so their reservations
    // have to go with them or they block their ids until the next sweep.
    for (const { source, key } of this._notificationQueue.slice(1)) {
      this.activeDetections.delete(`${source}:${key}`);
    }

    const detection = this.activeDetections.get(detectionId);
    if (detection && !detection.dismissed) {
      this._showPrompt(detectionId, best.source, best.key, best.data);
    }

    this._notificationQueue = [];
  }

  _dismiss() {
    this.audioActivityDetector.dismiss();
  }

  setMeetingModeActive(active) {
    this._meetingModeActive = active;
    debugLogger.info("Meeting mode active state changed", { active }, "meeting");
    if (!active) {
      // Own mic usage during meeting mode sets hasPrompted=true; reset so future detections work
      this.audioActivityDetector.resetPrompt();
    }
  }

  // The meeting session ends when its recording stops, not when the renderer
  // happens to navigate away — "Back to notes" isn't rendered in every layout, so
  // relying on it left the suppression latch set for the rest of the process.
  endMeetingSession(reason = "recording-stopped") {
    debugLogger.info("Meeting session ended", { reason }, "meeting");
    this.setMeetingModeActive(false);
    this._pendingStopReason = reason;
    this._stopInFlight = true;
    if (!this._meetingRecording) this.meetingRecordingStopComplete();
  }

  meetingRecordingStopComplete() {
    if (!this._stopInFlight) return;
    const reason = this._requestedStopReason ?? this._pendingStopReason;
    this._stopInFlight = false;
    this.meetingRecordingStopped(reason);
  }

  _publishRecording() {
    this._userRecording = this._dictationActive || !!this._meetingRecording;
    this.audioActivityDetector.setUserRecording(this._userRecording);
  }

  _startPostRecordingCooldown(delayMs = POST_RECORDING_COOLDOWN_MS) {
    if (this._postRecordingCooldown) clearTimeout(this._postRecordingCooldown);
    this._postRecordingCooldown = setTimeout(() => {
      this._postRecordingCooldown = null;
      this._flushNotificationQueue();
    }, delayMs);
  }

  _recordingStarted() {
    this._clearMeetingModeWatchdog();
    if (this._postRecordingCooldown) {
      clearTimeout(this._postRecordingCooldown);
      this._postRecordingCooldown = null;
    }
  }

  meetingRecordingStarted({ noteId = null } = {}) {
    debugLogger.info("Meeting recording started", { noteId }, "meeting");
    this._requestedStopReason = null;
    this._pendingStopReason = null;
    this._meetingRecording = { noteId, startedAt: Date.now() };
    if (this.callStateDetector && !this.callStateDetector.isRunning?.()) {
      this.callStateDetector.start();
      this._detectorStartedForRecording = true;
    }
    this.callStateDetector?.setSelfRecording(true);
    this._armCap(Date.now());
    this._recordingStarted();
    this._publishRecording();
  }

  meetingRecordingStopped(reason) {
    debugLogger.info("Meeting recording stopped", { reason }, "meeting");
    const noteId = this._meetingRecording?.noteId ?? null;
    const wasRecording = !!this._meetingRecording;
    this._clearCap();
    this.callStateDetector?.setSelfRecording(false);
    if (this._detectorStartedForRecording && !this.preferences.autoStartRecording) {
      this.callStateDetector?.stop();
    }
    this._detectorStartedForRecording = false;
    this._meetingRecording = null;
    this._autoStarted = false;
    this._requestedStopReason = null;
    this._pendingStopReason = null;
    this._stopInFlight = false;
    this._publishRecording();
    this.windowManager?.dismissRecordingNotice?.();

    let cooldownMs = POST_RECORDING_COOLDOWN_MS;
    if (wasRecording && reason === "call-ended") {
      const until = Date.now() + CALL_ENDED_NOTICE_MS;
      this._callEndedNotice = { noteId, until };
      this.windowManager?.showRecordingNotice?.({ kind: "call-ended", noteId, until });
      cooldownMs = Math.max(cooldownMs, until - Date.now());
    }

    if (this.__meetingModeActive) this._armMeetingModeWatchdog();
    if (!this._dictationActive) this._startPostRecordingCooldown(cooldownMs);
  }

  setUserRecording(active) {
    this._dictationActive = active;
    this._publishRecording();

    if (active) {
      this._recordingStarted();
    } else if (!this._meetingRecording) {
      if (this.__meetingModeActive) this._armMeetingModeWatchdog();
      this._startPostRecordingCooldown();
    }
  }

  setPreferences(prefs) {
    debugLogger.info("Updating detection preferences", prefs, "meeting");
    Object.assign(this.preferences, prefs);

    if (this.preferences.processDetection) {
      this.meetingProcessDetector.start();
    } else {
      this.meetingProcessDetector.stop();
    }

    if (this.preferences.audioDetection) {
      this.audioActivityDetector.start();
    } else {
      this.audioActivityDetector.stop();
    }

    if (this.callStateDetector) {
      if (this._meetingRecording) {
        if (this.preferences.autoStartRecording) this.callStateDetector.start();
        else this._detectorStartedForRecording = true;
      } else if (this.preferences.autoStartRecording) {
        this.callStateDetector.start();
      } else {
        this.callStateDetector.stop();
      }
    }
  }

  getPreferences() {
    return { ...this.preferences };
  }

  start() {
    debugLogger.info("Meeting detection engine started", this.preferences, "meeting");
    if (this.preferences.processDetection) this.meetingProcessDetector.start();
    if (this.preferences.audioDetection) this.audioActivityDetector.start();
    if (this.preferences.autoStartRecording) this.callStateDetector?.start();
  }

  stop() {
    debugLogger.info("Meeting detection engine stopped", {}, "meeting");
    this.meetingProcessDetector.stop();
    this.audioActivityDetector.stop();
    this.callStateDetector?.stop();
    this._autoStarted = false;
    this._clearCap();
    this._clearMeetingModeWatchdog();
    this.activeDetections.clear();
    this._meetingModeActive = false;
    if (this._postRecordingCooldown) {
      clearTimeout(this._postRecordingCooldown);
      this._postRecordingCooldown = null;
    }
    this._notificationQueue = [];
  }

  broadcastToWindows(channel, data) {
    const windows = BrowserWindow.getAllWindows();
    windows.forEach((win) => {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, data);
      }
    });
  }
}

module.exports = MeetingDetectionEngine;
