const test = require("node:test");
const assert = require("node:assert/strict");
const { requireSqlite } = require("../support/sqlite.js");

const { JobStore, MAX_ATTEMPTS } = require("../../src/helpers/jobStore.js");
const { BackgroundJobQueue } = require("../../src/helpers/backgroundJobQueue.js");
const { JOB_KINDS, runJob, isKnownJobKind } = require("../../src/helpers/jobDispatch.js");

const Database = requireSqlite();

// The same DDL database.js creates in its idempotent bootstrap. Duplicated
// rather than booting DatabaseManager because these tests are about the job
// rows, not about the other nineteen tables — but it has to stay in step, and
// the last test in this file is what says so if it does not.
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

function queueWith(store, run) {
  const queue = new BackgroundJobQueue();
  const calls = [];
  queue.usePersistence(store, {
    postCallPipelineManager: {
      run: async (noteId, options = {}) => {
        calls.push({ method: "run", noteId, ...options });
        if (run) await run(noteId, options);
      },
      runSingleStep: async (noteId, step) => {
        calls.push({ method: "runSingleStep", noteId, step });
        if (run) await run(noteId, { step });
      },
    },
  });
  return { queue, calls };
}

test("a queued job is recorded, run, and removed", async () => {
  const { db, store } = freshStore();
  const { queue, calls } = queueWith(store);

  assert.equal(queue.enqueueKind("post-call-12", JOB_KINDS.POST_CALL_PIPELINE, { noteId: 12 }), true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 1);

  await queue.drain();

  assert.deepEqual(calls, [{ method: "run", noteId: 12 }]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 0, "a done job leaves no row");
});

// The whole point: quitting used to lose everything pending, with nothing
// recorded and no retry. That is why meetings ended up with a transcript and no
// notes and nothing ever tried again.
test("work pending at quit is still there on the next launch", async () => {
  const { db, store } = freshStore();
  const first = queueWith(store);

  first.queue.enqueueKind("post-call-20", JOB_KINDS.POST_CALL_PIPELINE, { noteId: 20 });
  first.queue.enqueueKind("post-call-21", JOB_KINDS.POST_CALL_PIPELINE, { noteId: 21 });
  // Quit: main.js calls cancelPending(), which empties the in-memory array.
  first.queue.cancelPending();

  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 2, "the rows survive");

  const second = queueWith(new JobStore(db));
  assert.equal(second.queue.recover(), 2);
  await second.queue.drain();

  assert.deepEqual(
    second.calls.map((c) => c.noteId).sort(),
    [20, 21],
    "both meetings are picked up by the next launch"
  );
});

test("a job interrupted mid-flight comes back as pending, not as a failure", () => {
  const { db, store } = freshStore();
  const row = store.insert("post-call-30", JOB_KINDS.POST_CALL_PIPELINE, { noteId: 30 });
  store.markRunning(row.id);

  // The app is killed here. Nothing marks it failed, because nothing rejected.
  const recovered = new JobStore(db).recoverInterrupted();

  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].job_key, "post-call-30");
  assert.equal(recovered[0].attempts, 1, "the attempt it did make still counts");
});

// A job that can never succeed must not be retried forever across launches --
// which is worse than losing it, because it runs at every startup and the user
// cannot see why.
test("a job that always fails is retried a bounded number of times", async () => {
  const { db, store } = freshStore();
  store.insert("post-call-40", JOB_KINDS.POST_CALL_PIPELINE, { noteId: 40 });

  let launches = 0;
  for (let launch = 0; launch < MAX_ATTEMPTS + 3; launch += 1) {
    const { queue } = queueWith(new JobStore(db), async () => {
      throw new Error("model missing");
    });
    if (queue.recover() > 0) launches += 1;
    await queue.drain();
  }

  assert.equal(launches, MAX_ATTEMPTS, `tried on ${MAX_ATTEMPTS} launches, then stopped`);

  const row = db.prepare("SELECT * FROM jobs WHERE job_key = 'post-call-40'").get();
  assert.equal(row.status, "failed");
  assert.equal(row.attempts, MAX_ATTEMPTS);
  assert.equal(row.last_error, "model missing", "and it says why, instead of vanishing");
});

