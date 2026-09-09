const test = require("node:test");
const assert = require("node:assert/strict");

const IPCHandlers = require("../../src/helpers/ipcHandlers");

// mergeWithTranscript aligns a system segment with `seg.startedAt ?? seg.timestamp`.
// Diarization segments are in seconds from the start of the audio, so a `startedAt` left
// in epoch milliseconds puts every system segment ~1.7e12 seconds past the end of the
// recording and every speaker lands on the wrong words. Nothing else in the suite fails
// when the conversion is removed, which is how it survives a merge.

function createHandlers() {
  const seen = [];
  const handlers = Object.create(IPCHandlers.prototype);
  Object.assign(handlers, {
    speakerDiarizationEnabled: true,
    _noteFilesEnabled: false,
    diarizationManager: {
      isAvailable: () => true,
      convertRawPcmToWav: async () => "/tmp/ow-startedat.wav",
      diarize: async () => [{ speaker: "spk0", start: 0, end: 2 }],
      capSpeakerClusters: (segments) => segments,
      mergeWithTranscript: (segments) => {
        seen.push(...segments.map((segment) => ({ ...segment })));
        return segments.map((segment) => ({ ...segment, speaker: "speaker_0" }));
      },
    },
    databaseManager: {
      getSpeakerProfiles: () => [],
      getNote: () => null,
      updateNote: () => ({ success: true, note: {} }),
      updateNoteTranscriptKeepingUpdatedAt: () => ({ success: true }),
      saveNoteSpeakerEmbeddings: () => {},
    },
    broadcastToWindows: () => {},
    _asyncVectorUpsert: () => {},
    _asyncMirrorWrite: () => {},
    _resolveSpeakerExpectation: () => ({ numSpeakers: 0, cap: null }),
    _enqueuePostCallPipeline: () => {},
  });
  const win = { isDestroyed: () => true, webContents: { send: () => {} } };
  return { handlers, seen, win };
}

const AUDIO_STARTED_AT = 1757000000000;

test("startedAt is converted to relative seconds alongside timestamp", async () => {
  const { handlers, seen, win } = createHandlers();

  await handlers._startOrSkipDiarization(
    "session-1",
    "/tmp/ow-startedat.pcm",
    AUDIO_STARTED_AT,
    [
      {
        id: "s1",
        text: "hello there",
        source: "system",
        timestamp: AUDIO_STARTED_AT + 4000,
        startedAt: AUDIO_STARTED_AT + 3000,
      },
    ],
    win,
    null,
    null,
    42
  );

  const system = seen.find((segment) => segment.source === "system");
  assert.ok(system, "the system segment must reach mergeWithTranscript");
  assert.equal(system.timestamp, 4, "timestamp is seconds from the start of the audio");
  assert.equal(
    system.startedAt,
    3,
    "startedAt must be converted too -- mergeWithTranscript aligns on it first"
  );
});

test("a startedAt already in relative seconds is left alone", async () => {
  const { handlers, seen, win } = createHandlers();

  await handlers._startOrSkipDiarization(
    "session-2",
    "/tmp/ow-startedat.pcm",
    AUDIO_STARTED_AT,
    [
      {
        id: "s1",
        text: "hello there",
        source: "system",
        timestamp: AUDIO_STARTED_AT + 4000,
        startedAt: 3,
      },
    ],
    win,
    null,
    null,
    42
  );

  const system = seen.find((segment) => segment.source === "system");
  assert.equal(system.startedAt, 3, "an already-relative value must not be converted twice");
});

test("a segment with no startedAt does not gain a bogus one", async () => {
  const { handlers, seen, win } = createHandlers();

  await handlers._startOrSkipDiarization(
    "session-3",
    "/tmp/ow-startedat.pcm",
    AUDIO_STARTED_AT,
    [{ id: "s1", text: "hello there", source: "system", timestamp: AUDIO_STARTED_AT + 4000 }],
    win,
    null,
    null,
    42
  );

  const system = seen.find((segment) => segment.source === "system");
  assert.equal(system.startedAt, undefined);
});
