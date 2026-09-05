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

// The reproduction PR #44's own review found, as an assertion.
//
// segmentMintedSpeakerIds records which ids were CREATED during this segment.
// _resolveFinalSegmentSpeaker reads it as "which clusters hold no evidence from
// before this segment" — a different question, and _mergeTransientSpeakers is
// the operation that separates the two. A recluster tick landing mid-segment can
// leave a minted id in the set after it has absorbed an established cluster's
// entire history; finalize then overrules a real speaker and hands their name to
// someone else.
//
// The route is not exotic. _performRecluster breaks a tie on hasName before
// count, so a count-1 minted cluster wins only by carrying a display name the
// established one lacks — which is what the stored-profile branch of
// _resolveSpeakerForEmbedding gives it. The app arms that branch itself: a
// 1-on-1 calendar meeting writes a speaker profile carrying the attendee's email
// (bindOneOnOneAttendeeToSpeaker in ipcHandlers), and getLiveSpeakerProfiles
// then returns it for every later meeting with that person.
test("a cluster that absorbed an established speaker is no longer this segment's guess", async () => {
  const live = identifier();
  seedCluster(live, "speaker_0", ALICE);
  seedCluster(live, "speaker_1", BOB);

  // The 1.6 s window matched Bob's stored profile, so a fresh cluster is minted
  // carrying Bob's name — the one thing that lets it win the tie-break.
  const provisional = live._assignSpeakerId(BOB);
  live.transientDisplayNames.set(provisional, "Bob");
  live.transientProfileIds.set(provisional, 42);
  live.currentSegmentSpeakerId = provisional;
  live.currentSegmentSpeakerName = "Bob";

  // The 30 s recluster timer fires while the segment is still open. Mean segment
  // length is 5.0 s against a 30 s interval, so roughly one segment in six is.
  live._performRecluster();
  assert.equal(live.transientCounts.get(provisional), 6, "the minted cluster absorbed Bob");
  assert.equal(live.transientEmbeddings.has("speaker_1"), false);

  // The full-segment embedding drifted toward Alice: 0.71, above MATCH_THRESHOLD
  // and below CONFIDENT_MATCH_THRESHOLD.
  await finalizeWith(live, ALICE_SHORT_WINDOW);

  assert.deepEqual(
    [...live.transientEmbeddings.keys()].sort(),
    ["speaker_0", provisional].sort(),
    "Alice and Bob are two people and must stay two clusters"
  );
  assert.equal(
    live.transientDisplayNames.get("speaker_0"),
    undefined,
    "Alice's cluster must not inherit Bob's name"
  );
  assert.equal(live.transientDisplayNames.get(provisional), "Bob");
  assert.equal(live.transientProfileIds.get(provisional), 42);
  assert.deepEqual(live._drainPendingMerges(), [], "finalize must not merge two real speakers");
});

// The guard the fix must not weaken: when both clusters in a merge were minted
// during this segment, the survivor is still a guess and finalize must stay free
// to overrule it.
test("a merge between two clusters minted this segment leaves the survivor overrulable", () => {
  const live = identifier();
  const first = live._assignSpeakerId(ALICE);
  const second = live._assignSpeakerId(ALICE_SHORT_WINDOW);

  live._mergeTransientSpeakers(first, second, 0.71);

  assert.equal(
    live.segmentMintedSpeakerIds.has(first),
    true,
    "nothing older was absorbed, so the survivor still holds no pre-segment evidence"
  );
  assert.equal(live.segmentMintedSpeakerIds.has(second), false, "the removed id is gone");
});

// A merge that no-ops because one side is already gone must not touch the set.
// _performRecluster's inner loop can revisit an id, and this is what pins the
// three new lines to their side of the null guard.
test("a merge that cannot proceed leaves the minted set untouched", () => {
  const live = identifier();
  const minted = live._assignSpeakerId(ALICE);

  assert.equal(live._mergeTransientSpeakers(minted, "speaker_gone", 0.9), null);
  assert.equal(live.segmentMintedSpeakerIds.has(minted), true);
});

