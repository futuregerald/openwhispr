const test = require("node:test");
const assert = require("node:assert/strict");
const { mock } = require("node:test");

const health = require("../../src/helpers/meetingDetectionHealth");
const MeetingDetectionEngine = require("../../src/helpers/meetingDetectionEngine");
const { CAP_MS, WARN_LEAD_MS, CALL_ENDED_NOTICE_MS } = require("../../src/helpers/recordingLimits");

const START = 1_000_000;
const MINUTE = 60 * 1000;
const COOLDOWN_MS = 2500;

function createEngine({ autoStartRecording = false, detectorRunning = false } = {}) {
  const noop = () => {};
  const notices = [];
  const dismissals = [];
  const prompts = [];
  const navigations = [];
  const broadcasts = [];
  const saved = [];
  const updates = [];
  const detectorCalls = [];
  let running = detectorRunning;

  const callStateDetector = {
    on: noop,
    start: () => {
      running = true;
      detectorCalls.push("start");
    },
    stop: () => {
      running = false;
      detectorCalls.push("stop");
    },
    isRunning: () => running,
    setSelfRecording: (active) => detectorCalls.push(`self:${active}`),
  };

  const sourceNote = {
    id: 3,
    title: "Weekly planning",
    calendar_event_id: "evt-1",
    participants: '[{"email":"a@example.com"}]',
    meeting_type_id: 4,
  };

  const engine = new MeetingDetectionEngine(
    { getActiveMeetingState: () => null },
    { on: noop, start: noop, stop: noop },
    { on: noop, start: noop, stop: noop, resetPrompt: noop, dismiss: noop, setUserRecording: noop },
    {
      notificationPrefs: {},
      showMeetingNotification: (payload) => prompts.push(payload),
      dismissMeetingNotification: noop,
      queueMeetingNoteNavigation: async (payload) => navigations.push(payload),
      showRecordingNotice: (data) => notices.push({ ...data, at: Date.now() }),
      dismissRecordingNotice: () => dismissals.push(Date.now()),
    },
    {
      getNote: (id) => (id === sourceNote.id ? sourceNote : null),
      saveNote: (title, content, type) => {
        saved.push({ title, content, type });
        return { note: { id: 99, title } };
      },
      getMeetingsFolder: () => ({ id: 7 }),
      getActiveEvents: () => [],
      getCalendarEventById: () => null,
      autoMapMeetingType: () => null,
      updateNote: (id, fields) => {
        updates.push({ id, fields });
        return { success: true, note: { id, ...fields } };
      },
    },
    callStateDetector
  );
  engine.broadcastToWindows = (channel, data) => broadcasts.push({ channel, data, at: Date.now() });
  engine.preferences.autoStartRecording = autoStartRecording;

  return {
    engine,
    notices,
    dismissals,
    prompts,
    navigations,
    broadcasts,
    saved,
    updates,
    detectorCalls,
  };
}

const stopRequests = (broadcasts) =>
  broadcasts.filter((b) => b.channel === "meeting-auto-stop-request");

function useTimers(t) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: START });
  t.after(() => mock.timers.reset());
}

function stopRecording(engine, reason = "meeting-transcription-stop") {
  engine.endMeetingSession(reason);
  engine.meetingRecordingStopComplete();
}

test.beforeEach(() => health.reset());

test("a recording warns five minutes before the two hour cap and then asks to stop", (t) => {
  useTimers(t);
  const { engine, notices, broadcasts } = createEngine();

  engine.meetingRecordingStarted({ noteId: 3 });

  t.mock.timers.tick(CAP_MS - WARN_LEAD_MS - 1);
  assert.equal(notices.length, 0);
  t.mock.timers.tick(1);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, "cap-warning");
  assert.equal(notices[0].endsAt, START + CAP_MS);
  assert.equal(notices[0].at, START + CAP_MS - WARN_LEAD_MS);
  assert.equal(stopRequests(broadcasts).length, 0);

  t.mock.timers.tick(WARN_LEAD_MS);
  const requests = stopRequests(broadcasts);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].data, { reason: "cap" });
  assert.equal(requests[0].at, START + CAP_MS);
});

