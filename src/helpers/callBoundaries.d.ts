import type { BoundarySegment, CallBoundaryReason } from "./callBoundaryScore";

/**
 * One contiguous run of sessions that a split would turn into a single note.
 *
 * `indices` is the cluster membership: positions in the ORIGINAL `segments`
 * array this piece owns, ascending by array position. A splitter must assign
 * segments by this list. `startsAt`/`endsAt` are a summary, and the array is not
 * sorted by time, so walking an index range would orphan and double-assign
 * segments.
 *
 * Across a non-refused report the `pieces` are a true partition: every index in
 * `segments` appears in exactly one piece.
 */
export type CallPiece = {
  /** Indices into the report's own `sessions` ordering, ascending by time. */
  sessionIndices: number[];
  indices: number[];
  count: number;
  /** First and last timestamp in the note's own `unit`, NOT always seconds. */
  startsAt: number;
  endsAt: number;
  /** `endsAt - startsAt`, converted to seconds using `unit`. */
  durationSeconds: number;
};

/**
 * A confirmed seam between two calls. Everything a splitter needs is here, so
 * the detector never has to be re-run to act on one.
 */
export type CallBoundary = {
  /** The gap sits between `sessions[sessionIndex]` and `sessions[sessionIndex + 1]`. */
  sessionIndex: number;
  /** Always seconds, whatever the note's `unit`. */
  gapSeconds: number;
  score: number;
  reasons: CallBoundaryReason[];
  /** Last timestamp before the silence and first after it, in the note's `unit`. */
  gapStartsAt: number;
  gapEndsAt: number;
  beforePieceIndex: number;
  afterPieceIndex: number;
  before: CallPiece;
  after: CallPiece;
};

/**
 * `refused` is set, and `pieces`/`boundaries` are empty, when the note cannot be
 * split safely at all:
 *
 * - `"insufficient-timestamps"` — fewer than two segments carry a finite
 *   timestamp, so there is no series to cluster.
 * - `"unassigned-segments"` — at least one segment belongs to no session. That
 *   covers a missing or non-finite timestamp and, the dangerous case, a note
 *   that mixes epoch-ms with relative-seconds stamps, where the detector
 *   discards the minority time base. Splitting such a note would silently drop
 *   those segments, so no boundary is reported at all.
 *
 * An empty `boundaries` with no `refused` means the note was read successfully
 * and holds one call.
 */
export type CallBoundaryReport = {
  unit: "epoch-ms" | "relative-seconds";
  pieces: CallPiece[];
  boundaries: CallBoundary[];
  refused?: "insufficient-timestamps" | "unassigned-segments";
};

/** Silence at or above this length starts a new candidate session. */
export declare const SESSION_GAP_SECONDS: 30;
/**
 * A session holding fewer segments than this can never sit either side of a
 * boundary. `detectSessions` only *labels* such a session `isFragment`; it
 * neither merges nor drops one, so this rule is enforced here. It is what stops
 * a note with many short clusters and a long silence from shredding into a
 * dozen notes.
 */
export declare const MIN_SESSION_SEGMENTS: 20;
/**
 * A boundary is dropped when it would leave a piece shorter than this. Where a
 * short piece is bordered by two boundaries, the lower-scoring one is dropped
 * first, and the check repeats until every remaining piece clears the floor.
 */
export declare const MIN_PIECE_SECONDS: 300;

/**
 * Finds the seams between back-to-back calls welded into one recording.
 *
 * Wraps `detectSessions` at a 30-second silence gap, then scores each boundary
 * between time-consecutive sessions with `scoreCallBoundary`, reading the
 * segments within `BOUNDARY_WINDOW_SECONDS` either side. `segments` need not be
 * in time order — real transcripts are not — and are sorted here.
 *
 * Read `boundary` from the scorer rather than recomputing its threshold: a
 * one-sided window scores without being a boundary.
 */
export declare function detectCallBoundaries(
  segments: readonly BoundarySegment[],
  options?: {
    gapSeconds?: number;
    minSessionSegments?: number;
    minPieceSeconds?: number;
  }
): CallBoundaryReport;
