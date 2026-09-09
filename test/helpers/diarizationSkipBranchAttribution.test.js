const test = require("node:test");
const assert = require("node:assert/strict");

const IPCHandlers = require("../../src/helpers/ipcHandlers");
const { serializeTranscriptSegments } = require("../../src/helpers/transcriptSpeakerState");

// When diarization is off, unavailable, or there is no raw PCM to feed it,
// `_startOrSkipDiarization` used to persist the live segments untouched: epoch-ms
// timestamps in a transcript whose other halves are relative seconds, and no owner on
// any mic line. An un-owned mic line is what the note-writing LLM attributes to
// somebody else.

const EPOCH = 1757000000000;

function createHandlers({ note = null, sessionConfig = { enabled: false } } = {}) {
  const writes = [];
  const sent = [];

  const handlers = Object.create(IPCHandlers.prototype);
  Object.assign(handlers, {
    speakerDiarizationEnabled: true,
    _noteFilesEnabled: false,
    diarizationManager: { isAvailable: () => false },
    databaseManager: {
      getNote: () => note,
      updateNote: (id, updates) => {
        writes.push({ id, updates });
        return { success: true, note: { id, ...updates } };
      },
    },
    broadcastToWindows: () => {},
    _asyncVectorUpsert: () => {},
    _asyncMirrorWrite: () => {},
    _persistSpeakerEmbeddings: () => true,
    _enqueuePostCallPipeline: () => {},
  });

  const win = {
    isDestroyed: () => false,
    webContents: { send: (_channel, payload) => sent.push(payload) },
  };

  const run = (segments, audioStartedAt = EPOCH) =>
    handlers._startOrSkipDiarization(
      "session-1",
      null,
      audioStartedAt,
      segments,
      win,
      null,
      sessionConfig,
      42
    );

  return { handlers, writes, sent, run };
}

const LIVE_SEGMENTS = [
  { text: "hello there", source: "system", timestamp: EPOCH },
  { text: "hi back", source: "mic", timestamp: EPOCH + 4000 },
];

test("the diarization-skip branch attributes mic segments to the user", () => {
  const { writes, run } = createHandlers();

  run(LIVE_SEGMENTS);

  const stored = JSON.parse(writes.at(-1).updates.transcript);
  const mic = stored.find((seg) => seg.source === "mic");
  assert.equal(mic.speaker, "you", "mic is the user by definition, diarization or not");
});

test("the diarization-skip branch normalises epoch-ms stamps to relative seconds", () => {
  const { writes, run } = createHandlers();

  run(LIVE_SEGMENTS);

  const stored = JSON.parse(writes.at(-1).updates.transcript);
  assert.deepEqual(
    stored.map((seg) => seg.timestamp),
    [0, 4],
    "a transcript must not mix epoch ms with relative seconds"
  );
});

test("the skip branch leaves already-relative stamps alone", () => {
  const { writes, run } = createHandlers();

  run(
    [
      { text: "hello there", source: "system", timestamp: 0 },
      { text: "hi back", source: "mic", timestamp: 4 },
    ],
    0
  );

  const stored = JSON.parse(writes.at(-1).updates.transcript);
  assert.deepEqual(
    stored.map((seg) => seg.timestamp),
    [0, 4]
  );
});

test("the skip branch never overwrites a speaker the user locked", () => {
  const { writes, run } = createHandlers();

  run([
    {
      text: "hi back",
      source: "mic",
      timestamp: EPOCH,
      speaker: "speaker_1",
      speakerName: "Fabian",
      speakerLocked: true,
      speakerLockSource: "user",
    },
  ]);

  const stored = JSON.parse(writes.at(-1).updates.transcript);
  assert.equal(stored[0].speaker, "speaker_1");
  assert.equal(stored[0].speakerName, "Fabian");
});

test("the skip branch hands the renderer the same normalised segments it persisted", () => {
  const { sent, run } = createHandlers();

  run(LIVE_SEGMENTS);

  const mic = sent.at(-1).segments.find((seg) => seg.source === "mic");
  assert.equal(mic.speaker, "you");
  assert.equal(mic.timestamp, 4);
});

test("the skip branch merges onto the stored transcript rather than duplicating it", () => {
  const note = {
    id: 42,
    transcript: serializeTranscriptSegments([
      { text: "hello there", source: "system", timestamp: 0 },
      { text: "hi back", source: "mic", timestamp: 4 },
    ]),
  };
  const { writes, run } = createHandlers({ note });

  run(LIVE_SEGMENTS);

  const stored = JSON.parse(writes.at(-1).updates.transcript);
  assert.equal(stored.length, 2, "normalising must not make the incoming segments unmatchable");
  assert.equal(stored.find((seg) => seg.source === "mic").speaker, "you");
});
