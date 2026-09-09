// @ts-check

/** @typedef {{ timestamp?: number | null }} TimestampedSegment */

/**
 * @typedef {object} WeldedSession
 * @property {number} startIndex lowest index in the ORIGINAL segment array, never the filtered or sorted series
 * @property {number} endIndex highest index in the ORIGINAL segment array, never the filtered or sorted series
 * @property {number} count
 * @property {number} startsAt
 * @property {number} endsAt
 * @property {boolean} isFragment
 */

/**
 * @typedef {object} WeldedSessionReport
 * @property {boolean} usable
 * @property {"epoch-ms" | "relative-seconds"} unit
 * @property {"insufficient-timestamps"} [reason]
 * @property {WeldedSession[]} sessions ascending by time, empty when not usable
 */

const EPOCH_THRESHOLD = 1e9;
const DEFAULT_GAP_SECONDS = 3600;
const DEFAULT_MIN_SESSION_SEGMENTS = 5;

/**
 * @param {readonly TimestampedSegment[]} segments
 * @param {{ gapSeconds?: number, minSessionSegments?: number }} [options]
 * @returns {WeldedSessionReport} `sessions` reports where each session's segments are,
 * NOT a partition of the array. Two properties a consumer must not assume:
 * segments with no timestamp, and those in the discarded time base when the note mixes
 * units, fall in no session at all — so the ranges need not start at 0, need not reach
 * `segments.length - 1`, and can leave holes between them; and because the array is not
 * sorted by time, one session's `[startIndex..endIndex]` can overlap another's. Anything
 * that splits a note by these ranges must therefore assign segments by cluster
 * membership, not by walking the index range, or it will orphan and double-assign them.
 */
export const detectSessions = (segments, options = {}) => {
  const gapSeconds = options.gapSeconds ?? DEFAULT_GAP_SECONDS;
  const minSessionSegments = options.minSessionSegments ?? DEFAULT_MIN_SESSION_SEGMENTS;

  /** @type {{ index: number, value: number }[]} */
  const stamps = [];
  for (let index = 0; index < (segments?.length ?? 0); index += 1) {
    const value = segments[index]?.timestamp;
    if (typeof value === "number" && Number.isFinite(value)) {
      stamps.push({ index, value });
    }
  }

  const epochStamps = stamps.filter((stamp) => stamp.value > EPOCH_THRESHOLD);
  const isEpoch = epochStamps.length >= 2;
  const unit = /** @type {"epoch-ms" | "relative-seconds"} */ (
    isEpoch ? "epoch-ms" : "relative-seconds"
  );
  const series = isEpoch ? epochStamps : stamps.filter((stamp) => stamp.value <= EPOCH_THRESHOLD);

  if (series.length < 2) {
    return { usable: false, unit, reason: "insufficient-timestamps", sessions: [] };
  }

  const sorted = [...series].sort((a, b) => a.value - b.value);
  const gapThreshold = isEpoch ? gapSeconds * 1000 : gapSeconds;

  /** @type {{ index: number, value: number }[][]} */
  const clusters = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].value - sorted[i - 1].value > gapThreshold) {
      clusters.push([sorted[i]]);
    } else {
      clusters[clusters.length - 1].push(sorted[i]);
    }
  }

  const sessions = clusters.map((cluster) => ({
    startIndex: Math.min(...cluster.map((stamp) => stamp.index)),
    endIndex: Math.max(...cluster.map((stamp) => stamp.index)),
    count: cluster.length,
    startsAt: cluster[0].value,
    endsAt: cluster[cluster.length - 1].value,
    isFragment: cluster.length < minSessionSegments,
  }));

  return { usable: true, unit, sessions };
};
