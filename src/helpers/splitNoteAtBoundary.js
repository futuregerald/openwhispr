// @ts-check

const { deriveTimestamps } = require("./transcriptSegmentIndex.js");

/** @typedef {import("./callBoundaries").CallBoundaryReport} CallBoundaryReport */

const SPEAKER_TABLES = ["speaker_mappings", "note_speaker_embeddings"];

const assertWrote = (result, what) => {
  if (!result || result.success !== true) {
    throw new Error(`splitNoteAtBoundary: ${what} was refused by the database`);
  }
  return result;
};

const refuse = (reason) => ({ success: false, reason });

const formatUtcSqliteTimestamp = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

const parseSegments = (transcript) => {
  if (typeof transcript !== "string" || transcript.trim() === "") return null;
  try {
    const parsed = JSON.parse(transcript);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const byTimestamp = (a, b) => {
  const left = Number.isFinite(a.timestamp) ? a.timestamp : Number.POSITIVE_INFINITY;
  const right = Number.isFinite(b.timestamp) ? b.timestamp : Number.POSITIVE_INFINITY;
  return left - right;
};

const isPartitionOf = (total, ...groups) => {
  const seen = new Set();
  for (const group of groups) {
    for (const index of group) {
      if (!Number.isInteger(index) || index < 0 || index >= total) return false;
      if (seen.has(index)) return false;
      seen.add(index);
    }
  }
  return seen.size === total;
};

const columnsOf = (db, table) =>
  db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => row.name);

const copySpeakerRows = (db, parentId, childId, speakerIds) => {
  if (speakerIds.length === 0) return;
  const placeholders = speakerIds.map(() => "?").join(", ");
  for (const table of SPEAKER_TABLES) {
    const columns = columnsOf(db, table);
    if (columns.length === 0) continue;
    const projected = columns.map((name) => (name === "note_id" ? "?" : `"${name}"`)).join(", ");
    db.prepare(
      `INSERT OR REPLACE INTO ${table} (${columns.map((name) => `"${name}"`).join(", ")})
       SELECT ${projected} FROM ${table}
       WHERE note_id = ? AND speaker_id IN (${placeholders})`
    ).run(childId, parentId, ...speakerIds);
  }
};

const sliceSecondsOf = (segments, originMs) => {
  let lowest = Number.POSITIVE_INFINITY;
  let highest = Number.NEGATIVE_INFINITY;
  for (const segment of segments) {
    const { offsetMs } = deriveTimestamps(segment && segment.timestamp, originMs);
    if (offsetMs == null) return null;
    if (offsetMs < lowest) lowest = offsetMs;
    if (offsetMs > highest) highest = offsetMs;
  }
  if (!Number.isFinite(lowest) || !Number.isFinite(highest) || lowest < 0) return null;
  return { start: lowest / 1000, end: highest / 1000 };
};

/**
 * Splits one welded recording into two notes at a confirmed call boundary.
 *
 * `report` is a `CallBoundaryReport` whose `pieces` are a true partition of the
 * transcript array the detector was given, and `boundaryIndex` picks the seam
 * within `report.boundaries`. The parent keeps every piece up to and including
 * `beforePieceIndex`; the child takes every piece from `afterPieceIndex` on.
 * Segments move by `indices` membership, so an index range is never walked.
 *
 * Timestamps, `transcript_origin_ms` and `transcript_origin_source` are carried
 * across untouched: both notes describe the same audio file, so a rebased offset
 * would point at the wrong moment in it and a recomputed origin would add the
 * child's offset twice.
 *
 * `onNoteCreated` is required, and is called once with the stored child row
 * after the transaction commits. The renderer broadcast, the Qdrant upsert and
 * the markdown mirror live on the IPC layer rather than on `DatabaseManager`, so
 * without it the child is invisible to the notes list, unfindable by the agent's
 * `search_notes`, and has no mirror file.
 *
 * @param {{
 *   databaseManager: any,
 *   noteId: number,
 *   report: CallBoundaryReport,
 *   boundaryIndex?: number,
 *   onNoteCreated: (note: any) => void,
 *   childTitle?: string,
 *   childContent?: string,
 *   createdAtAnchorMs?: number | null,
 * }} args
 */
function splitNoteAtBoundary({
  databaseManager,
  noteId,
  report,
  boundaryIndex = 0,
  onNoteCreated,
  childTitle,
  childContent,
  createdAtAnchorMs = null,
}) {
  if (!databaseManager || !databaseManager.db) {
    throw new Error("splitNoteAtBoundary: databaseManager is required");
  }
  if (typeof onNoteCreated !== "function") {
    throw new Error(
      "splitNoteAtBoundary: onNoteCreated is required, or the child note gets no broadcast, no vector row and no mirror file"
    );
  }
  if (!report || !Array.isArray(report.pieces) || !Array.isArray(report.boundaries)) {
    throw new Error("splitNoteAtBoundary: report must be a CallBoundaryReport");
  }
  if (report.refused) return refuse("report-refused");

  const boundary = report.boundaries[boundaryIndex];
  if (!boundary) return refuse("no-boundary");

  const parent = databaseManager.getNote(noteId);
  if (!parent) return refuse("note-not-found");

  const segments = parseSegments(parent.transcript);
  if (!segments) return refuse("unreadable-transcript");

  const parentIndices = report.pieces
    .slice(0, boundary.beforePieceIndex + 1)
    .flatMap((piece) => piece.indices);
  const childIndices = report.pieces
    .slice(boundary.afterPieceIndex)
    .flatMap((piece) => piece.indices);

  if (!isPartitionOf(segments.length, parentIndices, childIndices)) {
    return refuse("transcript-does-not-match-report");
  }
  if (parentIndices.length === 0 || childIndices.length === 0) return refuse("empty-piece");

  const parentSegments = parentIndices.map((index) => segments[index]).sort(byTimestamp);
  const childSegments = childIndices.map((index) => segments[index]).sort(byTimestamp);

  const originMs = Number.isSafeInteger(parent.transcript_origin_ms)
    ? parent.transcript_origin_ms
    : null;
  const parentSlice = sliceSecondsOf(parentSegments, originMs);
  const childSlice = sliceSecondsOf(childSegments, originMs);
  if (!parentSlice || !childSlice) return refuse("unresolvable-slice-bounds");

  const createdAtOriginMs =
    originMs ?? (Number.isSafeInteger(createdAtAnchorMs) ? createdAtAnchorMs : null);
  const childStartedAtMs = deriveTimestamps(
    childSegments[0].timestamp,
    createdAtOriginMs
  ).startedAtMs;
  const childCreatedAt =
    childStartedAtMs == null ? parent.created_at : formatUtcSqliteTimestamp(childStartedAtMs);

  const retainedSpeakerIds = [
    ...new Set(
      childSegments
        .map((segment) => segment && segment.speaker)
        .filter((id) => typeof id === "string" && id !== "")
    ),
  ];

  const db = databaseManager.db;
  const run = db.transaction(() => {
    const created = assertWrote(
      databaseManager.saveNote(
        childTitle ?? parent.title,
        childContent ?? "",
        parent.note_type,
        parent.source_file,
        parent.audio_duration_seconds,
        parent.folder_id
      ),
      "creating the child note"
    );
    const childId = created.note.id;

    assertWrote(
      databaseManager.updateNote(childId, {
        transcript: JSON.stringify(childSegments),
        transcript_origin_ms: parent.transcript_origin_ms ?? null,
        transcript_origin_source: parent.transcript_origin_source ?? null,
        mic_audio_path: parent.mic_audio_path ?? null,
        system_audio_path: parent.system_audio_path ?? null,
        split_parent_note_id: noteId,
        slice_start_s: childSlice.start,
        slice_end_s: childSlice.end,
      }),
      "writing the child transcript and slice"
    );

    if (childCreatedAt) {
      assertWrote(
        databaseManager.setNoteCreatedAt(childId, childCreatedAt),
        "stamping the child created_at"
      );
    }

    assertWrote(
      databaseManager.updateNote(noteId, {
        transcript: JSON.stringify(parentSegments),
        split_parent_note_id: noteId,
        slice_start_s: parentSlice.start,
        slice_end_s: parentSlice.end,
      }),
      "trimming the parent transcript"
    );

    copySpeakerRows(db, noteId, childId, retainedSpeakerIds);

    databaseManager._reindexTranscriptNow(noteId);
    databaseManager._reindexTranscriptNow(childId);

    return childId;
  });

  const childNoteId = run();
  onNoteCreated(databaseManager.getNote(childNoteId));

  return {
    success: true,
    parentNoteId: noteId,
    childNoteId,
    parentSegmentCount: parentSegments.length,
    childSegmentCount: childSegments.length,
    parentSlice,
    childSlice,
  };
}

module.exports = { splitNoteAtBoundary };
