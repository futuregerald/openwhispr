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

function runPipeline() {
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
      getNote: () => ({ id: 37, transcript: serializeTranscriptSegments(fixture.segments) }),
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
      fixture.segments,
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

test("the bleed-flagged segments are speech the fix keeps rather than echo it drops", async () => {
  const stored = await runPipeline();

  const flagged = fixture.segments.filter((seg) => seg.likelyRenderBleed);
  assert.equal(flagged.length, 108, "the fixture must keep the shape it was captured from");

  const echoed = stored.filter((seg) => seg.dedupedAsEcho);
  assert.ok(
    echoed.length <= 3,
    `a correct window leaves at most a couple of true echoes, got ${echoed.length}`
  );
});
