"use strict";

const { MATCH_THRESHOLD, MATCH_MARGIN } = require("./liveSpeakerMatching");

/**
 * Classifies one speaker profile against the unmapped speakers of one note, and
 * returns at most one of them: { outcome: "match" | "suggest", speakerId,
 * confidence }, or null when nothing is close enough.
 *
 * A near-tie is deliberately a SUGGESTION rather than a rejection. Whether two
 * speakers scoring alike are two people or one over-split person is not settled
 * here -- liveSpeakerMatching's header records over-splitting as an observed
 * production failure, and issue #43 is the measurement that would decide it. A
 * suggestion is correct under either reading, because the user answers it.
 *
 * There is deliberately no high-confidence waiver of the margin. Live matching
 * waives it above 0.8, where a near-tie means two clusters of one voice to
 * merge. Here the speakers are already separated, so a high-confidence near-tie
 * is the riskiest thing to auto-confirm, not the safest.
 */
function classifyRetroactiveMatch(profileEmbedding, candidates, similarityOf) {
  let best = null;
  let bestScore = -Infinity;
  let runnerUp = -Infinity;

  for (const candidate of candidates || []) {
    const score = similarityOf(profileEmbedding, candidate.embedding);
    if (!Number.isFinite(score)) continue;
    if (score > bestScore) {
      runnerUp = bestScore;
      bestScore = score;
      best = candidate;
    } else if (score > runnerUp) {
      runnerUp = score;
    }
  }

  if (!best || bestScore < MATCH_THRESHOLD) return null;
  if (best.mapped) return null;

  const ambiguous = bestScore - runnerUp < MATCH_MARGIN;
  return {
    outcome: ambiguous ? "suggest" : "match",
    speakerId: best.speakerId,
    confidence: bestScore,
  };
}

module.exports = { classifyRetroactiveMatch, MATCH_THRESHOLD, MATCH_MARGIN };
