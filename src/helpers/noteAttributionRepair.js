const fs = require("fs");
const path = require("path");

const debugLogger = require("./debugLogger");
const { repairSegments } = require("./repairNoteSegments.js");
const { backupDatabase } = require("./databaseBackup.js");

const SUMMARY_FILENAME = ".note-attribution-repair.json";
const BACKUP_REASON = "attribution-repair";

const dirsBackedUpThisLaunch = new Set();

function summaryPath(userDataDir) {
  return path.join(userDataDir, SUMMARY_FILENAME);
}

function parseStoredSegments(transcript) {
  if (typeof transcript !== "string" || !transcript.startsWith("[")) return null;
  try {
    const parsed = JSON.parse(transcript);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function assess(transcript) {
  const segments = parseStoredSegments(transcript);
  if (!segments || segments.length === 0) return null;
  const result = repairSegments(segments);
  if (result.micAttributed === 0 && result.timestampsNormalised === 0) return null;
  return result;
}

function findNotesNeedingAttributionRepair(databaseManager) {
  return databaseManager
    .listNoteTranscripts()
    .map((row) => {
      const result = assess(row.transcript);
      if (!result) return null;
      return {
        id: row.id,
        title: row.title,
        micAttributed: result.micAttributed,
        timestampsNormalised: result.timestampsNormalised,
        skippedMixedUnits: result.skippedMixedUnits,
      };
    })
    .filter(Boolean);
}

function readRepairSummary(userDataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(summaryPath(userDataDir), "utf8"));
    if (!Array.isArray(parsed?.notes) || parsed.notes.length === 0) return null;
    return {
      notes: parsed.notes,
      micAttributed: parsed.notes.reduce((total, note) => total + (note.micAttributed || 0), 0),
    };
  } catch {
    return null;
  }
}

function appendRepairSummary(userDataDir, entry) {
  const existing = readRepairSummary(userDataDir);
  const notes = [...(existing?.notes || []), entry];
  try {
    fs.writeFileSync(summaryPath(userDataDir), JSON.stringify({ notes }));
  } catch (error) {
    debugLogger.warn("Could not record the attribution repair summary", {
      error: error.message,
    });
  }
}

function clearRepairSummary(userDataDir) {
  try {
    fs.rmSync(summaryPath(userDataDir), { force: true });
  } catch (error) {
    debugLogger.warn("Could not clear the attribution repair summary", { error: error.message });
  }
}

const NOTHING_DONE = {
  repaired: false,
  micAttributed: 0,
  timestampsNormalised: 0,
  skippedMixedUnits: false,
  backupPath: null,
};

function repairNoteAttribution({ noteId, databaseManager, broadcast, userDataDir, backup }) {
  const note = databaseManager.getNote(noteId);
  if (!note) return { ...NOTHING_DONE };

  const result = assess(note.transcript);
  if (!result) return { ...NOTHING_DONE };

  let backupPath = null;
  if (!dirsBackedUpThisLaunch.has(userDataDir)) {
    const take = backup || (() => backupDatabase(databaseManager.db, { userDataDir, reason: BACKUP_REASON }));
    backupPath = take().path;
    dirsBackedUpThisLaunch.add(userDataDir);
  }

  const written = databaseManager.updateNoteTranscriptKeepingUpdatedAt(
    noteId,
    JSON.stringify(result.segments)
  );
  if (!written?.success) return { ...NOTHING_DONE, backupPath };

  appendRepairSummary(userDataDir, {
    noteId,
    title: note.title,
    micAttributed: result.micAttributed,
    timestampsNormalised: result.timestampsNormalised,
    skippedMixedUnits: result.skippedMixedUnits,
  });

  broadcast("note-updated", written.note);

  debugLogger.info("Repaired stored note attribution", {
    noteId,
    micAttributed: result.micAttributed,
    timestampsNormalised: result.timestampsNormalised,
    skippedMixedUnits: result.skippedMixedUnits,
  });

  return {
    repaired: true,
    micAttributed: result.micAttributed,
    timestampsNormalised: result.timestampsNormalised,
    skippedMixedUnits: result.skippedMixedUnits,
    backupPath,
  };
}

module.exports = {
  findNotesNeedingAttributionRepair,
  repairNoteAttribution,
  readRepairSummary,
  appendRepairSummary,
  clearRepairSummary,
};
