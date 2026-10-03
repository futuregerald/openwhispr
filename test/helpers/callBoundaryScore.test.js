const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/callBoundaryScore.js");

const segment = (speakerName, text, timestamp) => ({
  id: `seg-${timestamp}`,
  source: "system",
  speakerName,
  text,
  timestamp,
});

// Note 95's real measured text either side of its 105.4s gap at seq 1695.
const NOTE_95_BEFORE = [
  segment("Jorge", "I have to drop out, I'm going to have lunch", 8300),
  segment("Regina", "Thank you. Good one.", 8340),
];

const NOTE_95_AFTER = [
  segment("Fabian", "You already three minutes late.", 8446),
  segment("Fabian", "that's perfectly fine. That's on time.", 8452),
  segment("Molly", "Fill me in what's happening with life.", 8460),
];

test("note 95's real 105s boundary splits, scoring every language signal", async () => {
  const { scoreCallBoundary } = await load();

  const result = scoreCallBoundary({
    before: NOTE_95_BEFORE,
    after: NOTE_95_AFTER,
    gapSeconds: 105.4,
  });

  assert.equal(result.boundary, true);
  assert.equal(result.score, 6);
  assert.deepEqual(result.reasons, ["farewell-cue", "opening-cue", "speaker-turnover"]);
});

test("the same windows at a 31s gap still split: the language carries it, not the silence", async () => {
  const { scoreCallBoundary } = await load();

  const result = scoreCallBoundary({
    before: NOTE_95_BEFORE,
    after: NOTE_95_AFTER,
    gapSeconds: 31,
  });

  assert.equal(result.boundary, true);
  assert.equal(result.score, 6);
});

test("a 200s silence with the same speakers and no cues is not a boundary", async () => {
  const { scoreCallBoundary } = await load();

  const result = scoreCallBoundary({
    before: [
      segment("Jorge", "so the migration runs nightly", 100),
      segment("Regina", "and we watch the queue depth", 140),
    ],
    after: [
      segment("Jorge", "the queue depth was flat all week", 345),
      segment("Regina", "we should still alert on it", 380),
    ],
    gapSeconds: 200,
  });

  assert.equal(result.boundary, false);
  assert.equal(result.score, 1);
  assert.deepEqual(result.reasons, ["long-gap"]);
});

test("a farewell cue alone does not split", async () => {
  const { scoreCallBoundary } = await load();

  const result = scoreCallBoundary({
    before: [segment("Jorge", "ok I have to run", 100), segment("Regina", "sure", 110)],
    after: [segment("Jorge", "back to the queue depth then", 150), segment("Regina", "right", 160)],
    gapSeconds: 40,
  });

  assert.equal(result.boundary, false);
  assert.equal(result.score, 2);
  assert.deepEqual(result.reasons, ["farewell-cue"]);
});

test("farewell plus opening splits even with no speaker turnover and a short gap", async () => {
  const { scoreCallBoundary } = await load();

  const result = scoreCallBoundary({
    before: [segment("Jorge", "that's all I had", 100), segment("Regina", "great", 110)],
    after: [segment("Jorge", "can you hear me?", 150), segment("Regina", "yes", 160)],
    gapSeconds: 45,
  });

  assert.equal(result.boundary, true);
  assert.equal(result.score, 4);
  assert.deepEqual(result.reasons, ["farewell-cue", "opening-cue"]);
});

test("speaker turnover plus an opening cue splits with no farewell", async () => {
  const { scoreCallBoundary } = await load();

  const result = scoreCallBoundary({
    before: [segment("Jorge", "the queue depth was flat", 100), segment("Regina", "agreed", 110)],
    after: [segment("Fabian", "thanks for joining", 150), segment("Molly", "no problem", 160)],
    gapSeconds: 45,
  });

  assert.equal(result.boundary, true);
  assert.equal(result.score, 4);
  assert.deepEqual(result.reasons, ["opening-cue", "speaker-turnover"]);
});

test("an empty before window never throws and never splits", async () => {
  const { scoreCallBoundary } = await load();

  const result = scoreCallBoundary({
    before: [],
    after: NOTE_95_AFTER,
    gapSeconds: 300,
  });

  // An empty side carries no language to judge, so the surviving signals must not
  // be allowed to reach the threshold on their own: here they otherwise would (3).
  assert.equal(result.boundary, false);
  assert.equal(result.score, 3);
  assert.deepEqual(result.reasons, ["opening-cue", "long-gap"]);
});

test("an empty after window never throws and never splits", async () => {
  const { scoreCallBoundary } = await load();

  const result = scoreCallBoundary({
    before: NOTE_95_BEFORE,
    after: [],
    gapSeconds: 300,
  });

  assert.equal(result.boundary, false);
  assert.equal(result.score, 3);
  assert.deepEqual(result.reasons, ["farewell-cue", "long-gap"]);
});

test("a farewell in the middle of the before window, not its last 3 segments, does not split", async () => {
  const { scoreCallBoundary } = await load();

  const before = [
    segment("Jorge", "first a quick recap", 10),
    segment("Regina", "ok I have to drop in a minute but go on", 20),
    segment("Jorge", "the migration runs nightly", 30),
    segment("Regina", "and we watch the queue depth", 40),
    segment("Jorge", "which was flat all week", 50),
    segment("Regina", "so we leave the alert as it is", 60),
  ];

  const result = scoreCallBoundary({
    before,
    after: [
      segment("Jorge", "one more thing about the alert", 110),
      segment("Regina", "go ahead", 120),
    ],
    gapSeconds: 45,
  });

  assert.equal(result.boundary, false);
  assert.equal(result.score, 0);
  assert.deepEqual(result.reasons, []);
});

test("punctuation and case do not hide a cue: Bye! and BYE. both match", async () => {
  const { scoreCallBoundary } = await load();

  for (const farewell of ["Bye!", "BYE."]) {
    const result = scoreCallBoundary({
      before: [segment("Jorge", farewell, 100)],
      after: [segment("Jorge", "back to the queue depth", 150)],
      gapSeconds: 45,
    });

    assert.deepEqual(result.reasons, ["farewell-cue"], farewell);
  }
});

test("an apostrophe cue still matches once punctuation is stripped from both sides", async () => {
  const { scoreCallBoundary } = await load();

  const result = scoreCallBoundary({
    before: [segment("Jorge", "I'll let you go", 100)],
    after: [segment("Jorge", "back to the queue depth", 150)],
    gapSeconds: 45,
  });

  assert.deepEqual(result.reasons, ["farewell-cue"]);
});

test("missing text and speaker names are tolerated", async () => {
  const { scoreCallBoundary } = await load();

  const result = scoreCallBoundary({
    before: [{ text: null, speakerName: null, timestamp: 100 }, { timestamp: 110 }],
    after: [{ text: undefined, speakerName: "   ", timestamp: 150 }],
    gapSeconds: 45,
  });

  assert.equal(result.boundary, false);
  assert.deepEqual(result.reasons, []);
});

test("the 120s window is exported as a named constant for the caller to slice by", async () => {
  const { BOUNDARY_WINDOW_SECONDS } = await load();

  assert.equal(BOUNDARY_WINDOW_SECONDS, 120);
});
