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
  raw
    .prepare("INSERT INTO transcriptions (text) VALUES (?)")
    .run("a legacy dictation about badgers");
  raw.close();

  const dbm = reopen(dir);

  assert.equal(
    matchCount(dbm, "badgers"),
    1,
    "the one-shot rebuild has to pick up rows written before the index existed"
  );
});

// The gate this replaces was `PRAGMA user_version < 2`, and the test above passes only
// because its raw fixture leaves user_version at 0. A real database carries 3, stamped by
// the unmerged feature/graceful-db-migrations branch, so the rebuild never fired and every
// pre-existing dictation was unsearchable forever. Reported as #81.
test("rows predating the index are searchable even when user_version is already past the old gate", () => {
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
  raw
    .prepare("INSERT INTO transcriptions (text) VALUES (?)")
    .run("a legacy dictation about badgers");
  raw.pragma("user_version = 3");
  raw.close();

  const dbm = reopen(dir);

  assert.equal(
    matchCount(dbm, "badgers"),
    1,
    "index population must not depend on a pragma two migration schemes both write"
  );
});

// count(*) on an external-content table proxies to the content table, so it reports 4 for an
// index holding nothing. %_docsize is the only honest measure, and any check written against
// count(*) passes while the index is empty.
test("get_index_status reports transcriptions_fts as not ready while the index is behind", () => {
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
  raw
    .prepare("INSERT INTO transcriptions (text) VALUES (?)")
    .run("a legacy dictation about badgers");
  raw.pragma("user_version = 3");
  raw.close();

  const dbm = reopen(dir);

  // Repaired on open, so the honest answer here is ready.
  const healthy = dbm.getSearchIndexStatus().transcriptions_fts;
  assert.equal(healthy.ready, true);
  assert.equal(healthy.missing, 0);
  assert.equal(healthy.total, 1);

  // Now break it behind the manager's back and confirm the status can say so.
  dbm.db.exec("INSERT INTO transcriptions_fts(transcriptions_fts) VALUES('delete-all')");
  const broken = dbm.getSearchIndexStatus().transcriptions_fts;
  assert.equal(broken.ready, false, "ready must be derived, not a hardcoded literal");
  assert.equal(broken.missing, 1);
});

