const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const QdrantManager = require("../../src/helpers/qdrantManager");

// Mirrors the values in src/helpers/qdrantManager.js. Kept local rather than
// exported: a test that imports the constant it asserts on cannot catch the
// constant changing.
const RESTART_BASE_MS = 2000;
const RESTART_MAX_MS = 60 * 1000;
const RESTART_MAX_ATTEMPTS = 5;
const HEALTH_CHECK_INTERVAL_MS = 5000;
const DEGRADED_AFTER_MS = 30000;

/**
 * A stand-in for the spawned child, carrying only the surface qdrantManager and
 * gracefulStopProcess touch.
 *
 * `exitCode` is deliberately left undefined: killProcessGroup returns early on
 * `proc.exitCode !== null` (src/utils/process.js), so no signal is ever sent to
 * a real pid. Without that, `process.kill(-pid)` on a fabricated pid could
 * signal an unrelated process group on the developer's machine.
 */
function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.killed = false;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {
    child.killed = true;
  };
  return child;
}

/**
 * Drives the real QdrantManager with its spawn, port and config seams replaced.
 *
 * Two things this has to work around, both found by the tests hanging:
 *
 * 1. `_writeConfig` is stubbed because the real one writes config.yaml into
 *    ~/.cache/openwhispr/qdrant-data — the user's actual Qdrant config.
 * 2. `stop()` goes through `gracefulStopProcess`, which waits for either a
 *    `close` event or a timeout. Under mock timers the timeout never fires and
 *    the fake child never closes on its own, so `stop()` deadlocks. The harness
 *    emits `close` while that await is pending.
 */
function managerHarness(t, { ports = [6333, 6340, 6350], failStartsAfter = Infinity } = {}) {
  const m = new QdrantManager();
  const started = [];
  let startAttempts = 0;
  let healthFailuresRemaining = 0;
  let child = null;

  m.getBinaryPath = () => "/fake/qdrant";
  m._findPort = async () => ports[Math.min(startAttempts, ports.length - 1)];
  m._writeConfig = () => ({ configPath: "/fake/config.yaml", storagePath: "/fake/storage" });

  m._spawn = () => {
    startAttempts += 1;
    child = fakeChild(900000 + startAttempts);
    return child;
  };

  m._checkHealth = async () => {
    if (startAttempts > failStartsAfter) return false;
    if (healthFailuresRemaining > 0) {
      healthFailuresRemaining -= 1;
      return false;
    }
    return true;
  };

  m.onReady((port) => started.push(port));

  // The health-check interval and any pending restart timer keep the event loop
  // alive, so without this the suite passes and then hangs forever instead of
  // exiting.
  t.after(() => {
    m._stopHealthCheck();
    if (m._restartTimer) clearTimeout(m._restartTimer);
  });

  return {
    manager: m,
    startedPorts: started,
    get startAttempts() {
      return startAttempts;
    },
    get startCount() {
      return started.length;
    },
    async start() {
      return m.start();
    },
    async stop() {
      const dying = child;
      child = null;
      const pending = m.stop();
      if (dying) queueMicrotask(() => dying.emit("close", 0));
      await pending;
    },
    killForTest(code = 1) {
      const dying = child;
      child = null;
      dying.emit("close", code);
    },
    failHealthChecks(n) {
      healthFailuresRemaining = n;
    },
  };
}

test("the manager exposes the seams the tests depend on", () => {
  const m = new QdrantManager();
  for (const seam of ["_spawn", "_findPort", "_writeConfig", "onReady"]) {
    assert.equal(typeof m[seam], "function", `${seam} is missing`);
  }
});

test("onReady fires with the port on every successful start, not just the first", async (t) => {
  const h = managerHarness(t, { ports: [6333, 6340] });

  await h.start();
  await h.stop();
  await h.start();

  assert.deepEqual(
    h.startedPorts,
    [6333, 6340],
    "a restart on a new port never re-wired the search client"
  );
});

test("a throwing onReady consumer does not fail the start", async (t) => {
  const h = managerHarness(t);
  h.manager.onReady(() => {
    throw new Error("consumer blew up");
  });
  await h.start();
  assert.equal(h.manager.isReady(), true, "a bad callback took down a healthy start");
});
