const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { requireSqlite } = require("../support/sqlite.js");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-segment-index-"));
const originalLoad = Module._load;

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: {
        getPath: () => userDataDir,
        getAppPath: () => process.cwd(),
        isReady: () => false,
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

process.env.NODE_ENV = "test";

const DatabaseManager = require("../../src/helpers/database.js");
const {
  reshredNote,
  backfillTranscriptSegments,
} = require("../../src/helpers/transcriptSegmentIndex.js");

function createDb() {
  requireSqlite();
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-segment-index-"));
  return new DatabaseManager();
}

function seedNote(dbm, transcript, { originMs = null, title = "Note" } = {}) {
  const { note } = dbm.saveNote(title, "", "meeting");
  dbm.db
    .prepare("UPDATE notes SET transcript = ?, transcript_origin_ms = ? WHERE id = ?")
    .run(typeof transcript === "string" ? transcript : JSON.stringify(transcript), originMs, note.id);
  return note.id;
}

function segmentRows(dbm, noteId) {
  return dbm.db
    .prepare("SELECT * FROM transcript_segments WHERE note_id = ? ORDER BY seq")
    .all(noteId);
}

function indexRow(dbm, noteId) {
  return dbm.db.prepare("SELECT * FROM transcript_segment_index WHERE note_id = ?").get(noteId);
}

function totalChanges(dbm) {
  return dbm.db.prepare("SELECT total_changes() AS c").get().c;
}

test("epoch-millisecond timestamps with a known origin derive offset and wall clock", () => {
  const dbm = createDb();
  const origin = 1758500000000;
  const noteId = seedNote(
    dbm,
    [
      { text: "one", timestamp: origin + 1500, speaker: "speaker_0" },
      { text: "two", timestamp: origin + 4200, speaker: "speaker_1" },
    ],
    { originMs: origin }
  );

  reshredNote(dbm.db, noteId);
  const rows = segmentRows(dbm, noteId);

  assert.deepEqual(
    rows.map((r) => [r.offset_ms, r.started_at_ms, r.timestamp_kind]),
    [
      [1500, origin + 1500, "absolute"],
      [4200, origin + 4200, "absolute"],
    ]
  );
});

test("relative-second timestamps with no origin yield an offset but no wall clock", () => {
  const dbm = createDb();
  const noteId = seedNote(dbm, [
    { text: "one", timestamp: 0, speaker: "speaker_0" },
    { text: "two", timestamp: 12.4, speaker: "speaker_0" },
  ]);

  reshredNote(dbm.db, noteId);
  const rows = segmentRows(dbm, noteId);

  assert.deepEqual(
    rows.map((r) => [r.offset_ms, r.started_at_ms, r.timestamp_kind]),
    [
      [0, null, "relative"],
      [12400, null, "relative"],
    ]
  );
});

test("a mixed-unit transcript is derived per value and flagged, never blanked wholesale", () => {
  const dbm = createDb();
  const origin = 1758500000000;
  const noteId = seedNote(
    dbm,
    [
      { text: "stored earlier, already relative", timestamp: 8.5, speaker: "speaker_0" },
      { text: "appended live, still epoch", timestamp: origin + 30000, speaker: "speaker_1" },
    ],
    { originMs: origin }
  );

  reshredNote(dbm.db, noteId);
  const rows = segmentRows(dbm, noteId);

  assert.deepEqual(
    rows.map((r) => [r.offset_ms, r.started_at_ms, r.timestamp_kind]),
    [
      [8500, origin + 8500, "absolute"],
      [30000, origin + 30000, "absolute"],
    ],
    "resuming a recording mixes units routinely, so a good timestamp must survive a bad neighbour"
  );
  assert.equal(indexRow(dbm, noteId).mixed_units, 1, "the mix is reported as a summary flag");
});

test("a timestamp-free segment is stored as unknown rather than zero", () => {
  const dbm = createDb();
  const noteId = seedNote(dbm, [{ text: "no clock", speaker: "speaker_0" }]);

  reshredNote(dbm.db, noteId);
  const [row] = segmentRows(dbm, noteId);

  assert.equal(row.offset_ms, null);
  assert.equal(row.started_at_ms, null);
  assert.equal(row.timestamp_kind, "unknown");
});

test("three segments shred to three rows carrying seq, speaker and text", () => {
  const dbm = createDb();
  const noteId = seedNote(dbm, [
    { text: "alpha", timestamp: 0, speaker: "speaker_0", speakerName: "Jorge" },
    { text: "beta", timestamp: 3, speaker: "speaker_1", speakerName: "Molly" },
    { text: "gamma", timestamp: 6, speaker: "speaker_0", speakerName: "Jorge" },
  ]);

  reshredNote(dbm.db, noteId);

  assert.deepEqual(
    segmentRows(dbm, noteId).map((r) => [r.seq, r.speaker_id, r.speaker_name, r.text]),
    [
      [0, "speaker_0", "Jorge", "alpha"],
      [1, "speaker_1", "Molly", "beta"],
      [2, "speaker_0", "Jorge", "gamma"],
    ]
  );
  assert.equal(indexRow(dbm, noteId).segment_count, 3);
});

test("an unchanged transcript reshreds to zero writes", () => {
  const dbm = createDb();
  const noteId = seedNote(dbm, [{ text: "alpha", timestamp: 0, speaker: "speaker_0" }]);

  reshredNote(dbm.db, noteId);
  const before = totalChanges(dbm);
  const result = reshredNote(dbm.db, noteId);

  assert.equal(totalChanges(dbm) - before, 0, "the hash gate must short-circuit before any write");
  assert.equal(result.skipped, true);
});

test("appending segments rewrites the note in full with correct ordering", () => {
  const dbm = createDb();
  const noteId = seedNote(dbm, [
    { text: "alpha", timestamp: 0, speaker: "speaker_0" },
    { text: "beta", timestamp: 3, speaker: "speaker_0" },
    { text: "gamma", timestamp: 6, speaker: "speaker_0" },
  ]);
  reshredNote(dbm.db, noteId);

  dbm.db
    .prepare("UPDATE notes SET transcript = ? WHERE id = ?")
    .run(
      JSON.stringify([
        { text: "alpha", timestamp: 0, speaker: "speaker_0" },
        { text: "beta", timestamp: 3, speaker: "speaker_0" },
        { text: "gamma", timestamp: 6, speaker: "speaker_0" },
        { text: "delta", timestamp: 9, speaker: "speaker_1" },
        { text: "epsilon", timestamp: 12, speaker: "speaker_1" },
      ]),
      noteId
    );
  reshredNote(dbm.db, noteId);

  assert.deepEqual(
    segmentRows(dbm, noteId).map((r) => [r.seq, r.text]),
    [
      [0, "alpha"],
      [1, "beta"],
      [2, "gamma"],
      [3, "delta"],
      [4, "epsilon"],
    ]
  );
});

test("editing the first segment is reflected without changing the row count", () => {
  const dbm = createDb();
  const noteId = seedNote(dbm, [
    { text: "alpha", timestamp: 0, speaker: "speaker_0" },
    { text: "beta", timestamp: 3, speaker: "speaker_0" },
  ]);
  reshredNote(dbm.db, noteId);

  dbm.db
    .prepare("UPDATE notes SET transcript = ? WHERE id = ?")
    .run(
      JSON.stringify([
        { text: "alpha corrected", timestamp: 0, speaker: "speaker_0" },
        { text: "beta", timestamp: 3, speaker: "speaker_0" },
      ]),
      noteId
    );
  reshredNote(dbm.db, noteId);

  const rows = segmentRows(dbm, noteId);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].text, "alpha corrected");
});

