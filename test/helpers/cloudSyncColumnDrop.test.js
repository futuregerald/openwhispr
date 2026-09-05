const test = require("node:test");
const assert = require("node:assert/strict");
const { requireSqlite } = require("../support/sqlite.js");

const Database = requireSqlite();
const DatabaseManager = require("../../src/helpers/database.js");

// _dropCloudSyncColumns against a real database, without booting the rest of
// DatabaseManager. The method only touches this.db.
function managerOver(db) {
  const manager = Object.create(DatabaseManager.prototype);
  manager.db = db;
  return manager;
}

function legacyDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE transcriptions (id INTEGER PRIMARY KEY, text TEXT, cloud_id TEXT, sync_status TEXT);
    CREATE TABLE custom_dictionary (id INTEGER PRIMARY KEY, word TEXT, cloud_id TEXT);
    CREATE TABLE snippets (id INTEGER PRIMARY KEY, body TEXT);
    CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT);
    CREATE TABLE folders (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE agent_conversations (id INTEGER PRIMARY KEY, title TEXT);
    CREATE INDEX idx_transcriptions_cloud_id ON transcriptions(cloud_id);
  `);
  return db;
}

const columns = (db, table) =>
  new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));

test("the leftover cloud columns and their blocking index are dropped", () => {
  const db = legacyDb();

  const failures = managerOver(db)._dropCloudSyncColumns();

  assert.deepEqual(failures, [], "a clean database reports nothing");
  assert.equal(columns(db, "transcriptions").has("cloud_id"), false);
  assert.equal(columns(db, "transcriptions").has("sync_status"), false);
  assert.equal(columns(db, "custom_dictionary").has("cloud_id"), false);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'idx_transcriptions_cloud_id'").get().n,
    0,
    "an index over the column blocks DROP COLUMN, so it goes first"
  );
});

test("a database that never had the columns is left alone and reports nothing", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE transcriptions (id INTEGER PRIMARY KEY, text TEXT);
    CREATE TABLE custom_dictionary (id INTEGER PRIMARY KEY, word TEXT);
    CREATE TABLE snippets (id INTEGER PRIMARY KEY, body TEXT);
    CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT);
    CREATE TABLE folders (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE agent_conversations (id INTEGER PRIMARY KEY, title TEXT);
  `);

  assert.deepEqual(managerOver(db)._dropCloudSyncColumns(), []);
});

// The point of aggregating. Every drop is individually non-fatal and logged one
// at a time, so a database where they ALL failed used to be indistinguishable
// from one where the work was already done: same silent launch either way.
test("failures are reported together instead of only one line at a time", () => {
  const db = legacyDb();
  const manager = managerOver(db);
  const realExec = db.exec.bind(db);
  db.exec = (sql) => {
    if (sql.includes("DROP COLUMN")) throw new Error("database is locked");
    return realExec(sql);
  };

  const failures = manager._dropCloudSyncColumns();

  assert.equal(failures.length, 3, "transcriptions x2 and custom_dictionary x1");
  assert.deepEqual(
    failures.map((f) => f.target).sort(),
    ["custom_dictionary.cloud_id", "transcriptions.cloud_id", "transcriptions.sync_status"]
  );
  for (const failure of failures) {
    assert.match(failure.error, /database is locked/);
  }
});

test("a failed index drop is reported too, not just the columns", () => {
  const db = legacyDb();
  const manager = managerOver(db);
  const realExec = db.exec.bind(db);
  db.exec = (sql) => {
    if (sql.includes("DROP INDEX")) throw new Error("no write permission");
    return realExec(sql);
  };

  const failures = manager._dropCloudSyncColumns();

  assert.ok(
    failures.some((f) => f.target === "index idx_transcriptions_cloud_id"),
    `expected the index among ${JSON.stringify(failures.map((f) => f.target))}`
  );
});

test("one failure does not stop the other drops", () => {
  const db = legacyDb();
  const manager = managerOver(db);
  const realExec = db.exec.bind(db);
  db.exec = (sql) => {
    if (sql.includes("transcriptions DROP COLUMN cloud_id")) throw new Error("nope");
    return realExec(sql);
  };

  const failures = manager._dropCloudSyncColumns();

  assert.equal(failures.length, 1);
  assert.equal(
    columns(db, "custom_dictionary").has("cloud_id"),
    false,
    "a later table must still be cleaned"
  );
});

test("initialization is not failed by a column that cannot be dropped", () => {
  const db = legacyDb();
  const manager = managerOver(db);
  db.exec = () => {
    throw new Error("everything is broken");
  };

  // An undropped column is inert because nothing reads it. Refusing to launch
  // over one would be worse than leaving it in place.
  assert.doesNotThrow(() => manager._dropCloudSyncColumns());
});
