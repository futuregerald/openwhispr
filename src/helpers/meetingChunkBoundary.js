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

const frameRmsSeries = (pcm24k) => {
  const frames = [];
  const frameBytes = FRAME_SAMPLES * 2;
  for (let offset = 0; offset + frameBytes <= pcm24k.length; offset += frameBytes) {
    let sumSq = 0;
    for (let i = 0; i < FRAME_SAMPLES; i += 1) {
      const sample = pcm24k.readInt16LE(offset + i * 2) / 0x7fff;
      sumSq += sample * sample;
    }
    frames.push(Math.sqrt(sumSq / FRAME_SAMPLES));
  }
  return frames;
};

const createChunkBoundaryFinder = ({ silenceFloorMultiplier = SILENCE_FLOOR_MULTIPLIER } = {}) => {
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
        return { cutSample: totalSamples, reason: "final" };
      }
      if (totalMs < MIN_CHUNK_MS) {
        return { cutSample: null, reason: "below_min" };
      }

      const frames = frameRmsSeries(pcm24k);
      let quietest = Infinity;
      let loudest = 0;
      for (const rms of frames) {
        if (rms < quietest) quietest = rms;
        if (rms > loudest) loudest = rms;
      }

      if (quietest <= loudest * FLOOR_SEPARATION_RATIO) {
        if (noiseFloorRms === 0 || quietest < noiseFloorRms) {
          noiseFloorRms = quietest;
        } else {
          noiseFloorRms = noiseFloorRms * (1 - FLOOR_RISE_WEIGHT) + quietest * FLOOR_RISE_WEIGHT;
        }
      }

      const threshold = Math.max(noiseFloorRms * silenceFloorMultiplier, ABSOLUTE_SILENCE_RMS);
      const holdFrames = Math.ceil(SILENCE_HOLD_MS / FRAME_MS);
      const minFrame = Math.ceil(MIN_CHUNK_MS / FRAME_MS);
      const maxFrame = Math.floor(MAX_CHUNK_MS / FRAME_MS);

      let bestStart = -1;
      let bestEnd = -1;
      let runStart = -1;
      for (let i = 0; i <= frames.length; i += 1) {
        const silent = i < frames.length && frames[i] < threshold;
        if (silent) {
          if (runStart === -1) runStart = i;
          continue;
        }
        if (runStart !== -1) {
          if (i - runStart >= holdFrames && i > minFrame && runStart > 0) {
            bestStart = runStart;
            bestEnd = i;
          }
          runStart = -1;
        }
      }

      if (bestStart !== -1) {
        const midFrame = Math.floor((bestStart + bestEnd) / 2);
        const cutFrame = Math.min(Math.max(midFrame, minFrame), bestEnd - 1);
        return { cutSample: cutFrame * FRAME_SAMPLES, reason: "silence" };
      }

      if (totalMs >= MAX_CHUNK_MS) {
        return { cutSample: maxFrame * FRAME_SAMPLES, reason: "max_chunk" };
      }

      return { cutSample: null, reason: "no_boundary" };
    },
  };
};

module.exports = {
  createChunkBoundaryFinder,
  SAMPLE_RATE,
  FRAME_MS,
  SILENCE_HOLD_MS,
  MIN_CHUNK_MS,
  MAX_CHUNK_MS,
  SILENCE_FLOOR_MULTIPLIER,
  ABSOLUTE_SILENCE_RMS,
  FLOOR_SEPARATION_RATIO,
  FLOOR_RISE_WEIGHT,
};
