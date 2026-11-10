const test = require("node:test");
const assert = require("node:assert/strict");

const { assignClustersToProfiles } = require("../../src/helpers/speakerAssignment");
const thresholds = require("../../src/helpers/speakerThresholds");

// Scores are stated directly: each cluster and profile embedding is a lookup key
// into a table, so a test says the similarities it means.
function run({ clusters, profiles, scores, pairScores = {}, overrides = {} }) {
  const similarity = (a, b) => {
    const key = `${a.key}|${b.key}`;
    if (key in scores) return scores[key];
    if (key in pairScores) return pairScores[key];
    const reverse = `${b.key}|${a.key}`;
    if (reverse in pairScores) return pairScores[reverse];
    return 0;
  };
  return assignClustersToProfiles({
    clusters: clusters.map((c) => ({
      speakerId: c.id,
      embedding: { key: c.id },
      speechS: c.speechS ?? 60,
    })),
    profiles: profiles.map((p) => ({
      id: p.id,
      embedding: { key: p.id },
      totalSpeechS: p.totalSpeechS ?? 120,
    })),
    similarity,
    thresholds: { ...defaults(), ...overrides },
  });
}

function defaults() {
  return {
    confirm: thresholds.CONFIRM_THRESHOLD,
    suggest: thresholds.SUGGEST_THRESHOLD,
    margin: thresholds.MARGIN,
    minClusterSpeechS: thresholds.MIN_CLUSTER_SPEECH_S,
    minProfileSpeechS: thresholds.MIN_PROFILE_SPEECH_S,
  };
}

const ids = (list) => list.map((e) => [e.speakerId, e.profileId]);

test("the calibrated thresholds are the values T4 measured", () => {
  assert.equal(thresholds.CONFIRM_THRESHOLD, 0.7);
  assert.equal(thresholds.SUGGEST_THRESHOLD, 0.55);
  assert.equal(thresholds.MARGIN, 0.1);
  assert.equal(thresholds.MIN_CLUSTER_SPEECH_S, 6);
  assert.equal(thresholds.MIN_PROFILE_SPEECH_S, 20);
  assert.equal("AUTO_MERGE_CLUSTERS" in thresholds, false);
  assert.equal(thresholds.RETRANSCRIBE_MATCH_THRESHOLD, 0.6);
});

test("a clear match with enough speech on both sides is confirmed with its score", () => {
  const r = run({
    clusters: [{ id: "speaker_0" }],
    profiles: [{ id: 1 }, { id: 2 }],
    scores: { "speaker_0|1": 0.82, "speaker_0|2": 0.3 },
  });
  assert.deepEqual(r.confirmed, [{ speakerId: "speaker_0", profileId: 1, score: 0.82 }]);
  assert.deepEqual(r.suggested, []);
});

test("a runner-up profile within the margin blocks the confirm and leaves a suggestion", () => {
  const r = run({
    clusters: [{ id: "speaker_0" }],
    profiles: [{ id: 1 }, { id: 2 }],
    scores: { "speaker_0|1": 0.82, "speaker_0|2": 0.75 },
  });
  assert.deepEqual(r.confirmed, []);
  assert.deepEqual(r.suggested, [{ speakerId: "speaker_0", profileId: 1, score: 0.82 }]);
});

test("a runner-up just outside the margin does not block the confirm", () => {
  const r = run({
    clusters: [{ id: "speaker_0" }],
    profiles: [{ id: 1 }, { id: 2 }],
    scores: { "speaker_0|1": 0.8, "speaker_0|2": 0.7 },
    overrides: { margin: 0.1 - 1e-9 },
  });
  assert.deepEqual(ids(r.confirmed), [["speaker_0", 1]]);
});

test("a score below the confirm threshold only suggests", () => {
  const r = run({
    clusters: [{ id: "speaker_0" }],
    profiles: [{ id: 1 }],
    scores: { "speaker_0|1": 0.69 },
  });
  assert.deepEqual(r.confirmed, []);
  assert.deepEqual(ids(r.suggested), [["speaker_0", 1]]);
});

test("a score at the confirm threshold confirms", () => {
  const r = run({
    clusters: [{ id: "speaker_0" }],
    profiles: [{ id: 1 }],
    scores: { "speaker_0|1": 0.7 },
  });
  assert.deepEqual(ids(r.confirmed), [["speaker_0", 1]]);
});

test("a score below the suggest threshold yields nothing", () => {
  const r = run({
    clusters: [{ id: "speaker_0" }],
    profiles: [{ id: 1 }],
    scores: { "speaker_0|1": 0.54 },
  });
  assert.deepEqual(r.confirmed, []);
  assert.deepEqual(r.suggested, []);
});

test("a cluster with too little speech is never confirmed, only suggested", () => {
  const r = run({
    clusters: [{ id: "speaker_0", speechS: 5.9 }],
    profiles: [{ id: 1 }],
    scores: { "speaker_0|1": 0.95 },
  });
  assert.deepEqual(r.confirmed, []);
  assert.deepEqual(ids(r.suggested), [["speaker_0", 1]]);
});