test("a plain-string transcript is indexed as one segment rather than dropped", () => {
  const dbm = createDb();
  const noteId = seedNote(dbm, "just a flat string with no segments at all");

  reshredNote(dbm.db, noteId);
  const rows = segmentRows(dbm, noteId);

  assert.equal(rows.length, 1, "PersonalNotesView writes a bare string when a recording has no segments");
  assert.equal(rows[0].seq, 0);
  assert.equal(rows[0].speaker_name, null);
  assert.equal(rows[0].timestamp_kind, "unknown");
  assert.equal(rows[0].text, "just a flat string with no segments at all");
});

test("changing only a speaker mapping still relabels the indexed segments", () => {
  const dbm = createDb();
  const noteId = seedNote(dbm, [
    { text: "alpha", timestamp: 0, speaker: "speaker_1", speakerName: "Speaker 2", speakerIsPlaceholder: true },
  ]);
  reshredNote(dbm.db, noteId);
  assert.equal(segmentRows(dbm, noteId)[0].speaker_name, null);

  dbm.setSpeakerMapping(noteId, "speaker_1", null, "Jorge");
  reshredNote(dbm.db, noteId);

  assert.equal(
    segmentRows(dbm, noteId)[0].speaker_name,
    "Jorge",
    "renaming a speaker leaves the transcript byte-identical, so the hash must cover the mappings"
  );
});

