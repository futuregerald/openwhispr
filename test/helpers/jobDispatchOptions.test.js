const test = require("node:test");
const assert = require("node:assert/strict");

const { runJob, JOB_KINDS } = require("../../src/helpers/jobDispatch.js");

// The guard that stops a regeneration overwriting hand-edited notes is carried in
// the job payload and honoured in the pipeline. The dispatch table is the only
// thing joining the two, and a typo on either side fails open -- the pipeline
// treats a missing flag as "write unconditionally", which is correct for the
// manual button and catastrophic for the automatic path. So drive the real table.
function capturingPipeline() {
  const calls = [];
  return {
    calls,
    postCallPipelineManager: {
      runSingleStep: async (noteId, step, options) => {
        calls.push({ noteId, step, options });
      },
    },
  };
}

test("an automatic regeneration demands provenance, which is the default", async () => {
  const { calls, postCallPipelineManager } = capturingPipeline();

  await runJob({ postCallPipelineManager }, JOB_KINDS.REGENERATE_NOTES, { noteId: 12 });

  assert.deepEqual(calls, [{ noteId: 12, step: "notes", options: { allowOverwrite: false } }]);
});

test("only the manual button may waive the check, and only explicitly", async () => {
  const { calls, postCallPipelineManager } = capturingPipeline();

  await runJob({ postCallPipelineManager }, JOB_KINDS.REGENERATE_NOTES, {
    noteId: 12,
    allowOverwrite: true,
  });

  assert.deepEqual(calls, [{ noteId: 12, step: "notes", options: { allowOverwrite: true } }]);
});

test("a malformed waiver protects the notes rather than overwriting them", async () => {
  for (const malformed of ["true", 1, {}, null]) {
    const { calls, postCallPipelineManager } = capturingPipeline();

    await runJob({ postCallPipelineManager }, JOB_KINDS.REGENERATE_NOTES, {
      noteId: 12,
      allowOverwrite: malformed,
    });

    assert.equal(
      calls[0].options.allowOverwrite,
      false,
      `${JSON.stringify(malformed)} must not waive the provenance check`
    );
  }
});