// extractEmbeddingFromSamples rejects when the ONNX utility process crashes
// (speakerEmbeddings.js), so stop()'s finalize can throw. It used to have no
// try/catch, which meant one failed embedding cost the caller everything: the
// transient state, the final merges, and the reset that the NEXT meeting needs.
// stopLiveSpeakerIdentification's .catch(() => null) in ipcHandlers swallowed
// it, so the loss was silent, and startLiveSpeakerIdentification awaits that
// stop uncaught -- so the throw could also abort the next meeting's startup.
test("stop() still returns the meeting's speakers when the last embedding fails", async () => {
  const live = identifier();
  seedCluster(live, "speaker_0", ALICE);
  seedCluster(live, "speaker_1", BOB);

  const provisional = live._assignSpeakerId(ALICE_SHORT_WINDOW);
  live.currentSegmentSpeakerId = provisional;
  live.speechActive = true;
  live.speechChunks = [new Float32Array(16000 * 4)];
  live.segmentEndSample = 16000 * 4;

  const original = speakerEmbeddings.extractEmbeddingFromSamples;
  speakerEmbeddings.extractEmbeddingFromSamples = async () => {
    throw new Error("onnx worker exited");
  };
  let state;
  try {
    state = await live.stop();
  } finally {
    speakerEmbeddings.extractEmbeddingFromSamples = original;
  }

  assert.ok(
    ["speaker_0", "speaker_1"].every((id) => id in state),
    "the speakers identified before the crash must survive it"
  );
  assert.equal(live.speechActive, false, "the identifier is reset for the next meeting");
  assert.equal(live.currentSegmentSpeakerId, null);
  assert.equal(live.transientEmbeddings.size, 0);
});

// I6: finalize used plain nearest-neighbour, which cannot fire in the regime
// this change exists for. When one person holds several duplicate clusters, the
// top two candidates are both duplicates of that person -- within MATCH_MARGIN
// of each other and below CONFIDENT_MATCH_THRESHOLD -- so acceptsMatch returns
// false and no correction fires at all. This is a plausible mechanical reason
// notes 22 and 23 stayed at 8 and 12 clusters for one real person.
test("a segment matching two duplicate clusters of one person merges them", async () => {
  const live = identifier();
  // The band that matters, and it is narrow: both clusters score 0.707 and 0.735
  // against the segment -- above MATCH_THRESHOLD 0.65, below
  // CONFIDENT_MATCH_THRESHOLD 0.8 -- and 0.028 apart, inside MATCH_MARGIN 0.03.
  // That combination is exactly what makes acceptsMatch refuse. Their centroids
  // are 0.988 to each other, so they are two copies of one voice.
  seedCluster(live, "speaker_0", vec(1, 1, 0));
  seedCluster(live, "speaker_1", vec(1, 0.9, 0.2));

  const provisional = live._assignSpeakerId(ALICE);
  live.currentSegmentSpeakerId = provisional;

  await finalizeWith(live, ALICE);

  const survivors = [...live.transientEmbeddings.keys()];
  assert.equal(survivors.length, 1, `one person, one cluster; got ${survivors.join(", ")}`);
  assert.ok(
    ["speaker_0", "speaker_1"].includes(survivors[0]),
    "the survivor must be an established cluster, not this segment's guess"
  );
});

// The other half of the same branch: two candidates that are near-tied against
// the segment but genuinely UNLIKE each other are two different people. Merging
// them is the failure mode of the fix above, so it must not happen.
test("two near-tied candidates that are unlike each other are left as two people", async () => {
  const live = identifier();
  // Both ~0.707 to the segment embedding, but orthogonal to each other.
  seedCluster(live, "speaker_0", ALICE);
  seedCluster(live, "speaker_1", BOB);

  const provisional = live._assignSpeakerId(vec(1, 0, 1));
  live.currentSegmentSpeakerId = provisional;

  await finalizeWith(live, vec(1, 0, 1));

  assert.ok(
    live.transientEmbeddings.has("speaker_0") && live.transientEmbeddings.has("speaker_1"),
    "two unlike clusters are two people and must both survive"
  );
});

