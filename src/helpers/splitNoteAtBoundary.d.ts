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
  start: number;
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
 * Segments move by `indices` membership, never by walking an index range, and
 * both notes end up with `split_parent_note_id` set to the parent's own id, so
 * one query returns every piece of a recording.
 *
 * Timestamps and the transcript origin are carried across untouched: the two
 * notes describe the same audio file, so a rebased offset would point at the
 * wrong moment in it, and an origin recomputed from the child's first segment
 * would add that offset a second time.
 *
 * `onNoteCreated` is required and throws when absent. It is called once, after
 * the transaction commits, with the stored child row. The renderer broadcast,
 * the Qdrant upsert and the markdown mirror live on the IPC layer rather than on
 * `DatabaseManager`, so a child created without them is missing from the notes
 * list until a refresh, unfindable by the agent's `search_notes`, and has no
 * mirror file.
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
}): SplitResult;