test("keeping the recording pushes both the warning and the stop back", (t) => {
  useTimers(t);
  const { engine, notices, dismissals, broadcasts } = createEngine();
  engine.meetingRecordingStarted({ noteId: 3 });

  t.mock.timers.tick(116 * MINUTE);
  const keptAt = Date.now();
  engine.keepRecording();
  assert.equal(dismissals.length, 1);

  t.mock.timers.tick(CAP_MS - 116 * MINUTE);
  assert.equal(stopRequests(broadcasts).length, 0, "the original stop time must be cancelled");

  t.mock.timers.tick(keptAt + CAP_MS - WARN_LEAD_MS - Date.now());
  assert.equal(notices.length, 2);
  assert.equal(notices[1].endsAt, keptAt + CAP_MS);

  t.mock.timers.tick(WARN_LEAD_MS);
  assert.equal(stopRequests(broadcasts).length, 1);
  assert.equal(Date.now(), keptAt + CAP_MS);
});

test("dictation starting and stopping mid-meeting leaves the meeting's cap and detector alone", (t) => {
  useTimers(t);
  const { engine, broadcasts, detectorCalls } = createEngine({ detectorRunning: true });
  engine.meetingRecordingStarted({ noteId: 3 });
  t.mock.timers.tick(30 * MINUTE);

  engine.setUserRecording(true);
  engine.setUserRecording(false);

  assert.equal(detectorCalls.includes("self:false"), false);
  assert.equal(engine._userRecording, true);
  assert.equal(health.getSnapshot().latches.userRecording, true);

  t.mock.timers.tick(CAP_MS - 30 * MINUTE);
  const requests = stopRequests(broadcasts);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].data, { reason: "cap" });
});

test("a call ending stops a manually started recording", () => {
  const { engine, broadcasts } = createEngine();
  engine.meetingRecordingStarted({ noteId: 3 });
  assert.equal(engine._autoStarted, false);

  engine._handleCallEnded();

  const requests = stopRequests(broadcasts);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].data, { reason: "call-ended" });
});

test("a call ending with nothing recording asks for nothing", () => {
  const { engine, broadcasts } = createEngine();

  engine._handleCallEnded();

  assert.equal(stopRequests(broadcasts).length, 0);
});

test("with auto-start off the detector runs only for the recording", () => {
  const { engine, detectorCalls } = createEngine({ autoStartRecording: false });

  engine.meetingRecordingStarted({ noteId: 3 });
  assert.deepEqual(detectorCalls, ["start", "self:true"]);

  stopRecording(engine);
  assert.deepEqual(detectorCalls, ["start", "self:true", "self:false", "stop"]);
});

test("with auto-start on the detector keeps running after the recording", () => {
  const { engine, detectorCalls } = createEngine({
    autoStartRecording: true,
    detectorRunning: true,
  });

  engine.meetingRecordingStarted({ noteId: 3 });
  stopRecording(engine);

  assert.deepEqual(detectorCalls, ["self:true", "self:false"]);
});

test("turning auto-start off mid-recording waits for the recording to stop", () => {
  const { engine, detectorCalls } = createEngine({
    autoStartRecording: true,
    detectorRunning: true,
  });
  engine.meetingRecordingStarted({ noteId: 3 });

  engine.setPreferences({ autoStartRecording: false });
  assert.equal(detectorCalls.includes("stop"), false, "stopping now would blind end detection");

  stopRecording(engine);
  assert.equal(detectorCalls.at(-1), "stop");
});

