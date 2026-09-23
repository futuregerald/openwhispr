const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { requireSqlite } = require("../support/sqlite.js");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-transcriptions-fts-"));
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

function freshDir() {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-transcriptions-fts-"));
  return userDataDir;
}

function createDb() {
  requireSqlite();
  freshDir();
  return new DatabaseManager();
}

function reopen(dir) {
  userDataDir = dir;
  return new DatabaseManager();
}

function ftsRowCount(dbm) {
  return dbm.db.prepare("SELECT COUNT(*) AS c FROM transcriptions_fts").get().c;
}

function matchCount(dbm, term) {
  return dbm.db
    .prepare("SELECT COUNT(*) AS c FROM transcriptions_fts WHERE transcriptions_fts MATCH ?")
    .get(term).c;
}

test("rows that predate the index are searchable after it is built", () => {
  const Database = requireSqlite();
  const dir = freshDir();

  const raw = new Database(path.join(dir, "transcriptions.db"));
  raw.exec(`
    CREATE TABLE transcriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  raw.prepare("INSERT INTO transcriptions (text) VALUES (?)").run("a legacy dictation about badgers");
  raw.close();

  const dbm = reopen(dir);

  assert.equal(
    matchCount(dbm, "badgers"),
    1,
    "the one-shot rebuild has to pick up rows written before the index existed"
  );
});

test("the index does not grow when the database is reopened", () => {
  const dbm = createDb();
  const dir = userDataDir;

  for (let i = 0; i < 20; i++) dbm.saveTranscription(`dictation number ${i} about otters`);
  const firstCount = ftsRowCount(dbm);
  const firstScore = dbm.db
    .prepare(
      "SELECT bm25(transcriptions_fts) AS score FROM transcriptions_fts WHERE transcriptions_fts MATCH ? ORDER BY rowid LIMIT 1"
    )
    .get("otters").score;
  dbm.db.close();

  const second = reopen(dir);
  second.db.close();
  const third = reopen(dir);

  assert.equal(
    ftsRowCount(third),
    firstCount,
    "INSERT OR IGNORE into an external-content FTS5 table re-appends every row; notes_fts has been doing this since it shipped"
  );
  assert.equal(
    third.db
      .prepare(
        "SELECT bm25(transcriptions_fts) AS score FROM transcriptions_fts WHERE transcriptions_fts MATCH ? ORDER BY rowid LIMIT 1"
      )
      .get("otters").score,
    firstScore,
    "a duplicated index also drifts bm25 ranking for the same row"
  );
});

test("insert, text update and delete keep the index in step", () => {
  const dbm = createDb();

  const saved = dbm.saveTranscription("the quarterly revenue projection");
  assert.equal(matchCount(dbm, "quarterly"), 1);

  dbm.updateTranscriptionText(saved.id, "the annual budget review", null);
  assert.equal(matchCount(dbm, "quarterly"), 0);
  assert.equal(matchCount(dbm, "budget"), 1);

  dbm.deleteTranscription(saved.id);
  assert.equal(matchCount(dbm, "budget"), 0);
});

test("raw_text is searchable alongside the cleaned text", () => {
  const dbm = createDb();
  const saved = dbm.saveTranscription("cleaned up wording");
  dbm.updateTranscriptionText(saved.id, "cleaned up wording", "umm the raw disfluent wording");

  assert.equal(matchCount(dbm, "disfluent"), 1);
});

test("searchTranscriptions ranks hits and skips soft-deleted rows", () => {
  const dbm = createDb();

  const kept = dbm.saveTranscription("badgers badgers badgers everywhere");
  dbm.saveTranscription("a single mention of badgers");
  const removed = dbm.saveTranscription("badgers that were deleted");
  dbm.db.prepare("UPDATE transcriptions SET deleted_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    removed.id
  );

  const results = dbm.searchTranscriptions("badgers", 10);

  assert.equal(results.length, 2, "a soft-deleted transcription must not surface");
  assert.equal(results[0].id, kept.id, "the denser match ranks first");
  assert.ok(!results.some((row) => row.id === removed.id));
});

test("searchTranscriptions returns nothing for a query with no usable tokens", () => {
  const dbm = createDb();
  dbm.saveTranscription("something real");

  assert.deepEqual(dbm.searchTranscriptions("   ", 10), []);
  assert.deepEqual(dbm.searchTranscriptions("!!!", 10), []);
});

test("clearing audio flags does not re-tokenise the transcription corpus", () => {
  const dbm = createDb();
  const saved = dbm.saveTranscription("a dictation with audio attached");

  const before = dbm.db.prepare("SELECT total_changes() AS c").get().c;
  dbm.db.prepare("UPDATE transcriptions SET has_audio = 0 WHERE id = ?").run(saved.id);
  const after = dbm.db.prepare("SELECT total_changes() AS c").get().c;

  assert.equal(
    after - before,
    1,
    "the trigger fires AFTER UPDATE OF text, raw_text so a non-text update costs one row, not a delete plus reinsert"
  );
  assert.equal(matchCount(dbm, "dictation"), 1);
});
