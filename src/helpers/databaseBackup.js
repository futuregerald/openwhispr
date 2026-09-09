const fs = require("fs");
const path = require("path");

function stamp() {
  return new Date().toISOString().replace(/\.\d+Z$/, "").replace(/:/g, "-");
}

function uniquePath(dir, reason) {
  const base = `transcriptions-${reason}-${stamp()}`;
  let candidate = path.join(dir, `${base}.db`);
  let suffix = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base}-${suffix}.db`);
    suffix += 1;
  }
  return candidate;
}

function countNotes(handle) {
  return handle.prepare("SELECT COUNT(*) AS n FROM notes").get().n;
}

function backupDatabase(db, { userDataDir, reason, openBackup } = {}) {
  const dir = path.join(userDataDir, "backups");
  fs.mkdirSync(dir, { recursive: true });

  const destination = uniquePath(dir, reason);
  db.prepare("VACUUM INTO ?").run(destination);

  const expected = countNotes(db);
  const open = openBackup || ((file) => new (require("better-sqlite3"))(file, { readonly: true }));

  let actual;
  let handle;
  try {
    handle = open(destination);
    actual = countNotes(handle);
  } catch (error) {
    throw new Error(`Backup verification failed: ${destination} could not be read (${error.message})`);
  } finally {
    try {
      handle?.close();
    } catch {
      handle = null;
    }
  }

  if (actual !== expected) {
    throw new Error(
      `Backup verification failed: ${destination} holds ${actual} notes, expected ${expected}`
    );
  }

  return { path: destination, noteCount: expected };
}

module.exports = { backupDatabase };
