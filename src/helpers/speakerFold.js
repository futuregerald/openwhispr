// @ts-check

import { lockTranscriptSpeaker } from "./transcriptSpeakerState.js";

/**
 * Folds several speakers into one, over segments the renderer already holds.
 *
 * Deliberately applies to locked segments. The lock stops automatic relabelling from
 * overwriting a name a person chose; a merge started from the speaker panel IS that person
 * choosing, so skipping locked segments there makes the button a no-op on exactly the
 * speakers someone has bothered to name.
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
