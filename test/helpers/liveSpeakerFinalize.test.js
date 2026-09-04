const test = require("node:test");
const assert = require("node:assert/strict");

const speakerEmbeddings = require("../../src/helpers/speakerEmbeddings");
const { LiveSpeakerIdentifier } = require("../../src/helpers/liveSpeakerIdentifier");

// The provisional speaker is decided on the first 1.6 s of a segment and, until
// this change, was binding for the whole turn: `_finalizeSpeechSegment` computed
// the best embedding in the system — the whole segment, best window — and then
// short-circuited on the 1.6 s guess. Measured, 79% of same-speaker pairs score
// below MATCH_THRESHOLD at 1.6 s against 2% at 3 s, which is why one 94-minute
// two-person call minted 176 clusters.
//
// The correction has to be a MERGE, not a second identification:
// applyConfirmedSpeaker in ipcHandlers only stamps a transcript segment when
// `(!seg.speaker || seg.speakerIsPlaceholder)`, and the provisional
// identification already called applyConfirmedSpeaker.

const DIM = 8;

// Cosine similarity is what the identifier compares, so the fixtures are built
// as unit vectors at chosen angles rather than as fake similarity numbers —
// _updateCentroid averages them, and a fake would not survive that.
function vec(...values) {
  const v = new Float32Array(DIM);
  values.forEach((value, i) => (v[i] = value));
  const norm = Math.hypot(...v);
  for (let i = 0; i < DIM; i += 1) v[i] /= norm;
  return v;
}

const ALICE = vec(1, 0);
// ~0.71 against ALICE: a real match, well above MATCH_THRESHOLD (0.65) but
// below CONFIDENT_MATCH_THRESHOLD (0.8), which is where a short window lands.
const ALICE_SHORT_WINDOW = vec(1, 1);
const BOB = vec(0, 0, 1);
const CAROL = vec(0, 0, 0, 1);
const NOISE = vec(0, 0, 0, 0, 1);

function identifier() {
  const live = new LiveSpeakerIdentifier();
  live.enabled = true;
  live.getSpeakerProfiles = () => [];
  return live;
}

function seedCluster(live, id, embedding) {
  live.transientEmbeddings.set(id, embedding);
  live.transientCounts.set(id, 5);
  live.nextLiveIndex = Math.max(live.nextLiveIndex, Number(id.split("_")[1]) + 1);
}

async function finalizeWith(live, fullSegmentEmbedding) {
  live.speechActive = true;
  live.speechChunks = [new Float32Array(16000 * 4)];
  live.segmentStartSample = 0;
  live.segmentEndSample = 16000 * 4;
  const original = speakerEmbeddings.extractEmbeddingFromSamples;
  speakerEmbeddings.extractEmbeddingFromSamples = async () => fullSegmentEmbedding;
  try {
    await live._finalizeSpeechSegment();
  } finally {
    speakerEmbeddings.extractEmbeddingFromSamples = original;
  }
}

test("the full-segment embedding overrules a cluster this segment minted", async () => {
  const live = identifier();
  seedCluster(live, "speaker_0", ALICE);

  // The 1.6 s window scored badly against speaker_0 and minted speaker_1.
  const provisional = live._assignSpeakerId(ALICE_SHORT_WINDOW);
  live.currentSegmentSpeakerId = provisional;
  assert.equal(provisional, "speaker_1");

  // The provisional centroid is a window of THIS segment, so it scores higher
  // against the full-segment embedding than the real speaker does. Without
  // excluding ids minted this segment, the guess vouches for itself and the
  // correction never fires.
  assert.ok(
    speakerEmbeddings.cosineSimilarity(ALICE_SHORT_WINDOW, ALICE_SHORT_WINDOW) >
      speakerEmbeddings.cosineSimilarity(ALICE, ALICE_SHORT_WINDOW)
  );

  await finalizeWith(live, ALICE_SHORT_WINDOW);

  const merges = live._drainPendingMerges();
  assert.deepEqual(
    merges.map(({ keep, remove }) => ({ keep, remove })),
    [{ keep: "speaker_0", remove: "speaker_1" }]
  );
  assert.equal(live.transientEmbeddings.has("speaker_1"), false);

  // The surviving cluster must also LEARN from the full-segment embedding —
  // that is the best evidence the pipeline ever produces. Without it every
  // correction still merges, but the winner never improves, so later segments
  // match it worse and the over-splitting quietly returns.
  assert.equal(live.transientCounts.get("speaker_0"), 7, "5 seeded + 1 merged + 1 learned");
  assert.ok(
    speakerEmbeddings.cosineSimilarity(live.transientEmbeddings.get("speaker_0"), ALICE) <
      speakerEmbeddings.cosineSimilarity(ALICE, ALICE),
    "the centroid moved away from the seed"
  );
  assert.ok(
    speakerEmbeddings.cosineSimilarity(
      live.transientEmbeddings.get("speaker_0"),
      ALICE_SHORT_WINDOW
    ) > speakerEmbeddings.cosineSimilarity(ALICE, ALICE_SHORT_WINDOW),
    "the centroid moved toward the segment it just absorbed"
  );
});