// The failure mode persistence exists FOR, and the one that can loop. A job
// that rejects runs markFailed and is bounded. A job that takes the PROCESS down
// -- an ONNX bad_alloc, an OOM kill, a hard power-off -- never reaches markFailed
// and leaves its row `running`. Without a bound on the running revival, a job
// that reliably kills the app is re-queued at every launch forever, before any
// window exists, and the only escape is editing SQLite by hand.
test("a job that crashes the app is not re-queued forever", () => {
  const { db, store } = freshStore();
  store.insert("post-call-99", JOB_KINDS.POST_CALL_PIPELINE, { noteId: 99 });

  let launchesThatRanIt = 0;
  for (let launch = 0; launch < MAX_ATTEMPTS + 4; launch += 1) {
    const recovering = new JobStore(db);
    const pending = recovering.recoverInterrupted();
    if (pending.some((row) => row.job_key === "post-call-99")) {
      launchesThatRanIt += 1;
      // The process dies here: markRunning has counted the attempt, and nothing
      // ever runs markDone or markFailed.
      recovering.markRunning(pending.find((row) => row.job_key === "post-call-99").id);
    }
  }

  assert.equal(
    launchesThatRanIt,
    MAX_ATTEMPTS,
    `a crashing job must stop after ${MAX_ATTEMPTS} launches, not run every time`
  );

  const row = db.prepare("SELECT * FROM jobs WHERE job_key = 'post-call-99'").get();
  assert.equal(row.status, "failed", "and it must not sit at 'running' forever");
  assert.match(row.last_error, /interrupted/);
});

test("a failure is recorded rather than losing the job silently", async () => {
  const { db, store } = freshStore();
  const { queue } = queueWith(store, async () => {
    throw new Error("llama-server died");
  });

  queue.enqueueKind("post-call-50", JOB_KINDS.POST_CALL_PIPELINE, { noteId: 50 });
  await queue.drain();

  const row = db.prepare("SELECT * FROM jobs WHERE job_key = 'post-call-50'").get();
  assert.equal(row.status, "failed");
  assert.equal(row.attempts, 1);
  assert.equal(row.last_error, "llama-server died");
});

// A `failed` row is a finished attempt, not a queued one. If it blocked new
// requests, one failure would silently swallow every later enqueue for that
// note -- a worse version of the bug this whole change exists to fix. It also
// matters because _enqueuePostCallPipeline gates the large-model auto-download
// on the return value.
test("a failed job does not block a fresh request for the same note", async () => {
  const { db, store } = freshStore();
  const failing = queueWith(store, async () => {
    throw new Error("llama-server died");
  });

  failing.queue.enqueueKind("post-call-80", JOB_KINDS.POST_CALL_PIPELINE, { noteId: 80 });
  await failing.queue.drain();
  assert.equal(db.prepare("SELECT status FROM jobs WHERE job_key='post-call-80'").get().status, "failed");

  const retry = queueWith(new JobStore(db));
  assert.equal(
    retry.queue.enqueueKind("post-call-80", JOB_KINDS.POST_CALL_PIPELINE, { noteId: 80 }),
    true,
    "a new request must be accepted, not swallowed by the old failure"
  );
  await retry.queue.drain();

  assert.deepEqual(retry.calls, [{ method: "run", noteId: 80 }]);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE job_key='post-call-80'").get().n,
    0,
    "and it succeeded, so the row is gone"
  );
});

test("reviving a failed job keeps its attempt count, so the bound still holds", async () => {
  const { db, store } = freshStore();
  const first = queueWith(store, async () => {
    throw new Error("nope");
  });
  first.queue.enqueueKind("post-call-81", JOB_KINDS.POST_CALL_PIPELINE, { noteId: 81 });
  await first.queue.drain();

  const revived = new JobStore(db).insert("post-call-81", JOB_KINDS.POST_CALL_PIPELINE, {
    noteId: 81,
  });

  assert.equal(revived.status, "pending");
  assert.equal(revived.attempts, 1, "the failed attempt still counts toward MAX_ATTEMPTS");
  assert.equal(revived.last_error, null, "but the stale reason is cleared");
});

test("a job that is still queued is not revived out from under itself", () => {
  const { store } = freshStore();
  const row = store.insert("post-call-82", JOB_KINDS.POST_CALL_PIPELINE, { noteId: 82 });
  store.markRunning(row.id);

  assert.equal(
    store.insert("post-call-82", JOB_KINDS.POST_CALL_PIPELINE, { noteId: 82 }),
    null,
    "a running job must not be re-queued and run twice"
  );
});

