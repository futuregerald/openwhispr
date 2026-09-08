const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createChunkBoundaryFinder,
  SAMPLE_RATE,
  MIN_CHUNK_MS,
  MAX_CHUNK_MS,
} = require("../../src/helpers/meetingChunkBoundary");

const SYLLABLE_HZ = 4;
const SYLLABLE_DIP = 0.35;

// 24 kHz mono s16le PCM. "Speech" is white noise under a 4 Hz syllabic
// envelope; "silence" is a flat room-noise bed.
function buildPcm(runs, { amplitude = 0.2, floorAmplitude = 0.0005 } = {}) {
  const total = runs.reduce((sum, run) => sum + Math.round((run.ms / 1000) * SAMPLE_RATE), 0);
  const buffer = Buffer.alloc(total * 2);
  let offset = 0;
  let seed = 1;
  let elapsed = 0;
  for (const run of runs) {
    const count = Math.round((run.ms / 1000) * SAMPLE_RATE);
    for (let i = 0; i < count; i += 1) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const noise = (seed / 0x7fffffff) * 2 - 1;
      const envelope = run.speech
        ? SYLLABLE_DIP +
          (1 - SYLLABLE_DIP) * Math.abs(Math.sin(2 * Math.PI * SYLLABLE_HZ * elapsed))
        : 1;
      const level = (run.speech ? amplitude : floorAmplitude) * envelope;
      buffer.writeInt16LE(Math.round(noise * level * 0x7fff), offset);
      offset += 2;
      elapsed += 1 / SAMPLE_RATE;
    }
  }
  return buffer;
}

const msOf = (samples) => (samples / SAMPLE_RATE) * 1000;

test("does not cut a buffer shorter than the minimum chunk", () => {
  const finder = createChunkBoundaryFinder();
  const pcm = buildPcm([
    { ms: 1200, speech: true },
    { ms: 400, speech: false },
  ]);
  assert.deepEqual(finder.findCut(pcm), { cutSample: null, reason: "below_min" });
});
