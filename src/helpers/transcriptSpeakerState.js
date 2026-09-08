// @ts-check
// Shared by the renderer and the main process. Main `require()`s this file, so it must
// not reach for any renderer global — that is why the parse helper takes an `onError`
// callback instead of importing a logger.

/** @typedef {import("../stores/meetingRecordingStore").TranscriptSegment} TranscriptSegment */
/** @typedef {Pick<TranscriptSegment, "speaker" | "speakerName" | "speakerIsPlaceholder" | "suggestedName" | "suggestedProfileId" | "speakerStatus" | "speakerLocked" | "speakerLockSource">} SpeakerStateFields */
/** @typedef {"provisional" | "confirmed" | "suggested" | "locked"} TranscriptSpeakerStatus */
/** @typedef {"user" | "diarization" | "suggestion"} TranscriptSpeakerLockSource */

const SPEAKER_STATE_FIELDS = [
  "speaker",
  "speakerName",
  "speakerIsPlaceholder",
  "suggestedName",
  "suggestedProfileId",
  "speakerStatus",
  "speakerLocked",
  "speakerLockSource",
];

/**
 * @param {TranscriptSegment} segment
 * @returns {Record<string, unknown>}
 */
const asFields = (segment) => /** @type {any} */ (segment);

/** @param {string} text */
const normalizeText = (text) => text.trim().replace(/\s+/g, " ");

/** @param {TranscriptSegment} segment */
const getSegmentMatchKey = (segment) =>
  [segment.source, segment.timestamp ?? "", normalizeText(segment.text)].join("|");

/**
 * @param {string} [status]
 * @param {boolean} [speakerLocked]
 * @param {TranscriptSpeakerLockSource} [speakerLockSource]
 * @returns {TranscriptSpeakerStatus | undefined}
 */
const canonicalizeTranscriptSpeakerStatus = (status, speakerLocked, speakerLockSource) => {
  if (speakerLocked || speakerLockSource === "user") {
    return "locked";
  }

  switch (status) {
    case "provisional":
    case "confirmed":
    case "suggested":
    case "locked":
      return status;
    case "suggested_profile":
      return "suggested";
    case "user_locked":
      return "locked";
    case "uncertain_overlap":
      return "provisional";
    default:
      return undefined;
  }
};

/**
 * @param {TranscriptSegment} segment
 * @returns {TranscriptSpeakerStatus | undefined}
 */
const pickSpeakerStatus = (segment) => {
  const normalizedStatus = canonicalizeTranscriptSpeakerStatus(
    segment.speakerStatus,
    segment.speakerLocked,
    segment.speakerLockSource
  );
  if (normalizedStatus) return normalizedStatus;
  if (segment.suggestedName && !segment.speakerName) return "suggested";
  if (segment.source === "system" && segment.speakerIsPlaceholder) return "provisional";
  if (segment.speaker && segment.speaker !== "you") return "confirmed";
  return undefined;
};

/** @param {TranscriptSegment} segment */
export const isTranscriptSpeakerLocked = (segment) =>
  !!segment.speakerLocked ||
  segment.speakerLockSource === "user" ||
  canonicalizeTranscriptSpeakerStatus(segment.speakerStatus) === "locked";

/**
 * @param {TranscriptSegment} segment
 * @returns {TranscriptSegment}
 */
export const normalizeTranscriptSegment = (segment) => {
  const speakerStatus = pickSpeakerStatus(segment);
  const speakerLocked =
    !!segment.speakerLocked || segment.speakerLockSource === "user" || speakerStatus === "locked";
  return {
    ...segment,
    speakerStatus,
    speakerLocked,
    speakerLockSource: speakerLocked
      ? (segment.speakerLockSource ?? "user")
      : segment.speakerLockSource,
  };
};

/** @param {TranscriptSegment[]} segments */
export const normalizeTranscriptSegments = (segments) =>
  segments.map((segment) => normalizeTranscriptSegment(segment));

/**
 * @param {TranscriptSegment} segment
 * @param {Partial<SpeakerStateFields>} patch
 */
export const applyTranscriptSpeakerPatch = (segment, patch) =>
  normalizeTranscriptSegment({ ...segment, ...patch });

/**
 * @param {TranscriptSegment} segment
 * @param {Partial<SpeakerStateFields>} [patch]
 */
export const lockTranscriptSpeaker = (segment, patch = {}) =>
  normalizeTranscriptSegment({
    ...segment,
    ...patch,
    speakerLocked: true,
    speakerStatus: "locked",
    speakerLockSource: "user",
  });

/**
 * @param {TranscriptSegment} existing
 * @param {TranscriptSegment} incoming
 */
