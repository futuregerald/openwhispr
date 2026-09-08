const SAMPLE_RATE = 24000;
const FRAME_MS = 20;
const MIN_CHUNK_MS = 2000;
const MAX_CHUNK_MS = 6000;

const createChunkBoundaryFinder = () => ({
  reset() {},
  getNoiseFloorRms() {
    return 0;
  },
  findCut(pcm24k, { final = false } = {}) {
    const totalSamples = Math.floor(pcm24k.length / 2);
    if (final) {
      return { cutSample: totalSamples, reason: "final" };
    }
    return { cutSample: null, reason: "below_min" };
  },
});

module.exports = {
  createChunkBoundaryFinder,
  SAMPLE_RATE,
  FRAME_MS,
  MIN_CHUNK_MS,
  MAX_CHUNK_MS,
};