test("enqueuing the same key twice runs the pipeline once", async () => {
  const { store } = freshStore();
  const { queue, calls } = queueWith(store);

  assert.equal(queue.enqueueKind("post-call-60", JOB_KINDS.POST_CALL_PIPELINE, { noteId: 60 }), true);
  assert.equal(
    queue.enqueueKind("post-call-60", JOB_KINDS.POST_CALL_PIPELINE, { noteId: 60 }),
    false,
    "the second says so rather than pretending it queued"
  );

  await queue.drain();
  assert.equal(calls.length, 1);
});

test("one job at a time, whatever recovery hands it", async () => {
  const { db, store } = freshStore();
  for (const noteId of [1, 2, 3, 4]) {
    store.insert(`post-call-${noteId}`, JOB_KINDS.POST_CALL_PIPELINE, { noteId });
  }

  let concurrent = 0;
  let peak = 0;
  const { queue } = queueWith(new JobStore(db), async () => {
    concurrent += 1;
    peak = Math.max(peak, concurrent);
    await new Promise((resolve) => setTimeout(resolve, 1));
    concurrent -= 1;
  });

  queue.recover();
  await queue.drain();

  assert.equal(peak, 1, "recovery must not launch four pipelines at once");
});

test("fromStep travels with the job", async () => {
  const { store } = freshStore();
  const { queue, calls } = queueWith(store);

  queue.enqueueKind("post-call-retry-70", JOB_KINDS.POST_CALL_PIPELINE, {
    noteId: 70,
    fromStep: "notes",
  });
  queue.enqueueKind("regenerate-notes-71", JOB_KINDS.REGENERATE_NOTES, { noteId: 71 });
  await queue.drain();

  assert.deepEqual(calls, [
    { method: "run", noteId: 70, fromStep: "notes" },
    { method: "runSingleStep", noteId: 71, step: "notes" },
  ]);
});

// A row written by a newer version and read by an older one is a real
// possibility after a downgrade. Doing nothing quietly is the failure this
// whole change exists to remove.
test("an unknown job kind fails loudly instead of disappearing", async () => {
  const { db, store } = freshStore();
  store.insert("weird-1", "kind-from-the-future", { noteId: 1 });

  const { queue } = queueWith(new JobStore(db));
  queue.recover();
  await queue.drain();

  const row = db.prepare("SELECT * FROM jobs WHERE job_key = 'weird-1'").get();
  assert.equal(row.status, "failed");
  assert.match(row.last_error, /Unknown job kind/);
});

test("without a store the queue behaves exactly as it did before", async () => {
  const queue = new BackgroundJobQueue();
  const ran = [];
  queue.enqueue("plain", async () => ran.push("plain"));
  await queue.drain();
  assert.deepEqual(ran, ["plain"]);
});

test("every dispatchable kind is one the dispatcher knows", () => {
  for (const kind of Object.values(JOB_KINDS)) {
    assert.equal(isKnownJobKind(kind), true, `${kind} has no handler`);
  }
  assert.throws(() => runJob({}, "not-a-kind", {}), /Unknown job kind/);
});

// The DDL above is a copy of database.js's. Asserting that each contains the
// same handful of strings would not catch drift -- add a column to database.js
// and both still pass. So the two are normalised and compared to each other.
test("the jobs schema here is identical to the one the app creates", () => {
  const fs = require("node:fs");
  const source = fs.readFileSync(require.resolve("../../src/helpers/database.js"), "utf8");

  const marker = "CREATE TABLE IF NOT EXISTS jobs";
  const start = source.indexOf(marker);
  assert.ok(start > -1, "database.js no longer creates a jobs table");

  // Balance parentheses from the opening one, so the end is found rather than
  // guessed at by searching for a column name that might move.
  const open = source.indexOf("(", start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "(") depth += 1;
    else if (source[i] === ")") {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  assert.ok(end > -1, "unbalanced parentheses in the jobs DDL");

  const normalise = (ddl) =>
    ddl
      .slice(ddl.indexOf("("))
      .replace(/\s+/g, " ")
      .replace(/\s*,\s*/g, ",")
      .trim();

  assert.equal(
    normalise(source.slice(start, end)),
    normalise(JOBS_DDL),
    "this file's jobs DDL has drifted from the one database.js creates"
  );
});
