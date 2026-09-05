const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveRetryStep } = require("../../src/helpers/noteRetryStep.js");
const {
  isPipelineStep,
  STEP_ORDER,
  localizedTitlePlaceholders,
} = require("../../src/helpers/postCallPipelineManager.js");

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
    meeting({ title: localizedTitlePlaceholders()[0], transcript: "t", enhanced_content: "notes" })
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
    meeting({ title: localizedTitlePlaceholders()[0], transcript: null, enhanced_content: null })
  );
  assert.equal(step, "retranscribe");
});

test("every step this resolver returns is one the pipeline accepts", () => {
  const notes = [
    meeting({ transcript: null }),
    meeting({ transcript: "t" }),
    // Taken from the real list rather than typed out: the English placeholder is
    // "New note", not "New Note", and guessing it made this test assert nothing.
    meeting({ title: localizedTitlePlaceholders()[1], transcript: "t", enhanced_content: "n" }),
  ];
  for (const note of notes) {
    const { step } = resolveRetryStep(note);
    assert.equal(isPipelineStep(step), true, `${step} is not a pipeline step`);
  }
});

test("a missing note resolves to nothing rather than throwing", () => {
  assert.deepEqual(resolveRetryStep(null), { step: null, reason: "missing" });
});

// The placeholder list must be the pipeline's own, not a hard-coded English
// one. A note created in Spanish carries "Nota sin título", which no English
// list matches -- so a hard-coded list would report every non-English user's
// ungenerated title as complete and offer them no retry. The pipeline resolves
// every placeholder in every supported language for exactly this reason.
test("a placeholder title is recognised in every supported language", () => {
  const placeholders = localizedTitlePlaceholders();
  assert.ok(placeholders.length >= 10, `only ${placeholders.length} placeholders resolved`);

  for (const placeholder of placeholders) {
    const { step } = resolveRetryStep(
      meeting({ title: placeholder, transcript: "t", enhanced_content: "notes" })
    );
    assert.equal(step, "title", `"${placeholder}" was not recognised as a placeholder`);
  }
});

test("a real title in another language is not mistaken for a placeholder", () => {
  const { step } = resolveRetryStep(
    meeting({ title: "Reunión semanal de equipo", transcript: "t", enhanced_content: "notes" })
  );
  assert.equal(step, null, "a genuine Spanish title must count as generated");
});