const mergeSpeakerFields = (existing, incoming) => {
  const merged = { ...incoming };
  const existingFields = asFields(existing);
  const mergedFields = asFields(merged);

  for (const field of SPEAKER_STATE_FIELDS) {
    if (mergedFields[field] === undefined && existingFields[field] !== undefined) {
      mergedFields[field] = existingFields[field];
    }
  }

  if (isTranscriptSpeakerLocked(existing)) {
    // Keep the user's name/lock but let diarization refine the speaker cluster, so one
    // locked label can't freeze a bucket diarization splits into multiple speakers.
    for (const field of SPEAKER_STATE_FIELDS) {
      if (field === "speaker" || field === "speakerIsPlaceholder") continue;
      if (existingFields[field] !== undefined) {
        mergedFields[field] = existingFields[field];
      }
    }
  }

  return normalizeTranscriptSegment(merged);
};

/**
 * @param {TranscriptSegment[]} existingSegments
 * @param {TranscriptSegment[]} incomingSegments
 * @returns {TranscriptSegment[]}
 */
export const mergeTranscriptSegments = (existingSegments, incomingSegments) => {
  if (incomingSegments.length === 0) {
    return normalizeTranscriptSegments(existingSegments);
  }
  if (existingSegments.length === 0) {
    return incomingSegments.map((segment, index) =>
      normalizeTranscriptSegment({ ...segment, id: segment.id || `merged-${index}` })
    );
  }

  /** @type {Map<string, number>} */
  const existingById = new Map();
  /** @type {Map<string, number[]>} */
  const existingByKey = new Map();

  existingSegments.forEach((segment, index) => {
    if (segment.id) existingById.set(segment.id, index);
    const key = getSegmentMatchKey(segment);
    const bucket = existingByKey.get(key);
    if (bucket) bucket.push(index);
    else existingByKey.set(key, [index]);
  });

  /** @type {Set<number>} */
  const usedIndexes = new Set();
  /** @type {Map<number, TranscriptSegment>} */
  const enrichedByIndex = new Map();
  /** @type {TranscriptSegment[]} */
  const unmatchedIncoming = [];

  incomingSegments.forEach((segment, index) => {
    /** @param {number[]} [candidates] */
    const findUnused = (candidates) =>
      candidates?.find((candidateIndex) => !usedIndexes.has(candidateIndex));

    let matchIndex = segment.id ? existingById.get(segment.id) : undefined;
    if (matchIndex !== undefined && usedIndexes.has(matchIndex)) matchIndex = undefined;

    if (matchIndex === undefined) {
      matchIndex = findUnused(existingByKey.get(getSegmentMatchKey(segment)));
    }

    if (matchIndex === undefined) {
      const fallbackIndex = existingSegments.findIndex(
        (candidate, existingIndex) =>
          !usedIndexes.has(existingIndex) &&
          candidate.source === segment.source &&
          candidate.text === segment.text
      );
      if (fallbackIndex >= 0) matchIndex = fallbackIndex;
    }

    if (matchIndex !== undefined) {
      usedIndexes.add(matchIndex);
      enrichedByIndex.set(matchIndex, mergeSpeakerFields(existingSegments[matchIndex], segment));
    } else {
      unmatchedIncoming.push(
        normalizeTranscriptSegment({ ...segment, id: segment.id || `merged-${index}` })
      );
    }
  });

  const preserved = existingSegments.map(
    (segment, index) => enrichedByIndex.get(index) ?? normalizeTranscriptSegment(segment)
  );

  return [...preserved, ...unmatchedIncoming];
};

/** @param {TranscriptSegment[]} segments */
export const serializeTranscriptSegments = (segments) =>
  JSON.stringify(
    segments.map((segment) => ({
      text: segment.text,
      source: segment.source,
      timestamp: segment.timestamp,
      speaker: segment.speaker,
      speakerName: segment.speakerName,
      speakerIsPlaceholder: segment.speakerIsPlaceholder,
      suggestedName: segment.suggestedName,
      suggestedProfileId: segment.suggestedProfileId,
      speakerStatus: segment.speakerStatus,
      speakerLocked: segment.speakerLocked,
      speakerLockSource: segment.speakerLockSource,
    }))
  );

/**
 * Ids are not persisted, so they are re-synthesised on every read. Callers rely on
 * `stored-${i}` being stable for a given transcript.
 *
 * @param {string} raw
 * @param {(message: string, error: unknown) => void} [onError]
 * @returns {TranscriptSegment[]}
 */
export const parseTranscriptSegments = (raw, onError) => {
  if (!raw || !raw.startsWith("[")) return [];
  try {
    const parsed = JSON.parse(raw);
    return normalizeTranscriptSegments(
      parsed.map((s, i) => ({
        id: `stored-${i}`,
        text: s.text,
        source: s.source,
        timestamp: s.timestamp,
        speaker: s.speaker,
        speakerName: s.speakerName,
        speakerIsPlaceholder: s.speakerIsPlaceholder,
        suggestedName: s.suggestedName,
        suggestedProfileId: s.suggestedProfileId,
        speakerStatus: s.speakerStatus,
        speakerLocked: s.speakerLocked,
        speakerLockSource: s.speakerLockSource,
      }))
    );
  } catch (e) {
    onError?.("Failed to parse transcript segments", e);
    return [];
  }
};
