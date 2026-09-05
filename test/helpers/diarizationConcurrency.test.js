const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveDiarizationThreads,
  MAX_DIARIZATION_THREADS,
} = require("../../src/helpers/diarizationThreads.js");

// A DiarizationManager with the engine routing stubbed out, so these tests are
// about the gate rather than about ONNX.
const DiarizationManager = require("../../src/helpers/diarization.js");

function managerWithFakeEngine(onDiarize) {
  // No `?? Object.prototype` fallback on purpose: if the module ever stops
  // exporting the class, these tests must break loudly rather than quietly
  // exercise a stub of themselves.
  const manager = Object.create(DiarizationManager.prototype);
  manager._diarizeGate = Promise.resolve();
  manager._diarizeNow = onDiarize;
  return manager;
}

// Three callers reach diarize() without passing through the single-slot job
// queue: the diarize-audio-file IPC handler, the retranscribe path, and the
// live meeting's own post-call diarization. Two of them overlapping used to
// spawn two model processes at once with nothing bounding the pair.
test("two overlapping diarizations run one at a time", async () => {
  let concurrent = 0;
  let peak = 0;
  const manager = managerWithFakeEngine(async () => {
    concurrent += 1;
    peak = Math.max(peak, concurrent);
    await new Promise((resolve) => setTimeout(resolve, 5));
    concurrent -= 1;
    return [];
  });

  await Promise.all([
    manager.diarize("/tmp/a.wav"),
    manager.diarize("/tmp/b.wav"),
    manager.diarize("/tmp/c.wav"),
  ]);

  assert.equal(peak, 1, "two model processes must never be live at once");
});

test("each caller still gets its own result", async () => {
  const manager = managerWithFakeEngine(async (wavPath) => [{ speaker: wavPath }]);

  const [a, b] = await Promise.all([
    manager.diarize("/tmp/a.wav"),
    manager.diarize("/tmp/b.wav"),
  ]);

  assert.deepEqual(a, [{ speaker: "/tmp/a.wav" }]);
  assert.deepEqual(b, [{ speaker: "/tmp/b.wav" }]);
});

// Serialising must not turn one failure into a permanently jammed gate.
test("a failed diarization does not block the next one", async () => {
  let call = 0;
  const manager = managerWithFakeEngine(async () => {
    call += 1;
    if (call === 1) throw new Error("binary missing");
    return ["ok"];
  });

  await assert.rejects(() => manager.diarize("/tmp/a.wav"), /binary missing/);
  assert.deepEqual(await manager.diarize("/tmp/b.wav"), ["ok"]);
});

test("the caller sees the rejection rather than a swallowed empty result", async () => {
  const manager = managerWithFakeEngine(async () => {
    throw new Error("engine exploded");
  });
  await assert.rejects(() => manager.diarize("/tmp/a.wav"), /engine exploded/);
});

// sherpa-onnx-diarize defaults both thread flags to 1, so this is about owning
// the number rather than about capping something that was unbounded.
test("threads scale with the machine but stay well under its core count", () => {
  assert.equal(resolveDiarizationThreads({ availableParallelism: 2, env: {} }), 1);
  assert.equal(resolveDiarizationThreads({ availableParallelism: 8, env: {} }), 2);
  assert.equal(resolveDiarizationThreads({ availableParallelism: 16, env: {} }), 4);
});

test("a huge machine is still capped", () => {
  assert.equal(
    resolveDiarizationThreads({ availableParallelism: 256, env: {} }),
    MAX_DIARIZATION_THREADS
  );
});

test("a single-core machine still gets one thread, never zero", () => {
  assert.equal(resolveDiarizationThreads({ availableParallelism: 1, env: {} }), 1);
});

test("an explicit override is honoured but still capped", () => {
  const env = { OPENWHISPR_DIARIZATION_THREADS: "3" };
  assert.equal(resolveDiarizationThreads({ availableParallelism: 2, env }), 3);
  assert.equal(
    resolveDiarizationThreads({
      availableParallelism: 2,
      env: { OPENWHISPR_DIARIZATION_THREADS: "999" },
    }),
    MAX_DIARIZATION_THREADS
  );
});

test("a nonsense override falls back to the computed value", () => {
  for (const value of ["banana", "0", "-4", ""]) {
    assert.equal(
      resolveDiarizationThreads({
        availableParallelism: 8,
        env: { OPENWHISPR_DIARIZATION_THREADS: value },
      }),
      2,
      `override ${JSON.stringify(value)} should be ignored`
    );
  }
});

// The gate holds a reference to every call's promise. When a diarization
// rejects and no further call arrives to consume the gate, that stored promise
// is a rejection nobody handles -- which Node reports, and which
// --unhandled-rejections=strict turns into a crash. The caller's own catch does
// not cover it, because the gate is a SECOND reference to the same promise.
test("a rejected diarization leaves no unhandled rejection behind", async () => {
  const manager = managerWithFakeEngine(async () => {
    throw new Error("engine exploded");
  });

  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    await manager.diarize("/tmp/a.wav").catch(() => {});
    // Let the microtask queue and one macrotask turn drain, which is when Node
    // decides a rejection was never handled.
    await new Promise((resolve) => setTimeout(resolve, 10));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }

  assert.deepEqual(
    unhandled.map((error) => error?.message),
    [],
    "the gate must absorb the failure it stores, not re-raise it"
  );
});

// A call parked on the gate has not spawned anything, so shutdown()'s sweep of
// _processes cannot see it. Without a shutting-down check, quitting while one
// diarization runs lets the parked one spawn during teardown and outlive the
// app. Before the gate existed every call spawned immediately and was always in
// _processes when shutdown ran, so this hazard is new.
test("a diarization parked on the gate does not spawn after shutdown", async () => {
  const spawned = [];
  const manager = managerWithFakeEngine(async (wavPath) => {
    spawned.push(wavPath);
    await new Promise((resolve) => setTimeout(resolve, 20));
    return [];
  });
  manager._shuttingDown = false;
  manager._processes = new Set();

  const first = manager.diarize("/tmp/first.wav");
  const parked = manager.diarize("/tmp/parked.wav");

  // Let the first call actually reach the engine, which is the real situation:
  // one diarization in flight and already tracked in _processes, another
  // waiting behind it with nothing spawned yet.
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(spawned, ["/tmp/first.wav"], "the first call is in flight");

  await DiarizationManager.prototype.shutdown.call(manager);
  await Promise.all([first, parked]);

  assert.deepEqual(spawned, ["/tmp/first.wav"], "the parked call must not spawn after quit");
});

test("the parked call still resolves rather than hanging the caller", async () => {
  // Slow enough that the second call is genuinely still parked when shutdown
  // arrives -- an instant engine would let both finish first and the test would
  // assert nothing.
  const manager = managerWithFakeEngine(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return ["segments"];
  });
  manager._shuttingDown = false;
  manager._processes = new Set();

  const first = manager.diarize("/tmp/first.wav");
  const parked = manager.diarize("/tmp/parked.wav");
  await new Promise((resolve) => setTimeout(resolve, 5));
  await DiarizationManager.prototype.shutdown.call(manager);

  await first;
  assert.deepEqual(await parked, [], "an abandoned diarization returns the empty contract");
});