test("an explicit non-placeholder name wins over a mapping, and a placeholder stores null", () => {
  const dbm = createDb();
  const noteId = seedNote(dbm, [
    { text: "alpha", timestamp: 0, speaker: "speaker_0", speakerName: "Jorge Chayan" },
    { text: "beta", timestamp: 3, speaker: "speaker_1", speakerName: "Speaker 2", speakerIsPlaceholder: true },
    { text: "gamma", timestamp: 6, speaker: "speaker_2" },
  ]);
  dbm.setSpeakerMapping(noteId, "speaker_0", null, "J. Chayan");

  reshredNote(dbm.db, noteId);

  assert.deepEqual(
    segmentRows(dbm, noteId).map((r) => r.speaker_name),
    ["Jorge Chayan", null, null],
    "the index must label segments the way the UI does, and never store a placeholder as a person"
  );
});

test("a malformed transcript records its hash without throwing or writing rows", () => {
  const dbm = createDb();
  const noteId = seedNote(dbm, "[{ this is not valid json");

  assert.doesNotThrow(() => reshredNote(dbm.db, noteId));
  assert.equal(segmentRows(dbm, noteId).length, 0);
  assert.ok(indexRow(dbm, noteId), "the hash is recorded so the note is not retried every tick");
  assert.equal(indexRow(dbm, noteId).segment_count, 0);
});

test("a soft-deleted note has its segments removed", () => {
  const dbm = createDb();
  const noteId = seedNote(dbm, [{ text: "alpha", timestamp: 0, speaker: "speaker_0" }]);
  reshredNote(dbm.db, noteId);
  assert.equal(segmentRows(dbm, noteId).length, 1);

  dbm.db.prepare("UPDATE notes SET deleted_at = ? WHERE id = ?").run(new Date().toISOString(), noteId);
  reshredNote(dbm.db, noteId);

  assert.equal(segmentRows(dbm, noteId).length, 0);
  assert.equal(indexRow(dbm, noteId), undefined);
});

function timeoutCount() {
  return process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length;
}

test("updateNote marks a note dirty only when it writes the transcript", () => {
  const dbm = createDb();
  const { note } = dbm.saveNote("Hooks", "", "meeting");

  dbm.updateNote(note.id, { title: "Renamed" });
  assert.equal(dbm._dirtyTranscriptNotes.has(note.id), false, "a title edit is not transcript work");

  dbm.updateNote(note.id, { transcript: JSON.stringify([{ text: "alpha", timestamp: 0 }]) });
  assert.equal(dbm._dirtyTranscriptNotes.has(note.id), true);
});

test("the two raw-SQL transcript writers mark a note dirty as well", () => {
  const dbm = createDb();
  const { note: first } = dbm.saveNote("Attribution repair", "", "meeting");
  const { note: second } = dbm.saveNote("Origin backfill", "", "meeting");

  dbm.updateNoteTranscriptKeepingUpdatedAt(
    first.id,
    JSON.stringify([{ text: "repaired", timestamp: 0 }])
  );
  assert.equal(
    dbm._dirtyTranscriptNotes.has(first.id),
    true,
    "noteAttributionRepair bypasses updateNote and runs on every launch"
  );

  dbm.setTranscriptOriginKeepingUpdatedAt(second.id, 1758500000000, "audio");
  assert.equal(
    dbm._dirtyTranscriptNotes.has(second.id),
    true,
    "every derived timestamp is computed from the origin this writer changes"
  );
});

