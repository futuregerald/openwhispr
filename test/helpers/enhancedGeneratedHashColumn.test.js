const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { requireSqlite } = require("../support/sqlite.js");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-enhanced-generated-hash-"));
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
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-enhanced-generated-hash-"));
  return new DatabaseManager();
}

const noteColumns = (db) =>
  new Set(
    db.db
      .prepare("PRAGMA table_info(notes)")
      .all()
      .map((column) => column.name)
  );

test("a fresh database has the enhanced_generated_hash column on notes", () => {
  const db = createDb();

  assert.ok(
    noteColumns(db).has("enhanced_generated_hash"),
    `expected enhanced_generated_hash among ${JSON.stringify([...noteColumns(db)])}`
  );
});

// updateNote silently ignores any field missing from its allowlist, so the column can exist
// while every write to it is a no-op. The round trip is what proves the allowlist entry.
test("enhanced_generated_hash round-trips through updateNote and getNote", () => {
  const db = createDb();
  const note = db.saveNote("Weekly sync", "body").note;

  assert.equal(db.getNote(note.id).enhanced_generated_hash ?? null, null);

  db.updateNote(note.id, { enhanced_generated_hash: "abc" });

  assert.equal(db.getNote(note.id).enhanced_generated_hash, "abc");

  db.updateNote(note.id, { enhanced_generated_hash: null });
  assert.equal(db.getNote(note.id).enhanced_generated_hash ?? null, null);
});