// The duplicate-merge branch has to stay subordinate to identity. Two clusters
// can look like copies of one voice and still be two people who have been named
// -- a stored profile or a display name is stronger evidence than any cosine
// score, which is the rule _performRecluster and _assignOrForceCluster already
// follow.
test("two near-tied clusters carrying different names are not merged by finalize", async () => {
  const live = identifier();
  seedCluster(live, "speaker_0", vec(1, 1, 0));
  seedCluster(live, "speaker_1", vec(1, 0.9, 0.2));
  live.transientDisplayNames.set("speaker_0", "Alice");
  live.transientDisplayNames.set("speaker_1", "Bob");

  const provisional = live._assignSpeakerId(ALICE);
  live.currentSegmentSpeakerId = provisional;

  await finalizeWith(live, ALICE);

  assert.ok(
    live.transientEmbeddings.has("speaker_0") && live.transientEmbeddings.has("speaker_1"),
    "two named people must survive a cosine score that says they are one"
  );
  assert.equal(live.transientDisplayNames.get("speaker_0"), "Alice");
  assert.equal(live.transientDisplayNames.get("speaker_1"), "Bob");
});

// The floor is what stops the duplicate-merge branch running on clusters that
// have nothing to do with the speaker. Without it, a segment resembling NEITHER
// candidate would still merge them, purely because they resemble each other.
test("clusters that do not match the segment are not merged on each other's account", async () => {
  const live = identifier();
  // 0.447 and 0.477 against the segment: both well below MATCH_THRESHOLD, but
  // 0.981 to each other, so the duplicate test alone would fire.
  seedCluster(live, "speaker_0", vec(0.5, 1, 0));
  seedCluster(live, "speaker_1", vec(0.5, 0.9, 0.2));

  const provisional = live._assignSpeakerId(ALICE);
  live.currentSegmentSpeakerId = provisional;

  await finalizeWith(live, ALICE);

  assert.equal(
    live.transientEmbeddings.size,
    3,
    "a segment that matches neither candidate is no reason to merge them"
  );
});

// M5. Both lifecycle clears of segmentMintedSpeakerIds are removable with the
// suite green, because _finalizeSpeechSegment's clear covers the happy path.
// They are load-bearing on its two EARLY RETURNS -- a segment below
// MIN_SEGMENT_SAMPLES, and an embedding that comes back null -- neither of
// which reaches that clear. A stale id surviving into the next segment is what
// C1 is about, so these are not decorative.
test("a segment too short to identify does not leak its minted ids into the next one", async () => {
  const live = identifier();
  const stale = live._assignSpeakerId(ALICE);

  live.speechActive = true;
  live.speechChunks = [new Float32Array(16000)]; // 1.0 s, below MIN_SEGMENT_SECONDS 1.5
  live.segmentStartSample = 0;
  live.segmentEndSample = 16000;
  await live._finalizeSpeechSegment();

  assert.equal(live.segmentMintedSpeakerIds.has(stale), true, "finalize returned early");

  // The next window that opens a segment is what must clear it.
  live._getVadProbability = async () => 0.9;
  await live._processWindow(new Float32Array(512), 16000, 16512);

  assert.equal(live.speechActive, true);
  assert.deepEqual([...live.segmentMintedSpeakerIds], [], "a new segment starts with no guesses");
});

test("starting a meeting clears any minted ids left by the one before", () => {
  const live = identifier();
  live._assignSpeakerId(ALICE);
  assert.equal(live.segmentMintedSpeakerIds.size, 1);

  live._resetMeetingState();

  assert.deepEqual([...live.segmentMintedSpeakerIds], []);
});

// M6. Nothing pinned SPEECH_THRESHOLD or SILENCE_THRESHOLD, and nothing
// exercised _processWindow at all -- putting 0.5 back to 0.15 left the whole
// suite green, on the riskiest change in this branch. These assert the
// segmentation behaviour rather than the literals, so they survive a rename and
// still fail on a value change.
test("a window at 0.4 does not open a segment, and 0.5 does", async () => {
  const live = identifier();
  let probability = 0.4;
  live._getVadProbability = async () => probability;

  await live._processWindow(new Float32Array(512), 0, 512);
  assert.equal(live.speechActive, false, "0.4 is below Silero's own 0.5 default");

  probability = 0.5;
  await live._processWindow(new Float32Array(512), 512, 1024);
  assert.equal(live.speechActive, true);
  assert.equal(live.segmentStartSample, 512, "the segment starts at the window that opened it");
});

