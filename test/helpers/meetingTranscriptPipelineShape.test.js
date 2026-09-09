const test = require("node:test");
const assert = require("node:assert/strict");

const IPCHandlers = require("../../src/helpers/ipcHandlers");
const DiarizationManager = require("../../src/helpers/diarization.js");
const { serializeTranscriptSegments } = require("../../src/helpers/transcriptSpeakerState");
const fixture = require("../fixtures/meetingTranscriptShape.json");

// A real 81-minute meeting, redacted to pseudo-tokens that keep the mic/system text
// overlaps intact. Shipped, this transcript finished with 108 of its 589 mic segments
// carrying no speaker and a raw epoch-ms timestamp — an un-owned line is what the
// note-writing LLM hands to the wrong person.

const EPOCH_MS_FLOOR = 1e9;

function runPipeline(segments = fixture.segments) {
  const writes = [];

  const handlers = Object.create(IPCHandlers.prototype);
  Object.assign(handlers, {
    speakerDiarizationEnabled: true,
    _noteFilesEnabled: false,
    diarizationManager: {
      isAvailable: () => true,
      convertRawPcmToWav: async () => "/tmp/ow-test-shape.wav",
      diarize: async () => fixture.diarizationSegments,
      capSpeakerClusters: (segments) => segments,
      // The real merge, not a stand-in: dedupe lives inside it and is the defect.
      mergeWithTranscript: DiarizationManager.prototype.mergeWithTranscript,
    },
    databaseManager: {
      // What the renderer already stored while the meeting was live: epoch-ms stamps,
      // no speakers. This is the set the diarized result merges onto.
      getNote: () => ({ id: 37, transcript: serializeTranscriptSegments(segments) }),
      updateNote: (id, updates) => {
        writes.push({ id, updates });
        return { success: true, note: { id, ...updates } };
      },
    },
    broadcastToWindows: () => {},
    _asyncVectorUpsert: () => {},
    _asyncMirrorWrite: () => {},
    _persistSpeakerEmbeddings: () => true,
    _resolveSpeakerExpectation: () => ({ numSpeakers: 0, cap: null }),
    _enqueuePostCallPipeline: () => {},
  });

  const win = { isDestroyed: () => true, webContents: { send: () => {} } };

  return handlers
    ._startOrSkipDiarization(
      "session-shape",
      "/tmp/ow-test-shape.pcm",
      fixture.audioStartedAt,
      segments,
      win,
      null,
      null,
      37
    )
    .then(() => JSON.parse(writes.at(-1).updates.transcript));
}

test("no mic segment in a real meeting shape ends without a speaker", async () => {
  const stored = await runPipeline();

  const orphans = stored.filter((seg) => seg.source === "mic" && !seg.speaker);
  assert.equal(
    orphans.length,
    0,
    `${orphans.length} mic segments finished un-attributed, e.g. ${JSON.stringify(orphans.slice(0, 3))}`
  );
});

test("no segment in a real meeting shape keeps an epoch-ms timestamp", async () => {
  const stored = await runPipeline();

  const unnormalized = stored.filter((seg) => (seg.timestamp ?? 0) > EPOCH_MS_FLOOR);
  assert.equal(
    unnormalized.length,
    0,
    `${unnormalized.length} segments kept epoch ms in a relative-seconds transcript`
  );
});

test("the merge neither loses nor duplicates a segment of a real meeting shape", async () => {
  const stored = await runPipeline();

  assert.equal(stored.length, fixture.segments.length);
});

// A planted echo: the same distinctive text on the mic and on system audio 2 seconds
// apart, carrying the bleed evidence the real 108 carry. It is the only true echo in the
// meeting, so a correct window flags exactly one segment — which pins the count from
// both sides. `<= 3` did not: the real value is 0, so it also held when the window was
// zeroed, when the flag was never written, and when the marking was removed outright.
const PLANTED_ECHO_TEXT = "wz900 wz901 wz902 wz903";
const PLANTED_MIC_AT = fixture.audioStartedAt + 4890000;
const PLANTED_SYSTEM_AT = fixture.audioStartedAt + 4892000;

const SEGMENTS_WITH_PLANTED_ECHO = [
  ...fixture.segments,
  {
    text: PLANTED_ECHO_TEXT,
    source: "mic",
    timestamp: PLANTED_MIC_AT,
    likelyRenderBleed: true,
  },
  { text: PLANTED_ECHO_TEXT, source: "system", timestamp: PLANTED_SYSTEM_AT },
];

test("the bleed-flagged segments are speech the fix keeps rather than echo it drops", async () => {
  const stored = await runPipeline(SEGMENTS_WITH_PLANTED_ECHO);

  const flagged = fixture.segments.filter((seg) => seg.likelyRenderBleed);
  assert.equal(flagged.length, 108, "the fixture must keep the shape it was captured from");

  const echoed = stored.filter((seg) => seg.dedupedAsEcho);
  assert.deepEqual(
    echoed.map((seg) => seg.text),
    [PLANTED_ECHO_TEXT],
    `the planted echo and nothing else may be flagged, got ${echoed.length} flagged`
  );

  const plantedMic = stored.find((seg) => seg.source === "mic" && seg.text === PLANTED_ECHO_TEXT);
  assert.ok(plantedMic, "echo is marked, not dropped — dropping is what loses the user's speech");
  assert.equal(plantedMic.speaker, "you");
  assert.equal(plantedMic.timestamp, (PLANTED_MIC_AT - fixture.audioStartedAt) / 1000);

  const survivingBleed = stored.filter(
    (seg) => seg.source === "mic" && flagged.some((f) => f.text === seg.text)
  );
  assert.ok(
    survivingBleed.length >= flagged.length,
    `all ${flagged.length} bleed-flagged segments must survive, ${survivingBleed.length} did`
  );
  assert.equal(
    survivingBleed.filter((seg) => seg.speaker !== "you").length,
    0,
    "surviving bleed-flagged speech is the user's own"
  );
});
