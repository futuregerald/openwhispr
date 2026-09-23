const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { requireSqlite } = require("../support/sqlite.js");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-segment-search-"));
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
const { reshredNote } = require("../../src/helpers/transcriptSegmentIndex.js");

function createDb() {
  requireSqlite();
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-segment-search-"));
  return new DatabaseManager();
}

function seedIndexedNote(dbm, segments, { title = "Note", originMs = null, createdAt = null } = {}) {
  const { note } = dbm.saveNote(title, "", "meeting");
  dbm.db
    .prepare("UPDATE notes SET transcript = ?, transcript_origin_ms = ? WHERE id = ?")
    .run(JSON.stringify(segments), originMs, note.id);
  if (createdAt) {
    dbm.db.prepare("UPDATE notes SET created_at = ? WHERE id = ?").run(createdAt, note.id);
  }
  reshredNote(dbm.db, note.id);
  return note.id;
}

test("a keyword hit returns the segment with its speaker, note and timestamp", () => {
  const dbm = createDb();
  const origin = 1758500000000;
  const noteId = seedIndexedNote(
    dbm,
    [
      { text: "we should revisit the pricing model", timestamp: 12, speaker: "speaker_0", speakerName: "Jorge" },
      { text: "unrelated chatter", timestamp: 30, speaker: "speaker_1", speakerName: "Molly" },
    ],
    { title: "Pricing sync", originMs: origin }
  );

  const hits = dbm.searchTranscriptSegments({ query: "pricing" });

  assert.equal(hits.length, 1);
  assert.equal(hits[0].note_id, noteId);
  assert.equal(hits[0].note_title, "Pricing sync");
  assert.equal(hits[0].seq, 0);
  assert.equal(hits[0].speaker_name, "Jorge");
  assert.equal(hits[0].offset_ms, 12000);
  assert.equal(hits[0].started_at_ms, origin + 12000);
  assert.equal(hits[0].timestamp_kind, "absolute");
  assert.match(hits[0].text, /pricing model/);
});

test("the speaker filter narrows a keyword search", () => {
  const dbm = createDb();
  seedIndexedNote(dbm, [
    { text: "budget concerns", timestamp: 0, speaker: "speaker_0", speakerName: "Jorge" },
    { text: "budget approved", timestamp: 5, speaker: "speaker_1", speakerName: "Molly" },
  ]);

  const hits = dbm.searchTranscriptSegments({ query: "budget", speaker: "Molly" });

  assert.equal(hits.length, 1);
  assert.equal(hits[0].speaker_name, "Molly");
});

test("the note filter narrows a keyword search", () => {
  const dbm = createDb();
  const wanted = seedIndexedNote(dbm, [{ text: "shared keyword here", timestamp: 0, speaker: "speaker_0" }]);
  seedIndexedNote(dbm, [{ text: "shared keyword elsewhere", timestamp: 0, speaker: "speaker_0" }]);

  const hits = dbm.searchTranscriptSegments({ query: "keyword", noteId: wanted });

  assert.equal(hits.length, 1);
  assert.equal(hits[0].note_id, wanted);
});

test("context segments return the neighbours on either side", () => {
  const dbm = createDb();
  seedIndexedNote(dbm, [
    { text: "opening remarks", timestamp: 0, speaker: "speaker_0" },
    { text: "the pivotal decision", timestamp: 5, speaker: "speaker_1" },
    { text: "closing remarks", timestamp: 10, speaker: "speaker_0" },
  ]);

  const [hit] = dbm.searchTranscriptSegments({ query: "pivotal", contextSegments: 1 });

  assert.deepEqual(
    hit.context.before.map((row) => row.text),
    ["opening remarks"]
  );
  assert.deepEqual(
    hit.context.after.map((row) => row.text),
    ["closing remarks"]
  );
});

test("segments of a soft-deleted note are excluded", () => {
  const dbm = createDb();
  const noteId = seedIndexedNote(dbm, [{ text: "secret agenda", timestamp: 0, speaker: "speaker_0" }]);

  assert.equal(dbm.searchTranscriptSegments({ query: "agenda" }).length, 1);

  dbm.db.prepare("UPDATE notes SET deleted_at = ? WHERE id = ?").run(new Date().toISOString(), noteId);

  assert.equal(
    dbm.searchTranscriptSegments({ query: "agenda" }).length,
    0,
    "searchNotes filters deleted_at and this path must too"
  );
});

