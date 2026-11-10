"use strict";

const SAMPLE_RATE = 16000;
const FRAME_LENGTH = 400;
const FRAME_SHIFT = 160;
const FFT_SIZE = 512;
const NUM_MELS = 80;
const LOW_FREQ = 20;
const HIGH_FREQ = SAMPLE_RATE / 2;
const PREEMPHASIS = 0.97;
const INT16_SCALE = 32768;
const LOG_FLOOR = 1.1920928955078125e-7;

const melScale = (freq) => 1127 * Math.log(1 + freq / 700);

let melBanks = null;
function getMelBanks() {
  if (melBanks) return melBanks;

  const numFftBins = FFT_SIZE / 2;
  const fftBinWidth = SAMPLE_RATE / FFT_SIZE;
  const melLow = melScale(LOW_FREQ);
  const melHigh = melScale(HIGH_FREQ);
  const melDelta = (melHigh - melLow) / (NUM_MELS + 1);

  melBanks = new Array(NUM_MELS);
  for (let m = 0; m < NUM_MELS; m++) {
    const left = melLow + m * melDelta;
    const center = left + melDelta;
    const right = center + melDelta;
    const weights = new Float64Array(numFftBins + 1);
    for (let k = 0; k < numFftBins; k++) {
      const mel = melScale(fftBinWidth * k);
      const up = (mel - left) / (center - left);
      const down = (right - mel) / (right - center);
      weights[k] = Math.max(0, Math.min(up, down));
    }
    melBanks[m] = weights;
  }
  return melBanks;
}

let hammingWindow = null;
function getHammingWindow() {
  if (hammingWindow) return hammingWindow;
  hammingWindow = new Float64Array(FRAME_LENGTH);
  for (let i = 0; i < FRAME_LENGTH; i++) {
    hammingWindow[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (FRAME_LENGTH - 1));
  }
  return hammingWindow;
}

function powerSpectrum(frame) {
  const n = FFT_SIZE;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  re.set(frame);

  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    while (j & bit) {
      j ^= bit;
      bit >>= 1;
    }
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    const half = len / 2;
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let j = 0; j < half; j++) {
        const vRe = re[i + j + half] * curRe - im[i + j + half] * curIm;
        const vIm = re[i + j + half] * curIm + im[i + j + half] * curRe;
        re[i + j + half] = re[i + j] - vRe;
        im[i + j + half] = im[i + j] - vIm;
        re[i + j] += vRe;
        im[i + j] += vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }

  const bins = n / 2 + 1;
  const power = new Float64Array(bins);
  for (let k = 0; k < bins; k++) power[k] = re[k] * re[k] + im[k] * im[k];
  return power;
}

function computeKaldiFbank(samples) {
  const numFrames =
    samples.length < FRAME_LENGTH
      ? 0
      : Math.floor((samples.length - FRAME_LENGTH) / FRAME_SHIFT) + 1;
  if (numFrames === 0) return null;

  const window = getHammingWindow();
  const banks = getMelBanks();
  const features = new Float32Array(numFrames * NUM_MELS);
  const frame = new Float64Array(FRAME_LENGTH);

  for (let f = 0; f < numFrames; f++) {
    const start = f * FRAME_SHIFT;
    let mean = 0;
    for (let i = 0; i < FRAME_LENGTH; i++) {
      frame[i] = samples[start + i] * INT16_SCALE;
      mean += frame[i];
    }
    mean /= FRAME_LENGTH;
    for (let i = 0; i < FRAME_LENGTH; i++) frame[i] -= mean;

    for (let i = FRAME_LENGTH - 1; i > 0; i--) frame[i] -= PREEMPHASIS * frame[i - 1];
    frame[0] -= PREEMPHASIS * frame[0];

    for (let i = 0; i < FRAME_LENGTH; i++) frame[i] *= window[i];

    const power = powerSpectrum(frame);
    for (let m = 0; m < NUM_MELS; m++) {
      const weights = banks[m];
      let energy = 0;
      for (let k = 0; k < power.length; k++) energy += weights[k] * power[k];
      features[f * NUM_MELS + m] = Math.log(Math.max(energy, LOG_FLOOR));
    }
  }

  return { features, numFrames };
}

function applyCmn(features, numFrames, numMels) {
  const means = new Float64Array(numMels);
  for (let f = 0; f < numFrames; f++) {
    for (let m = 0; m < numMels; m++) means[m] += features[f * numMels + m];
  }
  for (let m = 0; m < numMels; m++) means[m] /= numFrames;

  const normalised = new Float32Array(features.length);
  for (let f = 0; f < numFrames; f++) {
    for (let m = 0; m < numMels; m++) {
      normalised[f * numMels + m] = features[f * numMels + m] - means[m];
    }
  }
  return normalised;
}

module.exports = { computeKaldiFbank, applyCmn, NUM_MELS, SAMPLE_RATE };
