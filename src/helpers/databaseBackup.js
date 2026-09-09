const fs = require("fs");
const path = require("path");

const debugLogger = require("./debugLogger");

const RESTORE_INSTRUCTIONS =
  "Restoring is not a plain file copy: this backup is a rollback-journal database while the live one runs in WAL mode. Quit OpenWhispr, delete transcriptions.db-wal and transcriptions.db-shm next to transcriptions.db, then copy this file over transcriptions.db.";

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

const BACKUPS_KEPT = 3;

function backupOrder(dir, name) {
  const suffix = /-(\d+)\.db$/.exec(name);
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(path.join(dir, name)).mtimeMs;
  } catch {
    mtimeMs = 0;
  }
  return { mtimeMs, suffix: suffix ? Number(suffix[1]) : 0 };
}

function pruneOldBackups(dir, reason, keep = BACKUPS_KEPT) {
  let names;
  try {
    names = fs
      .readdirSync(dir)
      .filter((name) => name.startsWith(`transcriptions-${reason}-`) && name.endsWith(".db"));
  } catch (error) {
    debugLogger.warn("Could not list old database backups", { dir, error: error.message });
    return [];
  }

  const newestFirst = names
    .map((name) => ({ name, ...backupOrder(dir, name) }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.suffix - a.suffix);

  const removed = [];
  for (const { name } of newestFirst.slice(keep)) {
    try {
      fs.rmSync(path.join(dir, name), { force: true });
      removed.push(name);
    } catch (error) {
      debugLogger.warn("Could not remove an old database backup", { name, error: error.message });
    }
  }
  return removed;
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

  const backupPath = path.resolve(destination);
  const pruned = pruneOldBackups(dir, reason);

  debugLogger.notice("Database backed up before repair", {
    backupPath,
    noteCount: expected,
    restore: RESTORE_INSTRUCTIONS,
    prunedOlderBackups: pruned.length,
  });

  return { path: backupPath, noteCount: expected, restore: RESTORE_INSTRUCTIONS };
}

module.exports = { backupDatabase, pruneOldBackups, BACKUPS_KEPT, RESTORE_INSTRUCTIONS };
