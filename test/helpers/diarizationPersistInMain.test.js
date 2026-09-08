const test = require("node:test");
const assert = require("node:assert/strict");

const IPCHandlers = require("../../src/helpers/ipcHandlers");
const { requireSqlite } = require("../support/sqlite");
const {
  mergeTranscriptSegments,
  parseTranscriptSegments,
  serializeTranscriptSegments,
} = require("../../src/helpers/transcriptSpeakerState");

// Diarization runs in main, succeeds, and used to be saved only by a React callback in
// the renderer. That callback is skipped whenever the window is gone, the note has been
// switched, or the session id has already been cleared, so the result was lost. These
// tests pin the write to the main process, where none of that applies.

const EPOCH = 1757000000000;

function storedTranscript(segments) {
  return serializeTranscriptSegments(segments);
}

// The embedding write goes through a real better-sqlite3 BLOB bind. A hand-rolled fake
// accepts a plain number Array; the real driver binds it as a parameter spread and
// throws. That difference is how a broken embedding write once passed this suite.
function createEmbeddingStore() {
  const Database = requireSqlite();
  const db = new Database(":memory:");
  db.exec(
    "CREATE TABLE note_speaker_embeddings (note_id INTEGER, speaker_id TEXT, embedding BLOB)"
  );
  const stmt = db.prepare(
    "INSERT INTO note_speaker_embeddings (note_id, speaker_id, embedding) VALUES (?, ?, ?)"
  );
  return {
    save(noteId, embeddings) {
      for (const [speakerId, blob] of Object.entries(embeddings)) {
        stmt.run(noteId, speakerId, blob);
      }
    },
    rows: () => db.prepare("SELECT * FROM note_speaker_embeddings").all(),
  };
}

function createHandlers({ diarizeImpl, available = true, note } = {}) {
  const writes = [];
  const broadcasts = [];
  const sent = [];
  const autoLabelled = [];
  const embeddingStore = createEmbeddingStore();

  const handlers = Object.create(IPCHandlers.prototype);
  Object.assign(handlers, {
    speakerDiarizationEnabled: true,
    _noteFilesEnabled: false,
    diarizationManager: {
      isAvailable: () => available,
      convertRawPcmToWav: async () => "/tmp/ow-test-diar.wav",
      diarize: diarizeImpl || (async () => [{ speaker: "spk0", start: 0, end: 2 }]),
      capSpeakerClusters: (segments) => segments,
      mergeWithTranscript: (segments) =>
        segments.map((s) => ({ ...s, speaker: s.source === "mic" ? "you" : "speaker_0" })),
    },
    databaseManager: {
      getSpeakerProfiles: () => [],
      getNote: () => note ?? null,
      updateNote: (id, updates) => {
        writes.push({ id, updates });
        return { success: true, note: { id, ...updates } };
      },
      saveNoteSpeakerEmbeddings: (id, embeddings) => embeddingStore.save(id, embeddings),
    },
    _tryAutoLabelOneOnOne: (id) => autoLabelled.push(id),
    broadcastToWindows: (channel, payload) => broadcasts.push({ channel, payload }),
    _asyncVectorUpsert: () => {},
    _asyncMirrorWrite: () => {},
    _resolveSpeakerExpectation: () => ({ numSpeakers: 0, cap: null }),
    _enqueuePostCallPipeline: () => {},
  });

  const destroyedWin = {
    isDestroyed: () => true,
    webContents: {
      send: () => {
        throw new Error("must not reach a destroyed window");
      },
    },
  };
  const liveWin = {
    isDestroyed: () => false,
    webContents: { send: (_channel, payload) => sent.push(payload) },
  };

  return { handlers, writes, embeddingStore, autoLabelled, broadcasts, sent, destroyedWin, liveWin };
}

const SEGMENTS = [
  { id: "s1", text: "hello there", source: "system", timestamp: 0 },
  { id: "s2", text: "hi back", source: "mic", timestamp: 1 },
];

function run(handlers, win, noteId, segments = SEGMENTS) {
  return handlers._startOrSkipDiarization(
    "session-1",
    "/tmp/ow-test-raw.pcm",
    0,
    segments,
    win,
    null,
    null,
    noteId
  );
}

// --- Gate 2: the move itself -------------------------------------------------------

