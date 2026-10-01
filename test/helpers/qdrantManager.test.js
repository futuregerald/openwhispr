const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const QdrantManager = require("../../src/helpers/qdrantManager");

// Mirrors src/helpers/qdrantManager.js. Kept local rather than imported: a test
// that reads the constant it asserts on cannot catch that constant changing.
// The timing values are not mirrored here -- each test overrides them on the
// instance so the suite runs in milliseconds instead of minutes.
const RESTART_MAX_ATTEMPTS = 5;

// PERSIST_FROM is LOG_LEVELS.notice (src/helpers/debugLogger.js), and neither
// is exported. Mirrored here; if that threshold moves, this set goes stale.
const PERSISTED_LEVELS = new Set(["notice", "warn", "error", "fatal"]);

const debugLogger = require("../../src/helpers/debugLogger");

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
function managerHarness(
  t,
  {
    ports = [6333, 6340, 6350],
    failStartsAfter = Infinity,
    restartBaseMs = null,
    healthIntervalMs = null,
    degradedAfterMs = null,
    slowPortMs = null,
  } = {}
) {
  const m = new QdrantManager();
  const started = [];
  const logs = [];
  let startAttempts = 0;
  let healthFailuresRemaining = 0;
  let heldUnhealthy = false;
  let child = null;

  // debugLogger is a shared singleton and qdrantManager calls it by property
  // lookup, so patching the instance is enough to observe what it logs.
  const originals = {};
  for (const level of ["trace", "debug", "info", "notice", "warn", "error", "fatal"]) {
    if (typeof debugLogger[level] !== "function") continue;
    originals[level] = debugLogger[level].bind(debugLogger);
    debugLogger[level] = (message, meta) => logs.push({ level, message, meta });
  }
  t.after(() => {
    for (const [level, fn] of Object.entries(originals)) debugLogger[level] = fn;
  });

  if (restartBaseMs !== null) {
    m._restartBaseMs = restartBaseMs;
    m._restartMaxMs = restartBaseMs * 4;
  }
  if (healthIntervalMs !== null) m._healthIntervalMs = healthIntervalMs;
  if (degradedAfterMs !== null) m._degradedAfterMs = degradedAfterMs;

  m.getBinaryPath = () => "/fake/qdrant";
  m._findPort = async () => {
    if (slowPortMs) await new Promise((r) => setTimeout(r, slowPortMs));
    return ports[Math.min(startAttempts, ports.length - 1)];
  };
  m._writeConfig = () => ({ configPath: "/fake/config.yaml", storagePath: "/fake/storage" });

  m._spawn = () => {
    startAttempts += 1;
    child = fakeChild(900000 + startAttempts);
    // Past the allowance, the binary dies on launch -- how a genuinely broken
    // sidecar fails. Letting _waitForReady poll for its full 30s startup
    // timeout instead would make these tests take minutes.
    //
    // The child is RETURNED and then emits close, rather than returning null:
    // real spawn never returns null, and _doStart reads `this.process.pid`
    // immediately, so a null made these tests exercise a TypeError before any
    // listener was attached -- the close never reached the handler at all.
    const spawned = child;
    if (startAttempts > failStartsAfter) {
      queueMicrotask(() => {
        child = null;
        spawned.emit("close", 1);
      });
    }
    return spawned;
  };

  m._checkHealth = async () => {
    if (heldUnhealthy) return false;
    // A doomed spawn must also fail its health check: _waitForReady polls health
    // before the child's close event can land, so reporting healthy here would
    // let a start that is already dying be recorded as a success.
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
    logs,
    // Drains real timers by yielding repeatedly; the restart backoff is shortened
    // to single-digit ms so this stays fast and deterministic.
    async settle(ms = 100) {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    },
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
    // Keeps a start suspended inside _waitForReady for as long as the test needs.
    holdHealth(held) {
      heldUnhealthy = held;
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

test("an unexpected exit schedules a restart", async (t) => {
  const h = managerHarness(t, { restartBaseMs: 1 });
  await h.start();
  h.killForTest();
  await h.settle();
  assert.equal(h.startAttempts, 2, "a crashed qdrant was never brought back");
});

// Without this the app resurrects the sidecar it is trying to shut down.
test("a deliberate stop does not restart", async (t) => {
  const h = managerHarness(t, { restartBaseMs: 1 });
  await h.start();
  await h.stop();
  await h.settle();
  assert.equal(h.startAttempts, 1, "quitting the app respawned qdrant");
});

// The flag alone does not cover this: _doStart clears `stopping` on entry, so a
// timer scheduled BEFORE stop() walks straight through it. The child is
// detached, so the respawn survives app.exit(0) as an orphan holding the
// storage directory.
test("quitting during a restart backoff does not respawn", async (t) => {
  const h = managerHarness(t, { restartBaseMs: 50 });
  await h.start();
  h.killForTest();
  await h.stop();
  // Asserted BEFORE the backoff elapses: the two guards are redundant by
  // construction -- stop() clearing the timer and the timer re-checking
  // `stopping` each mask the other in startAttempts -- and once the timer has
  // fired it nulls itself either way. Checked here, this pins the clearing; the
  // re-check is pinned by the pair together. A pending timer also holds the
  // event loop open against the 8s shutdown deadline.
  assert.equal(h.manager._restartTimer, null, "a pending restart timer survived stop()");
  await h.settle(200);
  assert.equal(h.startAttempts, 1, "quitting mid-backoff left an orphaned qdrant");
});

// The single easiest thing to leave out and the hardest to notice: without
// clearing the flag, the first Repair permanently disables crash-restart.
test("a start after a stop re-arms the restart", async (t) => {
  const h = managerHarness(t, { restartBaseMs: 1 });
  await h.start();
  await h.stop();
  await h.start();
  h.killForTest();
  await h.settle();
  assert.equal(h.startAttempts, 3, "restart stayed disabled after a manual repair");
});

// Asserts the contract, not an exact spawn count. A restart is scheduled from
// two places -- the close handler and the catch of a failed restart -- so a
// given attempt does not always translate into a spawn before the next one is
// scheduled, and `1 + RESTART_MAX_ATTEMPTS` is not an invariant.
test("restart gives up rather than looping forever", async (t) => {
  const h = managerHarness(t, { restartBaseMs: 1, failStartsAfter: 1 });
  await h.start();
  h.killForTest();
  // Each doomed attempt costs one STARTUP_POLL_INTERVAL_MS (100ms) inside
  // _waitForReady before the child's close is observed, so the cap needs room.
  await h.settle(1500);

  assert.equal(
    h.manager._restartAttempts,
    RESTART_MAX_ATTEMPTS,
    "the attempt counter ran past its cap, or stopped early"
  );
  assert.ok(
    h.startAttempts > 1 && h.startAttempts <= 1 + RESTART_MAX_ATTEMPTS,
    `spawned ${h.startAttempts} times, outside the 2..${1 + RESTART_MAX_ATTEMPTS} the cap allows`
  );
  assert.ok(
    h.logs.some((l) => l.message === "qdrant could not be restarted; giving up"),
    "it never said it had given up"
  );

  // And having given up, it stays given up.
  const settled = h.startAttempts;
  await h.settle(300);
  assert.equal(h.startAttempts, settled, "it resumed retrying after giving up");
});

test("an unexpected exit is logged at a level that reaches the log file", async (t) => {
  const h = managerHarness(t, { restartBaseMs: 1 });
  await h.start();
  h.killForTest();
  await h.settle();
  const entry = h.logs.find((l) => l.message === "qdrant exited unexpectedly");
  assert.ok(entry, "the crash was not logged under the expected message");
  assert.ok(
    PERSISTED_LEVELS.has(entry.level),
    `a crash logged at ${entry.level} never reaches the log file`
  );
});

test("a deliberate stop is not logged as a crash", async (t) => {
  const h = managerHarness(t, { restartBaseMs: 1 });
  await h.start();
  await h.stop();
  assert.ok(!h.logs.some((l) => l.message === "qdrant exited unexpectedly"));
});

// _scheduleRestart is also called from the catch of a failed restart, which is
// async and can therefore interleave with a stop. That path is not reachable
// from the close handler (which returns early on `stopping`), so it is driven
// directly rather than through a contrived race.
test("a restart is never scheduled while stopping", async (t) => {
  const h = managerHarness(t, { restartBaseMs: 1 });
  await h.start();
  h.manager.stopping = true;
  h.manager._scheduleRestart("restart-failed");
  assert.equal(h.manager._restartTimer, null, "a restart was queued during shutdown");
});

// Defect 2: ready was set true only at startup, so any transient failure
// downgraded it permanently.
test("ready recovers when the health check succeeds again", async (t) => {
  const h = managerHarness(t, { healthIntervalMs: 5 });
  await h.start();
  h.failHealthChecks(1);
  await h.settle(40);
  assert.equal(h.manager.isReady(), true, "ready never came back after a single blip");
});

// 795 of 986 measured gaps are a single alternation, so a per-failure signal
// would flap constantly.
// Asserted while `ready` is still false, which is the only window in which a
// `degraded = !ready` implementation would differ from a time-based one. The
// first draft settled 40ms against a 500ms window with ready already restored,
// so it held for every possible implementation and could not fail.
test("one failed check does not report degraded", async (t) => {
  const h = managerHarness(t, { healthIntervalMs: 5, degradedAfterMs: 500 });
  await h.start();
  h.failHealthChecks(Infinity);
  await h.settle(40);
  assert.equal(h.manager.isReady(), false, "precondition: the check is failing right now");
  assert.equal(h.manager.getStatus().degraded, false, "a single blip was reported as an outage");
});

test("a sustained outage reports degraded", async (t) => {
  const h = managerHarness(t, { healthIntervalMs: 5, degradedAfterMs: 50 });
  await h.start();
  h.failHealthChecks(Infinity);
  await h.settle(150);
  assert.equal(h.manager.getStatus().degraded, true);
});

test("degraded clears on the first confirmed success", async (t) => {
  const h = managerHarness(t, { healthIntervalMs: 5, degradedAfterMs: 50 });
  await h.start();
  h.failHealthChecks(Infinity);
  await h.settle(150);
  assert.equal(h.manager.getStatus().degraded, true);
  h.failHealthChecks(0);
  await h.settle(40);
  assert.equal(h.manager.getStatus().degraded, false);
});

// The case Task 1 exists for, and the one a lastSuccessAt-only rule cannot see:
// if qdrant never came up, lastSuccessAt stays null forever, degraded stays
// false, and neither the notice nor the Repair button is ever reachable.
test("a qdrant that never starts reads as degraded", async (t) => {
  const h = managerHarness(t, { failStartsAfter: 0, restartBaseMs: 1, degradedAfterMs: 30 });
  await h.start().catch(() => {});
  await h.settle(120);
  assert.equal(h.manager.isReady(), false);
  assert.equal(
    h.manager.getStatus().degraded,
    true,
    "a qdrant that never came up looked perfectly healthy"
  );
});

test("a sidecar that was never asked to start is not degraded", async (t) => {
  const h = managerHarness(t, { degradedAfterMs: 1 });
  await h.settle(20);
  assert.equal(h.manager.getStatus().degraded, false, "an unstarted sidecar reported a fault");
});

test("a failed check clears ready while it lasts", async (t) => {
  const h = managerHarness(t, { healthIntervalMs: 5 });
  await h.start();
  assert.equal(h.manager.isReady(), true);
  h.failHealthChecks(Infinity);
  await h.settle(40);
  assert.equal(h.manager.isReady(), false, "a failing health check still reported ready");
});

// The CRITICAL this branch originally shipped with. stop() neither awaited nor
// cancelled an in-flight _doStart, so the repair handler's stop()-then-start()
// handed back the very start it had just killed: no new process was spawned,
// the error reported described the process the repair itself killed, and
// `stopping` -- cleared only inside _doStart -- stayed latched true, which
// silently disabled crash-restart for the rest of the session.
test("repairing during an in-flight start really does start a new one", async (t) => {
  const h = managerHarness(t, { restartBaseMs: 1, healthIntervalMs: 5, slowPortMs: 0 });
  h.holdHealth(true);

  const inflight = h.start().catch(() => {});
  await h.settle(30);
  assert.equal(h.startAttempts, 1, "nothing was spawned to begin with");

  h.holdHealth(false);
  await h.stop();
  await h.start();
  await inflight;

  assert.equal(h.startAttempts, 2, "the repair handed back the start it had just killed");
  assert.equal(h.manager.stopping, false, "stopping latched true, disabling crash-restart");
  assert.equal(h.manager.isReady(), true);
});

// The child is spawned detached, so a start that completes after shutdown has
// begun outlives app.exit(0) and holds the storage directory until the reaper
// finds it on the next launch. Clearing the restart timer does not cover this:
// _doStart is already past its guard, suspended on an await.
test("a stop while a start is mid-flight never spawns", async (t) => {
  const h = managerHarness(t, { slowPortMs: 60 });

  const pending = h.start().catch(() => {});
  await h.settle(10);
  assert.equal(h.startAttempts, 0, "the port lookup should still be in flight");

  await h.stop();
  await h.settle(150);
  await pending;

  assert.equal(h.startAttempts, 0, "a detached qdrant was spawned after shutdown began");
  assert.equal(h.manager.process, null);
});
