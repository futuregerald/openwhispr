const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { requireSqlite } = require("../support/sqlite.js");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-segment-schema-"));
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

function createDb() {
  requireSqlite();
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-segment-schema-"));
  return new DatabaseManager();
}

function objectNames(db) {
  return db.db
    .prepare("SELECT name FROM sqlite_master")
    .all()
    .map((row) => row.name);
}

test("initDatabase creates the transcript segment tables, index and FTS mirror", () => {
  const db = createDb();
  const names = objectNames(db);

  for (const object of [
    "transcript_segments",
    "transcript_segments_fts",
    "transcript_segment_index",
    "idx_transcript_segments_speaker",
  ]) {
    assert.ok(names.includes(object), `${object} must exist in sqlite_master`);
  }
});

test("transcript_segments cascades from notes so a deleted note leaves no segments", () => {
  const db = createDb();

  const foreignKeys = db.db.prepare("PRAGMA foreign_key_list(transcript_segments)").all();
  const noteFk = foreignKeys.find((fk) => fk.table === "notes");
  assert.ok(noteFk, "transcript_segments must declare a foreign key to notes");
  assert.equal(noteFk.on_delete, "CASCADE");

  const { note } = db.saveNote("Cascade", "", "meeting");
  db.db
    .prepare(
      "INSERT INTO transcript_segments (note_id, seq, speaker_id, speaker_name, text, offset_ms, started_at_ms, timestamp_kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(note.id, 0, "speaker_0", "Jorge", "hello", 0, null, "relative");

  assert.equal(
    db.db.prepare("SELECT COUNT(*) AS c FROM transcript_segments").get().c,
    1,
    "the segment row is present before the note is deleted"
  );

  db.deleteNote(note.id);

  assert.equal(
    db.db.prepare("SELECT COUNT(*) AS c FROM transcript_segments").get().c,
    0,
    "deleting the note cascades its segments away"
  );
});

test("transcript_segment_index cascades from notes too", () => {
  const db = createDb();

  const foreignKeys = db.db.prepare("PRAGMA foreign_key_list(transcript_segment_index)").all();
  const noteFk = foreignKeys.find((fk) => fk.table === "notes");
  assert.ok(noteFk, "transcript_segment_index must declare a foreign key to notes");
  assert.equal(noteFk.on_delete, "CASCADE");
});

test("transcript_segments carries no digest column", () => {
  const db = createDb();
  const columns = db.db
    .prepare("PRAGMA table_info(transcript_segments)")
    .all()
    .map((column) => column.name);

  assert.ok(
    !columns.includes("digest"),
    "the incremental-reshred digest was removed; a full rewrite is 27ms and a digest silently drifts"
  );
  assert.deepEqual(columns, [
    "note_id",
    "seq",
    "speaker_id",
    "speaker_name",
    "text",
    "offset_ms",
    "started_at_ms",
    "timestamp_kind",
  ]);
});

test("transcript_segments_fts mirrors inserts, updates and deletes of its content table", () => {
  const db = createDb();
  const { note } = db.saveNote("FTS mirror", "", "meeting");

  const insert = db.db.prepare(
    "INSERT INTO transcript_segments (note_id, seq, speaker_id, speaker_name, text, offset_ms, started_at_ms, timestamp_kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );
  insert.run(note.id, 0, "speaker_0", "Jorge", "the quarterly revenue projection", 0, null, "relative");

  const matches = (term) =>
    db.db
      .prepare("SELECT COUNT(*) AS c FROM transcript_segments_fts WHERE transcript_segments_fts MATCH ?")
      .get(term).c;

  assert.equal(matches("quarterly"), 1, "an inserted segment is searchable");

  db.db
    .prepare("UPDATE transcript_segments SET text = ? WHERE note_id = ? AND seq = ?")
    .run("the annual budget review", note.id, 0);

  assert.equal(matches("quarterly"), 0, "the stale term is removed on update");
  assert.equal(matches("budget"), 1, "the new term is indexed on update");

  db.db.prepare("DELETE FROM transcript_segments WHERE note_id = ?").run(note.id);

  assert.equal(matches("budget"), 0, "the index entry is dropped on delete");
});
