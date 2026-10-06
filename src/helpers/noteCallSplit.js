// @ts-check

const { splitNoteAtBoundary } = require("./splitNoteAtBoundary.js");

const MAX_CALL_SPLITS = 8;

const parseSegments = (transcript) => {
  if (typeof transcript !== "string" || transcript.trim() === "") return null;
  try {
    const parsed = JSON.parse(transcript);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const UTC_SQLITE_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/**
 * @param {unknown} createdAt a UTC `YYYY-MM-DD HH:MM:SS` stamp
 * @returns {number | null}
 */
const createdAtAnchorMsOf = (createdAt) => {
  if (typeof createdAt !== "string" || !UTC_SQLITE_TIMESTAMP.test(createdAt)) return null;
  const ms = Date.parse(`${createdAt.replace(" ", "T")}Z`);
  return Number.isSafeInteger(ms) ? ms : null;
};

const boundaryCountOf = (report) =>
  report && !report.refused && Array.isArray(report.boundaries) ? report.boundaries.length : 0;

async function scanNoteCallBoundaries({ databaseManager, noteId }) {
  const note = databaseManager.getNote(noteId);
  if (!note) return { success: false, error: "Note not found" };

  const segments = parseSegments(note.transcript);
  if (!segments) return { success: true, noteId, boundaryCount: 0, callCount: 1 };

  const { detectCallBoundaries } = await import("./callBoundaries.js");
  const boundaryCount = boundaryCountOf(detectCallBoundaries(segments));
  return { success: true, noteId, boundaryCount, callCount: boundaryCount + 1 };
}

async function splitNoteCalls({
  databaseManager,
  noteId,
  onNoteCreated,
  onNoteChanged,
  childTitle = "",
  maxSplits = MAX_CALL_SPLITS,
}) {
  const { detectCallBoundaries } = await import("./callBoundaries.js");
  const childNoteIds = [];
  let lastRefusal = "no-boundary";

  for (let attempt = 0; attempt < maxSplits; attempt += 1) {
    const note = databaseManager.getNote(noteId);
    if (!note) {
      lastRefusal = "note-not-found";
      break;
    }

    const segments = parseSegments(note.transcript);
    if (!segments) {
      lastRefusal = "unreadable-transcript";
      break;
    }

    const report = detectCallBoundaries(segments);
    if (boundaryCountOf(report) === 0) break;

    const result = splitNoteAtBoundary({
      databaseManager,
      noteId,
      report,
      boundaryIndex: report.boundaries.length - 1,
      onNoteCreated,
      childTitle,
      createdAtAnchorMs: createdAtAnchorMsOf(note.created_at),
    });

    if (result.success !== true) {
      lastRefusal = result.reason;
      break;
    }

    childNoteIds.unshift(result.childNoteId);
    if (onNoteChanged) onNoteChanged(databaseManager.getNote(noteId));
  }

  if (childNoteIds.length === 0) return { success: false, reason: lastRefusal };
  return { success: true, parentNoteId: noteId, childNoteIds };
}

module.exports = { MAX_CALL_SPLITS, scanNoteCallBoundaries, splitNoteCalls };
