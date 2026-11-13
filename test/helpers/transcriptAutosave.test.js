const test = require("node:test");
const assert = require("node:assert/strict");

const loadModule = () => import("../../src/helpers/transcriptAutosave.js");

const INTERVAL_MS = 30_000;

function harness(t) {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const state = { segments: [] };
  const writes = [];
  return {
    state,
    writes,
    read: () => state.segments,
    write: (segments) => writes.push(segments.length),
    arrive: (count = 1) => {
      state.segments = [...state.segments, ...Array.from({ length: count }, () => ({ text: "x" }))];
    },
  };
}

test("it writes on every interval while new lines keep arriving between ticks", async (t) => {
  const { startTranscriptAutosave } = await loadModule();
  const h = harness(t);
  const stop = startTranscriptAutosave({ intervalMs: INTERVAL_MS, read: h.read, write: h.write });

  for (let tick = 1; tick <= 4; tick += 1) {
    h.arrive();
    t.mock.timers.tick(10_000);
    h.arrive();
    t.mock.timers.tick(10_000);
    h.arrive();
    t.mock.timers.tick(10_000);
    assert.equal(h.writes.length, tick, `tick ${tick} must have written`);
  }
  assert.deepEqual(h.writes, [3, 6, 9, 12], "each write carries the lines read at that tick");
  stop();
});

test("it does not write when nothing changed since the last write", async (t) => {
  const { startTranscriptAutosave } = await loadModule();
  const h = harness(t);
  const stop = startTranscriptAutosave({ intervalMs: INTERVAL_MS, read: h.read, write: h.write });

  h.arrive(2);
  t.mock.timers.tick(INTERVAL_MS);
  t.mock.timers.tick(INTERVAL_MS);
  t.mock.timers.tick(INTERVAL_MS);
  assert.deepEqual(h.writes, [2]);

  h.arrive();
  t.mock.timers.tick(INTERVAL_MS);
  assert.deepEqual(h.writes, [2, 3]);
  stop();
});

test("it does not write an empty transcript", async (t) => {
  const { startTranscriptAutosave } = await loadModule();
  const h = harness(t);
  const stop = startTranscriptAutosave({ intervalMs: INTERVAL_MS, read: h.read, write: h.write });

  t.mock.timers.tick(INTERVAL_MS * 3);
  assert.deepEqual(h.writes, []);
  stop();
});

test("stopping clears the interval so nothing is written afterwards", async (t) => {
  const { startTranscriptAutosave } = await loadModule();
  const h = harness(t);
  const stop = startTranscriptAutosave({ intervalMs: INTERVAL_MS, read: h.read, write: h.write });

  h.arrive();
  t.mock.timers.tick(INTERVAL_MS);
  assert.deepEqual(h.writes, [1]);

  stop();
  h.arrive();
  t.mock.timers.tick(INTERVAL_MS * 5);
  assert.deepEqual(h.writes, [1]);
});
