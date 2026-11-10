const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { computeKaldiFbank, applyCmn, NUM_MELS } = require("../../src/helpers/kaldiFbank");

const FIXTURE_DIR = path.join(__dirname, "..", "fixtures", "kaldi-fbank");
const FIXTURES = ["sweep", "noise", "silence_then_tone"];

const loadFixture = (name) => {
  const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, `${name}.json`), "utf8"));
  const samples = Float32Array.from(fixture.pcm16, (v) => v / 32768);
  return { ...fixture, samples };
};

const maxAbsDiff = (actual, expected, numMels, skipFrames) => {
  let worst = 0;
  for (let i = 0; i < expected.length; i++) {
    if (skipFrames?.[Math.floor(i / numMels)]) continue;
    worst = Math.max(worst, Math.abs(actual[i] - expected[i]));
  }
  return worst;
};

for (const name of FIXTURES) {
  test(`${name}: raw log-mel features match torchaudio kaldi.fbank`, () => {
    const fixture = loadFixture(name);
    const result = computeKaldiFbank(fixture.samples);
    assert.equal(result.numFrames, fixture.numFrames);
    assert.equal(result.features.length, fixture.fbank.length);
    const diff = maxAbsDiff(result.features, fixture.fbank, NUM_MELS, fixture.flooredFrames);
    assert.ok(diff < 1e-3, `max abs diff ${diff}`);
  });

  test(`${name}: mean-normalised features match torchaudio after CMN`, () => {
    const fixture = loadFixture(name);
    const { features, numFrames } = computeKaldiFbank(fixture.samples);
    const normalised = applyCmn(features, numFrames, NUM_MELS);
    const diff = maxAbsDiff(normalised, fixture.cmn, NUM_MELS, fixture.flooredFrames);
    assert.ok(diff < 1e-3, `max abs diff ${diff}`);
  });
}

test("floored frames stay within the float32 epsilon floor region", () => {
  const fixture = loadFixture("silence_then_tone");
  const { features } = computeKaldiFbank(fixture.samples);
  const floor = Math.log(1.1920928955078125e-7);
  fixture.flooredFrames.forEach((floored, frame) => {
    if (!floored) return;
    const row = features.subarray(frame * NUM_MELS, (frame + 1) * NUM_MELS);
    assert.ok(Math.min(...row) <= floor + 1e-3, `frame ${frame} min ${Math.min(...row)}`);
  });
});

test("CMN leaves every mel column with zero mean", () => {
  const { samples } = loadFixture("noise");
  const { features, numFrames } = computeKaldiFbank(samples);
  const normalised = applyCmn(features, numFrames, NUM_MELS);
  for (let m = 0; m < NUM_MELS; m++) {
    let sum = 0;
    for (let f = 0; f < numFrames; f++) sum += normalised[f * NUM_MELS + m];
    assert.ok(Math.abs(sum / numFrames) < 1e-4, `column ${m} mean ${sum / numFrames}`);
  }
});

test("frame count follows Kaldi snip_edges", () => {
  const samples = new Float32Array(400 + 160 * 7 + 50);
  assert.equal(computeKaldiFbank(samples).numFrames, 8);
});

test("fewer samples than one frame yields null", () => {
  assert.equal(computeKaldiFbank(new Float32Array(399)), null);
});
