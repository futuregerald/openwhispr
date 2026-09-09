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
const SMALLEST_SECONDS_VALUE_THAT_MUST_BE_A_WALL_CLOCK = 1e9;
const MAX_CREDITED_SECONDS_PER_SEGMENT = 30;
const SECONDS_PER_SEGMENT_WHEN_NO_GAP_IS_USABLE = 1;

/** @param {unknown} timestamp */
const toSeconds = (timestamp) => {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return null;
  return Math.abs(timestamp) > SMALLEST_TIMESTAMP_THAT_MUST_BE_EPOCH_MILLISECONDS
    ? timestamp / 1000
    : timestamp;
};

/** @param {number} seconds */
const isWallClock = (seconds) => seconds > SMALLEST_SECONDS_VALUE_THAT_MUST_BE_A_WALL_CLOCK;

/**
 * @param {Array<{ source?: string, timestamp?: number }>} segments
 * @returns {number[]}
 */
export const computeSegmentDurations = (segments) => {
  const list = Array.isArray(segments) ? segments : [];

  /** @type {Map<string, Array<{ index: number, at: number }>>} */
  const timedIndicesBySource = new Map();
  for (let index = 0; index < list.length; index += 1) {
    const at = toSeconds(list[index]?.timestamp);
    if (at == null) continue;
    const source = list[index]?.source ?? "";
    const timed = timedIndicesBySource.get(source);
    if (timed) timed.push({ index, at });
    else timedIndicesBySource.set(source, [{ index, at }]);
  }

  const durations = new Array(list.length).fill(SECONDS_PER_SEGMENT_WHEN_NO_GAP_IS_USABLE);

  for (const timed of timedIndicesBySource.values()) {
    timed.sort((a, b) => a.at - b.at);
    for (let i = 0; i < timed.length - 1; i += 1) {
      const spoken = timed[i];
      const next = timed[i + 1];
      if (isWallClock(spoken.at) !== isWallClock(next.at)) continue;
      const gap = next.at - spoken.at;
      if (gap > 0) durations[spoken.index] = Math.min(gap, MAX_CREDITED_SECONDS_PER_SEGMENT);
    }
  }

  return durations;
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
