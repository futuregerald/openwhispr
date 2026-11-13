const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/lineSplit.js");

const FILLER = [
  "the migration runs nightly",
  "and we watch the queue depth",
  "the backfill finished at four",
  "we capped the retries at three",
  "the index is still building",
  "staging looks identical now",
];

const line = (speaker, text, timestamp) => ({
  id: `seg-${timestamp}`,
  source: "system",
  speakerName: speaker,
  text,
  timestamp,
});

const run = (speakers, startAt, step, count, texts = {}) =>
  Array.from({ length: count }, (_, i) =>
    line(speakers[i % speakers.length], texts[i] ?? FILLER[i % FILLER.length], startAt + i * step)
  );

const twoCalls = () => [
  ...run(["Jorge", "Regina"], 0, 20, 30, {
    27: "so that is everything from my side",
    28: "I have to drop out, I'm going to have lunch",
    29: "Thank you. Good one.",
  }),
  ...run(["Fabian", "Molly"], 685.4, 20, 30, {
    0: "You already three minutes late.",
    1: "that's perfectly fine. That's on time.",
    2: "Fill me in what's happening with life.",
  }),
];

const noteOf = (segments, extra = {}) => ({
  transcript: JSON.stringify(segments),
  transcript_origin_ms: 1_700_000_000_000,
  updated_at: "2023-11-14 23:30:00",
  ...extra,
});

test("a finished, split-safe note offers the action and names its earliest line", async () => {
  const { lineSplitState } = await load();
  const segments = twoCalls();
  assert.deepEqual(lineSplitState(noteOf(segments), segments, { isRecording: false }), {
    kind: "available",
    earliestIndex: 0,
  });
});

test("the earliest line in time is excluded even when it is not first in the array", async () => {
  const { lineSplitState } = await load();
  const segments = twoCalls();
  const shuffled = [segments[5], segments[0], ...segments.slice(1, 5), ...segments.slice(6)];
  const state = lineSplitState(noteOf(shuffled), shuffled, { isRecording: false });
  assert.equal(state.kind, "available");
  assert.equal(state.earliestIndex, 1);
});

test("ties for earliest time resolve to the lower array index, like the cut", async () => {
  const { lineSplitState } = await load();
  const segments = [line("A", "one", 5), line("B", "two", 5), line("A", "three", 9)];
  const state = lineSplitState(noteOf(segments), segments, { isRecording: false });
  assert.equal(state.earliestIndex, 0);
});

test("nothing is offered while the note is recording", async () => {
  const { lineSplitState } = await load();
  const segments = twoCalls();
  assert.deepEqual(lineSplitState(noteOf(segments), segments, { isRecording: true }), {
    kind: "hidden",
  });
});

test("a note with no transcript or a single line shows nothing", async () => {
  const { lineSplitState } = await load();
  assert.equal(lineSplitState({ transcript: "" }, [], { isRecording: false }).kind, "hidden");
  const one = [line("A", "hi", 1)];
  assert.equal(lineSplitState(noteOf(one), one, { isRecording: false }).kind, "hidden");
});

test("an unsafe note carries the safety reason and offers no earliest line", async () => {
  const { lineSplitState } = await load();
  const mixed = [line("A", "one", 1), line("B", "two", 1_700_000_000_000)];
  assert.deepEqual(lineSplitState(noteOf(mixed), mixed, { isRecording: false }), {
    kind: "unsafe",
    reason: "mixed-units",
  });
  const plain = { transcript: "just words, no structure" };
  assert.deepEqual(lineSplitState(plain, [line("A", "just", 1)], { isRecording: false }), {
    kind: "unsafe",
    reason: "plain-text",
  });
});

test("a displayed overlay that no longer lines up with the stored transcript offers nothing", async () => {
  const { lineSplitState } = await load();
  const stored = twoCalls();
  const fewer = stored.slice(0, 40);
  assert.equal(lineSplitState(noteOf(stored), fewer, { isRecording: false }).kind, "hidden");
  const reordered = [stored[1], stored[0], ...stored.slice(2)];
  assert.equal(lineSplitState(noteOf(stored), reordered, { isRecording: false }).kind, "hidden");
});

test("the preview counts lines and gives local times for each part", async () => {
  const { splitPreview } = await load();
  const segments = twoCalls();
  const preview = splitPreview(segments, 30, 1_700_000_000_000);
  assert.equal(preview.first.count, 30);
  assert.equal(preview.second.count, 30);
  assert.equal(preview.first.startSeconds, 0);
  assert.equal(preview.first.endSeconds, 580);
  assert.equal(preview.second.startSeconds, 685.4);
  assert.equal(preview.first.startsAtMs, 1_700_000_000_000);
  assert.equal(preview.second.startsAtMs, 1_700_000_000_000 + 685_400);
});