test("a cluster with exactly the minimum speech can be confirmed", () => {
  const r = run({
    clusters: [{ id: "speaker_0", speechS: 6 }],
    profiles: [{ id: 1 }],
    scores: { "speaker_0|1": 0.95 },
  });
  assert.deepEqual(ids(r.confirmed), [["speaker_0", 1]]);
});

test("a profile with too little enrolled speech can only suggest", () => {
  const r = run({
    clusters: [{ id: "speaker_0" }],
    profiles: [{ id: 1, totalSpeechS: 19.9 }],
    scores: { "speaker_0|1": 0.95 },
  });
  assert.deepEqual(r.confirmed, []);
  assert.deepEqual(ids(r.suggested), [["speaker_0", 1]]);
});

test("a profile with exactly the minimum enrolled speech can confirm", () => {
  const r = run({
    clusters: [{ id: "speaker_0" }],
    profiles: [{ id: 1, totalSpeechS: 20 }],
    scores: { "speaker_0|1": 0.95 },
  });
  assert.deepEqual(ids(r.confirmed), [["speaker_0", 1]]);
});

test("two clusters that both pass for one profile: only the higher scorer is confirmed", () => {
  const r = run({
    clusters: [{ id: "speaker_0" }, { id: "speaker_1" }],
    profiles: [{ id: 1 }],
    scores: { "speaker_0|1": 0.78, "speaker_1|1": 0.9 },
    pairScores: { "speaker_0|speaker_1": 0.2 },
  });
  assert.deepEqual(ids(r.confirmed), [["speaker_1", 1]]);
  assert.deepEqual(ids(r.suggested), [["speaker_0", 1]]);
});

test("two clusters that pass for one profile and resemble each other: the dropped one is suggested", () => {
  const r = run({
    clusters: [{ id: "speaker_0" }, { id: "speaker_1" }],
    profiles: [{ id: 1 }],
    scores: { "speaker_0|1": 0.78, "speaker_1|1": 0.9 },
    pairScores: { "speaker_0|speaker_1": 0.72 },
  });
  assert.deepEqual(ids(r.confirmed), [["speaker_1", 1]]);
  assert.deepEqual(ids(r.suggested), [["speaker_0", 1]], "the dropped cluster is suggested");
  assert.equal("mergeCandidates" in r, false);
});

// Cluster order is A, B, C. A first-come assignment gives profile X to A (0.75)
// and leaves B, which scores 0.95 for X, with nothing; the best total gives X to B.
test("assignment is by score, not by cluster order (3x3)", () => {
  const r = run({
    clusters: [{ id: "A" }, { id: "B" }, { id: "C" }],
    profiles: [{ id: "X" }, { id: "Y" }, { id: "Z" }],
    scores: {
      "A|X": 0.75,
      "A|Y": 0.2,
      "A|Z": 0.1,
      "B|X": 0.95,
      "B|Y": 0.3,
      "B|Z": 0.2,
      "C|X": 0.1,
      "C|Y": 0.2,
      "C|Z": 0.88,
    },
  });
  assert.deepEqual(ids(r.confirmed).sort(), [
    ["B", "X"],
    ["C", "Z"],
  ]);
  assert.deepEqual(ids(r.suggested), [["A", "X"]]);
});

test("each profile is confirmed for at most one cluster and each cluster at most once", () => {
  const r = run({
    clusters: [{ id: "A" }, { id: "B" }, { id: "C" }],
    profiles: [{ id: "X" }, { id: "Y" }],
    scores: { "A|X": 0.9, "B|X": 0.85, "C|X": 0.8, "C|Y": 0.95 },
  });
  const profiles = r.confirmed.map((c) => c.profileId);
  const clusters = r.confirmed.map((c) => c.speakerId);
  assert.equal(new Set(profiles).size, profiles.length);
  assert.equal(new Set(clusters).size, clusters.length);
  assert.deepEqual(ids(r.confirmed).sort(), [
    ["A", "X"],
    ["C", "Y"],
  ]);
});

test("no profiles yields nothing", () => {
  const r = run({ clusters: [{ id: "speaker_0" }], profiles: [], scores: {} });
  assert.deepEqual(r, { confirmed: [], suggested: [] });
});

test("no clusters yields nothing", () => {
  const r = run({ clusters: [], profiles: [{ id: 1 }], scores: {} });
  assert.deepEqual(r, { confirmed: [], suggested: [] });
});

test("a non-finite score is ignored rather than winning", () => {
  const r = run({
    clusters: [{ id: "speaker_0" }],
    profiles: [{ id: 1 }, { id: 2 }],
    scores: { "speaker_0|1": NaN, "speaker_0|2": 0.8 },
  });
  assert.deepEqual(ids(r.confirmed), [["speaker_0", 2]]);
});

test("thresholds default to the calibrated constants", () => {
  const r = assignClustersToProfiles({
    clusters: [{ speakerId: "speaker_0", embedding: "c", speechS: 60 }],
    profiles: [{ id: 1, embedding: "p", totalSpeechS: 120 }],
    similarity: () => 0.69,
  });
  assert.deepEqual(r.confirmed, []);
  assert.equal(r.suggested.length, 1);
});
