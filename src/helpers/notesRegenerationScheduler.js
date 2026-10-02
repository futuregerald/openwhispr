const debugLogger = require("./debugLogger");
const { JOB_KINDS } = require("./jobDispatch");
const { shouldRegenerateNotes } = require("./notesRegenerationPolicy.js");

const NOTES_REGENERATION_DELAY_MS = 60000;
const MAX_REARMS = 10;

class NotesRegenerationScheduler {
  constructor({
    db,
    backgroundJobQueue,
    hashOf,
    isEnabled = () => true,
    delayMs = NOTES_REGENERATION_DELAY_MS,
    timers = { setTimeout, clearTimeout },
    jobStore = null,
  }) {
    this._db = db;
    this._backgroundJobQueue = backgroundJobQueue;
    this._hashOf = hashOf;
    this._isEnabled = isEnabled;
    this._delayMs = delayMs;
    this._timers = timers;
    this._jobStore = jobStore;
    this._timerByNoteId = new Map();
    this._rearmsByNoteId = new Map();
  }

  get pendingCount() {
    return this._timerByNoteId.size;
  }

  schedule(noteId) {
    const rearms = this._rearmsByNoteId.get(noteId) ?? 0;
    this.cancel(noteId);
    if (rearms > 0) this._rearmsByNoteId.set(noteId, rearms);
    const timer = this._timers.setTimeout(() => this._fire(noteId), this._delayMs);
    this._timerByNoteId.set(noteId, timer);
  }

  cancel(noteId) {
    this._rearmsByNoteId.delete(noteId);
    const timer = this._timerByNoteId.get(noteId);
    if (timer === undefined) return;
    this._timers.clearTimeout(timer);
    this._timerByNoteId.delete(noteId);
  }

  // A debounce that lives in memory is lost to a quit, and the rename with it.
  // The job table already survives a quit, so an unfired timer is written there
  // as a row rather than enqueued -- enqueuing would start running it while the
  // app is tearing down. The pre-write check still protects the notes next launch.
  persistPendingForNextLaunch() {
    if (!this._jobStore?.insert) return 0;
    let persisted = 0;
    for (const noteId of this._timerByNoteId.keys()) {
      try {
        if (!this._decide(noteId).regenerate) continue;
        const row = this._jobStore.insert(
          `regenerate-notes-${noteId}`,
          JOB_KINDS.REGENERATE_NOTES,
          { noteId }
        );
        if (row) persisted += 1;
      } catch (error) {
        debugLogger.error("Could not persist a pending notes regeneration", {
          noteId,
          error: error.message,
        });
      }
    }
    if (persisted > 0) {
      debugLogger.info("Persisted pending notes regenerations for the next launch", { persisted });
    }
    return persisted;
  }

  stopAll() {
    for (const timer of this._timerByNoteId.values()) {
      this._timers.clearTimeout(timer);
    }
    this._timerByNoteId.clear();
    this._rearmsByNoteId.clear();
  }

  _decide(noteId) {
    let note;
    try {
      note = this._db.getNote(noteId);
    } catch (error) {
      debugLogger.error("Could not read note for notes regeneration", {
        noteId,
        error: error.message,
      });
      return { regenerate: false, reason: "note-unreadable" };
    }

    if (!note) {
      return { regenerate: false, reason: "note-missing" };
    }

    return shouldRegenerateNotes({
      enabled: this._isEnabled(),
      enhancedContent: note.enhanced_content,
      generatedHash: note.enhanced_generated_hash,
      hashOf: this._hashOf,
    });
  }

  _fire(noteId) {
    this._timerByNoteId.delete(noteId);

    const decision = this._decide(noteId);

    if (!decision.regenerate) {
      debugLogger.info("Skipping notes regeneration", { noteId, reason: decision.reason });
      return;
    }

    let queued;
    try {
      queued = this._backgroundJobQueue.enqueueKind(
        `regenerate-notes-${noteId}`,
        JOB_KINDS.REGENERATE_NOTES,
        { noteId }
      );
    } catch (error) {
      debugLogger.error("Could not enqueue notes regeneration", {
        noteId,
        error: error.message,
      });
      return;
    }

    if (queued) {
      this._rearmsByNoteId.delete(noteId);
      return;
    }

    const rearms = (this._rearmsByNoteId.get(noteId) ?? 0) + 1;
    if (rearms > MAX_REARMS) {
      this._rearmsByNoteId.delete(noteId);
      debugLogger.warn("Giving up re-arming notes regeneration", { noteId, rearms: MAX_REARMS });
      return;
    }

    debugLogger.info("Notes regeneration already in flight; re-arming", {
      noteId,
      delayMs: this._delayMs,
      rearms,
    });
    this._rearmsByNoteId.set(noteId, rearms);
    this.schedule(noteId);
  }
}

module.exports = { NotesRegenerationScheduler, NOTES_REGENERATION_DELAY_MS, MAX_REARMS };
