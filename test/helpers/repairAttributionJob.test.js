const test = require("node:test");
const assert = require("node:assert/strict");
const { requireSqlite } = require("../support/sqlite.js");

const { JobStore } = require("../../src/helpers/jobStore.js");
const { BackgroundJobQueue } = require("../../src/helpers/backgroundJobQueue.js");
const { JOB_KINDS, runJob, isKnownJobKind } = require("../../src/helpers/jobDispatch.js");
const IPCHandlers = require("../../src/helpers/ipcHandlers.js");

const Database = requireSqlite();

const JOBS_DDL = `
  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_key TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`;

function freshStore() {
  const db = new Database(":memory:");
  db.exec(JOBS_DDL);
  return { db, store: new JobStore(db) };
}

function queueWith(store) {
  const queue = new BackgroundJobQueue();
  const repaired = [];
  queue.usePersistence(store, {
    postCallPipelineManager: { run: async () => {}, runSingleStep: async () => {} },
    ipcHandlers: {
      repairNoteAttribution: (noteId) => {
        repaired.push(noteId);
        return { repaired: true };
      },
    },
  });
  return { queue, repaired };
}

test("the repair kind is a persisted kind the dispatcher knows", () => {
  assert.equal(typeof JOB_KINDS.REPAIR_NOTE_ATTRIBUTION, "string");
  assert.equal(isKnownJobKind(JOB_KINDS.REPAIR_NOTE_ATTRIBUTION), true);

  const seen = [];
  runJob(
    { ipcHandlers: { repairNoteAttribution: (noteId) => seen.push(noteId) } },
    JOB_KINDS.REPAIR_NOTE_ATTRIBUTION,
    { noteId: 36 }
  );

  assert.deepEqual(seen, [36]);
});

test("a repair job is written down before it runs and removed when it finishes", async () => {
  const { db, store } = freshStore();
  const { queue, repaired } = queueWith(store);

  assert.equal(
    queue.enqueueKind("repair-attribution-36", JOB_KINDS.REPAIR_NOTE_ATTRIBUTION, { noteId: 36 }),
    true
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 1);

  await queue.drain();

  assert.deepEqual(repaired, [36]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 0);
});

test("the same note is not queued for repair twice", () => {
  const { store } = freshStore();
  const { queue } = queueWith(store);

  assert.equal(
    queue.enqueueKind("repair-attribution-36", JOB_KINDS.REPAIR_NOTE_ATTRIBUTION, { noteId: 36 }),
    true
  );
  assert.equal(
    queue.enqueueKind("repair-attribution-36", JOB_KINDS.REPAIR_NOTE_ATTRIBUTION, { noteId: 36 }),
    false
  );
});

function handlersWithCandidates(candidates) {
  const enqueued = [];
  const handlers = Object.create(IPCHandlers.prototype);
  Object.assign(handlers, {
    databaseManager: {
      listNoteTranscripts: () =>
        candidates.map((id) => ({
          id,
          title: `note ${id}`,
          transcript: JSON.stringify([
            { text: "w0", source: "mic", timestamp: 1788877057845 },
            { text: "w1", source: "system", timestamp: 1788877067672, speaker: "speaker_0" },
          ]),
        })),
    },
    backgroundJobQueue: {
      enqueueKind: (jobKey, kind, payload) => {
        enqueued.push({ jobKey, kind, payload });
        return true;
      },
      recover: () => {
        enqueued.push({ jobKey: "__recover__" });
        return 0;
      },
    },
  });
  return { handlers, enqueued };
}

test("startup recovery queues one repair row per damaged note", () => {
  const { handlers, enqueued } = handlersWithCandidates([14, 27, 34, 36]);

  handlers.recoverBackgroundJobs();

  assert.deepEqual(
    enqueued.filter((e) => e.kind).map((e) => e.jobKey),
    [
      "repair-attribution-14",
      "repair-attribution-27",
      "repair-attribution-34",
      "repair-attribution-36",
    ]
  );
  assert.deepEqual(
    enqueued.filter((e) => e.kind).map((e) => e.payload.noteId),
    [14, 27, 34, 36]
  );
  assert.equal(enqueued.filter((e) => e.kind)[0].kind, JOB_KINDS.REPAIR_NOTE_ATTRIBUTION);
});

test("the jobs a previous run left behind are recovered before new repairs are queued", () => {
  const { handlers, enqueued } = handlersWithCandidates([14]);

  handlers.recoverBackgroundJobs();

  assert.deepEqual(
    enqueued.map((e) => e.jobKey),
    ["__recover__", "repair-attribution-14"]
  );
});

test("a database that cannot be read does not stop the rest of recovery", () => {
  const { handlers, enqueued } = handlersWithCandidates([]);
  handlers.databaseManager.listNoteTranscripts = () => {
    throw new Error("database is locked");
  };

  assert.doesNotThrow(() => handlers.recoverBackgroundJobs());
  assert.deepEqual(
    enqueued.map((e) => e.jobKey),
    ["__recover__"]
  );
});

test("nothing is queued when no note needs repair", () => {
  const { handlers, enqueued } = handlersWithCandidates([]);

  handlers.recoverBackgroundJobs();

  assert.deepEqual(
    enqueued.map((e) => e.jobKey),
    ["__recover__"]
  );
});

function handlersWithRealQueue(candidateIds) {
  const { db, store } = freshStore();
  const queue = new BackgroundJobQueue();
  const repaired = [];
  const statusWhileRunning = [];
  queue.usePersistence(store, {
    postCallPipelineManager: { run: async () => {}, runSingleStep: async () => {} },
    ipcHandlers: {
      repairNoteAttribution: async (noteId) => {
        repaired.push(noteId);
        await Promise.resolve();
        statusWhileRunning.push({
          noteId,
          status: db
            .prepare("SELECT status FROM jobs WHERE job_key = ?")
            .get(`repair-attribution-${noteId}`)?.status,
        });
        return { repaired: true };
      },
    },
  });

  const handlers = Object.create(IPCHandlers.prototype);
  Object.assign(handlers, {
    databaseManager: {
      listNoteTranscripts: () =>
        candidateIds.map((id) => ({
          id,
          title: `note ${id}`,
          transcript: JSON.stringify([
            { text: "w0", source: "mic", timestamp: 1788877057845 },
            { text: "w1", source: "system", timestamp: 1788877067672, speaker: "speaker_0" },
          ]),
        })),
    },
    backgroundJobQueue: queue,
  });

  return { db, store, queue, handlers, repaired, statusWhileRunning };
}

test("startup repairs each damaged note exactly once against the real queue", async () => {
  const { handlers, queue, repaired, db } = handlersWithRealQueue([14, 27, 34, 36]);

  handlers.recoverBackgroundJobs();
  await queue.drain();

  assert.deepEqual(repaired, [14, 27, 34, 36]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 0);
});

test("a repair job stays marked running for the whole time it is running", async () => {
  const { handlers, queue, statusWhileRunning } = handlersWithRealQueue([14, 27]);

  handlers.recoverBackgroundJobs();
  await queue.drain();

  assert.deepEqual(statusWhileRunning, [
    { noteId: 14, status: "running" },
    { noteId: 27, status: "running" },
  ]);
});