test("persists the diarized transcript even when the renderer window is destroyed", async () => {
  const { handlers, writes, destroyedWin } = createHandlers();

  await run(handlers, destroyedWin, 42);

  const write = writes.find((w) => w.updates?.transcript != null);
  assert.ok(write, "main must write the transcript when the renderer cannot be reached");
  assert.equal(write.id, 42);

  const stored = JSON.parse(write.updates.transcript);
  assert.ok(
    stored.some((s) => s.speaker === "speaker_0"),
    "the stored transcript must carry the diarized speaker"
  );
  assert.ok(
    stored.some((s) => s.source === "mic" && s.speaker === "you"),
    "mic segments must be attributed to the user"
  );
});

test("broadcasts note-updated so the renderer store cannot serve a stale transcript", async () => {
  const { handlers, broadcasts, destroyedWin } = createHandlers();

  await run(handlers, destroyedWin, 42);
  await new Promise((resolve) => setImmediate(resolve));

  const updated = broadcasts.find((b) => b.channel === "note-updated");
  assert.ok(updated, "a main-process note write must broadcast note-updated");
  assert.ok(
    JSON.parse(updated.payload.transcript).some((s) => s.speaker === "speaker_0"),
    "the broadcast must carry the diarized transcript, not the pre-diarization one"
  );
});

test("merges against the stored transcript rather than replacing it", async () => {
  const note = {
    id: 42,
    transcript: storedTranscript([
      {
        text: "hello there",
        source: "system",
        timestamp: EPOCH,
        speakerName: "Fabian",
        speakerLocked: true,
        speakerLockSource: "user",
      },
      { text: "hi back", source: "mic", timestamp: EPOCH + 1000 },
    ]),
  };
  const { handlers, writes, destroyedWin } = createHandlers({ note });

  await run(handlers, destroyedWin, 42);

  const stored = JSON.parse(writes.at(-1).updates.transcript);
  assert.equal(stored.length, 2, "no segment may be added or lost by the merge");
  const named = stored.find((s) => s.source === "system");
  assert.equal(named.speakerName, "Fabian", "a user-locked name must survive diarization");
  assert.equal(named.speaker, "speaker_0", "but the cluster is still refined by diarization");
});

test("sends the renderer the merged segments, not the un-merged diarized ones", async () => {
  const note = {
    id: 42,
    transcript: storedTranscript([
      {
        text: "hello there",
        source: "system",
        timestamp: EPOCH,
        speakerName: "Fabian",
        speakerLocked: true,
        speakerLockSource: "user",
      },
      { text: "hi back", source: "mic", timestamp: EPOCH + 1000 },
    ]),
  };
  const { handlers, sent, liveWin } = createHandlers({ note });

  await run(handlers, liveWin, 42);

  assert.equal(sent.length, 1);
  const named = sent[0].segments.find((s) => s.source === "system");
  assert.equal(
    named.speakerName,
    "Fabian",
    "the renderer must receive the merged form; the un-merged one would be written back over the stored transcript on the next speaker edit"
  );
});

test("does not write when there is no note to write to", async () => {
  const { handlers, writes, destroyedWin } = createHandlers();

  await run(handlers, destroyedWin, null);

  assert.deepEqual(writes, []);
});

test("writes speaker embeddings in a shape the real database accepts", async () => {
  const { handlers, embeddingStore } = createHandlers();

  // The centroid shape main actually produces: Array.from(Float32Array).
  handlers._persistSpeakerEmbeddings(42, { speaker_0: [0.1, 0.2, 0.3, 0.4] });

  const rows = embeddingStore.rows();
  assert.equal(rows.length, 1, "the centroid must reach the database");
  assert.ok(Buffer.isBuffer(rows[0].embedding), "it must be stored as a BLOB");
  assert.equal(rows[0].embedding.length, 16, "four float32s");
});

test("the persist path itself writes the embeddings it was handed", async () => {
  const { handlers, embeddingStore } = createHandlers();

  handlers._persistDiarizedTranscript(
    42,
    [{ id: "a", text: "hello there", source: "system", timestamp: 0, speaker: "speaker_0" }],
    { speaker_0: [0.1, 0.2, 0.3, 0.4] }
  );

  assert.equal(
    embeddingStore.rows().length,
    1,
    "dropping the embedding write from the persist path must fail here"
  );
});

test("auto-labels a 1:1 after writing embeddings, as the IPC handler did", async () => {
  const { handlers, autoLabelled } = createHandlers();

  handlers._persistSpeakerEmbeddings(42, { speaker_0: [0.1, 0.2, 0.3, 0.4] });

  assert.deepEqual(autoLabelled, [42]);
});

