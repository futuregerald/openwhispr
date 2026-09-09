// @ts-check

/**
 * @typedef {object} SpeakerStat
 * @property {string} id
 * @property {string} name
 * @property {boolean} isPlaceholder
 * @property {number} segmentCount
 * @property {number} talkTimeSeconds
 * @property {number} talkTimePercent
 */

const SMALLEST_TIMESTAMP_THAT_MUST_BE_EPOCH_MILLISECONDS = 1e10;
const MAX_SECONDS_BEFORE_A_GAP_READS_AS_A_CLOCK_CHANGE = 300;
const SECONDS_PER_SEGMENT_WHEN_NO_GAP_IS_USABLE = 1;

/** @param {unknown} timestamp */
const toSeconds = (timestamp) => {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return null;
  return Math.abs(timestamp) > SMALLEST_TIMESTAMP_THAT_MUST_BE_EPOCH_MILLISECONDS
    ? timestamp / 1000
    : timestamp;
};

/** @param {number[]} values */
const median = (values) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};

/**
 * @param {Array<{ source?: string, timestamp?: number }>} segments
 * @returns {number[]}
 */
export const computeSegmentDurations = (segments) => {
  const list = Array.isArray(segments) ? segments : [];
  const nextIndexBySource = new Map();
  /** @type {Array<number | null>} */
  const raw = new Array(list.length).fill(null);

  for (let i = list.length - 1; i >= 0; i -= 1) {
    const source = list[i]?.source ?? "";
    const nextIndex = nextIndexBySource.get(source);
    if (nextIndex != null) {
      const start = toSeconds(list[i]?.timestamp);
      const end = toSeconds(list[nextIndex]?.timestamp);
      if (start != null && end != null) {
        const delta = end - start;
        if (delta > 0 && delta <= MAX_SECONDS_BEFORE_A_GAP_READS_AS_A_CLOCK_CHANGE) raw[i] = delta;
      }
    }
    nextIndexBySource.set(source, i);
  }

  const fallback =
    median(raw.filter((d) => d != null)) ?? SECONDS_PER_SEGMENT_WHEN_NO_GAP_IS_USABLE;
  return raw.map((d) => (d == null ? fallback : d));
};

/**
 * @param {Array<{ speaker?: string, speakerName?: string, speakerIsPlaceholder?: boolean, source?: string, timestamp?: number }>} segments
 * @returns {SpeakerStat[]}
 */
export const computeSpeakerStats = (segments) => {
  const list = Array.isArray(segments) ? segments : [];
  const durations = computeSegmentDurations(list);
  /** @type {Map<string, SpeakerStat>} */
  const map = new Map();
  let totalDuration = 0;

  list.forEach((seg, index) => {
    if (!seg?.speaker) return;
    const duration = durations[index];
    totalDuration += duration;

    const existing = map.get(seg.speaker);
    if (existing) {
      existing.segmentCount += 1;
      existing.talkTimeSeconds += duration;
      if (seg.speakerName && !seg.speakerIsPlaceholder) {
        existing.name = seg.speakerName;
        existing.isPlaceholder = false;
      }
      return;
    }

    map.set(seg.speaker, {
      id: seg.speaker,
      name: seg.speakerName || seg.speaker,
      isPlaceholder: seg.speakerIsPlaceholder !== false,
      segmentCount: 1,
      talkTimeSeconds: duration,
      talkTimePercent: 0,
    });
  });

  for (const stat of map.values()) {
    stat.talkTimePercent =
      totalDuration > 0 ? Math.round((stat.talkTimeSeconds / totalDuration) * 100) : 0;
  }

  return Array.from(map.values()).sort((a, b) => b.talkTimeSeconds - a.talkTimeSeconds);
};
