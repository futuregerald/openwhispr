const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { requireSqlite } = require("../support/sqlite.js");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-dict-agent-"));
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
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-dict-agent-"));
  return new DatabaseManager();
}

const sourceOf = (db, word) =>
  db.db.prepare("SELECT source FROM custom_dictionary WHERE lower(word) = lower(?)").get(word)
    ?.source;

const deletedAtOf = (db, word) =>
  db.db.prepare("SELECT deleted_at FROM custom_dictionary WHERE lower(word) = lower(?)").get(word)
    ?.deleted_at;

// setDictionary HARD-deletes every active row absent from the array it is
// given, so a model passing a partial list would destroy the user's words.
// This is the invariant the additive method exists for.
test("adding words deletes none of the existing ones", () => {
  const db = freshDatabase();
  db.setDictionary(["Kubernetes", "Packwerk", "Pundit"]);

  db.addDictionaryWords(["Qdrant"]);

  assert.deepEqual([...db.getDictionary()].sort(), ["Kubernetes", "Packwerk", "Pundit", "Qdrant"]);
});

test("a word the agent adds is recorded as agent, not as something the user typed", () => {
  const db = freshDatabase();
  db.addDictionaryWords(["Qdrant"]);
  assert.equal(sourceOf(db, "Qdrant"), "agent");
});

test("a word the user already typed keeps its manual source", () => {
  const db = freshDatabase();
  db.setDictionary(["Packwerk"], "manual");
  db.addDictionaryWords(["Packwerk"]);
  assert.equal(sourceOf(db, "Packwerk"), "manual");
});

// promoteSource fires only for sourceForNewWords === "manual", so an agent
// re-add must NOT promote a learned word -- that would launder an auto-learned
// guess into something indistinguishable from a typed word.
test("an auto-learned word is not promoted by an agent re-adding it", () => {
  const db = freshDatabase();
  db.setDictionary(["Parakeet"], "learned");
  db.addDictionaryWords(["Parakeet"]);
  assert.equal(sourceOf(db, "Parakeet"), "learned");
});

test("a soft-deleted word is restored keeping its own source", () => {
  const db = freshDatabase();
  db.setDictionary(["Packwerk"], "manual");
  db.db
    .prepare("UPDATE custom_dictionary SET deleted_at = datetime('now') WHERE word = ?")
    .run("Packwerk");
  assert.ok(deletedAtOf(db, "Packwerk"), "precondition: the row is soft-deleted");

  db.addDictionaryWords(["Packwerk"]);

  assert.equal(deletedAtOf(db, "Packwerk"), null);
  assert.equal(sourceOf(db, "Packwerk"), "manual");
  assert.deepEqual(db.getDictionary(), ["Packwerk"]);
});

test("a case variant does not duplicate the word", () => {
  const db = freshDatabase();
  db.setDictionary(["Qdrant"]);
  db.addDictionaryWords(["qdrant"]);
  assert.equal(db.getDictionary().length, 1);
});

test("non-strings and blanks are dropped rather than stored", () => {
  const db = freshDatabase();
  db.setDictionary(["Packwerk"]);
  db.addDictionaryWords(["  ", "", null, undefined, 42, {}, ["nested"], "Qdrant"]);
  assert.deepEqual([...db.getDictionary()].sort(), ["Packwerk", "Qdrant"]);
});

test("an empty list is a no-op and does not clear the dictionary", () => {
  const db = freshDatabase();
  db.setDictionary(["Packwerk", "Pundit"]);
  db.addDictionaryWords([]);
  assert.deepEqual([...db.getDictionary()].sort(), ["Packwerk", "Pundit"]);
});

test("a non-array is refused rather than silently treated as empty", () => {
  const db = freshDatabase();
  db.setDictionary(["Packwerk"]);
  assert.throws(() => db.addDictionaryWords("Qdrant"), /array/i);
  assert.throws(() => db.addDictionaryWords(null), /array/i);
  assert.deepEqual(db.getDictionary(), ["Packwerk"]);
});

test("the returned list is the full post-write dictionary, which is what the broadcast carries", () => {
  const db = freshDatabase();
  db.setDictionary(["Packwerk"]);
  const returned = db.addDictionaryWords(["Qdrant"]);
  assert.deepEqual([...returned].sort(), ["Packwerk", "Qdrant"]);
});
