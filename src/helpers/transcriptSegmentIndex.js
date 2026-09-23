const crypto = require("crypto");
const debugLogger = require("./debugLogger");
const { parseTranscriptSegments } = require("./transcriptSpeakerState.js");
const { EPOCH_MS_FLOOR } = require("./repairNoteSegments.js");

function readSpeakerMappings(db, noteId) {
  const rows = db
    .prepare(
      "SELECT speaker_id, display_name FROM speaker_mappings WHERE note_id = ? ORDER BY speaker_id"
    )
    .all(noteId);
  const byId = {};
  for (const row of rows) byId[row.speaker_id] = row.display_name;
  return byId;
}

function resolveIndexedSpeakerName(segment, speakerNamesById) {
  if (segment.speakerName && !segment.speakerIsPlaceholder) return segment.speakerName;
  if (segment.speaker && speakerNamesById[segment.speaker]) {
    return speakerNamesById[segment.speaker];
  }
  return null;
}

function deriveTimestamps(rawTimestamp, originMs) {
  if (!Number.isFinite(rawTimestamp)) {
    return { offsetMs: null, startedAtMs: null, kind: "unknown" };
  }
  if (rawTimestamp > EPOCH_MS_FLOOR) {
    return {
      offsetMs: originMs != null ? rawTimestamp - originMs : null,
      startedAtMs: rawTimestamp,
      kind: "absolute",
    };
  }
  const offsetMs = Math.round(rawTimestamp * 1000);
  return {
    offsetMs,
    startedAtMs: originMs != null ? originMs + offsetMs : null,
    kind: originMs != null ? "absolute" : "relative",
  };
}

function hasMixedUnits(segments) {
  let sawEpoch = false;
  let sawRelative = false;
  for (const segment of segments) {
    if (!Number.isFinite(segment.timestamp)) continue;
    if (segment.timestamp > EPOCH_MS_FLOOR) sawEpoch = true;
    else sawRelative = true;
  }
  return sawEpoch && sawRelative;
}

function computeTranscriptHash(transcript, originMs, speakerNamesById) {
  return crypto
    .createHash("sha1")
    .update(`${transcript ?? ""}|${String(originMs)}|${JSON.stringify(speakerNamesById)}`)
    .digest("hex");
}

function segmentsFromTranscript(transcript) {
  const raw = typeof transcript === "string" ? transcript : "";
  if (!raw.trim()) return [];
  if (raw.startsWith("[")) return parseTranscriptSegments(raw);
  return [{ text: raw }];
}

function buildSegmentRows(segments, originMs, speakerNamesById) {
  return segments.map((segment, index) => {
    const { offsetMs, startedAtMs, kind } = deriveTimestamps(segment.timestamp, originMs);
    return {
      seq: index,
      speakerId: segment.speaker ?? null,
      speakerName: resolveIndexedSpeakerName(segment, speakerNamesById),
      text: String(segment.text ?? ""),
      offsetMs,
      startedAtMs,
      timestampKind: kind,
    };
  });
}

function clearNoteFromIndex(db, noteId) {
  db.prepare("DELETE FROM transcript_segments WHERE note_id = ?").run(noteId);
  db.prepare("DELETE FROM transcript_segment_index WHERE note_id = ?").run(noteId);
}

