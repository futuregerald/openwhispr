const test = require("node:test");
const assert = require("node:assert/strict");

const { foldSpeakersInto } = require("../../src/helpers/speakerFold.js");

const seg = (id, speaker, extra = {}) => ({ id, speaker, text: "x", ...extra });

test("folds every target speaker's segments into the primary", () => {
  const segments = [seg("a", "speaker_0"), seg("b", "speaker_1"), seg("c", "speaker_2")];

  const next = foldSpeakersInto(segments, "speaker_0", ["speaker_1", "speaker_2"], "Kathy");

  assert.deepEqual(next.map((s) => s.speaker), ["speaker_0", "speaker_0", "speaker_0"]);
  assert.equal(next[1].speakerName, "Kathy");
});

// The whole reason the panel's merge moved into the renderer. The main-process path it
// replaced skipped locked segments, and a speaker the user has already named is fully
// locked -- note 4's speaker_1 is locked on all 257 of its segments, so merging it folded
// 0 of them and reported success. A merge started from the panel is the user's own
// decision, so it applies to locked segments too.
test("folds segments the user had locked, because merging them was an explicit choice", () => {
  const segments = [
    seg("a", "speaker_0"),
    seg("b", "speaker_1", { speakerLocked: true, speakerLockSource: "user", speakerName: "Irvin" }),
  ];

  const next = foldSpeakersInto(segments, "speaker_0", ["speaker_1"], "Chris");

  assert.equal(next[1].speaker, "speaker_0");
  assert.equal(next[1].speakerName, "Chris");
});

test("leaves every other speaker untouched, including the primary's own segments", () => {
  const untouched = seg("a", "speaker_9", { speakerName: "Molly", speakerLocked: true });
  const segments = [untouched, seg("b", "speaker_1")];

  const next = foldSpeakersInto(segments, "speaker_0", ["speaker_1"], "Kathy");

  assert.deepEqual(next[0], untouched);
});

test("a fold with no targets changes nothing", () => {
  const segments = [seg("a", "speaker_0"), seg("b", "speaker_1")];

  assert.deepEqual(foldSpeakersInto(segments, "speaker_0", [], "Kathy"), segments);
});

test("the folded segments are locked, so diarization cannot undo the merge", () => {
  const next = foldSpeakersInto([seg("b", "speaker_1")], "speaker_0", ["speaker_1"], "Kathy");

  assert.equal(next[0].speakerLocked, true);
  assert.equal(next[0].speakerIsPlaceholder, false);
});

test("a folded segment drops any suggestion that pointed at the old speaker", () => {
  const segments = [seg("b", "speaker_1", { suggestedName: "Someone", suggestedProfileId: 7 })];

  const next = foldSpeakersInto(segments, "speaker_0", ["speaker_1"], "Kathy");

  assert.equal(next[0].suggestedName, undefined);
  assert.equal(next[0].suggestedProfileId, undefined);
});

// The sequence the split-authority bug destroyed: with rename in the renderer and merge in
// main, the merge was invisible to the editor and the next rename wrote the pre-merge
// segments back over it. Both now run over the same array.
test("rename, then merge, then rename again leaves the merge intact", () => {
  const renameTo = (segments, speakerId, name) =>
    segments.map((s) =>
      s.speaker === speakerId ? { ...s, speakerName: name, speakerLocked: true } : s
    );

  let segments = [seg("a", "speaker_0"), seg("b", "speaker_1"), seg("c", "speaker_1")];

  segments = renameTo(segments, "speaker_1", "Irvin");
  segments = foldSpeakersInto(segments, "speaker_0", ["speaker_1"], "Chris");
  segments = renameTo(segments, "speaker_0", "Chris Kidd");

  assert.deepEqual(segments.map((s) => s.speaker), ["speaker_0", "speaker_0", "speaker_0"]);
  assert.deepEqual(
    segments.map((s) => s.speakerName),
    ["Chris Kidd", "Chris Kidd", "Chris Kidd"],
    "no segment may revert to the pre-merge speaker"
  );
});
