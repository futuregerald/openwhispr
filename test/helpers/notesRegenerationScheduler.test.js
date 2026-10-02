const test = require("node:test");
const assert = require("node:assert/strict");

const {
  NotesRegenerationScheduler,
  NOTES_REGENERATION_DELAY_MS,
  MAX_REARMS,
} = require("../../src/helpers/notesRegenerationScheduler.js");

const DELAY_MS = NOTES_REGENERATION_DELAY_MS;

// A fake clock. `tick` fires every callback whose deadline falls inside the
// window, in deadline order, so a callback that re-arms a timer inside the same
// window still fires -- which is exactly what the re-arm case needs.
const createFakeTimers = () => {
  let now = 0;
  let nextId = 1;
  const pending = new Map();

  return {
    timers: {
      setTimeout: (fn, ms) => {
        const id = nextId++;
        pending.set(id, { fn, at: now + ms });
        return id;
      },
      clearTimeout: (id) => {
        pending.delete(id);
      },
    },
    tick(ms) {
      const target = now + ms;
      for (;;) {
        let due = null;
        for (const [id, entry] of pending) {
          if (entry.at > target) continue;
          if (!due || entry.at < due.entry.at) due = { id, entry };
        }
        if (!due) break;
        pending.delete(due.id);
        now = due.entry.at;
        due.entry.fn();
      }
      now = target;
    },
    get pendingCount() {
      return pending.size;
    },
  };
};

const hashOf = (content) => `hash:${content}`;

const generatedNote = (id) => ({
  id,
  enhanced_content: `notes for ${id}`,
  enhanced_generated_hash: hashOf(`notes for ${id}`),
});

// `notes` maps note id -> row (or undefined). `enqueueResults` is consumed one
// per call; once exhausted every later call returns true.
const createHarness = ({ notes = {}, enqueueResults = [], throwOnEnqueue = false } = {}) => {
  const clock = createFakeTimers();
  const enqueued = [];
  const results = [...enqueueResults];

  const scheduler = new NotesRegenerationScheduler({
    db: { getNote: (id) => notes[id] },
    backgroundJobQueue: {
      enqueueKind: (jobKey, kind, payload) => {
        enqueued.push({ jobKey, kind, payload });
        if (throwOnEnqueue) throw new Error("queue exploded");
        return results.length > 0 ? results.shift() : true;
      },
    },
    hashOf,
    delayMs: DELAY_MS,
    timers: clock.timers,
  });

  return { scheduler, clock, enqueued };
};

test("one rename enqueues one regeneration, with no waiver of the provenance check", () => {
  const { scheduler, clock, enqueued } = createHarness({ notes: { 7: generatedNote(7) } });

  assert.equal(NOTES_REGENERATION_DELAY_MS, 60000, "the debounce Gerald asked for");

  scheduler.schedule(7);
  clock.tick(DELAY_MS);

  assert.equal(enqueued.length, 1);
  assert.deepEqual(enqueued[0], {
    jobKey: "regenerate-notes-7",
    kind: "regenerate-notes",
    payload: { noteId: 7 },
  });
});

test("nothing is enqueued before the delay elapses", () => {
  const { scheduler, clock, enqueued } = createHarness({ notes: { 7: generatedNote(7) } });

  scheduler.schedule(7);
  clock.tick(DELAY_MS - 1);

  assert.equal(enqueued.length, 0);
});

test("every rename resets the timer, so a rename session regenerates once", () => {
  const { scheduler, clock, enqueued } = createHarness({ notes: { 7: generatedNote(7) } });

  scheduler.schedule(7);
  clock.tick(100);
  scheduler.schedule(7);
  clock.tick(100);
  scheduler.schedule(7);

  clock.tick(DELAY_MS - 1);
  assert.equal(enqueued.length, 0, "fired before 60s after the LAST rename");

  clock.tick(1);
  assert.equal(enqueued.length, 1);
});

test("two notes keep independent timers", () => {
  const { scheduler, clock, enqueued } = createHarness({
    notes: { 7: generatedNote(7), 8: generatedNote(8) },
  });

  scheduler.schedule(7);
  scheduler.schedule(8);
  clock.tick(DELAY_MS);

  assert.equal(enqueued.length, 2);
  assert.deepEqual(enqueued.map((call) => call.jobKey).sort(), [
    "regenerate-notes-7",
    "regenerate-notes-8",
  ]);
});

test("notes hand-edited after the rename are left alone, decided at fire time", () => {
  const notes = { 7: generatedNote(7) };
  const { scheduler, clock, enqueued } = createHarness({ notes });

  scheduler.schedule(7);
  notes[7] = { ...notes[7], enhanced_content: "the user fixed a sentence" };
  clock.tick(DELAY_MS);

  assert.equal(enqueued.length, 0);
});

