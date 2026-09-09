const { isSpeakerLocked, applyConfirmedSpeaker } = require("./speakerAssignmentPolicy");

function normalizeMergeIds(mergeIds, keepId) {
  const list = Array.isArray(mergeIds) ? mergeIds : [mergeIds];
  const seen = new Set();
  for (const id of list) {
    if (typeof id !== "string" || id === "" || id === keepId) continue;
    seen.add(id);
  }
  return seen;
}

function mergeSpeakerSegments(segments, keepId, mergeIds) {
  const list = Array.isArray(segments) ? segments : [];
  const targets = normalizeMergeIds(mergeIds, keepId);
  const keepSeg = list.find((s) => s?.speaker === keepId);
  const keepName = keepSeg?.speakerName || keepId;
  const keepIsPlaceholder = keepSeg ? keepSeg.speakerIsPlaceholder !== false : true;

  let mergedCount = 0;
  let skippedLockedCount = 0;

  const nextSegments = list.map((seg) => {
    if (!seg || !targets.has(seg.speaker)) return seg;
    if (isSpeakerLocked(seg)) {
      skippedLockedCount += 1;
      return seg;
    }
    mergedCount += 1;
    return applyConfirmedSpeaker(
      { ...seg },
      {
        speaker: keepId,
        speakerName: keepName,
        speakerIsPlaceholder: keepIsPlaceholder,
      }
    );
  });

  return { segments: nextSegments, mergedCount, skippedLockedCount };
}

function renameSpeakerSegments(segments, speakerId, newName) {
  const list = Array.isArray(segments) ? segments : [];
  let renamedCount = 0;
  let skippedLockedCount = 0;

  const nextSegments = list.map((seg) => {
    if (!seg || seg.speaker !== speakerId) return seg;
    if (isSpeakerLocked(seg)) {
      skippedLockedCount += 1;
      return seg;
    }
    renamedCount += 1;
    return applyConfirmedSpeaker({ ...seg }, { speakerName: newName, speakerIsPlaceholder: false });
  });

  return { segments: nextSegments, renamedCount, skippedLockedCount };
}

module.exports = {
  mergeSpeakerSegments,
  renameSpeakerSegments,
};