test("speaker mapping writes mark a note dirty even though the transcript is untouched", () => {
  const dbm = createDb();
  const noteId = seedNote(dbm, [{ text: "alpha", timestamp: 0, speaker: "speaker_1" }]);

  dbm.setSpeakerMapping(noteId, "speaker_1", null, "Jorge");
  assert.equal(dbm._dirtyTranscriptNotes.has(noteId), true);

  dbm._dirtyTranscriptNotes.clear();
  dbm.removeSpeakerMapping(noteId, "speaker_1");
  assert.equal(dbm._dirtyTranscriptNotes.has(noteId), true);
});

test("an origin-only change re-derives the stored wall-clock timestamps", () => {
  const dbm = createDb();
  const origin = 1758500000000;
  const noteId = seedNote(dbm, [{ text: "alpha", timestamp: 10, speaker: "speaker_0" }], {
    originMs: origin,
  });
  reshredNote(dbm.db, noteId);
  assert.equal(segmentRows(dbm, noteId)[0].started_at_ms, origin + 10000);

  dbm.setTranscriptOriginKeepingUpdatedAt(noteId, origin + 60000, "audio");
  reshredNote(dbm.db, noteId);

  assert.equal(
    segmentRows(dbm, noteId)[0].started_at_ms,
    origin + 60000 + 10000,
    "the hash must cover the origin or the gate returns early with every timestamp wrong"
  );
});

test("the reconciliation sweep repairs a write that bypassed every hook", () => {
  const dbm = createDb();
  const noteId = seedNote(dbm, [{ text: "before", timestamp: 0, speaker: "speaker_0" }]);
  reshredNote(dbm.db, noteId);
  assert.equal(segmentRows(dbm, noteId)[0].text, "before");

  dbm.db
    .prepare("UPDATE notes SET transcript = ? WHERE id = ?")
    .run(JSON.stringify([{ text: "after", timestamp: 0, speaker: "speaker_0" }]), noteId);
  dbm._dirtyTranscriptNotes.clear();

  dbm.reconcileTranscriptSegments();

  assert.equal(
    segmentRows(dbm, noteId)[0].text,
    "after",
    "a missed hook must decay into staleness, not permanent corruption"
  );
});

test("the sweep rotates past the first batch so a high note id is eventually repaired", () => {
  const dbm = createDb();
  const noteIds = [];
  for (let i = 0; i < 60; i++) {
    noteIds.push(seedNote(dbm, [{ text: `note ${i}`, timestamp: 0, speaker: "speaker_0" }]));
  }
  for (const noteId of noteIds) reshredNote(dbm.db, noteId);

  const lateNote = noteIds[54];
  dbm.db
    .prepare("UPDATE notes SET transcript = ? WHERE id = ?")
    .run(JSON.stringify([{ text: "repaired late", timestamp: 0, speaker: "speaker_0" }]), lateNote);
  dbm._dirtyTranscriptNotes.clear();

  // Drive the real tick, which drains at most TRANSCRIPT_INDEX_BATCH notes and only
  // sweeps when the queue is empty — a sweep that drained its whole 25-note batch in
  // one tick would freeze the main process for over a second on long meetings.
  let ticks = 0;
  for (; ticks < 500; ticks++) {
    dbm._transcriptIndexTick();
    if (segmentRows(dbm, lateNote)[0].text === "repaired late") break;
  }

  assert.ok(ticks < 500, "the sweep never reached note 55");
  assert.equal(
    segmentRows(dbm, lateNote)[0].text,
    "repaired late",
    "a cursor that resets to the first 25 ids every time would never reach note 55"
  );
});

