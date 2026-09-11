// @ts-check

import { computeSegmentDurations } from "./speakerTalkTime.js";

const SEGMENTS_INTO_A_SPEAKER_STILL_CONSIDERED_EARLY = 12;
// The two captures do not start together, so a system-anchored cue can land just before the
// mic file begins. Measured skew reaches 2.2 s; beyond this the cue belongs to another track.
const SECONDS_A_CUE_MAY_PRECEDE_A_TRACK = 5;

/**
 * @typedef {object} AuditionCue
 * @property {number} seconds
 * @property {"mic" | "system"} track
 */

/**
 * Where to start playing so the user hears this speaker actually speaking.
 *
 * Takes every segment, not just this speaker's: a turn lasts until the next segment in the
 * TRACK, so a speaker's own segments cannot measure one. Given only their own, a one-word
 * utterance followed by a long absence measures as a long turn, which selects exactly the
 * segments this exists to skip.
 *
 * @param {Array<{ speaker?: string, source?: string, timestamp?: number }>} segments
 * @param {string} speakerId
 * @param {{ systemDuration?: number | null, micDuration?: number | null }} tracks
 * @returns {AuditionCue | null}
 */
export const resolveSpeakerAuditionCue = (segments, speakerId, tracks) => {
  const list = Array.isArray(segments) ? segments : [];
  if (!speakerId || list.length === 0) return null;

  const durations = computeSegmentDurations(list);

  const durationFor = {
    mic: Number.isFinite(tracks?.micDuration) ? Number(tracks.micDuration) : null,
    system: Number.isFinite(tracks?.systemDuration) ? Number(tracks.systemDuration) : null,
  };

  // The mic file's own zero. A longer mic track means it started earlier, so the same instant
  // sits further into it. Approximate: the two captures do not stop together, which adds
  // roughly half a second of skew.
  const shiftFor = {
    mic:
      durationFor.mic !== null && durationFor.system !== null
        ? durationFor.mic - durationFor.system
        : 0,
    system: 0,
  };

  // Judged per segment, not per speaker: one stray segment on the other source must not drag
  // every other cue onto a track whose zero it was never measured against.
  const playable = [];
  for (let index = 0; index < list.length; index += 1) {
    const segment = list[index];
    if (!segment || segment.speaker !== speakerId) continue;
    const at = segment.timestamp;
    if (typeof at !== "number" || !Number.isFinite(at)) continue;

    const track = /** @type {"mic" | "system"} */ (segment.source === "mic" ? "mic" : "system");
    const duration = durationFor[track];
    if (duration === null || duration <= 0) continue;

    // An epoch stamp is not an offset into anything, and a cue for the other track can land
    // far before this one begins. Both fall outside a real track's extent.
    const shifted = at + shiftFor[track];
    if (shifted >= duration || shifted < -SECONDS_A_CUE_MAY_PRECEDE_A_TRACK) continue;

    playable.push({ at: shifted, heldFor: durations[index], track });
  }
  if (playable.length === 0) return null;

  const early = playable
    .sort((a, b) => a.at - b.at)
    .slice(0, SEGMENTS_INTO_A_SPEAKER_STILL_CONSIDERED_EARLY);

  const best = [...early].sort((a, b) => b.heldFor - a.heldFor || a.at - b.at)[0];
  return { seconds: Math.max(0, best.at), track: best.track };
};

export default { resolveSpeakerAuditionCue };
