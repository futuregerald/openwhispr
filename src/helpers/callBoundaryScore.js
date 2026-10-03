// @ts-check

/** @typedef {{ text?: string | null, speakerName?: string | null, timestamp?: number | null }} BoundarySegment */

export const BOUNDARY_WINDOW_SECONDS = 120;
export const LONG_GAP_SECONDS = 120;
export const FAREWELL_LOOKBACK_SEGMENTS = 3;
export const OPENING_LOOKAHEAD_SEGMENTS = 5;
export const SPEAKER_SIMILARITY_THRESHOLD = 0.5;
export const BOUNDARY_SCORE_THRESHOLD = 3;

export const FAREWELL_CUES = [
  "have to drop",
  "have to run",
  "I'll let you go",
  "talk to you",
  "see you",
  "bye",
  "thanks everyone",
  "good one",
  "that's all I had",
  "any other feedback",
];

export const OPENING_CUES = [
  "can you hear me",
  "you're late",
  "on time",
  "thanks for joining",
  "how are you",
  "how's it going",
  "let me share",
  "give it a minute",
  "waiting for",
];

const FAREWELL_WEIGHT = 2;
const OPENING_WEIGHT = 2;
const TURNOVER_WEIGHT = 2;
const LONG_GAP_WEIGHT = 1;

const normalise = (value) =>
  typeof value === "string"
    ? value
        .toLowerCase()
        .replace(/[^a-z0-9\s]+/g, "")
        .replace(/\s+/g, " ")
        .trim()
    : "";

const NORMALISED_FAREWELL_CUES = FAREWELL_CUES.map(normalise).filter(Boolean);
const NORMALISED_OPENING_CUES = OPENING_CUES.map(normalise).filter(Boolean);

const asSegments = (value) => (Array.isArray(value) ? value : []);

const hasCue = (segments, normalisedCues) =>
  segments.some((segment) => {
    const text = normalise(segment && segment.text);
    if (!text) return false;
    return normalisedCues.some((cue) => text.includes(cue));
  });

const speakerSet = (segments) => {
  const names = new Set();
  for (const segment of segments) {
    const name = normalise(segment && segment.speakerName);
    if (name) names.add(name);
  }
  return names;
};

const jaccard = (left, right) => {
  let shared = 0;
  for (const name of left) {
    if (right.has(name)) shared += 1;
  }
  const union = left.size + right.size - shared;
  return union === 0 ? 1 : shared / union;
};

/**
 * @param {{ before?: BoundarySegment[] | null, after?: BoundarySegment[] | null, gapSeconds?: number | null }} options
 * @returns {{ boundary: boolean, score: number, reasons: string[] }}
 */
export const scoreCallBoundary = (options = {}) => {
  const before = asSegments(options && options.before);
  const after = asSegments(options && options.after);
  const gapSeconds = Number(options && options.gapSeconds);

  const reasons = [];
  let score = 0;

  if (hasCue(before.slice(-FAREWELL_LOOKBACK_SEGMENTS), NORMALISED_FAREWELL_CUES)) {
    reasons.push("farewell-cue");
    score += FAREWELL_WEIGHT;
  }

  if (hasCue(after.slice(0, OPENING_LOOKAHEAD_SEGMENTS), NORMALISED_OPENING_CUES)) {
    reasons.push("opening-cue");
    score += OPENING_WEIGHT;
  }

  const beforeSpeakers = speakerSet(before);
  const afterSpeakers = speakerSet(after);
  if (
    beforeSpeakers.size > 0 &&
    afterSpeakers.size > 0 &&
    jaccard(beforeSpeakers, afterSpeakers) < SPEAKER_SIMILARITY_THRESHOLD
  ) {
    reasons.push("speaker-turnover");
    score += TURNOVER_WEIGHT;
  }

  if (Number.isFinite(gapSeconds) && gapSeconds >= LONG_GAP_SECONDS) {
    reasons.push("long-gap");
    score += LONG_GAP_WEIGHT;
  }

  const bothSidesHaveSegments = before.length > 0 && after.length > 0;

  return {
    boundary: bothSidesHaveSegments && score >= BOUNDARY_SCORE_THRESHOLD,
    score,
    reasons,
  };
};