test("skips the embedding write when diarization produced no embeddings", async () => {
  const { handlers, embeddingStore, autoLabelled, destroyedWin } = createHandlers();

  await run(handlers, destroyedWin, 42);

  assert.deepEqual(embeddingStore.rows(), [], "an empty embedding map must not be written");
  assert.deepEqual(autoLabelled, [], "and must not trigger auto-labelling");
});

test("a failed embedding write does not discard the merged transcript", async () => {
  const { handlers, destroyedWin } = createHandlers();
  handlers.databaseManager.saveNoteSpeakerEmbeddings = () => {
    throw new Error("blob rejected");
  };

  const merged = handlers._persistDiarizedTranscript(
    42,
    [{ id: "a", text: "hello there", source: "system", timestamp: 0, speaker: "speaker_0" }],
    { speaker_0: [0.1, 0.2] }
  );

  assert.equal(merged[0].speaker, "speaker_0", "the transcript result must survive");
});

// --- The other two exits: the renderer's writers live inside a conditionally-mounted
// view, so if main does not write here the transcript can go unwritten entirely.

test("persists the transcript when diarization is unavailable", async () => {
  const { handlers, writes, destroyedWin } = createHandlers({ available: false });

  await run(handlers, destroyedWin, 42);

  const write = writes.find((w) => w.updates?.transcript != null);
  assert.ok(write, "the skip path must still persist the transcript");
  assert.equal(JSON.parse(write.updates.transcript).length, 2);
});

test("persists the transcript when diarization throws", async () => {
  const { handlers, writes, destroyedWin } = createHandlers({
    diarizeImpl: async () => {
      throw new Error("diarization exploded");
    },
  });

  await run(handlers, destroyedWin, 42);

  const write = writes.find((w) => w.updates?.transcript != null);
  assert.ok(write, "a diarization failure must not cost the note its transcript");
  assert.equal(JSON.parse(write.updates.transcript).length, 2);
});

// Guard on the new error handling only -- this one is green at HEAD by construction.
test("persists before enqueueing the pipeline on the failure path", async () => {
  const order = [];
  const { handlers, destroyedWin } = createHandlers({
    diarizeImpl: async () => {
      throw new Error("diarization exploded");
    },
  });
  const realUpdate = handlers.databaseManager.updateNote;
  handlers.databaseManager.updateNote = (id, updates) => {
    if (updates?.transcript != null) order.push("persist");
    return realUpdate(id, updates);
  };
  handlers._enqueuePostCallPipeline = () => order.push("enqueue");

  await run(handlers, destroyedWin, 42);

  assert.deepEqual(
    order,
    ["persist", "enqueue"],
    "the queue runs inline when idle and the pipeline reads the transcript first, so a later persist would be read past"
  );
});

// Guard on the new error handling only -- this one is green at HEAD by construction.
test("a persist failure does not take down diarization", async () => {
  const { handlers, sent, liveWin } = createHandlers();
  handlers.databaseManager.updateNote = () => {
    throw new Error("disk full");
  };

  await run(handlers, liveWin, 42);

  assert.equal(sent.length, 1, "the renderer is still told diarization finished");
  assert.ok(sent[0].segments.length > 0);
});

// --- Gate 1: the shared module, which main now depends on ---------------------------

test("shared module: stored epoch-ms segments merge with incoming relative-second ones", () => {
  const existing = parseTranscriptSegments(
    storedTranscript([
      { text: "hello there", source: "system", timestamp: EPOCH },
      { text: "hi back", source: "mic", timestamp: EPOCH + 1000 },
    ])
  );
  const incoming = [
    { id: "diarized-0", text: "hello there", source: "system", timestamp: 0, speaker: "speaker_0" },
    { id: "diarized-1", text: "hi back", source: "mic", timestamp: 1, speaker: "you" },
  ];

  const merged = mergeTranscriptSegments(existing, incoming);

  assert.equal(merged.length, existing.length, "nothing appended, nothing dropped");
  // Every mic segment that survived dedupe carries the user's attribution.
  for (const segment of merged.filter((s) => s.source === "mic")) {
    assert.equal(segment.speaker, "you");
  }
  const systemSpeakers = merged.filter((s) => s.source === "system").map((s) => s.speaker);
  assert.deepEqual(systemSpeakers, ["speaker_0"]);
});

test("shared module: parse reports failures through the caller's logger, not a global", () => {
  const seen = [];
  const result = parseTranscriptSegments("[not json", (message) => seen.push(message));

  assert.deepEqual(result, []);
  assert.equal(seen.length, 1, "main must be able to observe a parse failure");
});