test("a soft-deleted transcription does not make the index look behind forever", () => {
  const dbm = createDb();
  const saved = dbm.saveTranscription("a dictation that gets soft deleted");
  dbm.db
    .prepare("UPDATE transcriptions SET deleted_at = ? WHERE id = ?")
    .run(new Date().toISOString(), saved.id);

  const status = dbm.getSearchIndexStatus().transcriptions_fts;
  assert.equal(
    status.missing,
    0,
    "soft delete is an UPDATE of deleted_at, which fires no FTS trigger, so the row stays indexed and counted"
  );
  assert.equal(status.ready, true, "otherwise the repair would fire on every launch forever");
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

// The failure a count comparison cannot see: one orphan docsize row offsets one genuinely
// missing document, the totals match, and that row is unsearchable forever while the status
// reports ready. This is why the check is an anti-join and not count vs count.
test("an orphan index row does not mask a genuinely missing document", () => {
  const dbm = createDb();
  const kept = dbm.saveTranscription("a dictation about badgers");

  // Content row with no index row...
  dbm.db.exec(
    "INSERT INTO transcriptions_fts(transcriptions_fts, rowid, text, raw_text) " +
      `VALUES ('delete', ${kept.id}, 'a dictation about badgers', '')`
  );
  // ...offset by an index row with no content row, so the two counts agree again.
  dbm.db.exec("INSERT INTO transcriptions_fts(rowid, text, raw_text) VALUES (99999, 'orphan', '')");

  const total = dbm.db.prepare("SELECT count(*) AS c FROM transcriptions").get().c;
  const indexed = dbm.db.prepare("SELECT count(*) AS c FROM transcriptions_fts_docsize").get().c;
  assert.equal(indexed, total, "precondition: a count comparison sees nothing wrong here");

  const status = dbm.getSearchIndexStatus().transcriptions_fts;
  assert.equal(status.missing, 1, "the anti-join must still see the missing document");
  assert.equal(status.ready, false);

  const repaired = reopen(userDataDir);
  assert.equal(matchCount(repaired, "badgers"), 1, "and reopening must repair it");
});

test("notes_fts is not re-indexed on every launch", () => {
  const dbm = createDb();
  const dir = userDataDir;
  for (let i = 0; i < 10; i++) {
    dbm.saveNote(`note ${i}`, `a note about otters number ${i}`, "personal");
  }
  const settled = dbm.db.prepare("SELECT sum(length(block)) AS b FROM notes_fts_data").get().b;
  dbm.db.close();

  let current = settled;
  for (let launch = 0; launch < 3; launch++) {
    const next = reopen(dir);
    current = next.db.prepare("SELECT sum(length(block)) AS b FROM notes_fts_data").get().b;
    next.db.close();
  }

  assert.equal(
    current,
    settled,
    "the unconditional INSERT OR IGNORE re-appended the whole index every launch (#77)"
  );

  const status = reopen(dir);
  assert.equal(
    status.db
      .prepare("SELECT count(*) AS c FROM notes WHERE id NOT IN (SELECT id FROM notes_fts_docsize)")
      .get().c,
    0
  );
});

// The old backfill was `INSERT OR IGNORE ... SELECT ... FROM notes`, which conflicted on
// notes_fts_docsize.id and so kept exactly one docsize row per note -- but still appended a
// fresh copy of every posting. The anti-join repair therefore sees `missing: 0` on every
// existing install and leaves the inflated term frequencies in place. Measured on the real
// library: bm25 -13.1482 vs -4.2809 after a rebuild, and the top-5 order genuinely differs.
test("an install carrying duplicate postings is rebuilt once, and not again", () => {
  const dbm = createDb();
  const dir = userDataDir;
  for (let i = 0; i < 12; i++) {
    dbm.saveNote(`note ${i}`, `a meeting about otters and notes number ${i}`, "personal");
  }

  // Simulate what N launches of the old code left behind.
  const duplicate = dbm.db.prepare(
    `INSERT OR IGNORE INTO notes_fts(rowid, title, content, enhanced_content)
     SELECT id, COALESCE(title, ''), COALESCE(content, ''), COALESCE(enhanced_content, '')
     FROM notes`
  );
  for (let i = 0; i < 4; i++) duplicate.run();
  dbm.db.prepare("DELETE FROM schema_meta WHERE key = 'notes_fts_rebuilt'").run();
  const skewed = dbm.db
    .prepare(
      "SELECT bm25(notes_fts) AS score FROM notes_fts WHERE notes_fts MATCH 'otters' ORDER BY rowid LIMIT 1"
    )
    .get().score;
  assert.equal(
    dbm.db.prepare("SELECT count(*) AS c FROM notes_fts_docsize").get().c,
    12,
    "precondition: docsize is untouched, which is why the anti-join sees nothing missing"
  );
  dbm.db.close();

  const repaired = reopen(dir);
  const fixed = repaired.db
    .prepare(
      "SELECT bm25(notes_fts) AS score FROM notes_fts WHERE notes_fts MATCH 'otters' ORDER BY rowid LIMIT 1"
    )
    .get().score;
  assert.notEqual(fixed, skewed, "the duplicate postings must be cleared, not reported ready");
  assert.ok(fixed > skewed, `rebuild should raise the inflated score: ${skewed} -> ${fixed}`);
  assert.equal(
    repaired.db
      .prepare("SELECT count(*) AS c FROM schema_meta WHERE key = 'notes_fts_rebuilt'")
      .get().c,
    1
  );
  repaired.db.close();

  // ...and it must not run on every launch thereafter.
  const again = reopen(dir);
  assert.equal(
    again.db
      .prepare(
        "SELECT bm25(notes_fts) AS score FROM notes_fts WHERE notes_fts MATCH 'otters' ORDER BY rowid LIMIT 1"
      )
      .get().score,
    fixed,
    "a recorded one-time rebuild must not repeat"
  );
});

// transcript_segments_fts was left out of the repair and the status entirely. It matters more
// than the other two: transcript_segments_fts_delete fires on the DELETE at the top of every
// reshredNote, and raises SQLITE_CORRUPT_VTAB when the index has fallen behind -- so a lagging
// segment index breaks re-indexing outright rather than degrading search.
test("a segment index that has fallen behind is repaired and reported", () => {
  const dbm = createDb();
  const { note } = dbm.saveNote("a meeting", "", "meeting");
  const insert = dbm.db.prepare(
    `INSERT INTO transcript_segments (note_id, seq, speaker_id, speaker_name, text, offset_ms, timestamp_kind)
     VALUES (?, ?, 'speaker_0', 'Molly', ?, ?, 'relative')`
  );
  insert.run(note.id, 0, "the quarterly budget", 0);
  insert.run(note.id, 1, "and the hiring plan", 5000);

  const dir = userDataDir;
  // Wipe the index behind the manager's back, as a missed trigger would.
  dbm.db.exec("INSERT INTO transcript_segments_fts(transcript_segments_fts) VALUES('delete-all')");
  const broken = dbm.getSearchIndexStatus().transcript_segments_fts;
  assert.equal(broken.ready, false, "the status has to be able to report this");
  assert.equal(broken.missing, 2);
  dbm.db.close();

  const repaired = reopen(dir);
  const status = repaired.getSearchIndexStatus().transcript_segments_fts;
  assert.equal(status.ready, true);
  assert.equal(status.missing, 0);
  assert.equal(
    repaired.db
      .prepare(
        "SELECT count(*) AS c FROM transcript_segments_fts WHERE transcript_segments_fts MATCH ?"
      )
      .get("budget").c,
    1,
    "and the segments are searchable again"
  );

  // The re-index path must no longer raise SQLITE_CORRUPT_VTAB on the leading DELETE.
  assert.doesNotThrow(() => {
    repaired.db.prepare("DELETE FROM transcript_segments WHERE note_id = ?").run(note.id);
  });
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
  dbm.db
    .prepare("UPDATE transcriptions SET deleted_at = ? WHERE id = ?")
    .run(new Date().toISOString(), removed.id);

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