test("each returned segment is capped so one hit cannot flood the agent's context", () => {
  const dbm = createDb();
  const long = `marker ${"word ".repeat(400)}`;
  seedIndexedNote(dbm, [{ text: long, timestamp: 0, speaker: "speaker_0" }]);

  const [hit] = dbm.searchTranscriptSegments({ query: "marker" });

  assert.ok(hit.text.length <= 500, `segment text was ${hit.text.length} characters`);
  assert.equal(hit.truncated, true);
});

test("a date range filters absolute segments by their own wall clock", () => {
  const dbm = createDb();
  const origin = Date.parse("2026-09-15T10:00:00Z");
  seedIndexedNote(dbm, [{ text: "inside the window", timestamp: origin, speaker: "speaker_0" }], {
    originMs: origin,
  });
  const laterOrigin = Date.parse("2026-09-20T10:00:00Z");
  seedIndexedNote(dbm, [{ text: "outside the window", timestamp: laterOrigin, speaker: "speaker_0" }], {
    originMs: laterOrigin,
  });

  const hits = dbm.searchTranscriptSegments({
    query: "window",
    since: "2026-09-14T00:00:00Z",
    until: "2026-09-16T00:00:00Z",
  });

  assert.equal(hits.length, 1);
  assert.match(hits[0].text, /inside/);
});

test("a relative segment falls back to its note's created_at for date filtering", () => {
  const dbm = createDb();
  seedIndexedNote(dbm, [{ text: "no wall clock at all", timestamp: 4, speaker: "speaker_0" }], {
    createdAt: "2026-09-15 12:00:00",
  });

  const inside = dbm.searchTranscriptSegments({
    query: "clock",
    since: "2026-09-14T00:00:00Z",
    until: "2026-09-16T00:00:00Z",
  });
  const outside = dbm.searchTranscriptSegments({
    query: "clock",
    since: "2026-09-01T00:00:00Z",
    until: "2026-09-05T00:00:00Z",
  });

  assert.equal(inside.length, 1, "dropping relative rows would empty a search for finished meetings");
  assert.equal(inside[0].date_filter_basis, "note_created_at");
  assert.equal(outside.length, 0);
});

test("a speaker filter alone pages through that speaker's segments in seq order", () => {
  const dbm = createDb();
  const noteId = seedIndexedNote(
    dbm,
    Array.from({ length: 6 }, (_, i) => ({
      text: `line ${i}`,
      timestamp: i,
      speaker: i % 2 === 0 ? "speaker_0" : "speaker_1",
      speakerName: i % 2 === 0 ? "Jorge" : "Molly",
    }))
  );

  const first = dbm.searchTranscriptSegments({ speaker: "Jorge", noteId, limit: 2, offset: 0 });
  assert.deepEqual(
    first.map((row) => row.seq),
    [0, 2]
  );

  const second = dbm.searchTranscriptSegments({ speaker: "Jorge", noteId, limit: 2, offset: 2 });
  assert.deepEqual(
    second.map((row) => row.seq),
    [4]
  );
});

test("a note filter alone returns that note's segments without a query", () => {
  const dbm = createDb();
  const noteId = seedIndexedNote(dbm, [
    { text: "alpha", timestamp: 0, speaker: "speaker_0" },
    { text: "beta", timestamp: 3, speaker: "speaker_0" },
  ]);

  const hits = dbm.searchTranscriptSegments({ noteId });

  assert.deepEqual(
    hits.map((row) => row.text),
    ["alpha", "beta"]
  );
});

test("no query and no narrowing filter is rejected rather than scanning the library", () => {
  const dbm = createDb();
  seedIndexedNote(dbm, [{ text: "alpha", timestamp: 0, speaker: "speaker_0" }]);

  assert.throws(
    () => dbm.searchTranscriptSegments({}),
    (error) => error.code === "VALIDATION"
  );
});
