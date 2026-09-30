const test = require("node:test");
const assert = require("node:assert/strict");

const { classifyRetroactiveMatch } = require("../../src/helpers/retroactiveSpeakerMatch");

// A fake scorer, so a test states the similarities it means instead of hoping a
// fixture of real embeddings happens to produce them.
const classify = (candidates) =>
  classifyRetroactiveMatch(
    null,
    candidates.map((c) => ({ speakerId: c.speakerId, embedding: c })),
    (_profile, candidate) => candidate.score
  );

test("a clear winner is matched", () => {
  const r = classify([
    { speakerId: "speaker_0", score: 0.9 },
    { speakerId: "speaker_1", score: 0.2 },
  ]);
  assert.equal(r.outcome, "match");
  assert.equal(r.speakerId, "speaker_0");
  assert.ok(Math.abs(r.confidence - 0.9) < 1e-9);
});

// 0.9 vs 0.82 is a gap of 0.08, well over MATCH_MARGIN, so this MATCHES. The
// first draft of the plan asserted null here and was arithmetically wrong;
// worse, two mutation proofs pointed at it, so neither proved anything.
test("a clear winner still wins when a third speaker also clears the threshold", () => {
  const r = classify([
    { speakerId: "speaker_0", score: 0.9 },
    { speakerId: "speaker_1", score: 0.82 },
    { speakerId: "speaker_2", score: 0.7 },
  ]);
  assert.equal(r.outcome, "match");
  assert.equal(r.speakerId, "speaker_0");
});

test("nothing below the threshold is returned", () => {
  assert.equal(classify([{ speakerId: "speaker_0", score: 0.64 }]), null);
});

// The over-split case: one person became two clusters and both score high.
// Rejecting means the note never gets a label on any future sweep; confirming
// may label two different people as one. A suggestion is right either way.
test("a near-tie becomes a suggestion, not a match", () => {
  const r = classify([
    { speakerId: "speaker_0", score: 0.95 },
    { speakerId: "speaker_1", score: 0.94 },
  ]);
  assert.equal(r.outcome, "suggest");
  assert.equal(r.speakerId, "speaker_0", "the suggestion is the best candidate");
});

test("the margin is not waived at high confidence, unlike live matching", () => {
  const r = classify([
    { speakerId: "speaker_0", score: 0.99 },
    { speakerId: "speaker_1", score: 0.98 },
  ]);
  assert.equal(r.outcome, "suggest", "acceptsMatch would have confirmed this outright");
});

test("a winner clearing the margin is matched", () => {
  const r = classify([
    { speakerId: "speaker_0", score: 0.75 },
    { speakerId: "speaker_1", score: 0.7 },
  ]);
  assert.equal(r.outcome, "match");
});

test("a lone candidate has no runner-up to beat", () => {
  assert.equal(classify([{ speakerId: "speaker_0", score: 0.7 }]).outcome, "match");
});

test("no candidates yields nothing", () => {
  assert.equal(classify([]), null);
});

test("a non-finite score never wins", () => {
  assert.equal(classify([{ speakerId: "speaker_0", score: NaN }]), null);
});

test("a non-finite score does not mask a real winner", () => {
  const r = classify([
    { speakerId: "speaker_0", score: NaN },
    { speakerId: "speaker_1", score: 0.9 },
  ]);
  assert.equal(r.outcome, "match");
  assert.equal(r.speakerId, "speaker_1");
});
