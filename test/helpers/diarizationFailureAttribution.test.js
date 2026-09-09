const test = require("node:test");
const assert = require("node:assert/strict");

const IPCHandlers = require("../../src/helpers/ipcHandlers");

// The third exit from `_startOrSkipDiarization`. `diarize()` throwing is not
// hypothetical — an ONNX `bad_alloc` in the utility process kills the run — and the
// catch persists whatever the renderer had: epoch-ms stamps in a relative-seconds
// transcript, and no owner on any mic line. That is the same defect the skip and
// diarize branches were fixed for.

const EPOCH = 1757000000000;

function createHandlers({ note = null } = {}) {
  const writes = [];

  const handlers = Object.create(IPCHandlers.prototype);
  Object.assign(handlers, {
    speakerDiarizationEnabled: true,
    _noteFilesEnabled: false,
    diarizationManager: {
      isAvailable: () => true,
      convertRawPcmToWav: async () => "/tmp/ow-test-diar-fail.wav",
      diarize: async () => {
        throw new Error("std::bad_alloc");
      },
      capSpeakerClusters: (segments) => segments,
      mergeWithTranscript: (segments) => segments,
    },
    databaseManager: {
      getNote: () => note,
      getSpeakerProfiles: () => [],
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

  const win = { isDestroyed: () => false, webContents: { send: () => {} } };

  const run = (segments, audioStartedAt = EPOCH) =>
    handlers._startOrSkipDiarization(
      "session-fail",
      "/tmp/ow-test-fail.pcm",
      audioStartedAt,
      segments,
      win,
      null,
      null,
      42
    );

  return { writes, run };
}

const LIVE_SEGMENTS = [
  { text: "hello there", source: "system", timestamp: EPOCH },
  { text: "hi back", source: "mic", timestamp: EPOCH + 4000 },
];

test("a note whose diarization throws still has its mic segments attributed", async () => {
  const { writes, run } = createHandlers();

  await run(LIVE_SEGMENTS);

  const stored = JSON.parse(writes.at(-1).updates.transcript);
  const mic = stored.find((seg) => seg.source === "mic");
  assert.equal(mic.speaker, "you", "mic is the user by definition, diarization or not");
});

test("a note whose diarization throws still has its stamps normalised", async () => {
  const { writes, run } = createHandlers();

  await run(LIVE_SEGMENTS);

  const stored = JSON.parse(writes.at(-1).updates.transcript);
  assert.deepEqual(
    stored.map((seg) => seg.timestamp),
    [0, 4],
    "a transcript must not mix epoch ms with relative seconds"
  );
});

test("the failure branch never overwrites a speaker the user locked", async () => {
  const note = {
    id: 42,
    transcript: JSON.stringify([
      {
        text: "hi back",
        source: "mic",
        timestamp: 4,
        speaker: "speaker_1",
        speakerName: "Fabian",
        speakerLocked: true,
        speakerLockSource: "user",
      },
    ]),
  };
  const { writes, run } = createHandlers({ note });

  await run([{ text: "hi back", source: "mic", timestamp: EPOCH + 4000 }]);

  const stored = JSON.parse(writes.at(-1).updates.transcript);
  assert.equal(stored.length, 1, "the locked segment must be matched, not duplicated");
  assert.equal(stored[0].speakerName, "Fabian", "the name the user set survives the merge");
  assert.equal(stored[0].speakerLocked, true);
  assert.equal(stored[0].speakerLockSource, "user");
  assert.equal(stored[0].speakerStatus, "locked");
  // `mergeSpeakerFields` exempts `speaker` from lock preservation on purpose, so one
  // locked label cannot freeze a bucket diarization splits. The cluster id is therefore
  // NOT preserved — mic attribution replaces it. Only the name and lock are.
  assert.equal(stored[0].speaker, "you");
});
