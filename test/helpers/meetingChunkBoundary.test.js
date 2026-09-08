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

test("cuts inside the last silence gap, not at the buffer end", () => {
  const finder = createChunkBoundaryFinder();
  const pcm = buildPcm([
    { ms: 2500, speech: true },
    { ms: 400, speech: false },
    { ms: 1300, speech: true },
    { ms: 400, speech: false },
    { ms: 400, speech: true },
  ]);
  const { cutSample, reason } = finder.findCut(pcm);
  assert.equal(reason, "silence");
  const cutMs = msOf(cutSample);
  assert.ok(cutMs > 4200 && cutMs < 4600, `cut at ${cutMs}ms, expected inside 4200-4600ms`);
});

test("never emits a chunk shorter than the minimum, even when the gap straddles it", () => {
  const finder = createChunkBoundaryFinder();
  const pcm = buildPcm([
    { ms: 300, speech: true },
    { ms: 1800, speech: false },
    { ms: 3000, speech: true },
  ]);
  const { cutSample, reason } = finder.findCut(pcm);
  assert.equal(reason, "silence");
  assert.ok(msOf(cutSample) >= MIN_CHUNK_MS, `cut at ${msOf(cutSample)}ms, below MIN_CHUNK_MS`);
  assert.ok(msOf(cutSample) < 2100, `cut at ${msOf(cutSample)}ms, expected still inside the gap`);
});

test("ignores a silence gap that ends before the minimum chunk", () => {
  const finder = createChunkBoundaryFinder();
  const pcm = buildPcm([
    { ms: 300, speech: true },
    { ms: 400, speech: false },
    { ms: 4300, speech: true },
  ]);
  const { cutSample, reason } = finder.findCut(pcm);
  assert.equal(reason, "no_boundary");
  assert.equal(cutSample, null);
});

test("falls back to a hard cut at the cap when speech never pauses", () => {
  const finder = createChunkBoundaryFinder();
  const pcm = buildPcm([{ ms: 8000, speech: true }]);
  const { cutSample, reason } = finder.findCut(pcm);
  assert.equal(reason, "max_chunk");
  assert.equal(msOf(cutSample), MAX_CHUNK_MS);
});

test("a speech-dense window cannot be mistaken for one long silence", () => {
  const finder = createChunkBoundaryFinder();
  const flat = buildPcm([{ ms: 8000, speech: true }], { amplitude: 0.2 });
  assert.equal(finder.findCut(flat).reason, "max_chunk");
  assert.equal(
    finder.getNoiseFloorRms(),
    0,
    "no floor may be learned from a window with no silence"
  );
});

test("cuts correctly for a quiet speaker", () => {
  const finder = createChunkBoundaryFinder();
  const pcm = buildPcm(
    [
      { ms: 2500, speech: true },
      { ms: 400, speech: false },
      { ms: 1000, speech: true },
    ],
    { amplitude: 0.008, floorAmplitude: 0.0004 }
  );
  const { cutSample, reason } = finder.findCut(pcm);
  assert.equal(reason, "silence");
  const cutMs = msOf(cutSample);
  assert.ok(cutMs > 2500 && cutMs < 2900, `cut at ${cutMs}ms, expected inside 2500-2900ms`);
});

test("the gap boundary is not knife-edge on frame count", () => {
  for (const gapMs of [220, 260, 300, 380, 400, 460]) {
    const finder = createChunkBoundaryFinder();
    const pcm = buildPcm([
      { ms: 2500, speech: true },
      { ms: gapMs, speech: false },
      { ms: 1000, speech: true },
    ]);
    const { cutSample, reason } = finder.findCut(pcm);
    assert.equal(reason, "silence", `gap ${gapMs}ms gave ${reason}`);
    const cutMs = msOf(cutSample);
    const intoGap = (cutMs - 2500) / gapMs;
    assert.ok(
      intoGap >= 0.35 && intoGap <= 0.65,
      `gap ${gapMs}ms cut at ${cutMs}ms (${(intoGap * 100).toFixed(0)}% into the gap), expected near its midpoint`
    );
  }
});

test("final flush emits everything", () => {
  const finder = createChunkBoundaryFinder();
  const pcm = buildPcm([{ ms: 900, speech: true }]);
  const { cutSample, reason } = finder.findCut(pcm, { final: true });
  assert.equal(reason, "final");
  assert.equal(cutSample, pcm.length / 2);
});

test("finds the gap in a noisy room, where the absolute floor alone cannot", () => {
  const finder = createChunkBoundaryFinder();
  const pcm = buildPcm(
    [
      { ms: 2500, speech: true },
      { ms: 400, speech: false },
      { ms: 1000, speech: true },
    ],
    { amplitude: 0.12, floorAmplitude: 0.006 }
  );
  const { cutSample, reason } = finder.findCut(pcm);
  assert.equal(reason, "silence");
  assert.ok(
    finder.getNoiseFloorRms() * 2.5 > 0.0015,
    "the learned floor must be the operative threshold here"
  );
  const cutMs = msOf(cutSample);
  assert.ok(cutMs > 2500 && cutMs < 2900, `cut at ${cutMs}ms, expected inside 2500-2900ms`);
});

test("ignores a gap shorter than the silence hold", () => {
  const finder = createChunkBoundaryFinder();
  const pcm = buildPcm([
    { ms: 2500, speech: true },
    { ms: 100, speech: false },
    { ms: 1000, speech: true },
  ]);
  assert.equal(finder.findCut(pcm).reason, "no_boundary");
});

test("learns a noise floor and carries it across calls", () => {
  const finder = createChunkBoundaryFinder();
  const quiet = buildPcm(
    [
      { ms: 2500, speech: true },
      { ms: 400, speech: false },
      { ms: 1000, speech: true },
    ],
    { amplitude: 0.12, floorAmplitude: 0.004 }
  );
  finder.findCut(quiet);
  const first = finder.getNoiseFloorRms();
  assert.ok(first > 0, "a window with separation must teach the finder a floor");

  const louder = buildPcm(
    [
      { ms: 2500, speech: true },
      { ms: 400, speech: false },
      { ms: 1000, speech: true },
    ],
    { amplitude: 0.12, floorAmplitude: 0.012 }
  );
  finder.findCut(louder);
  const second = finder.getNoiseFloorRms();
  assert.ok(second > first, "a noisier room must raise the floor");
  assert.ok(second < first * 2, "the floor must rise slowly, not jump to the new observation");
});

test("reset clears a learned noise floor", () => {
  const finder = createChunkBoundaryFinder();
  const pcm = buildPcm(
    [
      { ms: 2500, speech: true },
      { ms: 400, speech: false },
      { ms: 1000, speech: true },
    ],
    { amplitude: 0.12, floorAmplitude: 0.006 }
  );
  finder.findCut(pcm);
  assert.ok(finder.getNoiseFloorRms() > 0);
  finder.reset();
  assert.equal(finder.getNoiseFloorRms(), 0);
});

test("a threshold that swallows the whole window is not a boundary", () => {
  const pcm = buildPcm([
    { ms: 2500, speech: true },
    { ms: 400, speech: false },
    { ms: 1000, speech: true },
  ]);
  assert.equal(createChunkBoundaryFinder().findCut(pcm).reason, "silence");

  const swallowed = createChunkBoundaryFinder({ silenceFloorMultiplier: 1000 });
  const { cutSample, reason } = swallowed.findCut(pcm);
  assert.equal(reason, "no_boundary");
  assert.equal(cutSample, null);
});