test("Keep recording on the notice card pushes the stop back and closes the card", (t) => {
  useTimers(t);
  const { engine, broadcasts, dismissals } = createEngine();
  engine.meetingRecordingStarted({ noteId: 3 });

  t.mock.timers.tick(CAP_MS - WARN_LEAD_MS + 60_000);
  engine.handleRecordingNoticeResponse("keep");
  t.mock.timers.tick(WARN_LEAD_MS);

  assert.equal(stopRequests(broadcasts).length, 0);
  assert.equal(dismissals.length, 1);
});

test("Stop now on the notice card asks the renderer to stop and closes the card", (t) => {
  useTimers(t);
  const { engine, broadcasts, dismissals } = createEngine();
  engine.meetingRecordingStarted({ noteId: 3 });

  engine.handleRecordingNoticeResponse("stop");

  assert.deepEqual(
    stopRequests(broadcasts).map((b) => b.data),
    [{ reason: "cap-user" }]
  );
  assert.equal(dismissals.length, 1);
});

test("closing the notice card any other way only closes it", (t) => {
  useTimers(t);
  const { engine, broadcasts, dismissals } = createEngine();
  engine.meetingRecordingStarted({ noteId: 3 });

  engine.handleRecordingNoticeResponse("dismiss");

  assert.equal(stopRequests(broadcasts).length, 0);
  assert.equal(dismissals.length, 1);
});

test("a call-ended stop shows the notice and Resume continues the note", async (t) => {
  useTimers(t);
  const { engine, notices, saved, updates, navigations, broadcasts } = createEngine();
  engine.meetingRecordingStarted({ noteId: 3 });
  engine._handleCallEnded();

  stopRecording(engine);

  assert.equal(notices.length, 1);
  assert.deepEqual(
    { kind: notices[0].kind, noteId: notices[0].noteId, until: notices[0].until },
    { kind: "call-ended", noteId: 3, until: START + CALL_ENDED_NOTICE_MS }
  );

  t.mock.timers.tick(CALL_ENDED_NOTICE_MS - 1);
  await engine.resumeAfterCallEnded();

  assert.deepEqual(saved, [{ title: "Weekly planning (continued)", content: "", type: "meeting" }]);
  assert.equal(navigations[0].trigger, "resume");
  assert.deepEqual(updates, [
    {
      id: 99,
      fields: {
        calendar_event_id: "evt-1",
        participants: '[{"email":"a@example.com"}]',
        meeting_type_id: 4,
      },
    },
  ]);
  assert.ok(broadcasts.some((b) => b.channel === "note-updated" && b.data.id === 99));

  await engine.resumeAfterCallEnded();
  assert.equal(saved.length, 1, "the same notice cannot be resumed twice");
});

test("Resume does nothing once the notice has passed", async (t) => {
  useTimers(t);
  const { engine, saved } = createEngine();
  engine.meetingRecordingStarted({ noteId: 3 });
  engine._handleCallEnded();
  stopRecording(engine);

  t.mock.timers.tick(CALL_ENDED_NOTICE_MS + 1);
  await engine.resumeAfterCallEnded();

  assert.equal(saved.length, 0);
});

test("Resume does nothing while another meeting is recording", async (t) => {
  useTimers(t);
  const { engine, saved } = createEngine();
  engine.meetingRecordingStarted({ noteId: 3 });
  engine._handleCallEnded();
  stopRecording(engine);
  engine.meetingRecordingStarted({ noteId: 50 });

  await engine.resumeAfterCallEnded();

  assert.equal(saved.length, 0);
});

test("Resume does nothing after a stop that was not a call ending", async (t) => {
  useTimers(t);
  const { engine, saved, notices } = createEngine();
  engine.meetingRecordingStarted({ noteId: 3 });
  stopRecording(engine);

  await engine.resumeAfterCallEnded();

  assert.equal(saved.length, 0);
  assert.equal(notices.length, 0);
});

