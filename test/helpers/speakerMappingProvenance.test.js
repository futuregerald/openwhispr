const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { requireSqlite } = require("../support/sqlite.js");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-speaker-prov-"));
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

function freshDatabase() {
  requireSqlite();
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-speaker-prov-"));
  return new DatabaseManager();
}

function insertNote(db) {
  const info = db.db
    .prepare("INSERT INTO notes (title, transcript) VALUES (?, ?)")
    .run("A meeting", JSON.stringify([]));
  return info.lastInsertRowid;
}

const columnsOf = (db, table) =>
  new Map(
    db.db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((c) => [c.name, c])
  );

test("speaker_mappings carries origin and confidence, defaulting to unknown", () => {
  const db = freshDatabase();
  const byName = columnsOf(db, "speaker_mappings");
  assert.ok(byName.has("origin"), "origin column missing");
  assert.ok(byName.has("confidence"), "confidence column missing");
  assert.equal(byName.get("origin").dflt_value, "'unknown'");
});

// The migration runs on every launch, so a non-idempotent one bricks the app on
// restart -- which no single-open test can catch.
test("the provenance migration survives a reopen", () => {
  const db = freshDatabase();
  const noteId = insertNote(db);
  db.db
    .prepare("INSERT INTO speaker_mappings (note_id, speaker_id, display_name) VALUES (?, ?, ?)")
    .run(noteId, "speaker_0", "Dana");
  db.db.close();

  const reopened = new DatabaseManager();
  const byName = columnsOf(reopened, "speaker_mappings");
  assert.ok(byName.has("origin"));
  assert.ok(byName.has("confidence"));
  const row = reopened.getSpeakerMappings(noteId)[0];
  assert.equal(row.origin, "unknown", "a row written before the column existed must stay unknown");
  assert.equal(row.confidence, null);
});

test("setSpeakerMapping refuses to write without provenance", () => {
  const db = freshDatabase();
  const noteId = insertNote(db);
  assert.throws(() => db.setSpeakerMapping(noteId, "speaker_0", null, "Dana"), /origin/i);
});

test("setSpeakerMapping refuses an unrecognised origin", () => {
  const db = freshDatabase();
  const noteId = insertNote(db);
  assert.throws(
    () => db.setSpeakerMapping(noteId, "speaker_0", null, "Dana", { origin: "guess" }),
    /origin/i
  );
});

test("an auto mapping stores its similarity, a manual one stores none", () => {
  const db = freshDatabase();
  const noteId = insertNote(db);
  db.setSpeakerMapping(noteId, "speaker_0", null, "Dana", { origin: "auto", confidence: 0.71 });
  db.setSpeakerMapping(noteId, "speaker_1", null, "Sam", { origin: "manual" });
  const rows = db.getSpeakerMappings(noteId);
  const dana = rows.find((r) => r.speaker_id === "speaker_0");
  const sam = rows.find((r) => r.speaker_id === "speaker_1");
  assert.equal(dana.origin, "auto");
  assert.ok(Math.abs(dana.confidence - 0.71) < 1e-9);
  assert.equal(sam.origin, "manual");
  assert.equal(sam.confidence, null);
});

// INSERT OR REPLACE replaces the whole row, so an optional argument would let a
// re-write silently reset provenance.
test("rewriting a mapping cannot silently drop its provenance", () => {
  const db = freshDatabase();
  const noteId = insertNote(db);
  db.setSpeakerMapping(noteId, "speaker_0", null, "Dana", { origin: "manual" });
  assert.throws(() => db.setSpeakerMapping(noteId, "speaker_0", null, "Dana"), /origin/i);
  assert.equal(db.getSpeakerMappings(noteId)[0].origin, "manual");
});
