"use strict";

const { JOB_KINDS } = require("./jobDispatch");

/**
 * Decide whether a finished meeting should kick off the post-call pipeline, and
 * queue it if so. Kept as a pure, injectable helper (queue + pipeline manager
 * passed in) so the trigger is unit-testable without standing up the whole IPC
 * layer — the pipeline itself was well covered while the thing that starts it
 * was not.
 *
 * @param {object} deps
 * @param {number|null|undefined} deps.noteId
 * @param {boolean} deps.disabled - user turned the automatic pipeline off
 * @param {{ enqueue: (id: string, fn: Function) => void }} deps.backgroundJobQueue
 * @param {{ run: (noteId: number) => any }} deps.postCallPipelineManager
 * @param {{ info: Function }} [deps.logger]
 * @returns {boolean} true when a job was queued
 */
function enqueuePostCallPipeline({
  noteId,
  disabled,
  backgroundJobQueue,
  postCallPipelineManager,
  logger,
}) {
  if (disabled) {
    logger?.info("Post-call pipeline disabled by user setting", {}, "meeting");
    return false;
  }
  if (noteId === null || noteId === undefined) return false;

  // Returns true whenever this note's pipeline is now ON THE QUEUE -- whether
  // this call put it there or a previous one did. It used to return true
  // unconditionally, and the caller gates the large whisper model's
  // auto-download on it: a recovered job from the last launch is precisely the
  // case that needs that model, so treating "already queued" as "not queued"
  // would withhold the download from the job that needs it most.
  //
  // Only `disabled` and a missing note id return false, as before.
  backgroundJobQueue.enqueueKind(`post-call-${noteId}`, JOB_KINDS.POST_CALL_PIPELINE, {
    noteId,
  });
  return true;
}

module.exports = { enqueuePostCallPipeline };
