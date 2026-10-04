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
 * `4 * 60 * 60` — four hours in seconds. A boundary is dropped when either of
 * its own adjacent pieces is longer than this.
 *
 * Grounded in the app's own behaviour, not a guess:
 * `src/helpers/meetingDetectionEngine.js` sets
 * `MAX_AUTO_RECORD_MS = 4 * 60 * 60 * 1000` as the safety cap for an
 * auto-started recording, so a *single* call piece longer than four hours
 * cannot be one auto-recorded call — it is still-welded audio. The number is
 * redeclared here rather than imported, because that module is main-process
 * code with Electron dependencies and this one must stay pure.
 *
 * Measured over all 90 notes in the real library: every piece the detector
 * produces is under 7210s (2h01m) except note 14, whose after-piece is 332296s
 * (92 hours). Splitting note 14 yields a 33-minute note plus a still-welded
 * 92-hour one, which is not an outcome worth offering. The cap separates that
 * one case from every legitimate one with two orders of magnitude to spare.
 *
 * **Drops the boundary; does not refuse the report.** `refused` is reserved for
 * notes that cannot be *read* safely — a missing timestamp, a mixed time base —
 * where the piece partition itself would be wrong. An over-long piece is a
 * well-read note whose seam is simply not worth offering, and refusing the
 * whole report would also discard the other, plausible boundaries of a
 * multi-boundary note. Dropping is the local, conservative choice and matches
 * how `MIN_PIECE_SECONDS` already behaves. For a single-boundary note such as
 * note 14 the user-visible result is identical: nothing is offered.
 *
 * **Ordering against `MIN_PIECE_SECONDS`, and why the two cannot fight.** The
 * cap runs as one pass *after* the minimum-piece loop has reached its fixpoint,
 * against the piece layout that loop settled on. Dropping a boundary only ever
 * merges two pieces, so it can only make pieces longer: the cap's pass can
 * never push a piece back under the five-minute floor, and so never re-opens
 * the loop. The reverse is not true — the loop's drops can lengthen a piece
 * past the cap — which is why the cap runs last. Every surviving boundary is
 * judged against the same fixed layout in a single pass, so the result does not
 * depend on evaluation order and there is no loop in which the two rules could
 * oscillate. The piece left behind after a drop is over-long by construction;
 * that is accepted rather than iterated on, because iterating would throw away
 * every boundary in a note merely because one end of the recording is
 * implausibly long.
 */
export declare const MAX_PIECE_SECONDS: 14400;

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
    maxPieceSeconds?: number;
  }
): CallBoundaryReport;
