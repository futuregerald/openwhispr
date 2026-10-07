export type BoundarySegment = {
  text?: string | null;
  speakerName?: string | null;
  timestamp?: number | null;
};

/**
 * Stable, machine-readable signal names. Callers and later pipeline phases read
 * these; they appear in this order whenever they fire.
 */
export type CallBoundaryReason = "farewell-cue" | "opening-cue" | "speaker-turnover" | "long-gap";

export type CallBoundaryScore = {
  /**
   * True only when `score >= BOUNDARY_SCORE_THRESHOLD` AND both windows hold at
   * least one segment.
   *
   * What the weights guarantee is narrower than "two signals are always
   * required": the three language and speaker signals weigh 2 each, so none of
   * them reaches 3 alone, and the long gap weighs 1, so silence alone never
   * splits either. But a long gap is a property of the very gap being judged
   * rather than independent evidence, so ONE language or speaker signal plus a
   * gap of at least `LONG_GAP_SECONDS` does reach the threshold.
   */
  boundary: boolean;
  score: number;
  reasons: CallBoundaryReason[];
};

/**
 * Seconds either side of a candidate gap that the CALLER must slice before
 * calling. This module does not filter by timestamp; it trusts the window it is
 * given.
 */
export declare const BOUNDARY_WINDOW_SECONDS: 120;
/** A gap at or above this length scores +1 on its own. */
export declare const LONG_GAP_SECONDS: 120;
/** Farewell cues are searched only in the LAST this-many segments of `before`. */
export declare const FAREWELL_LOOKBACK_SEGMENTS: 3;
/** Opening cues are searched only in the FIRST this-many segments of `after`. */
export declare const OPENING_LOOKAHEAD_SEGMENTS: 5;
/** Speaker-set Jaccard similarity strictly below this scores +2. */
export declare const SPEAKER_SIMILARITY_THRESHOLD: 0.5;
export declare const BOUNDARY_SCORE_THRESHOLD: 3;
/**
 * How many words may follow a cue inside its own clause and still leave the cue
 * counting as a cue. "I have to drop out" is a farewell; "we have to drop the
 * column first" is not, and only the length of the tail after the matched words
 * separates them.
 */
export declare const CUE_TRAILING_WORDS: 2;

export declare const FAREWELL_CUES: readonly string[];
export declare const OPENING_CUES: readonly string[];

/**
 * Scores whether a silence gap is the seam between two separate calls, from the
 * language and speakers either side of it.
 *
 * `before` and `after` are the segments within `BOUNDARY_WINDOW_SECONDS` of the
 * gap, already ordered ascending by timestamp by the caller. Missing or null
 * `text` and `speakerName` are tolerated.
 *
 * Cue matching is case-insensitive and happens per clause. Text is lowercased,
 * apostrophes are dropped (so an apostrophe cue such as "I'll let you go" still
 * matches), and every other punctuation run splits the segment into clauses. A
 * cue matches only when it occupies whole words — both sides of the comparison
 * are space-padded, so "see you" does not match "see your screen" — and only
 * when at most `CUE_TRAILING_WORDS` words follow it inside that clause, so
 * "have to drop" matches "I have to drop out" but not "we have to drop the
 * column first". Transcript text is untrusted input: it is never compiled into
 * a regex and never executed.
 *
 * Empty-set Jaccard decision: when EITHER speaker set is empty (no segment on
 * that side carries a usable `speakerName`), the `speaker-turnover` signal does
 * NOT fire. Absent speaker labels are not evidence that the speakers changed.
 * Separately, an empty `before` or `after` array forces `boundary: false`
 * regardless of score, while `score` and `reasons` still report what fired.
 */
export declare function scoreCallBoundary(options: {
  before?: BoundarySegment[] | null;
  after?: BoundarySegment[] | null;
  gapSeconds?: number | null;
}): CallBoundaryScore;