test("an open segment is held by 0.4, and a held window clears the hangover", async () => {
  const live = identifier();
  let probability = 0.9;
  live._getVadProbability = async () => probability;
  await live._processWindow(new Float32Array(512), 0, 512);
  assert.equal(live.speechActive, true);

  // The hangover has to be NON-ZERO before the reset can be observed. Asserting
  // it is 0 straight after the segment opened would pass whether or not the
  // reset exists -- deleting it leaves the whole suite green, which is how this
  // test was wrong the first time.
  probability = 0.34;
  await live._processWindow(new Float32Array(512), 512, 1024);
  assert.equal(live.silenceWindows, 1, "0.34 is silence and starts the hangover");
  assert.equal(live.speechActive, true, "one silent window does not end the segment");

  // 0.4 is below SPEECH_THRESHOLD but at or above SILENCE_THRESHOLD: Silero's
  // neg_threshold is deliberately lower than its onset, so a turn is not chopped
  // in half by a quiet stretch. Without the reset the counter would keep
  // climbing across a whole turn and chop it at the 24th quiet window wherever
  // they fell.
  probability = 0.4;
  await live._processWindow(new Float32Array(512), 1024, 1536);
  assert.equal(live.speechActive, true, "0.4 must not end an open segment");
  assert.equal(live.silenceWindows, 0, "a held window clears the hangover");
});

test("the hangover ends a segment only after SILENCE_WINDOWS_TO_END silent windows", async () => {
  const live = identifier();
  let probability = 0.9;
  live._getVadProbability = async () => probability;
  await live._processWindow(new Float32Array(512), 0, 512);

  // Below MIN_SEGMENT_SAMPLES, so _finalizeSpeechSegment returns early without
  // touching the embedding model -- the segmentation is what is under test.
  probability = 0.1;
  for (let window = 0; window < 23; window += 1) {
    await live._processWindow(new Float32Array(512), 512 + window * 512, 1024 + window * 512);
  }
  assert.equal(live.speechActive, true, "23 silent windows is not yet the end");
  assert.equal(live.silenceWindows, 23);

  await live._processWindow(new Float32Array(512), 512 + 23 * 512, 1024 + 23 * 512);
  assert.equal(live.speechActive, false, "the 24th ends it");
});

// M7. Nothing set onSpeakerIdentified, so nothing asserted the user-visible
// outcome: that the identification emitted AFTER a correction carries the
// merged-into id and that speaker's name. A correction that never reaches the
// renderer relabels nothing.
test("the identification emitted after a correction carries the corrected speaker", async () => {
  const live = identifier();
  seedCluster(live, "speaker_0", ALICE);
  live.transientDisplayNames.set("speaker_0", "Alice");

  const provisional = live._assignSpeakerId(ALICE_SHORT_WINDOW);
  live.currentSegmentSpeakerId = provisional;

  const emitted = [];
  live.onSpeakerIdentified = (identification) => emitted.push(identification);

  await finalizeWith(live, ALICE);

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].speakerId, "speaker_0", "not the 1.6 s guess it replaced");
  assert.equal(emitted[0].displayName, "Alice");
});

// The runner-up is floored as well as the best match. Without it the duplicate
// branch merges into a cluster the segment matched at 0.64 while the function
// nominally enforces MATCH_THRESHOLD of 0.65 -- and this correction overrules a
// label already stamped on the transcript, so it should not be the looser of the
// two paths.
test("a runner-up below MATCH_THRESHOLD does not trigger a duplicate merge", async () => {
  const live = identifier();
  // 0.66 and 0.64 against the segment: 0.02 apart, so acceptsMatch refuses, and
  // 0.9997 to each other, so the duplicate test alone would fire.
  seedCluster(live, "speaker_0", vec(0.66, 0.7513, 0));
  seedCluster(live, "speaker_1", vec(0.64, 0.7684, 0));

  const provisional = live._assignSpeakerId(ALICE);
  live.currentSegmentSpeakerId = provisional;

  await finalizeWith(live, ALICE);

  assert.equal(
    live.transientEmbeddings.size,
    3,
    "only one candidate cleared the floor, so there is no duplicate pair to merge"
  );
});

// Unreachable from all three call sites today. It is guarded because the damage
// is silent and total: set(keepId) followed by delete(removeId) on one id erases
// the cluster, and the minted bookkeeping flips with it.
test("a cluster cannot be merged into itself", () => {
  const live = identifier();
  seedCluster(live, "speaker_0", ALICE);

  assert.equal(live._mergeTransientSpeakers("speaker_0", "speaker_0", 1.0), null);
  assert.equal(live.transientEmbeddings.has("speaker_0"), true, "the cluster survives");
  assert.equal(live.transientCounts.get("speaker_0"), 5, "and its history is untouched");
});
