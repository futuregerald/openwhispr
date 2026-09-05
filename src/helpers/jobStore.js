const debugLogger = require("./debugLogger");

// Three launches, not three retries. A job that fails is terminal for the rest
// of the session -- re-enqueuing it immediately is how a permanently broken job
// becomes a busy loop -- and recoverInterrupted is the only thing that gives it
// another go. So the bound is on launches, which is what the issue asks for:
// "a job that always fails must not become an infinite loop across launches".
const MAX_ATTEMPTS = 3;

const PENDING = "pending";
const RUNNING = "running";
const FAILED = "failed";

/**
 * Persistence for the background job queue.
 *
 * Deliberately knows nothing about what a job DOES -- that is jobDispatch's
 * job -- so the SQL can be tested against a real database without Electron,
 * a pipeline manager, or a model.
 */
class JobStore {
  constructor(db) {
    this.db = db;
  }

  /**
   * Records a job, or returns the existing row if this key is already queued.
   *
   * Returns null when the key is already present, so the caller can tell
   * "queued" from "already queued" and not run the same pipeline twice.
   */
  insert(jobKey, kind, payload = {}) {
    const result = this.db
      .prepare(
        `INSERT INTO jobs (job_key, kind, payload, status, attempts)
         VALUES (?, ?, ?, '${PENDING}', 0)
         ON CONFLICT(job_key) DO NOTHING`
      )
      .run(jobKey, kind, JSON.stringify(payload));

    if (result.changes === 0) {
      return null;
    }

    return this.db.prepare("SELECT * FROM jobs WHERE job_key = ?").get(jobKey);
  }

  markRunning(id) {
    this.db
      .prepare(
        `UPDATE jobs
         SET status = '${RUNNING}', attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      )
      .run(id);
  }

  // A finished job leaves no row. The table is a work list, not a history --
  // keeping completed rows would need its own pruning, and nothing reads them.
  markDone(id) {
    this.db.prepare("DELETE FROM jobs WHERE id = ?").run(id);
  }

  markFailed(id, error) {
    this.db
      .prepare(
        `UPDATE jobs
         SET status = '${FAILED}', last_error = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      )
      .run(String(error?.message || error || "unknown"), id);
  }

  pending() {
    return this.db
      .prepare(`SELECT * FROM jobs WHERE status = '${PENDING}' ORDER BY id ASC`)
      .all();
  }

  /**
   * Puts back what a quit interrupted, and gives a failed job one more launch.
   *
   * `running` means the app died mid-job: it was interrupted, not rejected, so
   * it goes back to pending with its attempt already counted. A `failed` job
   * comes back only while it is under MAX_ATTEMPTS, which is what stops a job
   * that can never succeed from being retried forever.
   *
   * Returns the rows now pending, in insertion order. The caller re-enqueues
   * them into a queue that runs one at a time, so "not several at once" holds
   * by construction rather than by anything here.
   */
  recoverInterrupted() {
    const interrupted = this.db
      .prepare(
        `UPDATE jobs SET status = '${PENDING}', updated_at = CURRENT_TIMESTAMP
         WHERE status = '${RUNNING}'`
      )
      .run();

    const retried = this.db
      .prepare(
        `UPDATE jobs SET status = '${PENDING}', updated_at = CURRENT_TIMESTAMP
         WHERE status = '${FAILED}' AND attempts < ?`
      )
      .run(MAX_ATTEMPTS);

    const exhausted = this.db
      .prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status = '${FAILED}'`)
      .get().n;

    if (interrupted.changes || retried.changes || exhausted) {
      debugLogger.info("Recovered background jobs", {
        interrupted: interrupted.changes,
        retried: retried.changes,
        exhausted,
      });
    }

    return this.pending();
  }
}

module.exports = { JobStore, MAX_ATTEMPTS, PENDING, RUNNING, FAILED };
