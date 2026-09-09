const test = require("node:test");
const assert = require("node:assert");
const {
  toggleSpeakerSelection,
  toggleSelectAllSpeakers,
  getMergePrimaryId,
  getMergeTargetIds,
  canMergeSelection,
} = require("../../src/helpers/speakerMergeSelection");

test("toggleSpeakerSelection grows past two speakers", () => {
  let selected = [];
  for (const id of ["a", "b", "c", "d"]) {
    selected = toggleSpeakerSelection(selected, id);
  }
  assert.deepStrictEqual(selected, ["a", "b", "c", "d"]);
});

test("toggleSpeakerSelection removes an already-selected speaker", () => {
  const selected = toggleSpeakerSelection(["a", "b", "c"], "b");
  assert.deepStrictEqual(selected, ["a", "c"]);
});

test("toggleSpeakerSelection keeps the first pick first so the kept speaker is stable", () => {
  let selected = toggleSpeakerSelection([], "keep");
  selected = toggleSpeakerSelection(selected, "other");
  selected = toggleSpeakerSelection(selected, "third");
  assert.strictEqual(getMergePrimaryId(selected), "keep");
  assert.deepStrictEqual(getMergeTargetIds(selected), ["other", "third"]);
});

test("removing and re-adding the first pick moves the kept speaker to the new first pick", () => {
  let selected = ["a", "b"];
  selected = toggleSpeakerSelection(selected, "a");
  assert.strictEqual(getMergePrimaryId(selected), "b");
  selected = toggleSpeakerSelection(selected, "a");
  assert.deepStrictEqual(selected, ["b", "a"]);
  assert.strictEqual(getMergePrimaryId(selected), "b");
});

test("toggleSelectAllSpeakers selects every speaker when some are unselected", () => {
  const selected = toggleSelectAllSpeakers(["b"], ["a", "b", "c"]);
  assert.deepStrictEqual(selected, ["b", "a", "c"]);
  assert.strictEqual(getMergePrimaryId(selected), "b");
});

test("toggleSelectAllSpeakers clears the selection when everything is already selected", () => {
  assert.deepStrictEqual(toggleSelectAllSpeakers(["a", "b", "c"], ["a", "b", "c"]), []);
});

test("toggleSelectAllSpeakers drops ids that are no longer present", () => {
  assert.deepStrictEqual(toggleSelectAllSpeakers(["gone", "b"], ["a", "b"]), ["b", "a"]);
});

test("canMergeSelection needs two speakers, not exactly two", () => {
  assert.strictEqual(canMergeSelection([]), false);
  assert.strictEqual(canMergeSelection(["a"]), false);
  assert.strictEqual(canMergeSelection(["a", "b"]), true);
  assert.strictEqual(canMergeSelection(["a", "b", "c", "d"]), true);
});

test("getMergePrimaryId and getMergeTargetIds tolerate an empty selection", () => {
  assert.strictEqual(getMergePrimaryId([]), null);
  assert.deepStrictEqual(getMergeTargetIds([]), []);
  assert.deepStrictEqual(getMergeTargetIds(["only"]), []);
});
