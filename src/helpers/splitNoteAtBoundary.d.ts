import type { CallBoundaryReport } from "./callBoundaries";

/**
 * Why a split was declined. Nothing was written in any of these cases.
 *
 * - `"report-refused"` — the detector refused the note itself; see
 *   `CallBoundaryReport.refused`.
 * - `"no-boundary"` — `boundaryIndex` names no boundary in the report.
 * - `"note-not-found"` — no note with that id.
 * - `"unreadable-transcript"` — `notes.transcript` is empty, not JSON, or not an
 *   array.
 * - `"transcript-does-not-match-report"` — the report's pieces are not a
 *   partition of the transcript now stored on the note. This is also what makes
 *   a repeat split a no-op: once the first split has trimmed the parent, the
 *   same report no longer describes it.
 * - `"empty-piece"` — one side of the seam holds no segments.
 * - `"unresolvable-slice-bounds"` — a retained segment has no derivable offset
 *   into the audio file, which happens for an epoch-millisecond transcript with
 *   no `transcript_origin_ms`. Without the bounds the slice columns would be
 *   null and the retranscribe gate could not tell a slice from a whole
 *   recording.
 */
export type SplitRefusal =
  | "report-refused"
  | "no-boundary"
  | "note-not-found"
  | "unreadable-transcript"
  | "transcript-does-not-match-report"
  | "empty-piece"
  | "unresolvable-slice-bounds";

/**
 * Seconds from the start of the shared audio file, so `0` is the first frame of
 * that file and not the first segment of the note. Derived through
 * `deriveTimestamps`, so a relative-seconds and an epoch-millisecond transcript
 * yield the same scale.
 */
export type AudioSlice = {
  /** The first retained utterance's start, so any leading silence is excluded. */
  start: number;
  /**
   * The last retained utterance's `rangeEnd` where the transcript carries one —
   * re-transcription writes it — and that utterance's START otherwise, because a
   * live-captured segment records no end. So for a live-captured transcript this
   * is short by the length of the final utterance, and `end - start`, which is
   * what each note's `audio_duration_seconds` becomes, is short by the same.
   */
  end: number;
};

export type SplitResult =
  | {
      success: true;
      parentNoteId: number;
      childNoteId: number;
      parentSegmentCount: number;
      childSegmentCount: number;
      parentSlice: AudioSlice;
      childSlice: AudioSlice;
    }
  | { success: false; reason: SplitRefusal };

/**
 * Splits one welded recording into two notes at a confirmed call boundary.
 *
 * The parent keeps `report.pieces` up to and including the boundary's
 * `beforePieceIndex`; the child takes every piece from `afterPieceIndex` on.
 * Segments move by `indices` membership, never by walking an index range.
 *
 * Both notes get `split_parent_note_id` set to the parent's own id. Nothing in
 * the app reads that column yet — it is written for a future "show me the other
 * pieces of this recording" query, and for support when someone asks why a note
 * is half a meeting. Two limitations to know before relying on it: splitting a
 * CHILD overwrites the child's `split_parent_note_id` with the child's own id,
 * so the chain back to the original recording is lost after the second split,
 * and nothing enforces that the id still names a live note.
 *
 * Timestamps and the transcript origin are carried across untouched: the two
 * notes describe the same audio file, so a rebased offset would point at the
 * wrong moment in it, and an origin recomputed from the child's first segment
 * would add that offset a second time.
 *
 * `childTitle` defaults to the empty string. Inheriting the parent's title would
 * leave the child with a title that is not one of the app's placeholders, which
 * makes `isRegenerableNoteTitle` answer false, so the title step skips and the
 * child stays named after the parent's call — and the child deliberately carries
 * no `calendar_event_id`, the only other route to a generated title.
 *
 * Each note's `audio_duration_seconds` is set to its own slice length, rounded
 * to whole seconds. Copying the parent's value to both notes made the
 * meeting-time stats (`database.js`'s duration buckets) count one recording
 * twice.
 *
 * `onNoteCreated` is required and throws when absent. It is called once, after
 * the transaction commits, with the stored child row. The renderer broadcast,
 * the Qdrant upsert and the markdown mirror live on the IPC layer rather than on
 * `DatabaseManager`, so a child created without them is missing from the notes
 * list until a refresh, unfindable by the agent's `search_notes`, and has no
 * mirror file.
 *
 * `createdAtAnchorMs` is a fallback used for the child's `created_at` only, for
 * the caller that captured the note's `transcript_origin_ms` before something
 * else nulled it — re-transcription does exactly that, and the pipeline splits
 * afterwards. The order is the live `transcript_origin_ms`, then this anchor,
 * then the parent's own `created_at`. It never reaches the slice bounds or the
 * child's `transcript_origin_ms`, which stay the parent's live values: an origin
 * recomputed into those columns puts the child's transcript hours out.
 *
 * Deliberately **not** copied to the child: `calendar_event_id`, because the
 * event describes one of the calls at most, and `meeting_type_id`, because the
 * post-call pipeline skips classification when it is already set and the child
 * should be classified on its own text.
 */
export declare function splitNoteAtBoundary(args: {
  databaseManager: any;
  noteId: number;
  report: CallBoundaryReport;
  boundaryIndex?: number;
  onNoteCreated: (note: any) => void;
  childTitle?: string;
  childContent?: string;
  createdAtAnchorMs?: number | null;
}): SplitResult;
