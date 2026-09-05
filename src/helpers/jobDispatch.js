/**
 * What each persisted job kind actually does.
 *
 * The queue used to hold CLOSURES, which is why quitting lost the work: a row
 * cannot store a function. All six enqueue sites turned out to reduce to two
 * kinds over one payload shape, so the table is small — the awkward part was
 * never the storage, it was that the closures had to become data first.
 *
 * Kinds are persisted strings. Renaming one strands every row already written
 * with the old name, so treat them as a wire format: add, never rename.
 */
const JOB_KINDS = {
  // The whole post-call pipeline: retranscribe, title, classify, notes.
  // `fromStep` restarts partway, which is what per-note retry uses.
  POST_CALL_PIPELINE: "post-call-pipeline",
  // Just the notes step, for "regenerate notes" on a meeting that already has a
  // transcript it is happy with.
  REGENERATE_NOTES: "regenerate-notes",
};

const HANDLERS = {
  [JOB_KINDS.POST_CALL_PIPELINE]: ({ postCallPipelineManager }, payload) =>
    postCallPipelineManager.run(
      payload.noteId,
      payload.fromStep ? { fromStep: payload.fromStep } : {}
    ),

  [JOB_KINDS.REGENERATE_NOTES]: ({ postCallPipelineManager }, payload) =>
    postCallPipelineManager.runSingleStep(payload.noteId, "notes"),
};

function isKnownJobKind(kind) {
  return Object.prototype.hasOwnProperty.call(HANDLERS, kind);
}

/**
 * Runs one persisted job.
 *
 * Throws on an unknown kind rather than silently doing nothing: a row written
 * by a newer version and read by an older one is a real possibility after a
 * downgrade, and a job that vanishes without a trace is the failure this whole
 * change exists to remove. Throwing routes it through the normal failure path,
 * where it is recorded with its attempts.
 */
function runJob(dependencies, kind, payload) {
  const handler = HANDLERS[kind];
  if (!handler) {
    throw new Error(`Unknown job kind: ${kind}`);
  }
  return handler(dependencies, payload || {});
}

module.exports = { JOB_KINDS, isKnownJobKind, runJob };
