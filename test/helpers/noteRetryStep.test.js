const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveRetryStep, retryableSteps } = require("../../src/helpers/noteRetryStep.js");
const { isPipelineStep, STEP_ORDER } = require("../../src/helpers/postCallPipelineManager.js");

const meeting = (overrides) => ({
  id: 1,
  title: "Weekly sync",
  transcript: null,
  enhanced_content: null,
  system_audio_path: "/tmp/meeting.opus",
  mic_audio_path: null,
  ...overrides,
});

// The state 19 of this user's meetings are actually in, and the reason the
// retry menu exists: the title step succeeded, the notes step failed, and the
// renderer's in-memory pipeline store knows nothing about it because the
// failure happened while the control panel was shut.
test("a meeting with a transcript and no notes retries from the notes step", () => {
  const { step, reason } = resolveRetryStep(
    meeting({ transcript: "a real transcript", enhanced_content: null })
  );

  assert.equal(step, "notes");
  assert.equal(reason, "no-notes");
});

// Retrying from "retranscribe" would re-transcribe and re-diarize an hour of
// audio to fix a step that only needs the transcript it already has. That is
// what the one existing caller in the note editor does, and why it is the wrong
// default for a stuck meeting.
test("the notes retry does not go back through re-transcription", () => {
  const { step } = resolveRetryStep(meeting({ transcript: "a real transcript" }));
  assert.ok(STEP_ORDER.indexOf(step) > STEP_ORDER.indexOf("retranscribe"));
});

test("a meeting with no transcript but saved audio retries from the start", () => {
  const { step, reason } = resolveRetryStep(meeting({ transcript: null }));
  assert.equal(step, "retranscribe");
  assert.equal(reason, "no-transcript");
});

// Audio is cleared after 30 days once a meeting has been processed. Offering a
// retry that can only fail the same way is worse than offering none.
test("no transcript and no audio offers nothing rather than a retry that must fail", () => {
  const { step, reason } = resolveRetryStep(
    meeting({ transcript: null, system_audio_path: null, mic_audio_path: null })
  );
  assert.equal(step, null);
  assert.equal(reason, "no-transcript-no-audio");
});

test("a meeting that still has its placeholder title retries the title step", () => {
  const { step, reason } = resolveRetryStep(
    meeting({ title: "Untitled Note", transcript: "t", enhanced_content: "notes" })
  );
  assert.equal(step, "title");
  assert.equal(reason, "no-title");
});

test("a complete meeting offers nothing", () => {
  const { step, reason } = resolveRetryStep(
    meeting({ transcript: "t", enhanced_content: "notes" })
  );
  assert.equal(step, null);
  assert.equal(reason, "complete");
});

test("whitespace is not content", () => {
  assert.equal(resolveRetryStep(meeting({ transcript: "   " })).step, "retranscribe");
  assert.equal(
    resolveRetryStep(meeting({ transcript: "t", enhanced_content: "  \n " })).step,
    "notes"
  );
});

test("the earliest missing step wins, because everything after it depends on it", () => {
  // No transcript AND no notes AND a placeholder title: retranscribe, not notes.
  const { step } = resolveRetryStep(
    meeting({ title: "Untitled Note", transcript: null, enhanced_content: null })
  );
  assert.equal(step, "retranscribe");
});

test("every step this resolver returns is one the pipeline accepts", () => {
  const notes = [
    meeting({ transcript: null }),
    meeting({ transcript: "t" }),
    meeting({ title: "New Note", transcript: "t", enhanced_content: "n" }),
  ];
  for (const note of notes) {
    const { step } = resolveRetryStep(note);
    assert.equal(isPipelineStep(step), true, `${step} is not a pipeline step`);
  }
});

test("re-transcription is not offered for a meeting whose audio is gone", () => {
  assert.deepEqual(retryableSteps(meeting({})), STEP_ORDER);
  assert.deepEqual(
    retryableSteps(meeting({ system_audio_path: null, mic_audio_path: null })),
    STEP_ORDER.filter((s) => s !== "retranscribe")
  );
});

test("a missing note resolves to nothing rather than throwing", () => {
  assert.deepEqual(resolveRetryStep(null), { step: null, reason: "missing" });
});
