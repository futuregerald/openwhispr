// @ts-check

import speakerAssignmentPolicy from "./speakerAssignmentPolicy.js";

const { applyConfirmedSpeaker } = speakerAssignmentPolicy;

export const EPOCH_MS_FLOOR = 1e9;

/** @typedef {Record<string, any>} StoredSegment */

/**
 * @typedef {object} RepairResult
 * @property {StoredSegment[]} segments
 * @property {number} micAttributed
 * @property {number} timestampsNormalised
 * @property {boolean} skippedMixedUnits
 */

/**
 * @param {StoredSegment[]} segments
 * @returns {{ epochOrigin: number | null, skippedMixedUnits: boolean }}
 */
const chooseEpochOriginOrNull = (segments) => {
  const stamps = segments
    .map((segment) => segment.timestamp)
    .filter((timestamp) => Number.isFinite(timestamp));
  if (stamps.length === 0) return { epochOrigin: null, skippedMixedUnits: false };

  const earliest = Math.min(...stamps);
  const everyStampIsEpoch = earliest > EPOCH_MS_FLOOR;
  const someStampIsEpoch = Math.max(...stamps) > EPOCH_MS_FLOOR;

  return {
    epochOrigin: everyStampIsEpoch ? earliest : null,
    skippedMixedUnits: someStampIsEpoch && !everyStampIsEpoch,
  };
};

/**
 * @param {StoredSegment[]} segments
 * @returns {RepairResult}
 */
export const repairSegments = (segments) => {
  const { epochOrigin, skippedMixedUnits } = chooseEpochOriginOrNull(segments);

  let micAttributed = 0;
  let timestampsNormalised = 0;

  const repaired = segments.map((segment) => {
    const next = { ...segment };

    if (next.source === "mic" && !next.speaker) {
      applyConfirmedSpeaker(next, { speaker: "you", speakerIsPlaceholder: false });
      if (next.speaker === "you") micAttributed += 1;
    }

    if (epochOrigin !== null && Number.isFinite(next.timestamp)) {
      next.timestamp = (next.timestamp - epochOrigin) / 1000;
      timestampsNormalised += 1;
    }

    return next;
  });

  return { segments: repaired, micAttributed, timestampsNormalised, skippedMixedUnits };
};
