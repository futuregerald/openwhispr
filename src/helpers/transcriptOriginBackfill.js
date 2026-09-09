const fs = require("fs");
const path = require("path");

const debugLogger = require("./debugLogger");

const EPOCH_MS_FLOOR = 1e9;
const BACKUP_PREFIX = "transcriptions-attribution-repair-";
const SPAN_TOLERANCE_SECONDS = 0.001;

function parseSegments(transcript) {
  if (typeof transcript !== "string" || !transcript.startsWith("[")) return null;
  try {
    const parsed = JSON.parse(transcript);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function finiteStamps(segments) {
  return segments.map((segment) => segment.timestamp).filter((value) => Number.isFinite(value));
}

/**
 * A backup is taken on the first repair write of a launch, so any backup newer than the
 * repair that re-based a note already holds that note in relative seconds — the one state
 * whose origin cannot be recovered.
 */
function listRepairBackupsOldestFirst(backupsDir) {
  let names;
  try {
    names = fs.readdirSync(backupsDir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.startsWith(BACKUP_PREFIX) && name.endsWith(".db"))
    .map((name) => {
      const full = path.join(backupsDir, name);
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(full).mtimeMs;
      } catch {
        return null;
      }
      return { name, path: full, mtimeMs };
    })
    .filter(Boolean)
    .sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
}

/**
 * The origin is trusted only when the live copy is demonstrably
 * `(backup − min(backup)) / 1000`. A wrong origin is worse than none, so each check
 * refuses rather than guesses.
 */
function deriveOrigin(backupTranscript, liveSegments) {
  const backupSegments = parseSegments(backupTranscript);
  if (!backupSegments) return null;
  if (backupSegments.length !== liveSegments.length) return null;

  const backupStamps = finiteStamps(backupSegments);
  const liveStamps = finiteStamps(liveSegments);
  if (backupStamps.length === 0) return null;
  if (backupStamps.length !== liveStamps.length) return null;

  const backupMin = Math.min(...backupStamps);
  const backupMax = Math.max(...backupStamps);
  if (backupMin <= EPOCH_MS_FLOOR) return null;

  // Subtracting the minimum leaves the live copy zero-based. A copy that is not has had a
  // stamp moved, which keeps the span while shifting the anchor the span is measured from.
  const liveMin = Math.min(...liveStamps);
  if (liveMin !== 0) return null;

  // A zero span matches every candidate equally, so it is evidence of nothing.
  const backupSpanSeconds = (backupMax - backupMin) / 1000;
  if (backupSpanSeconds <= 0) return null;

  const liveMax = Math.max(...liveStamps);
  const spanDrift = Math.abs(backupSpanSeconds - liveMax);
  if (!(spanDrift <= SPAN_TOLERANCE_SECONDS)) return null;

  return backupMin;
}

// One open per backup, not one per note per backup: this runs at startup before any
// window, and the notes that can never be recovered stay in the candidate set forever.
function readBackupTranscripts(openDatabase, backupPath, noteIds) {
  let db = null;
  try {
    db = openDatabase(backupPath);
    const placeholders = noteIds.map(() => "?").join(", ");
    const rows = db
      .prepare(`SELECT id, transcript FROM notes WHERE id IN (${placeholders})`)
      .all(...noteIds);
    return new Map(rows.map((row) => [row.id, row.transcript]));
  } catch (error) {
    debugLogger.warn("Could not read a repair backup while recovering a transcript origin", {
      backupPath,
      error: error.message,
    });
    return new Map();
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

/**
 * Derives at enqueue time rather than inside the job, so a note whose origin cannot be
 * recovered yet is simply not enqueued. A job that ran and found nothing would be recorded
 * as DONE, and jobStore.insert refuses to re-run a completed key — one unlucky launch would
 * forfeit the recovery permanently.
 */
function findTranscriptOriginBackfills({ databaseManager, backupsDir, openDatabase }) {
  const pending = databaseManager.listNotesMissingTranscriptOrigin();
  if (pending.length === 0) return [];

  const backups = listRepairBackupsOldestFirst(backupsDir);
  if (backups.length === 0) {
    debugLogger.info("No repair backup available, so no transcript origin can be recovered yet", {
      noteCount: pending.length,
    });
    return [];
  }

  const unresolved = new Map();
  for (const row of pending) {
    const liveSegments = parseSegments(row.transcript);
    if (liveSegments) unresolved.set(row.id, liveSegments);
  }
  if (unresolved.size === 0) return [];

  const found = [];
  for (const backup of backups) {
    if (unresolved.size === 0) break;
    const transcripts = readBackupTranscripts(openDatabase, backup.path, [...unresolved.keys()]);
    for (const [noteId, liveSegments] of unresolved) {
      const transcript = transcripts.get(noteId);
      if (transcript == null) continue;
      const originMs = deriveOrigin(transcript, liveSegments);
      if (originMs === null) continue;
      found.push({ noteId, originMs, backup: backup.name });
      unresolved.delete(noteId);
    }
  }

  if (found.length > 0) {
    debugLogger.info("Recovered transcript origins from a repair backup", {
      noteIds: found.map((entry) => entry.noteId),
    });
  }
  return found;
}

function applyTranscriptOriginBackfill({ noteId, originMs, databaseManager }) {
  if (!Number.isFinite(originMs)) {
    debugLogger.warn("Refused to record a transcript origin that is not a number", {
      noteId,
      originMs,
    });
    return { applied: false };
  }
  const written = databaseManager.setTranscriptOriginKeepingUpdatedAt(
    noteId,
    originMs,
    "first-segment"
  );
  return { applied: Boolean(written?.success) };
}

module.exports = {
  findTranscriptOriginBackfills,
  applyTranscriptOriginBackfill,
  listRepairBackupsOldestFirst,
  deriveOrigin,
};
