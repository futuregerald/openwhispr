const test = require("node:test");
const assert = require("node:assert/strict");

const IPCHandlers = require("../../src/helpers/ipcHandlers");

const NOTE_ID = 42;
const vec = (values) => Buffer.from(Float32Array.from(values).buffer);

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

// Each diarized cluster's voice is fixed by where its segments start, so the
// extractor returns that cluster's vector for every segment it is asked about.
function createHandlers({ diarization, voiceAt, profiles, mappings = [] }) {
  const mappingWrites = [];
  const upserts = [];
  const persisted = [];

  const handlers = Object.create(IPCHandlers.prototype);
  Object.assign(handlers, {
    speakerDiarizationEnabled: true,
    diarizationManager: {
      isAvailable: () => true,
      convertRawPcmToWav: async () => "/tmp/ow-autoname-test.wav",
      diarize: async () => diarization,
      capSpeakerClusters: (segments) => segments,
      mergeWithTranscript: (_transcript, diar) => {
        const renumber = new Map();
        for (const d of diar) {
          if (!renumber.has(d.speaker)) renumber.set(d.speaker, `speaker_${renumber.size}`);
        }
        return diar.map((d, i) => ({
          id: `seg-${i}`,
          text: `words ${i}`,
          source: "system",
          timestamp: d.start,
          speaker: renumber.get(d.speaker),
        }));
      },
    },
    speakerEmbeddings: {
      isAvailable: () => true,
      extractEmbedding: async (_wav, start) => Float32Array.from(voiceAt(start)),
      computeCentroid: (embeddings) => embeddings[0],
      cosineSimilarity: cosine,
    },
    databaseManager: {
      getSpeakerProfiles: () => profiles,
      getSpeakerMappings: () => mappings,
      setSpeakerMapping: (...args) => mappingWrites.push(args),
      upsertSpeakerProfile: (...args) => upserts.push(args),
    },
    _resolveSpeakerExpectation: () => ({ maxSpeakers: null }),
    _persistDiarizedTranscript: (noteId, segments, embeddings, _startedAt, speech) => {
      persisted.push({ noteId, segments, embeddings, speech });
      return segments;
    },
    _enqueuePostCallPipeline: () => {},
  });

  return { handlers, mappingWrites, upserts, persisted };
}

function run(handlers) {
  return handlers._startOrSkipDiarization(
    "session-1",
    "/tmp/ow-autoname-test.pcm",
    0,
    [{ id: "t1", text: "hi", source: "system", timestamp: 0 }],
    null,
    null,
    null,
    NOTE_ID
  );
}

const PRIYA = [1, 0, 0];
const OMAR = [0, 1, 0];
const STRANGER = [0, 0, 1];

const profile = (id, name, embedding, totalSpeechS = 60) => ({
  id,
  display_name: name,
  embedding: vec(embedding),
  total_speech_s: totalSpeechS,
  sample_count: 3,
});

// raw_a speaks 0-10 and 12-20 (18 s); raw_b speaks 30-40 (10 s).
const TWO_SPEAKERS = [
  { speaker: "raw_a", start: 0, end: 10 },
  { speaker: "raw_b", start: 30, end: 40 },
  { speaker: "raw_a", start: 12, end: 20 },
];

const segmentsOf = (persisted, speaker) =>
  persisted[0].segments.filter((s) => s.speaker === speaker);

test("a confirmed post-call auto-name writes an auto mapping row carrying its score", async () => {
  const { handlers, mappingWrites, upserts, persisted } = createHandlers({
    diarization: TWO_SPEAKERS,
    voiceAt: (start) => (start < 30 ? [0.98, 0.2, 0] : STRANGER),
    profiles: [profile(1, "Priya", PRIYA), profile(2, "Omar", OMAR)],
  });

  await run(handlers);

  assert.equal(mappingWrites.length, 1, `mapping writes: ${JSON.stringify(mappingWrites)}`);
  const [noteId, speakerId, profileId, displayName, provenance] = mappingWrites[0];
  assert.equal(noteId, NOTE_ID);
  assert.equal(speakerId, "speaker_0");
  assert.equal(profileId, 1);
  assert.equal(displayName, "Priya");
  assert.equal(provenance.origin, "auto");
  assert.ok(
    Math.abs(provenance.confidence - cosine([0.98, 0.2, 0], PRIYA)) < 1e-6,
    `confidence was ${provenance.confidence}`
  );
  assert.ok(segmentsOf(persisted, "speaker_0").every((s) => s.speakerName === "Priya"));
  assert.ok(segmentsOf(persisted, "speaker_1").every((s) => !s.speakerName));
  assert.equal(upserts.length, 0, "auto-naming must not add a voiceprint sample");
});

