const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { requireSqlite } = require("../support/sqlite.js");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-origin-"));
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
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-origin-"));
  return new DatabaseManager();
}

function columns(db) {
  return db.db
    .prepare("PRAGMA table_info(notes)")
    .all()
    .map((row) => row.name);
}

test("notes carries the transcript origin and the source that anchors it", () => {
  const db = createDb();
  const names = columns(db);
  assert.ok(
    names.includes("transcript_origin_ms"),
    `expected transcript_origin_ms on notes, got: ${names.join(", ")}`
  );
  assert.ok(
    names.includes("transcript_origin_source"),
    `expected transcript_origin_source on notes, got: ${names.join(", ")}`
  );
  db.close?.();
});

test("the origin columns start empty, so an unknown origin is never mistaken for zero", () => {
  const db = createDb();
  const note = db.saveNote("Standup", "body", "meeting").note;
  const row = db.db
    .prepare("SELECT transcript_origin_ms, transcript_origin_source FROM notes WHERE id = ?")
    .get(note.id);
  assert.equal(row.transcript_origin_ms, null);
  assert.equal(row.transcript_origin_source, null);
  db.close?.();
});

// The diarization suite writes through a fake updateNote that stores whatever it is
// handed. The real one filters against an allowlist and silently drops anything absent
// from it, so a column can be written everywhere in main and still never reach the row.
test("updateNote actually persists the origin columns rather than dropping them", () => {
  const db = createDb();
  const note = db.saveNote("Standup", "body", "meeting").note;

  const result = db.updateNote(note.id, {
    transcript: "[]",
    transcript_origin_ms: 1788877046345,
    transcript_origin_source: "audio:system",
  });

  assert.equal(result.success, true);
  const row = db.getNote(note.id);
  assert.equal(row.transcript_origin_ms, 1788877046345);
  assert.equal(row.transcript_origin_source, "audio:system");
  db.close?.();
});

test("updateNote can clear the origin, so a re-anchored transcript cannot keep a stale one", () => {
  const db = createDb();
  const note = db.saveNote("Standup", "body", "meeting").note;
  db.updateNote(note.id, {
    transcript_origin_ms: 1788877046345,
    transcript_origin_source: "audio:system",
  });

  db.updateNote(note.id, {
    transcript: "[]",
    transcript_origin_ms: null,
    transcript_origin_source: null,
  });

  const row = db.getNote(note.id);
  assert.equal(row.transcript_origin_ms, null);
  assert.equal(row.transcript_origin_source, null);
  db.close?.();
});

// cliBridge's PATCH /v1/notes/:id and the renderer's db-update-note both pass an arbitrary
// object into updateNote. SQLite's INTEGER affinity stores "not-a-number" verbatim, and a
// corrupted origin is invisible until something prints it as wall clock.
test("a non-integer origin is refused rather than stored as text", () => {
  const db = createDb();
  const note = db.saveNote("Standup", "body", "meeting").note;

  for (const bad of ["not-a-number", 1.5, -5, 0]) {
    const result = db.updateNote(note.id, { transcript_origin_ms: bad });
    assert.equal(result.success, false, `${JSON.stringify(bad)} must be refused`);
  }

  assert.equal(db.getNote(note.id).transcript_origin_ms, null);
  db.close?.();
});

test("an origin source outside the known set is refused", () => {
  const db = createDb();
  const note = db.saveNote("Standup", "body", "meeting").note;

  assert.equal(db.updateNote(note.id, { transcript_origin_source: "whatever" }).success, false);
  assert.equal(db.getNote(note.id).transcript_origin_source, null);

  for (const good of ["audio:system", "first-segment", "unanchored"]) {
    assert.equal(db.updateNote(note.id, { transcript_origin_source: good }).success, true, good);
  }
  db.close?.();
});

test("a refused field does not let the rest of the update through", () => {
  const db = createDb();
  const note = db.saveNote("Standup", "body", "meeting").note;

  db.updateNote(note.id, { title: "Renamed", transcript_origin_ms: "garbage" });

  assert.equal(db.getNote(note.id).title, "Standup", "the whole update must be refused");
  db.close?.();
});
