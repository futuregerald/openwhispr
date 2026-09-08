const SAMPLE_RATE = 24000;
const FRAME_MS = 20;
const SILENCE_HOLD_MS = 200;
const MIN_CHUNK_MS = 2000;
const MAX_CHUNK_MS = 6000;
const SILENCE_FLOOR_MULTIPLIER = 2.5;
const ABSOLUTE_SILENCE_RMS = 0.0015;
const FLOOR_SEPARATION_RATIO = 0.25;
const FLOOR_RISE_WEIGHT = 0.1;

const FRAME_SAMPLES = (FRAME_MS / 1000) * SAMPLE_RATE;

const frameRmsSeries = (pcm24k, frameSamples = FRAME_SAMPLES) => {
  const frames = [];
  const frameBytes = frameSamples * 2;
  for (let offset = 0; offset + frameBytes <= pcm24k.length; offset += frameBytes) {
    let sumSq = 0;
    for (let i = 0; i < frameSamples; i += 1) {
      const sample = pcm24k.readInt16LE(offset + i * 2) / 0x7fff;
      sumSq += sample * sample;
    }
    frames.push(Math.sqrt(sumSq / frameSamples));
  }
  return frames;
};

const createChunkBoundaryFinder = ({
  silenceFloorMultiplier = SILENCE_FLOOR_MULTIPLIER,
  frameMs = FRAME_MS,
  silenceHoldMs = SILENCE_HOLD_MS,
  minChunkMs = MIN_CHUNK_MS,
  maxChunkMs = MAX_CHUNK_MS,
  absoluteSilenceRms = ABSOLUTE_SILENCE_RMS,
  floorSeparationRatio = FLOOR_SEPARATION_RATIO,
  floorRiseWeight = FLOOR_RISE_WEIGHT,
} = {}) => {
  const frameSamples = (frameMs / 1000) * SAMPLE_RATE;
  const holdFrames = Math.ceil(silenceHoldMs / frameMs);
  const minFrame = Math.ceil(minChunkMs / frameMs);
  const maxFrame = Math.floor(maxChunkMs / frameMs);

  let noiseFloorRms = 0;

  return {
    reset() {
      noiseFloorRms = 0;
    },
    getNoiseFloorRms() {
      return noiseFloorRms;
    },
    findCut(pcm24k, { final = false } = {}) {
      const totalSamples = Math.floor(pcm24k.length / 2);
      const totalMs = (totalSamples / SAMPLE_RATE) * 1000;

      if (final) {
        return { cutSampleAt24k: totalSamples, reason: "final", threshold: null };
      }
      if (totalMs < minChunkMs) {
        return { cutSampleAt24k: null, reason: "below_min", threshold: null };
      }

      const frames = frameRmsSeries(pcm24k, frameSamples);
      let quietest = Infinity;
      let loudest = 0;
      for (const rms of frames) {
        if (rms < quietest) quietest = rms;
        if (rms > loudest) loudest = rms;
      }

      if (quietest <= loudest * floorSeparationRatio) {
        if (noiseFloorRms === 0 || quietest < noiseFloorRms) {
          noiseFloorRms = quietest;
        } else {
          noiseFloorRms = noiseFloorRms * (1 - floorRiseWeight) + quietest * floorRiseWeight;
        }
      }

      const threshold = Math.max(noiseFloorRms * silenceFloorMultiplier, absoluteSilenceRms);

      let bestStart = -1;
      let bestEnd = -1;
      if (loudest >= threshold) {
        let runStart = -1;
        for (let i = 0; i <= frames.length; i += 1) {
          const silent = i < frames.length && frames[i] < threshold;
          if (silent) {
            if (runStart === -1) runStart = i;
            continue;
          }
          if (runStart !== -1) {
            if (i - runStart >= holdFrames && i > minFrame && runStart < maxFrame) {
              bestStart = runStart;
              bestEnd = i;
            }
            runStart = -1;
          }
        }
      }

      if (bestStart !== -1) {
        const midFrame = Math.floor((bestStart + bestEnd) / 2);
        const cutFrame = Math.min(Math.max(midFrame, minFrame), bestEnd - 1, maxFrame);
        return { cutSampleAt24k: cutFrame * frameSamples, reason: "silence", threshold };
      }

      if (totalMs >= maxChunkMs) {
        return { cutSampleAt24k: maxFrame * frameSamples, reason: "max_chunk", threshold };
      }

      return { cutSampleAt24k: null, reason: "no_boundary", threshold };
    },
  };
};

module.exports = {
  createChunkBoundaryFinder,
  frameRmsSeries,
  SAMPLE_RATE,
  FRAME_MS,
  FRAME_SAMPLES,
  SILENCE_HOLD_MS,
  MIN_CHUNK_MS,
  MAX_CHUNK_MS,
  SILENCE_FLOOR_MULTIPLIER,
  ABSOLUTE_SILENCE_RMS,
  FLOOR_SEPARATION_RATIO,
  FLOOR_RISE_WEIGHT,
};