test("the sweep wraps back to the start once it runs out of notes", () => {
  const dbm = createDb();
  const first = seedNote(dbm, [{ text: "original", timestamp: 0, speaker: "speaker_0" }]);
  for (let i = 0; i < 30; i++) seedNote(dbm, [{ text: `filler ${i}`, timestamp: 0 }]);
  for (let sweep = 0; sweep < 3; sweep++) dbm.reconcileTranscriptSegments();

  dbm.db
    .prepare("UPDATE notes SET transcript = ? WHERE id = ?")
    .run(JSON.stringify([{ text: "changed behind the hook", timestamp: 0, speaker: "speaker_0" }]), first);
  dbm._dirtyTranscriptNotes.clear();

  for (let sweep = 0; sweep < 6; sweep++) {
    dbm.reconcileTranscriptSegments();
    if (segmentRows(dbm, first)[0]?.text === "changed behind the hook") break;
  }

  assert.equal(segmentRows(dbm, first)[0].text, "changed behind the hook");
});

test("a sweep never reshreds more notes in one tick than an ordinary drain would", () => {
  const dbm = createDb();
  for (let i = 0; i < 40; i++) {
    seedNote(dbm, [{ text: `note ${i}`, timestamp: 0, speaker: "speaker_0" }]);
  }

  const drained = dbm.reconcileTranscriptSegments();

  assert.ok(
    drained <= 3,
    `a sweep drained ${drained} notes in one synchronous tick; at 1800 segments each that is over a second of frozen main process`
  );
  assert.ok(dbm._dirtyTranscriptNotes.size > 0, "the rest stay queued and bleed off over later ticks");
});

test("the indexer tick reconciles only once the dirty queue is drained", () => {
  const dbm = createDb();
  const noteId = seedNote(dbm, [{ text: "alpha", timestamp: 0, speaker: "speaker_0" }]);
  dbm._dirtyTranscriptNotes.add(noteId);

  assert.equal(dbm._transcriptIndexTick(), 1, "a tick with work to do drains it");
  assert.equal(dbm._transcriptIndexTickCount, 0, "draining does not advance the sweep counter");

  for (let tick = 0; tick < 11; tick++) assert.equal(dbm._transcriptIndexTick(), 0);
  assert.equal(dbm._transcriptIndexTick(), 1, "the twelfth idle tick runs a sweep batch");
});

test("merging two speaker profiles relabels the segments of every note they touched", () => {
  const dbm = createDb();
  const noteA = seedNote(dbm, [{ text: "from note a", timestamp: 0, speaker: "speaker_0" }]);
  const noteB = seedNote(dbm, [{ text: "from note b", timestamp: 0, speaker: "speaker_0" }]);

  const embedding = Buffer.from(new Float32Array([1, 0, 0]).buffer);
  const winner = dbm.upsertSpeakerProfile("Jorge Chayan", "jorge@example.com", embedding);
  const loser = dbm.upsertSpeakerProfile("J. Chayan", null, embedding);

  dbm.setSpeakerMapping(noteA, "speaker_0", winner.id, "Jorge Chayan");
  dbm.setSpeakerMapping(noteB, "speaker_0", loser.id, "J. Chayan");
  dbm._drainDirtyTranscriptNotes(10);

  assert.equal(segmentRows(dbm, noteB)[0].speaker_name, "J. Chayan");

  dbm.mergeSpeakerProfiles(winner, loser);

  assert.ok(
    dbm._dirtyTranscriptNotes.has(noteB),
    "a profile merge rewrites speaker_mappings across notes without touching any transcript"
  );

  dbm._drainDirtyTranscriptNotes(10);

  assert.equal(
    segmentRows(dbm, noteB)[0].speaker_name,
    "Jorge Chayan",
    "leaving the old label indexed makes find_person miss everything that speaker said"
  );
});

test("constructing a DatabaseManager starts no timer", () => {
  const before = timeoutCount();
  const dbm = createDb();

  assert.equal(timeoutCount(), before, "the whole existing suite depends on this staying true");
  assert.equal(dbm._transcriptIndexTimer, null, "the indexer is opt-in, started only from main.js");
});