test("the preview reads epoch-ms stamps as local times directly", async () => {
  const { splitPreview } = await load();
  const base = 1_700_000_000_000;
  const segments = [
    line("A", "one", base),
    line("B", "two", base + 4000),
    line("A", "three", base + 9000),
  ];
  const preview = splitPreview(segments, 2, null);
  assert.equal(preview.first.startsAtMs, base);
  assert.equal(preview.first.endsAtMs, base + 4000);
  assert.equal(preview.second.startsAtMs, base + 9000);
  assert.equal(preview.second.startSeconds, 9);
});

test("without a clock, relative lines have offsets but no local time", async () => {
  const { splitPreview } = await load();
  const preview = splitPreview(twoCalls(), 30, null);
  assert.equal(preview.first.startsAtMs, null);
  assert.equal(preview.second.startSeconds, 685.4);
});

test("the preview is null for the earliest line and for out-of-range lines", async () => {
  const { splitPreview } = await load();
  const segments = twoCalls();
  assert.equal(splitPreview(segments, 0, null), null);
  assert.equal(splitPreview(segments, 60, null), null);
  assert.equal(splitPreview(segments, -1, null), null);
  assert.equal(splitPreview(segments, 1.5, null), null);
});

test("the detected gap suggests the first line of the next call", async () => {
  const { detectedGapSuggestion } = await load();
  const suggestion = detectedGapSuggestion(twoCalls(), 1_700_000_000_000);
  assert.equal(suggestion.lineIndex, 30);
  assert.ok(Math.abs(suggestion.gapSeconds - 105.4) < 0.01);
  assert.equal(suggestion.atSeconds, 685.4);
  assert.equal(suggestion.atMs, 1_700_000_000_000 + 685_400);
});

test("no suggestion when the note holds one call", async () => {
  const { detectedGapSuggestion } = await load();
  assert.equal(detectedGapSuggestion(run(["A", "B"], 0, 20, 40), null), null);
  assert.equal(detectedGapSuggestion([], null), null);
});

test("failure reasons map to catalogue keys, unknown ones to the generic key", async () => {
  const { splitFailureKey } = await load();
  assert.equal(splitFailureKey("unsafe-timing"), "notes.callSplit.failedUnsafe");
  assert.equal(splitFailureKey("note-not-found"), "notes.callSplit.failedMissing");
  assert.equal(splitFailureKey("invalid-line"), "notes.splitAtLine.failedInvalidLine");
  assert.equal(splitFailureKey("empty-piece"), "notes.callSplit.failedStale");
  assert.equal(splitFailureKey("unresolvable-slice-bounds"), "notes.callSplit.failedUnanchored");
  assert.equal(splitFailureKey("transcript-does-not-match-report"), "notes.callSplit.failedStale");
  assert.equal(splitFailureKey("pipeline-running"), "notes.callSplit.failedPipelineRunning");
  assert.equal(splitFailureKey("transcript-changed"), "notes.splitAtLine.failedTranscriptChanged");
  assert.equal(splitFailureKey("split-failed"), "notes.callSplit.failedUnknown");
  assert.equal(splitFailureKey("something-new"), "notes.callSplit.failedUnknown");
  assert.equal(splitFailureKey(undefined), "notes.callSplit.failedUnknown");
});

test("nothing is offered while the note's post-call pipeline is running", async () => {
  const { lineSplitState } = await load();
  const segments = twoCalls();
  const note = noteOf(segments);
  assert.equal(
    lineSplitState(note, segments, { isRecording: false, pipelineRunning: true }).kind,
    "hidden"
  );
  assert.equal(
    lineSplitState(note, segments, { isRecording: false, pipelineRunning: false }).kind,
    "available"
  );
});

test("a transcript still waiting for its clock offers nothing and no reason line", async () => {
  const { lineSplitState } = await load();
  const base = 1_700_000_000_000;
  const segments = [line("A", "one", base), line("B", "two", base + 4000)];
  const state = lineSplitState(noteOf(segments, { transcript_origin_ms: null }), segments, {
    isRecording: false,
  });
  assert.deepEqual(state, { kind: "hidden" });
});

test("a cut whose lines are in time order is not flagged", async () => {
  const { splitPreview } = await load();
  assert.equal(splitPreview(twoCalls(), 30, null).linesOutOfOrder, false);
});

test("a line shown above the chosen line but stamped later is flagged", async () => {
  const { splitPreview } = await load();
  const segments = [
    line("A", "one", 0),
    line("B", "two", 50),
    line("A", "three", 10),
    line("B", "four", 20),
    line("A", "five", 30),
  ];
  assert.equal(splitPreview(segments, 3, null).linesOutOfOrder, true);
});

test("a line shown below the chosen line but stamped earlier is flagged", async () => {
  const { splitPreview } = await load();
  const segments = [
    line("A", "one", 0),
    line("B", "two", 20),
    line("A", "three", 30),
    line("B", "four", 10),
    line("A", "five", 40),
  ];
  assert.equal(splitPreview(segments, 2, null).linesOutOfOrder, true);
});
