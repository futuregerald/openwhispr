const { classifyInferenceError } = require("./inferenceErrorClass");

const TRANSIENT_ATTEMPTS = 4;
// A pass that already burned the full request timeout, or a server killed while
// loading a multi-GB model, gets one more go and no more. Four attempts is tens
// of minutes of the same thrash on a machine that is already struggling.
const SLOW_ATTEMPTS = 2;
const GENUINE_ATTEMPTS = 2;
// A pass this much slower than the established median means the machine is
// struggling, not that this chunk is harder. Needs two completed passes first,
// so a single cold-start outlier cannot trip it.
const DEGRADATION_FACTOR = 4;
const DEGRADATION_MIN_SAMPLES = 2;
const BACKOFF_MS = [2000, 4000, 8000];

function runnerError(message, code, details) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  return error;
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * Catches a run whose passes are stretching out — the signature of a machine
 * that has started swapping. It cannot catch a pass that hangs outright: the
 * runner is awaiting `infer`, so control only returns once the pass settles,
 * which for a wedged request means the llama-server request timeout. Bounding
 * that is the timeout's job, not this one.
 */
function throwIfDegrading({ durations, elapsed, currentPass, totalPasses }) {
  if (durations.length < DEGRADATION_MIN_SAMPLES) return;
  const baseline = median(durations);
  if (baseline <= 0 || elapsed <= baseline * DEGRADATION_FACTOR) return;
  throw runnerError(
    `Note generation is slowing down sharply (pass ${currentPass} took ${Math.round(elapsed / 1000)}s ` +
      `against a typical ${Math.round(baseline / 1000)}s) — stopping rather than grinding`,
    "LOCAL_MULTIPASS_DEGRADED",
    { elapsedMs: elapsed, baselineMs: baseline, currentPass, totalPasses }
  );
}

/**
 * Bounds the whole run regardless of how the individual passes fail. Without
 * it, a machine slow enough to make every pass crawl still runs every pass.
 */
function throwIfPastDeadline({ now, startedAt, deadlineMs, currentPass, totalPasses }) {
  if (deadlineMs == null) return;
  const elapsed = now() - startedAt;
  if (elapsed < deadlineMs) return;
  throw runnerError(
    `Note generation exceeded its time limit after ${currentPass} of ${totalPasses} passes`,
    "LOCAL_MULTIPASS_TIMEOUT",
    { elapsedMs: elapsed, currentPass, totalPasses }
  );
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw runnerError("Cancelled", "LOCAL_INFERENCE_ABORTED");
}

/**
 * One pass, with the retry policy the failure class demands. Transient failures
 * are retried and never leave a trace in the user's notes; a genuine failure
 * returns null so the caller can record a gap; fatal propagates immediately.
 */
async function runPass({ infer, prompt, options, sleep, signal }) {
  let lastError;

  for (let attempt = 1; ; attempt++) {
    throwIfAborted(signal);
    try {
      const text = await infer(prompt, options);
      if (typeof text !== "string" || text.trim() === "") {
        throw runnerError("The local model returned nothing", "EMPTY_RESPONSE");
      }
      return { text: text.trim() };
    } catch (error) {
      const kind = classifyInferenceError(error);
      if (kind === "fatal") throw error;

      lastError = error;
      const limit =
        kind === "transient"
          ? TRANSIENT_ATTEMPTS
          : kind === "slow"
            ? SLOW_ATTEMPTS
            : GENUINE_ATTEMPTS;
      if (attempt >= limit) {
        if (kind === "transient" || kind === "slow") {
          // Three failed retries mean the server or the machine is broken, not
          // that this section of the call was unreadable. Saying so beats
          // writing a gap marker that lies about which it was.
          throw runnerError(
            `Local inference kept failing: ${error?.message || "unknown error"}`,
            "LOCAL_MULTIPASS_FAILED",
            { cause: error?.code }
          );
        }
        return { text: null, error };
      }

      // Backoff applies to slow too: retrying instantly at a server that may
      // still be grinding the request we just destroyed helps nobody.
      if (kind === "transient" || kind === "slow") {
        await sleep(BACKOFF_MS[attempt - 1] ?? 8000);
      }
    }
  }
}

module.exports = {
  runnerError,
  median,
  throwIfDegrading,
  throwIfPastDeadline,
  throwIfAborted,
  runPass,
  TRANSIENT_ATTEMPTS,
  SLOW_ATTEMPTS,
  GENUINE_ATTEMPTS,
  BACKOFF_MS,
  DEGRADATION_FACTOR,
  DEGRADATION_MIN_SAMPLES,
};
