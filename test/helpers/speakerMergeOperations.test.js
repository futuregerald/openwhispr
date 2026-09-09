const test = require("node:test");
const assert = require("node:assert");
const {
  mergeSpeakerSegments,
  renameSpeakerSegments,
} = require("../../src/helpers/speakerMergeOperations");

const seg = (speaker, extra = {}) => ({
  source: "system",
  text: "x",
  speaker,
  speakerName: `${speaker} name`,
  speakerIsPlaceholder: true,
  ...extra,
});

test("mergeSpeakerSegments folds several speakers into the kept one in a single pass", () => {
  const segments = [
    seg("keep", { speakerName: "Fabian", speakerIsPlaceholder: false }),
    seg("a"),
    seg("b"),
    seg("c"),
    seg("untouched"),
  ];
  const result = mergeSpeakerSegments(segments, "keep", ["a", "b", "c"]);
  assert.strictEqual(result.mergedCount, 3);
  assert.strictEqual(result.skippedLockedCount, 0);
  assert.deepStrictEqual(
    result.segments.map((s) => s.speaker),
    ["keep", "keep", "keep", "keep", "untouched"]
  );
  for (const s of result.segments.slice(0, 4)) {
    assert.strictEqual(s.speakerName, "Fabian");
    assert.strictEqual(s.speakerIsPlaceholder, false);
  }
});

test("mergeSpeakerSegments accepts the legacy single-id form", () => {
  const segments = [seg("keep"), seg("a")];
  const result = mergeSpeakerSegments(segments, "keep", "a");
  assert.strictEqual(result.mergedCount, 1);
  assert.deepStrictEqual(
    result.segments.map((s) => s.speaker),
    ["keep", "keep"]
  );
});

test("mergeSpeakerSegments skips a locked segment and reports it", () => {
  const segments = [
    seg("keep", { speakerName: "Fabian", speakerIsPlaceholder: false }),
    seg("a", {
      speakerName: "Molly",
      speakerIsPlaceholder: false,
      speakerLocked: true,
      speakerLockSource: "user",
    }),
    seg("a"),
  ];
  const result = mergeSpeakerSegments(segments, "keep", ["a"]);
  assert.strictEqual(result.mergedCount, 1);
  assert.strictEqual(result.skippedLockedCount, 1);
  assert.strictEqual(result.segments[1].speaker, "a");
  assert.strictEqual(result.segments[1].speakerName, "Molly");
  assert.strictEqual(result.segments[2].speaker, "keep");
});

test("mergeSpeakerSegments honours a locked segment expressed only as speakerStatus", () => {
  const segments = [seg("keep"), seg("a", { speakerStatus: "locked" })];
  const result = mergeSpeakerSegments(segments, "keep", ["a"]);
  assert.strictEqual(result.mergedCount, 0);
  assert.strictEqual(result.skippedLockedCount, 1);
  assert.strictEqual(result.segments[1].speaker, "a");
});

test("mergeSpeakerSegments never merges a speaker into itself", () => {
  const segments = [seg("keep"), seg("a")];
  const result = mergeSpeakerSegments(segments, "keep", ["keep", "a", "a"]);
  assert.strictEqual(result.mergedCount, 1);
  assert.deepStrictEqual(
    result.segments.map((s) => s.speaker),
    ["keep", "keep"]
  );
});

test("mergeSpeakerSegments falls back to the kept id when it has no name", () => {
  const segments = [seg("keep", { speakerName: undefined }), seg("a")];
  const result = mergeSpeakerSegments(segments, "keep", ["a"]);
  assert.strictEqual(result.segments[1].speakerName, "keep");
});

test("mergeSpeakerSegments does not mutate the input segments", () => {
  const segments = [seg("keep"), seg("a")];
  const before = JSON.stringify(segments);
  mergeSpeakerSegments(segments, "keep", ["a"]);
  assert.strictEqual(JSON.stringify(segments), before);
});

test("renameSpeakerSegments renames every unlocked segment of the speaker", () => {
  const segments = [seg("a"), seg("a"), seg("b")];
  const result = renameSpeakerSegments(segments, "a", "Leandro");
  assert.strictEqual(result.renamedCount, 2);
  assert.strictEqual(result.skippedLockedCount, 0);
  assert.strictEqual(result.segments[0].speakerName, "Leandro");
  assert.strictEqual(result.segments[0].speakerIsPlaceholder, false);
  assert.strictEqual(result.segments[2].speakerName, "b name");
});

test("renameSpeakerSegments leaves a locked segment alone and reports it", () => {
  const segments = [
    seg("a", { speakerName: "Molly", speakerLocked: true, speakerLockSource: "user" }),
    seg("a"),
  ];
  const result = renameSpeakerSegments(segments, "a", "Leandro");
  assert.strictEqual(result.renamedCount, 1);
  assert.strictEqual(result.skippedLockedCount, 1);
  assert.strictEqual(result.segments[0].speakerName, "Molly");
  assert.strictEqual(result.segments[1].speakerName, "Leandro");
});

test("renameSpeakerSegments does not mutate the input segments", () => {
  const segments = [seg("a")];
  const before = JSON.stringify(segments);
  renameSpeakerSegments(segments, "a", "Leandro");
  assert.strictEqual(JSON.stringify(segments), before);
});