test("Resume cannot start a recording while the stop is still saving the first one", async (t) => {
  useTimers(t);
  const { engine, saved, notices } = createEngine();
  engine.meetingRecordingStarted({ noteId: 3 });
  engine._handleCallEnded();

  engine.endMeetingSession("meeting-transcription-stop");
  await engine.resumeAfterCallEnded();
  assert.equal(saved.length, 0);
  assert.equal(notices.length, 0, "the notice may not appear before the stop has saved");

  engine.meetingRecordingStopComplete();
  await engine.resumeAfterCallEnded();
  assert.equal(saved.length, 1);
});

test("Resume checks the in-flight stop on its own, not only through the recording state", async (t) => {
  useTimers(t);
  const { engine, saved } = createEngine();
  engine._callEndedNotice = { noteId: 3, until: START + CALL_ENDED_NOTICE_MS };
  engine._stopInFlight = true;

  await engine.resumeAfterCallEnded();

  assert.equal(saved.length, 0);
});

test("the stop reason the renderer was asked for wins over the handler's own", (t) => {
  useTimers(t);
  const { engine, notices } = createEngine();
  engine.meetingRecordingStarted({ noteId: 3 });
  engine._handleCallEnded();

  stopRecording(engine, "meeting-transcription-stop");

  assert.equal(notices[0].kind, "call-ended");
});

test("a stop with no recording completes straight away", () => {
  const { engine } = createEngine();
  engine._userRecording = true;

  engine.endMeetingSession();

  assert.equal(engine._userRecording, false);
  assert.equal(engine._stopInFlight, false);
});

test("queued prompts wait out the call-ended notice, but only 2.5 s after a normal stop", (t) => {
  useTimers(t);

  const normal = createEngine();
  normal.engine.meetingRecordingStarted({ noteId: 3 });
  normal.engine._handleDetection("audio", "sustained-audio", {});
  assert.equal(normal.prompts.length, 0);
  stopRecording(normal.engine);
  t.mock.timers.tick(COOLDOWN_MS);
  assert.equal(normal.prompts.length, 1);

  const callEnded = createEngine();
  callEnded.engine.meetingRecordingStarted({ noteId: 3 });
  callEnded.engine._handleDetection("audio", "sustained-audio", {});
  callEnded.engine._handleCallEnded();
  stopRecording(callEnded.engine);
  t.mock.timers.tick(COOLDOWN_MS);
  assert.equal(callEnded.prompts.length, 0, "a prompt would replace the call-ended notice");
  t.mock.timers.tick(CALL_ENDED_NOTICE_MS - COOLDOWN_MS);
  assert.equal(callEnded.prompts.length, 1);
});

test("stopping the recording clears both cap timers", (t) => {
  useTimers(t);
  const { engine, broadcasts, notices, dismissals } = createEngine();
  engine.meetingRecordingStarted({ noteId: 3 });
  t.mock.timers.tick(10 * MINUTE);

  stopRecording(engine);
  t.mock.timers.tick(CAP_MS);

  assert.equal(stopRequests(broadcasts).length, 0);
  assert.equal(notices.length, 0);
  assert.ok(dismissals.length >= 1, "an open cap warning must be dismissed");
});

test("starting a recording forgets a stop reason left over from the last one", (t) => {
  useTimers(t);
  const { engine, notices } = createEngine();
  engine.meetingRecordingStarted({ noteId: 3 });
  engine._handleCallEnded();
  engine.meetingRecordingStarted({ noteId: 4 });

  stopRecording(engine);

  assert.equal(notices.length, 0);
});

test("engines whose window manager has no recording notice still stop cleanly", () => {
  const { engine } = createEngine();
  delete engine.windowManager.showRecordingNotice;
  delete engine.windowManager.dismissRecordingNotice;
  engine.meetingRecordingStarted({ noteId: 3 });
  engine._handleCallEnded();

  assert.doesNotThrow(() => stopRecording(engine));
});

test("the published latches are unchanged by a meeting recording", () => {
  const { engine } = createEngine();
  engine.meetingRecordingStarted({ noteId: 3 });

  assert.deepEqual(Object.keys(health.getSnapshot().latches).sort(), [
    "meetingModeActive",
    "userRecording",
  ]);
});
