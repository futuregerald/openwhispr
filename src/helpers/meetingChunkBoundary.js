const SAMPLE_RATE = 24000;
const FRAME_MS = 20;
const SILENCE_HOLD_MS = 200;
const MIN_CHUNK_MS = 2000;
const MAX_CHUNK_MS = 6000;
const SILENCE_FLOOR_MULTIPLIER = 2.5;
const ABSOLUTE_SILENCE_RMS = 0.0015;
const FLOOR_SEPARATION_RATIO = 0.25;
const FLOOR_RISE_WEIGHT = 0.1;

const FRAME_SAMPLES = (FRAME_MS * SAMPLE_RATE) / 1000;

const frameRmsSeries = (pcm24k, frameSamples) => {
  if (!Number.isInteger(frameSamples) || frameSamples <= 0) {
    throw new RangeError(
      `frameRmsSeries requires an explicit positive integer frameSamples, got ${frameSamples}`
    );
  }
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
  if (!Number.isInteger(frameMs) || frameMs <= 0) {
    throw new RangeError(
      `frameMs must be a positive integer number of milliseconds, got ${frameMs}`
    );
  }
  const frameSamples = (frameMs * SAMPLE_RATE) / 1000;
  if (!Number.isInteger(frameSamples) || frameSamples <= 0) {
    throw new RangeError(
      `frameMs ${frameMs} does not yield a whole number of samples at ${SAMPLE_RATE} Hz`
    );
  }
  if (!(silenceHoldMs > 0)) {
    throw new RangeError(`silenceHoldMs must be greater than 0, got ${silenceHoldMs}`);
  }
  if (!(minChunkMs > 0)) {
    throw new RangeError(`minChunkMs must be greater than 0, got ${minChunkMs}`);
  }
  if (!(maxChunkMs > minChunkMs)) {
    throw new RangeError(
      `maxChunkMs (${maxChunkMs}) must be greater than minChunkMs (${minChunkMs})`
    );
  }
  if (!(maxChunkMs >= frameMs)) {
    throw new RangeError(`maxChunkMs (${maxChunkMs}) must be at least one frame of ${frameMs}ms`);
  }

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
    getFrameSamples() {
      return frameSamples;
    },
    findCut(pcm24k, { final = false } = {}) {
      const totalSamples = Math.floor(pcm24k.length / 2);
      const totalMs = (totalSamples / SAMPLE_RATE) * 1000;

      if (!final && totalMs < minChunkMs) {
        return {
          cutSampleAt24k: null,
          reason: "below_min",
          threshold: null,
          speechLikely: false,
        };
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
      const windowHasSpeech = loudest >= threshold;
      const emittedHasSpeech = (cutFrame) => {
        const end = Math.min(cutFrame, frames.length);
        for (let i = 0; i < end; i += 1) {
          if (frames[i] >= threshold) return true;
        }
        return false;
      };

      if (final) {
        return {
          cutSampleAt24k: totalSamples,
          reason: "final",
          threshold,
          speechLikely: emittedHasSpeech(frames.length),
        };
      }

      let lastQualifyingRunStart = -1;
      let lastQualifyingRunEnd = -1;
      if (windowHasSpeech) {
        let runStart = -1;
        for (let i = 0; i <= frames.length; i += 1) {
          const silent = i < frames.length && frames[i] < threshold;
          if (silent) {
            if (runStart === -1) runStart = i;
            continue;
          }
          if (runStart !== -1) {
            if (i - runStart >= holdFrames && i > minFrame && runStart < maxFrame) {
              lastQualifyingRunStart = runStart;
              lastQualifyingRunEnd = i;
            }
            runStart = -1;
          }
        }
      }

      if (lastQualifyingRunStart === 0) {
        const cutFrame = Math.min(lastQualifyingRunEnd, maxFrame);
        return {
          cutSampleAt24k: cutFrame * frameSamples,
          reason: "leading_silence",
          threshold,
          speechLikely: emittedHasSpeech(cutFrame),
        };
      }

      if (lastQualifyingRunStart > 0) {
        const midFrame = Math.floor((lastQualifyingRunStart + lastQualifyingRunEnd) / 2);
        const cutFrame = Math.min(Math.max(midFrame, minFrame), lastQualifyingRunEnd - 1, maxFrame);
        return {
          cutSampleAt24k: cutFrame * frameSamples,
          reason: "silence",
          threshold,
          speechLikely: emittedHasSpeech(cutFrame),
        };
      }

      if (totalMs >= maxChunkMs) {
        const speechLikely = emittedHasSpeech(maxFrame);
        return {
          cutSampleAt24k: maxFrame * frameSamples,
          reason: speechLikely ? "max_chunk" : "leading_silence",
          threshold,
          speechLikely,
        };
      }

      return { cutSampleAt24k: null, reason: "no_boundary", threshold, speechLikely: false };
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
