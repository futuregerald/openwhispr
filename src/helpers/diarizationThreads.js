const os = require("os");

// sherpa-onnx-diarize defaults --embedding.num-threads and
// --segmentation.num-threads to 1. So diarization was never the unbounded CPU
// hog it looked like from the absence of a flag in this repo -- it was pinned to
// one thread by a default nobody chose.
//
// Passing it explicitly makes the number a decision this repo owns rather than
// one inherited from a binary's default, and gives diarization a little more
// than one thread on a machine that has cores to spare, while still leaving
// most of them for whisper, the local model and the app itself.
//
// The ceiling is deliberately low. Diarization already runs off the single-slot
// job queue behind everything else, and this machine has had a measurement job
// drive load average to 67 and make it unusable mid-call. Modelled on
// resolveWhisperThreads (whisperServer.js), clamped far tighter because the
// default it replaces is 1, not 4.
const DEFAULT_DIARIZATION_THREADS = 1;
const MAX_DIARIZATION_THREADS = 4;
const THREAD_RATIO = 0.25;

function availableParallelism() {
  if (typeof os.availableParallelism === "function") {
    return os.availableParallelism();
  }
  return os.cpus()?.length || 1;
}

function parsePositiveInteger(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

/**
 * How many threads each diarization model may use.
 *
 * @param {object} runtime  { env, availableParallelism } — injected so the
 *                          decision is testable without a machine that happens
 *                          to have the right core count.
 */
function resolveDiarizationThreads(runtime = {}) {
  const cores = parsePositiveInteger(runtime.availableParallelism) || availableParallelism();
  const env = runtime.env || process.env;

  const explicit = parsePositiveInteger(env.OPENWHISPR_DIARIZATION_THREADS);
  if (explicit) {
    return clamp(explicit, 1, MAX_DIARIZATION_THREADS);
  }

  return clamp(
    Math.floor(cores * THREAD_RATIO),
    DEFAULT_DIARIZATION_THREADS,
    MAX_DIARIZATION_THREADS
  );
}

module.exports = {
  resolveDiarizationThreads,
  DEFAULT_DIARIZATION_THREADS,
  MAX_DIARIZATION_THREADS,
};