test("a profile with too little enrolled speech only suggests its name", async () => {
  const { handlers, mappingWrites, persisted } = createHandlers({
    diarization: TWO_SPEAKERS,
    voiceAt: (start) => (start < 30 ? PRIYA : STRANGER),
    profiles: [profile(1, "Priya", PRIYA, 10)],
  });

  await run(handlers);

  assert.equal(mappingWrites.length, 0);
  const segs = segmentsOf(persisted, "speaker_0");
  assert.ok(segs.every((s) => !s.speakerName));
  assert.ok(segs.every((s) => s.suggestedName === "Priya" && s.suggestedProfileId === 1));
});

test("a cluster with too little speech is suggested, not named", async () => {
  const { handlers, mappingWrites, persisted } = createHandlers({
    diarization: [
      { speaker: "raw_a", start: 0, end: 5 },
      { speaker: "raw_b", start: 30, end: 40 },
    ],
    voiceAt: (start) => (start < 30 ? PRIYA : STRANGER),
    profiles: [profile(1, "Priya", PRIYA)],
  });

  await run(handlers);

  assert.equal(mappingWrites.length, 0);
  assert.ok(segmentsOf(persisted, "speaker_0").every((s) => s.suggestedName === "Priya"));
});

test("two clusters that both sound like one person: only one is named", async () => {
  const { handlers, mappingWrites, persisted } = createHandlers({
    diarization: TWO_SPEAKERS,
    voiceAt: (start) => (start < 30 ? [0.95, 0.31, 0] : [0.99, 0, 0.14]),
    profiles: [
      profile(1, "Priya", PRIYA),
      profile(
        2,
        "Omar",
        STRANGER.map((v) => -v)
      ),
    ],
  });

  await run(handlers);

  assert.equal(mappingWrites.length, 1);
  assert.equal(mappingWrites[0][1], "speaker_1", "the closer cluster is the one named");
  assert.ok(segmentsOf(persisted, "speaker_0").every((s) => !s.speakerName));
  assert.ok(segmentsOf(persisted, "speaker_0").every((s) => s.suggestedName === "Priya"));
});

test("a speaker that already has a mapping row in the note is left alone", async () => {
  const { handlers, mappingWrites } = createHandlers({
    diarization: TWO_SPEAKERS,
    voiceAt: (start) => (start < 30 ? PRIYA : STRANGER),
    profiles: [profile(1, "Priya", PRIYA)],
    mappings: [
      { speaker_id: "speaker_0", profile_id: null, display_name: "Dana", origin: "manual" },
    ],
  });

  await run(handlers);

  assert.equal(mappingWrites.length, 0, "an existing mapping was overwritten");
});

test("a profile already mapped in the note is not given to a second speaker", async () => {
  const { handlers, mappingWrites } = createHandlers({
    diarization: TWO_SPEAKERS,
    voiceAt: (start) => (start < 30 ? PRIYA : STRANGER),
    profiles: [profile(1, "Priya", PRIYA)],
    mappings: [{ speaker_id: "speaker_7", profile_id: 1, display_name: "Priya", origin: "manual" }],
  });

  await run(handlers);

  assert.equal(mappingWrites.length, 0, "Priya was named twice in one note");
});

test("without a note id the auto-name still labels segments but writes no mapping", async () => {
  const { handlers, mappingWrites, persisted } = createHandlers({
    diarization: TWO_SPEAKERS,
    voiceAt: (start) => (start < 30 ? PRIYA : STRANGER),
    profiles: [profile(1, "Priya", PRIYA)],
  });

  await handlers._startOrSkipDiarization(
    "session-1",
    "/tmp/ow-autoname-test.pcm",
    0,
    [{ id: "t1", text: "hi", source: "system", timestamp: 0 }],
    null,
    null,
    null,
    null
  );

  assert.equal(mappingWrites.length, 0);
  assert.ok(segmentsOf(persisted, "speaker_0").every((s) => s.speakerName === "Priya"));
});