function reshredNote(db, noteId) {
  const note = db
    .prepare("SELECT transcript, transcript_origin_ms, deleted_at FROM notes WHERE id = ?")
    .get(noteId);

  if (!note || note.deleted_at) {
    clearNoteFromIndex(db, noteId);
    return { skipped: false, removed: true, segmentCount: 0, mixedUnits: false };
  }

  const speakerNamesById = readSpeakerMappings(db, noteId);
  const hash = computeTranscriptHash(note.transcript, note.transcript_origin_ms, speakerNamesById);
  const existing = db
    .prepare("SELECT transcript_hash FROM transcript_segment_index WHERE note_id = ?")
    .get(noteId);

  if (existing && existing.transcript_hash === hash) {
    return { skipped: true, removed: false, segmentCount: null, mixedUnits: false };
  }

  const segments = segmentsFromTranscript(note.transcript);
  const rows = buildSegmentRows(segments, note.transcript_origin_ms, speakerNamesById);
  const mixedUnits = hasMixedUnits(segments);

  const deleteSegments = db.prepare("DELETE FROM transcript_segments WHERE note_id = ?");
  const insertSegment = db.prepare(
    `INSERT INTO transcript_segments
       (note_id, seq, speaker_id, speaker_name, text, offset_ms, started_at_ms, timestamp_kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const upsertIndex = db.prepare(
    `INSERT INTO transcript_segment_index
       (note_id, transcript_hash, segment_count, mixed_units, indexed_at)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(note_id) DO UPDATE SET
       transcript_hash = excluded.transcript_hash,
       segment_count = excluded.segment_count,
       mixed_units = excluded.mixed_units,
       indexed_at = CURRENT_TIMESTAMP`
  );

  db.transaction(() => {
    deleteSegments.run(noteId);
    for (const row of rows) {
      insertSegment.run(
        noteId,
        row.seq,
        row.speakerId,
        row.speakerName,
        row.text,
        row.offsetMs,
        row.startedAtMs,
        row.timestampKind
      );
    }
    upsertIndex.run(noteId, hash, rows.length, mixedUnits ? 1 : 0);
  })();

  return { skipped: false, removed: false, segmentCount: rows.length, mixedUnits };
}

const BACKFILL_CHUNK_SIZE = 5;
const BACKFILL_CHUNK_DELAY_MS = 250;
const BACKFILL_PROGRESS_INTERVAL = 50;
const BACKFILL_MAX_FAILURES = 10;

function delay(ms) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function backfillTranscriptSegments(databaseManager, options = {}) {
  const {
    chunkSize = BACKFILL_CHUNK_SIZE,
    delayMs = BACKFILL_CHUNK_DELAY_MS,
    shouldStop = () => false,
    onProgress = null,
  } = options;

  let indexed = 0;
  const failed = new Set();

  for (;;) {
    if (shouldStop()) break;
    if (!databaseManager.db || !databaseManager.db.open) break;

    const pending = databaseManager
      .getPendingTranscriptIndexNoteIds(chunkSize + failed.size)
      .filter((noteId) => !failed.has(noteId))
      .slice(0, chunkSize);
    if (pending.length === 0) break;

    for (const noteId of pending) {
      try {
        reshredNote(databaseManager.db, noteId);
        indexed += 1;
        if (onProgress && indexed % BACKFILL_PROGRESS_INTERVAL === 0) onProgress(indexed);
      } catch (error) {
        debugLogger.error(
          "Transcript segment backfill failed for a note",
          { noteId, error: error.message },
          "transcript-index"
        );
        failed.add(noteId);
        if (failed.size >= BACKFILL_MAX_FAILURES) {
          debugLogger.error(
            "Transcript segment backfill giving up after repeated failures",
            { failures: failed.size },
            "transcript-index"
          );
          return indexed;
        }
      }
      await delay(delayMs);
    }
  }

  return indexed;
}

function startTranscriptSegmentBackfill(databaseManager) {
  if (!databaseManager) return;

  const pending = databaseManager.getSearchIndexStatus().transcript_segments.pending_notes;
  debugLogger.info("Transcript segment backfill starting", { pending }, "transcript-index");

  backfillTranscriptSegments(databaseManager, {
    onProgress: (done) =>
      debugLogger.info("Transcript segment backfill progress", { done }, "transcript-index"),
  })
    .then((indexed) => {
      debugLogger.info("Transcript segment backfill complete", { indexed }, "transcript-index");
      databaseManager.reconcileTranscriptSegments();
    })
    .catch((error) => {
      debugLogger.error(
        "Transcript segment backfill failed",
        { error: error.message },
        "transcript-index"
      );
    });
}

function segmentRowsForNote(db, noteId, limit = null) {
  const stored = db
    .prepare(
      `SELECT note_id, seq, speaker_id, speaker_name, text, offset_ms, started_at_ms, timestamp_kind
       FROM transcript_segments WHERE note_id = ? ORDER BY seq${limit != null ? " LIMIT ?" : ""}`
    )
    .all(...(limit != null ? [noteId, limit] : [noteId]));
  if (stored.length > 0) return stored;

  const note = db
    .prepare("SELECT transcript, transcript_origin_ms FROM notes WHERE id = ?")
    .get(noteId);
  if (!note) return [];

  const speakerNamesById = readSpeakerMappings(db, noteId);
  const parsed = segmentsFromTranscript(note.transcript);
  const segments = limit != null ? parsed.slice(0, limit) : parsed;
  return buildSegmentRows(segments, note.transcript_origin_ms, speakerNamesById).map((row) => ({
    note_id: noteId,
    seq: row.seq,
    speaker_id: row.speakerId,
    speaker_name: row.speakerName,
    text: row.text,
    offset_ms: row.offsetMs,
    started_at_ms: row.startedAtMs,
    timestamp_kind: row.timestampKind,
  }));
}

module.exports = {
  reshredNote,
  segmentRowsForNote,
  readSpeakerMappings,
  backfillTranscriptSegments,
  startTranscriptSegmentBackfill,
  computeTranscriptHash,
  deriveTimestamps,
  resolveIndexedSpeakerName,
};
