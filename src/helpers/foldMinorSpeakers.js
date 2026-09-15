const MIN_SPEAKER_SECONDS = 30;
const MIN_SPEAKER_SHARE = 0.3;
const NEAR_FLOOR_SECONDS = 15;

function secondsBySpeaker(segments) {
  const totals = new Map();
  for (const segment of segments) {
    totals.set(segment.speaker, (totals.get(segment.speaker) || 0) + (segment.end - segment.start));
  }
  return totals;
}

function foldFloorFor(
  totals,
  { minSpeakerSeconds = MIN_SPEAKER_SECONDS, minSpeakerShare = MIN_SPEAKER_SHARE } = {}
) {
  const totalSeconds = [...totals.values()].reduce((sum, seconds) => sum + seconds, 0);
  return Math.min(minSpeakerSeconds, minSpeakerShare * totalSeconds);
}

function gapBetween(a, b) {
  if (a.end < b.start) return b.start - a.end;
  if (b.end < a.start) return a.start - b.end;
  return 0;
}

function overlapBetween(a, b) {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

function isCloser(segment, candidate, current) {
  const candidateGap = gapBetween(segment, candidate);
  const currentGap = gapBetween(segment, current);
  if (candidateGap !== currentGap) return candidateGap < currentGap;
  return overlapBetween(segment, candidate) > overlapBetween(segment, current);
}

function foldMinorSpeakers(segments, options = {}) {
  if (!Array.isArray(segments) || segments.length === 0) return segments;

  const totals = secondsBySpeaker(segments);
  const floor = foldFloorFor(totals, options);
  let kept = new Set(
    [...totals].filter(([, seconds]) => seconds >= floor).map(([speaker]) => speaker)
  );
  if (kept.size === 0) {
    const [largest] = [...totals].sort((a, b) => b[1] - a[1])[0];
    kept = new Set([largest]);
  }

  const keptSegments = segments.filter((segment) => kept.has(segment.speaker));

  return segments.map((segment) => {
    if (kept.has(segment.speaker)) return segment;
    let nearest = keptSegments[0];
    for (const candidate of keptSegments) {
      if (isCloser(segment, candidate, nearest)) nearest = candidate;
    }
    return { ...segment, speaker: nearest.speaker };
  });
}

module.exports = {
  foldMinorSpeakers,
  foldFloorFor,
  secondsBySpeaker,
  MIN_SPEAKER_SECONDS,
  MIN_SPEAKER_SHARE,
  NEAR_FLOOR_SECONDS,
};
