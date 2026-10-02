const debugLogger = require("./debugLogger");
const { JOB_KINDS } = require("./jobDispatch");
const { shouldRegenerateNotes } = require("./notesRegenerationPolicy.js");

const NOTES_REGENERATION_DELAY_MS = 60000;

class NotesRegenerationScheduler {
  constructor({
    db,
    backgroundJobQueue,
    hashOf,
    isEnabled = () => true,
    delayMs = NOTES_REGENERATION_DELAY_MS,
    timers = { setTimeout, clearTimeout },
  }) {
    this._db = db;
    this._backgroundJobQueue = backgroundJobQueue;
    this._hashOf = hashOf;
    this._isEnabled = isEnabled;
    this._delayMs = delayMs;
    this._timers = timers;
    this._timerByNoteId = new Map();
  }

  get pendingCount() {
    return this._timerByNoteId.size;
  }

  schedule(noteId) {
    this.cancel(noteId);
    const timer = this._timers.setTimeout(() => this._fire(noteId), this._delayMs);
    this._timerByNoteId.set(noteId, timer);
  }

  cancel(noteId) {
    const timer = this._timerByNoteId.get(noteId);
    if (timer === undefined) return;
    this._timers.clearTimeout(timer);
    this._timerByNoteId.delete(noteId);
  }

  stopAll() {
    for (const timer of this._timerByNoteId.values()) {
      this._timers.clearTimeout(timer);
    }
    this._timerByNoteId.clear();
  }

  _fire(noteId) {
    this._timerByNoteId.delete(noteId);

    let note;
    try {
      note = this._db.getNote(noteId);
    } catch (error) {
      debugLogger.error("Could not read note for notes regeneration", {
        noteId,
        error: error.message,
      });
      return;
    }

    if (!note) {
      debugLogger.info("Skipping notes regeneration", { noteId, reason: "note-missing" });
      return;
    }

    const generatedHash = note.enhanced_generated_hash;
    const decision = shouldRegenerateNotes({
      enabled: this._isEnabled(),
      enhancedContent: note.enhanced_content,
      generatedHash,
      hashOf: this._hashOf,
    });

    if (!decision.regenerate) {
      debugLogger.info("Skipping notes regeneration", { noteId, reason: decision.reason });
      return;
    }

    let queued;
    try {
      queued = this._backgroundJobQueue.enqueueKind(
        `regenerate-notes-${noteId}`,
        JOB_KINDS.REGENERATE_NOTES,
        { noteId, onlyIfGeneratedHash: generatedHash }
      );
    } catch (error) {
      debugLogger.error("Could not enqueue notes regeneration", {
        noteId,
        error: error.message,
      });
      return;
    }

    if (queued) return;

    debugLogger.info("Notes regeneration already in flight; re-arming", {
      noteId,
      delayMs: this._delayMs,
    });
    this.schedule(noteId);
  }
}

module.exports = { NotesRegenerationScheduler, NOTES_REGENERATION_DELAY_MS };
