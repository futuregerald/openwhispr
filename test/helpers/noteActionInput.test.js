const test = require("node:test");
const assert = require("node:assert/strict");

const { runNoteAction } = require("../../src/helpers/noteActionRunner");

const load = () => import("../../src/utils/noteActionInput.ts");

const seg = (label, text) => ({ label, text });

const expectedCloudPrompt = (notes, formattedTranscript) =>
  [
    notes.trim() ? notes : "",
    formattedTranscript ? `## Meeting Transcript\n${formattedTranscript}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

const runLocally = async ({ localRunnerNoteContent }, labelledSegments) => {
  const calls = [];
  const result = await runNoteAction({
    noteContent: localRunnerNoteContent,
    segments: labelledSegments,
    systemPrompt: "SYS",
    contextSize: 4096,
    isGpuBackend: true,
    sleep: async () => {},
    infer: async (prompt) => {
      calls.push(prompt);
      return `out(${calls.length})`;
    },
  });
  return { calls, result };
};

const occurrences = (haystack, needle) => haystack.split(needle).length - 1;

test("the cloud prompt is the notes, then a Meeting Transcript heading and the transcript", async () => {
  const { buildNoteActionInput } = await load();
  const segments = [seg("You", "hello"), seg("Them", "hi back")];

  assert.equal(
    buildNoteActionInput({ notes: "my notes", rawTranscript: "[json]", labelledSegments: segments })
      .promptText,
    expectedCloudPrompt("my notes", "You: hello\nThem: hi back")
  );
  assert.equal(
    buildNoteActionInput({ notes: "my notes", rawTranscript: "plain text", labelledSegments: [] })
      .promptText,
    expectedCloudPrompt("my notes", "plain text")
  );
  assert.equal(
    buildNoteActionInput({ notes: "  ", rawTranscript: "", labelledSegments: segments }).promptText,
    expectedCloudPrompt("  ", "You: hello\nThem: hi back")
  );
  assert.equal(
    buildNoteActionInput({ notes: "only notes", rawTranscript: "", labelledSegments: [] })
      .promptText,
    expectedCloudPrompt("only notes", "")
  );
});

test("a local run on a short meeting sees the transcript exactly once", async () => {
  const { buildNoteActionInput } = await load();
  const segments = [seg("You", "hello there"), seg("Them", "a distinctive reply")];
  const input = buildNoteActionInput({
    notes: "my notes",
    rawTranscript: "[json]",
    labelledSegments: segments,
  });

  const { calls } = await runLocally(input, segments);

  assert.equal(calls.length, 1);
  assert.equal(occurrences(calls[0], "a distinctive reply"), 1);
  assert.equal(occurrences(calls[0], "my notes"), 1, "the user's notes still reach the model");
});

test("a meeting with no typed notes sends the local runner an empty note, and the transcript once", async () => {
  const { buildNoteActionInput } = await load();
  const segments = [seg("You", "hello there"), seg("Them", "a distinctive reply")];
  const input = buildNoteActionInput({
    notes: "",
    rawTranscript: "[json]",
    labelledSegments: segments,
  });

  assert.equal(input.localRunnerNoteContent, "");
  const { calls } = await runLocally(input, segments);
  assert.equal(occurrences(calls[0], "a distinctive reply"), 1);
});

test("a local run on a meeting longer than the context splits into passes instead of refusing", async () => {
  const { buildNoteActionInput } = await load();
  const segments = Array.from({ length: 24 }, (_, i) => seg("You", "w".repeat(400) + ` #${i}`));
  const input = buildNoteActionInput({
    notes: "my notes",
    rawTranscript: "[json]",
    labelledSegments: segments,
  });

  const { calls, result } = await runLocally(input, segments);

  assert.ok(result.passes > 1, "must have run as multiple passes");
  assert.match(
    calls[calls.length - 1],
    /my notes/,
    "the compose step still carries the user's notes"
  );
});

test("with segments, the local runner gets the notes alone; without, the whole prompt", async () => {
  const { buildNoteActionInput } = await load();

  assert.equal(
    buildNoteActionInput({
      notes: "my notes",
      rawTranscript: "[json]",
      labelledSegments: [seg("You", "x")],
    }).localRunnerNoteContent,
    "my notes"
  );
  const plain = buildNoteActionInput({
    notes: "my notes",
    rawTranscript: "plain",
    labelledSegments: [],
  });
  assert.equal(plain.localRunnerNoteContent, plain.promptText);
});

test("a plain-text transcript with no segments still reaches the local runner", async () => {
  const { buildNoteActionInput } = await load();
  const input = buildNoteActionInput({
    notes: "my notes",
    rawTranscript: "plain transcript body",
    labelledSegments: [],
  });

  const { calls } = await runLocally(input, []);

  assert.equal(occurrences(calls[0], "plain transcript body"), 1);
  assert.equal(occurrences(calls[0], "my notes"), 1);
});