test("starting and stopping the indexer leaves no timer behind", () => {
  const dbm = createDb();
  const before = timeoutCount();

  dbm.startTranscriptSegmentIndexer();
  assert.equal(timeoutCount(), before, "the interval is unref'd so node --test can still exit");
  assert.notEqual(dbm._transcriptIndexTimer, null);

  dbm.stopTranscriptSegmentIndexer();
  assert.equal(dbm._transcriptIndexTimer, null);
});

test("a tick over a closed database stops the indexer instead of throwing every 5 seconds", () => {
  const dbm = createDb();
  dbm.startTranscriptSegmentIndexer();
  const noteId = seedNote(dbm, [{ text: "alpha", timestamp: 0 }]);
  dbm._dirtyTranscriptNotes.add(noteId);

  dbm.db.close();

  assert.doesNotThrow(() => dbm._drainDirtyTranscriptNotes());
  assert.equal(dbm._transcriptIndexTimer, null, "factory reset closes the handle without nulling it");
});

test("the backfill indexes every pending note and is a no-op on a second run", async () => {
  const dbm = createDb();
  const noteIds = [];
  for (let i = 0; i < 12; i++) {
    noteIds.push(seedNote(dbm, [{ text: `note ${i}`, timestamp: 0, speaker: "speaker_0" }]));
  }

  assert.equal(dbm.getPendingTranscriptIndexNoteIds().length, 12);

  const indexed = await backfillTranscriptSegments(dbm, { chunkSize: 5, delayMs: 0 });

  assert.equal(indexed, 12);
  assert.equal(dbm.getPendingTranscriptIndexNoteIds().length, 0);
  for (const noteId of noteIds) assert.equal(segmentRows(dbm, noteId).length, 1);

  const before = totalChanges(dbm);
  const second = await backfillTranscriptSegments(dbm, { chunkSize: 5, delayMs: 0 });

  assert.equal(second, 0, "nothing is pending, so the second run does no work");
  assert.equal(totalChanges(dbm) - before, 0);
});

test("an interrupted backfill resumes from what is still pending", async () => {
  const dbm = createDb();
  for (let i = 0; i < 12; i++) {
    seedNote(dbm, [{ text: `note ${i}`, timestamp: 0, speaker: "speaker_0" }]);
  }

  let chunks = 0;
  const partial = await backfillTranscriptSegments(dbm, {
    chunkSize: 5,
    delayMs: 0,
    shouldStop: () => chunks++ >= 1,
  });

  assert.equal(partial, 5, "one chunk lands before the abort");
  assert.equal(
    dbm.getPendingTranscriptIndexNoteIds().length,
    7,
    "progress is recorded per note, so the remainder is simply still pending"
  );

  const resumed = await backfillTranscriptSegments(dbm, { chunkSize: 5, delayMs: 0 });

  assert.equal(resumed, 7);
  assert.equal(dbm.getPendingTranscriptIndexNoteIds().length, 0);
});

test("the index status report counts indexed, pending and total segments", async () => {
  const dbm = createDb();
  seedNote(dbm, [
    { text: "alpha", timestamp: 0, speaker: "speaker_0" },
    { text: "beta", timestamp: 3, speaker: "speaker_0" },
  ]);
  seedNote(dbm, [{ text: "gamma", timestamp: 0, speaker: "speaker_0" }]);

  assert.deepEqual(dbm.getSearchIndexStatus().transcript_segments, {
    indexed_notes: 0,
    pending_notes: 2,
    total_segments: 0,
  });

  await backfillTranscriptSegments(dbm, { chunkSize: 5, delayMs: 0 });

  assert.deepEqual(dbm.getSearchIndexStatus().transcript_segments, {
    indexed_notes: 2,
    pending_notes: 0,
    total_segments: 3,
  });
});

test("a drain tick reshreds the notes the hooks marked", () => {
  const dbm = createDb();
  const noteId = seedNote(dbm, [{ text: "alpha", timestamp: 0, speaker: "speaker_0" }]);
  dbm._dirtyTranscriptNotes.add(noteId);

  dbm._drainDirtyTranscriptNotes();

  assert.equal(segmentRows(dbm, noteId).length, 1);
  assert.equal(dbm._dirtyTranscriptNotes.has(noteId), false, "a drained note is not re-processed");
});
