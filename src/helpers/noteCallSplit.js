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
  reportFor = null,
}) {
  const { detectCallBoundaries } = await import("./callBoundaries.js");
  const reportOf = reportFor ?? ((segments) => detectCallBoundaries(segments));
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

    const report = reportOf(segments, note);
    if (boundaryCountOf(report) === 0) break;

    let result;
    try {
      result = splitNoteAtBoundary({
        databaseManager,
        noteId,
        report,
        boundaryIndex: report.boundaries.length - 1,
        onNoteCreated,
        childTitle,
        createdAtAnchorMs: createdAtAnchorMsOf(note.created_at),
      });
    } catch (err) {
      return {
        success: false,
        reason: "split-failed-partway",
        error: err.message,
        parentNoteId: noteId,
        childNoteIds,
      };
    }

    if (result.success !== true) {
      lastRefusal = result.reason;
      break;
    }

    childNoteIds.unshift(result.childNoteId);
    if (onNoteChanged) onNoteChanged(databaseManager.getNote(noteId));
  }

  if (childNoteIds.length === 0) return { success: false, reason: lastRefusal, childNoteIds };
  return { success: true, parentNoteId: noteId, childNoteIds };
}

const titleOrEmpty = (title) => (typeof title === "string" ? title.trim() : "");

async function splitNoteAtLine({
  databaseManager,
  noteId,
  lineIndex,
  firstTitle,
  secondTitle,
  onNoteCreated,
  onNoteChanged,
}) {
  const note = databaseManager.getNote(noteId);
  if (!note) return { success: false, reason: "note-not-found" };

  const { splitSafetyOf } = await import("./splitSafety.js");
  const safety = splitSafetyOf(note);
  if (!safety.ok) return { success: false, reason: "unsafe-timing", safetyReason: safety.reason };

  const segments = parseSegments(note.transcript);
  const { cutReportAt, timePositionOfIndex } = await import("./lineCut.js");
  const position = timePositionOfIndex(segments, lineIndex);
  if (position < 1) return { success: false, reason: "invalid-line" };

  let result;
  try {
    result = splitNoteAtBoundary({
      databaseManager,
      noteId,
      report: cutReportAt(segments, [position]),
      boundaryIndex: 0,
      onNoteCreated,
      childTitle: titleOrEmpty(secondTitle),
      createdAtAnchorMs: createdAtAnchorMsOf(note.created_at),
    });
  } catch (err) {
    return { success: false, reason: "split-failed", error: err.message };
  }
  if (result.success !== true) return { success: false, reason: result.reason };

  const renamedParent = titleOrEmpty(firstTitle);
  if (renamedParent !== "" && renamedParent !== note.title) {
    databaseManager.updateNote(noteId, { title: renamedParent });
  }
  if (onNoteChanged) onNoteChanged(databaseManager.getNote(noteId));

  return { success: true, parentNoteId: noteId, childNoteIds: [result.childNoteId] };
}

module.exports = { MAX_CALL_SPLITS, scanNoteCallBoundaries, splitNoteCalls, splitNoteAtLine };
