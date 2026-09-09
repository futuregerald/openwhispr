// @ts-check

import { lockTranscriptSpeaker } from "./transcriptSpeakerState.js";

/**
 * Folds several speakers into one, over segments the renderer already holds.
 *
 * Deliberately applies to locked segments. The main-process merge skips them, which makes it
 * a no-op on exactly the speakers a user has bothered to name — note 4's speaker_1 is locked
 * on all 257 of its segments. A merge started from the speaker panel is the user changing
 * their own mind, which the lock exists to protect, not to prevent.
 *
 * @template {{ speaker?: string }} T
 * @param {T[]} segments
 * @param {string} primaryId
 * @param {string[]} targetIds
 * @param {string} primaryName
 * @returns {T[]}
 */
export const foldSpeakersInto = (segments, primaryId, targetIds, primaryName) => {
  const list = Array.isArray(segments) ? segments : [];
  const folding = new Set(Array.isArray(targetIds) ? targetIds : []);
  if (!primaryId || folding.size === 0) return list;

  return list.map((segment) =>
    segment && folding.has(/** @type {string} */ (segment.speaker))
      ? /** @type {T} */ (/** @type {unknown} */ (
          lockTranscriptSpeaker(/** @type {any} */ (segment), {
            speaker: primaryId,
            speakerName: primaryName,
            speakerIsPlaceholder: false,
            suggestedName: undefined,
            suggestedProfileId: undefined,
          })
        ))
      : segment
  );
};

export default { foldSpeakersInto };