test("an established provisional speaker is left alone", async () => {
  // Mutation check for the minted-this-segment guard: without it, a segment
  // whose provisional id is a real existing cluster would merge two people.
  const live = identifier();
  seedCluster(live, "speaker_0", ALICE);
  seedCluster(live, "speaker_1", BOB);
  live.currentSegmentSpeakerId = "speaker_1";

  await finalizeWith(live, ALICE);

  assert.deepEqual(live._drainPendingMerges(), []);
  assert.equal(live.transientEmbeddings.has("speaker_1"), true);
});

test("a genuinely new speaker keeps its cluster and no second one is minted", async () => {
  // Mutation check for the double-mint hazard: excluding minted ids makes
  // _findTransientMatch return nothing, and falling through to
  // _assignOrForceCluster would create a SECOND cluster for one segment.
  const live = identifier();
  seedCluster(live, "speaker_0", ALICE);

  const provisional = live._assignSpeakerId(BOB);
  live.currentSegmentSpeakerId = provisional;

  await finalizeWith(live, BOB);

  assert.deepEqual(live._drainPendingMerges(), []);
  assert.equal(live.nextLiveIndex, 2, "no second cluster minted for one segment");
  assert.equal(live.transientEmbeddings.has(provisional), true);
});

test("a provisional whose own window was unlike the segment still keeps one cluster", async () => {
  // The sharper version of the double-mint check. Above, the provisional
  // centroid IS the full-segment embedding, so nothing could mint a second
  // cluster whatever the code did. Here the 1.6 s window was noise and matches
  // neither the segment nor any older speaker, which is the only shape that
  // actually reaches _assignOrForceCluster a second time.
  const live = identifier();
  seedCluster(live, "speaker_0", ALICE);

  const provisional = live._assignSpeakerId(NOISE);
  live.currentSegmentSpeakerId = provisional;
  assert.ok(speakerEmbeddings.cosineSimilarity(NOISE, CAROL) < 0.65);
  assert.ok(speakerEmbeddings.cosineSimilarity(ALICE, CAROL) < 0.65);

  await finalizeWith(live, CAROL);

  assert.deepEqual(live._drainPendingMerges(), []);
  assert.equal(live.nextLiveIndex, 2, "one segment must never produce two clusters");
  assert.equal(live.transientEmbeddings.has(provisional), true);
});

test("a provisional carrying a stored profile is not merged into a different identity", async () => {
  // Mutation check for the identity guard. Both existing callers of
  // _mergeTransientSpeakers (_performRecluster and _assignOrForceCluster) check
  // _hasConflictingIdentity first; the function itself does not.
  const live = identifier();
  seedCluster(live, "speaker_0", ALICE);
  live.transientProfileIds.set("speaker_0", 1);

  const provisional = live._assignSpeakerId(ALICE_SHORT_WINDOW);
  live.currentSegmentSpeakerId = provisional;
  live.transientProfileIds.set(provisional, 2);

  await finalizeWith(live, ALICE_SHORT_WINDOW);

  assert.deepEqual(live._drainPendingMerges(), []);
  assert.equal(live.transientEmbeddings.has(provisional), true);
});

test("merges made during stop() reach the caller instead of being reset away", async () => {
  // stopLiveSpeakerIdentification reclusters and only then calls stop(). stop()
  // finalizes the in-flight segment — where this correction is recorded — and
  // _resetMeetingState then emptied pendingMerges. Every meeting's last segment
  // lost its correction.
  const live = identifier();
  live.running = true;
  live.session = {};
  seedCluster(live, "speaker_0", ALICE);

  const provisional = live._assignSpeakerId(ALICE_SHORT_WINDOW);
  live.currentSegmentSpeakerId = provisional;
  live.speechActive = true;
  live.speechChunks = [new Float32Array(16000 * 4)];
  live.segmentEndSample = 16000 * 4;

  const original = speakerEmbeddings.extractEmbeddingFromSamples;
  speakerEmbeddings.extractEmbeddingFromSamples = async () => ALICE_SHORT_WINDOW;
  try {
    await live.stop();
  } finally {
    speakerEmbeddings.extractEmbeddingFromSamples = original;
  }

  assert.deepEqual(
    live.takeFinalMerges().map(({ keep, remove }) => ({ keep, remove })),
    [{ keep: "speaker_0", remove: "speaker_1" }]
  );
  assert.deepEqual(live.takeFinalMerges(), [], "draining twice must not repeat them");
});
