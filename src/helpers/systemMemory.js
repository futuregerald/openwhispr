/**
 * How much memory the machine can actually give us right now.
 *
 * Neither number Node offers is usable. `os.totalmem()` says 24 GB on a machine
 * with 17 GB already committed, which is how the local model came to reserve
 * more than the machine had and drive the desktop into swap. `os.freemem()` on
 * macOS counts only truly-free pages — 0.07 GB on that same machine, against
 * 3.7 GB genuinely reclaimable — which would clamp every Mac to the minimum
 * context.
 *
 * The probe is async on purpose: a synchronous fork+exec on a machine deep in
 * swap blocks the Electron main process for seconds, freezing every window and
 * all IPC. That is the symptom this file exists to prevent, not to cause.
 */
const os = require("os");
const fs = require("fs");
const { execFile } = require("child_process");

const PROBE_TIMEOUT_MS = 2000;
const CACHE_TTL_MS = 5000;

let cached = null;
let inFlight = null;
let probeOverride = null;

/**
 * "Pages purgeable" is deliberately excluded: it overlaps active and inactive,
 * so adding it double-counts and overstates what is available — the direction
 * that gets us back into swap.
 */
function parseVmStat(text) {
  const components = vmStatComponents(text);
  if (!components) return null;
  return components.free + components.inactive + components.speculative;
}

/**
 * The pages the probe counts, and the reclaimable ones it deliberately does not.
 *
 * The probe reads roughly half what macOS itself reports — 3.94 GiB against
 * `memory_pressure`'s 7.92 on the same machine, seconds apart. Widening it is the
 * direction that caused the 2026-08-12 stall, so the excluded fields are recorded
 * instead and the decision to widen is left to that evidence. `purgeable` and
 * `fileBacked` both overlap active and inactive, so neither can simply be added.
 *
 * @returns {{free:number, inactive:number, speculative:number, purgeable:number,
 *   fileBacked:number, compressor:number, pageSize:number}|null}
 */
function vmStatComponents(text) {
  if (typeof text !== "string" || text.length === 0) return null;

  const pageSizeMatch = text.match(/page size of (\d+) bytes/);
  const pageSize = pageSizeMatch ? Number(pageSizeMatch[1]) : 4096;

  const pages = (label) => {
    const m = text.match(new RegExp(`Pages ${label}:\\s+(\\d+)`));
    return m ? Number(m[1]) : null;
  };

  const free = pages("free");
  const inactive = pages("inactive");
  const speculative = pages("speculative");

  if (free == null && inactive == null) return null;

  // This one is not spelled "Pages <name>:" like every other line.
  const fileBackedMatch = text.match(/File-backed pages:\s+(\d+)/);

  return {
    free: (free || 0) * pageSize,
    inactive: (inactive || 0) * pageSize,
    speculative: (speculative || 0) * pageSize,
    purgeable: (pages("purgeable") || 0) * pageSize,
    fileBacked: (fileBackedMatch ? Number(fileBackedMatch[1]) : 0) * pageSize,
    compressor: (pages("occupied by compressor") || 0) * pageSize,
    pageSize,
  };
}

/** MemAvailable is the kernel's own estimate of exactly this. */
function parseMemInfo(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  const m = text.match(/^MemAvailable:\s+(\d+)\s*kB/m);
  return m ? Number(m[1]) * 1024 : null;
}

function runVmStat() {
  return new Promise((resolve) => {
    execFile("vm_stat", [], { timeout: PROBE_TIMEOUT_MS }, (err, stdout) => {
      resolve({
        bytes: err ? null : parseVmStat(stdout),
        source: "vm_stat",
        components: err ? null : vmStatComponents(stdout),
      });
    });
  });
}

async function readMemInfo() {
  try {
    const text = await fs.promises.readFile("/proc/meminfo", "utf8");
    return { bytes: parseMemInfo(text), source: "meminfo" };
  } catch {
    return { bytes: null, source: "meminfo" };
  }
}

function defaultProbe() {
  if (process.platform === "darwin") return runVmStat();
  if (process.platform === "linux") return readMemInfo();
  // Windows' os.freemem() already reports available physical memory.
  return Promise.resolve({ bytes: os.freemem(), source: "os.freemem" });
}

async function availableMemBytes() {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) {
    return { bytes: cached.bytes, source: cached.source, components: cached.components ?? null };
  }
  if (inFlight) return inFlight;

  inFlight = (async () => {
    let result;
    try {
      result = await (probeOverride || defaultProbe)();
    } catch {
      result = null;
    }
    if (!result || !Number.isFinite(result.bytes) || result.bytes == null) {
      // Nothing to decompose on this path — the components describe vm_stat's
      // view, and this is the fallback for when that view was unavailable.
      result = { bytes: os.freemem(), source: "os.freemem", components: null };
    }
    cached = { ...result, at: Date.now() };
    inFlight = null;
    return { bytes: result.bytes, source: result.source, components: result.components ?? null };
  })();

  return inFlight;
}

function __setProbeForTest(fn) {
  probeOverride = fn;
}

function __resetForTest() {
  cached = null;
  inFlight = null;
  probeOverride = null;
}

module.exports = {
  availableMemBytes,
  parseVmStat,
  vmStatComponents,
  parseMemInfo,
  __setProbeForTest,
  __resetForTest,
};