test("a note deleted inside the window enqueues nothing and does not throw", () => {
  const { scheduler, clock, enqueued } = createHarness({ notes: {} });

  scheduler.schedule(7);
  assert.doesNotThrow(() => clock.tick(DELAY_MS));
  assert.equal(enqueued.length, 0);
});

test("cancel before the delay enqueues nothing", () => {
  const { scheduler, clock, enqueued } = createHarness({ notes: { 7: generatedNote(7) } });

  scheduler.schedule(7);
  scheduler.cancel(7);
  clock.tick(DELAY_MS);

  assert.equal(enqueued.length, 0);
  assert.equal(clock.pendingCount, 0);
});

test("stopAll clears every pending timer", () => {
  const { scheduler, clock, enqueued } = createHarness({
    notes: { 7: generatedNote(7), 8: generatedNote(8) },
  });

  scheduler.schedule(7);
  scheduler.schedule(8);
  scheduler.stopAll();
  clock.tick(DELAY_MS);

  assert.equal(enqueued.length, 0);
  assert.equal(clock.pendingCount, 0);
  assert.equal(scheduler.pendingCount, 0);
});

test("a rename rejected by a still-running job is re-armed, not dropped", () => {
  const { scheduler, clock, enqueued } = createHarness({
    notes: { 7: generatedNote(7) },
    enqueueResults: [false, true],
  });

  scheduler.schedule(7);
  clock.tick(DELAY_MS);
  assert.equal(enqueued.length, 1, "one attempt made");
  assert.equal(scheduler.pendingCount, 1, "re-armed after the refusal");

  clock.tick(DELAY_MS);
  assert.equal(enqueued.length, 2, "exactly one further attempt, which was accepted");
  assert.equal(scheduler.pendingCount, 0);

  clock.tick(DELAY_MS * 3);
  assert.equal(enqueued.length, 2, "an accepted enqueue must not re-arm");
});

test("an enqueue that throws is swallowed and leaves no dead timer entry", () => {
  const { scheduler, clock, enqueued } = createHarness({
    notes: { 7: generatedNote(7) },
    throwOnEnqueue: true,
  });

  scheduler.schedule(7);
  assert.doesNotThrow(() => clock.tick(DELAY_MS));
  assert.equal(enqueued.length, 1);
  assert.equal(scheduler.pendingCount, 0);
  assert.equal(clock.pendingCount, 0);
});

test("the setting being off stops the fire-time enqueue", () => {
  const clock = createFakeTimers();
  const enqueued = [];
  const scheduler = new NotesRegenerationScheduler({
    db: { getNote: () => generatedNote(7) },
    backgroundJobQueue: {
      enqueueKind: (jobKey, kind, payload) => {
        enqueued.push({ jobKey, kind, payload });
        return true;
      },
    },
    hashOf,
    isEnabled: () => false,
    delayMs: DELAY_MS,
    timers: clock.timers,
  });

  scheduler.schedule(7);
  clock.tick(DELAY_MS);

  assert.equal(enqueued.length, 0);
  assert.equal(scheduler.pendingCount, 0);
});

test("re-arming gives up rather than looping forever behind a stuck job", () => {
  const { scheduler, clock, enqueued } = createHarness({
    notes: { 7: generatedNote(7) },
    enqueueResults: Array(MAX_REARMS + 5).fill(false),
  });

  scheduler.schedule(7);
  for (let i = 0; i < MAX_REARMS + 5; i += 1) clock.tick(DELAY_MS);

  assert.equal(enqueued.length, MAX_REARMS + 1, "one first attempt plus MAX_REARMS retries");
  assert.equal(scheduler.pendingCount, 0, "a permanently stuck job must not keep a timer alive");
});

test("an accepted enqueue clears the re-arm count, so a later rename gets its full allowance", () => {
  const { scheduler, clock, enqueued } = createHarness({
    notes: { 7: generatedNote(7) },
    enqueueResults: [false, true, ...Array(MAX_REARMS + 2).fill(false)],
  });

  scheduler.schedule(7);
  clock.tick(DELAY_MS);
  clock.tick(DELAY_MS);
  assert.equal(enqueued.length, 2, "re-armed once, then accepted");

  scheduler.schedule(7);
  for (let i = 0; i < MAX_REARMS + 2; i += 1) clock.tick(DELAY_MS);

  assert.equal(
    enqueued.length,
    2 + MAX_REARMS + 1,
    "the earlier refusal must not eat into a later rename's retries"
  );
});
