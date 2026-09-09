const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { requireSqlite } = require("../support/sqlite.js");

const Database = requireSqlite();
const { backupDatabase } = require("../../src/helpers/databaseBackup.js");

function seededDb(noteCount = 3) {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT, transcript TEXT)");
  const insert = db.prepare("INSERT INTO notes (title, transcript) VALUES (?, ?)");
  for (let i = 0; i < noteCount; i += 1) insert.run(`note ${i}`, "[]");
  return db;
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-backup-"));
}

test("the backup lands under backups/ and holds the same notes", () => {
  const db = seededDb(3);
  const userDataDir = tempDir();

  const result = backupDatabase(db, { userDataDir, reason: "attribution-repair" });

  assert.equal(path.dirname(result.path), path.join(userDataDir, "backups"));
  assert.ok(fs.existsSync(result.path), "the backup file must exist");
  assert.equal(result.noteCount, 3);

  const restored = new Database(result.path, { readonly: true });
  assert.equal(restored.prepare("SELECT COUNT(*) AS n FROM notes").get().n, 3);
  restored.close();
});

test("the backup filename says what it was taken for and when", () => {
  const db = seededDb(1);
  const userDataDir = tempDir();

  const result = backupDatabase(db, { userDataDir, reason: "attribution-repair" });

  assert.match(
    path.basename(result.path),
    /^transcriptions-attribution-repair-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.db$/
  );
});

test("a second backup never overwrites the first", () => {
  const db = seededDb(2);
  const userDataDir = tempDir();

  const first = backupDatabase(db, { userDataDir, reason: "attribution-repair" });
  const second = backupDatabase(db, { userDataDir, reason: "attribution-repair" });

  assert.notEqual(first.path, second.path);
  assert.ok(fs.existsSync(first.path), "overwriting the backup destroys the rollback path");
});

test("a backup that does not read back with the same note count is rejected", () => {
  const db = seededDb(4);
  const userDataDir = tempDir();

  assert.throws(
    () =>
      backupDatabase(db, {
        userDataDir,
        reason: "attribution-repair",
        openBackup: () => ({
          prepare: () => ({ get: () => ({ n: 1 }) }),
          close: () => {},
        }),
      }),
    /backup verification failed/i
  );
});

test("a backup that cannot be opened at all is rejected", () => {
  const db = seededDb(4);
  const userDataDir = tempDir();

  assert.throws(
    () =>
      backupDatabase(db, {
        userDataDir,
        reason: "attribution-repair",
        openBackup: () => {
          throw new Error("file is not a database");
        },
      }),
    /backup verification failed/i
  );
});

test("the verified backup is closed rather than left holding the file", () => {
  const db = seededDb(2);
  const userDataDir = tempDir();
  let closed = false;

  backupDatabase(db, {
    userDataDir,
    reason: "attribution-repair",
    openBackup: () => ({
      prepare: () => ({ get: () => ({ n: 2 }) }),
      close: () => {
        closed = true;
      },
    }),
  });

  assert.equal(closed, true);
});
