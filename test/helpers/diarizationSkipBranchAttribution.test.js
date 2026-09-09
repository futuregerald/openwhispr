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

// Main's live segments cannot carry lock fields: `storeMeetingDiarizationSegment`
// builds them from text/source/timestamp/committedAt and the three suppression flags
// only. In production the lock exists solely in the STORED transcript, so that is the
// only shape worth asserting against.
test("the skip branch keeps the lock the user set in the stored transcript", () => {
  const note = {
    id: 42,
    transcript: serializeTranscriptSegments([
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

  run([{ text: "hi back", source: "mic", timestamp: EPOCH + 4000 }]);

  const stored = JSON.parse(writes.at(-1).updates.transcript);
  assert.equal(stored.length, 1, "the locked segment must be matched, not duplicated");
  assert.equal(stored[0].speakerName, "Fabian", "the name the user set survives the merge");
  assert.equal(stored[0].speakerLocked, true);
  assert.equal(stored[0].speakerLockSource, "user");
  assert.equal(stored[0].speakerStatus, "locked");
  // `mergeSpeakerFields` exempts `speaker` from lock preservation on purpose, so one
  // locked label cannot freeze a bucket diarization splits. The cluster id is therefore
  // NOT preserved here — mic attribution replaces it. Only the name and lock are.
  assert.equal(stored[0].speaker, "you");
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

// Re-recording into an existing note. The stored transcript then holds a prior
// session's segments on the relative-seconds clock alongside this session's live
// epoch-ms ones. Normalising only the incoming side leaves the two sides on different
// clocks, so `source|timestamp|text` can never match and every segment falls through
// to the raw-text fallback, which ignores time entirely: a new "Yeah." lands on the
// PRIOR session's "Yeah." and overwrites its timestamp.
test("re-recording does not land this session's segment on a prior session's duplicate text", () => {
  const note = {
    id: 42,
    transcript: serializeTranscriptSegments([
      { text: "Yeah.", source: "mic", timestamp: 12, speaker: "you" },
      { text: "hello there", source: "system", timestamp: EPOCH },
      { text: "Yeah.", source: "mic", timestamp: EPOCH + 4000 },
    ]),
  };
  const { writes, run } = createHandlers({ note });

  run([
    { text: "hello there", source: "system", timestamp: EPOCH },
    { text: "Yeah.", source: "mic", timestamp: EPOCH + 4000 },
  ]);

  const stored = JSON.parse(writes.at(-1).updates.transcript);
  assert.equal(stored.length, 3, "the merge must neither drop nor duplicate a segment");
  assert.equal(
    stored.filter((seg) => seg.source === "mic" && seg.timestamp === 12).length,
    1,
    "the prior session's stamp must survive this session's identical text"
  );
  const fresh = stored.filter((seg) => seg.source === "mic" && seg.timestamp === 4);
  assert.equal(fresh.length, 1, "this session's mic segment must be the one that moved");
  assert.equal(fresh[0].speaker, "you");
  assert.equal(
    stored.filter((seg) => (seg.timestamp ?? 0) > 1e9).length,
    0,
    "no epoch-ms stamp may survive in a relative-seconds transcript"
  );
});
