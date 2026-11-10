"use strict";

const {
  CONFIRM_THRESHOLD,
  SUGGEST_THRESHOLD,
  MARGIN,
  MIN_CLUSTER_SPEECH_S,
  MIN_PROFILE_SPEECH_S,
} = require("./speakerThresholds");

const DEFAULT_THRESHOLDS = {
  confirm: CONFIRM_THRESHOLD,
  suggest: SUGGEST_THRESHOLD,
  margin: MARGIN,
  minClusterSpeechS: MIN_CLUSTER_SPEECH_S,
  minProfileSpeechS: MIN_PROFILE_SPEECH_S,
};

function finiteOrNegInfinity(score) {
  return Number.isFinite(score) ? score : -Infinity;
}

function rankProfilesFor(cluster, profiles, similarity) {
  return profiles
    .map((profile) => ({
      profile,
      score: finiteOrNegInfinity(similarity(cluster.embedding, profile.embedding)),
    }))
    .sort((a, b) => b.score - a.score);
}

function assignClustersToProfiles({ clusters = [], profiles = [], similarity, thresholds = {} }) {
  const { confirm, suggest, margin, minClusterSpeechS, minProfileSpeechS } = {
    ...DEFAULT_THRESHOLDS,
    ...thresholds,
  };

  const ranked = clusters.map((cluster) => ({
    cluster,
    ranking: rankProfilesFor(cluster, profiles, similarity),
  }));

  const eligible = [];
  for (const { cluster, ranking } of ranked) {
    const [best, runnerUp] = ranking;
    if (!best || best.score < confirm) continue;
    if (!(cluster.speechS >= minClusterSpeechS)) continue;
    if (!(best.profile.totalSpeechS >= minProfileSpeechS)) continue;
    if (best.score - (runnerUp?.score ?? -Infinity) < margin) continue;
    eligible.push({ cluster, profile: best.profile, score: best.score });
  }

  eligible.sort((a, b) => b.score - a.score);
  const confirmedByCluster = new Map();
  const confirmedByProfile = new Map();
  const mergeCandidates = [];
  for (const pair of eligible) {
    const holder = confirmedByProfile.get(pair.profile.id);
    if (holder) {
      const resemblance = finiteOrNegInfinity(
        similarity(holder.cluster.embedding, pair.cluster.embedding)
      );
      if (resemblance >= confirm) {
        mergeCandidates.push({
          keepSpeakerId: holder.cluster.speakerId,
          dropSpeakerId: pair.cluster.speakerId,
          profileId: pair.profile.id,
        });
      }
      continue;
    }
    confirmedByCluster.set(pair.cluster.speakerId, pair);
    confirmedByProfile.set(pair.profile.id, pair);
  }

  const confirmed = [];
  const suggested = [];
  for (const { cluster, ranking } of ranked) {
    const pair = confirmedByCluster.get(cluster.speakerId);
    if (pair) {
      confirmed.push({
        speakerId: cluster.speakerId,
        profileId: pair.profile.id,
        score: pair.score,
      });
      continue;
    }
    const best = ranking[0];
    if (best && best.score >= suggest) {
      suggested.push({
        speakerId: cluster.speakerId,
        profileId: best.profile.id,
        score: best.score,
      });
    }
  }

  return { confirmed, suggested, mergeCandidates };
}

module.exports = { assignClustersToProfiles, DEFAULT_THRESHOLDS };
