const { EventEmitter } = require("events");
const debugLogger = require("./debugLogger");
const { runJob } = require("./jobDispatch");

class BackgroundJobQueue extends EventEmitter {
  constructor() {
    super();
    this._queue = [];
    this._running = false;
    this._activeJob = null;
    this._store = null;
    this._dependencies = null;
  }

  /**
   * Gives the queue somewhere to write jobs down.
   *
   * Optional on purpose. Without it the queue behaves exactly as it always has
   * -- in memory, closures, lost on quit -- which is what every existing
   * enqueue() caller and the tests rely on. Persistence is opt-in per job, via
   * enqueueKind.
   */
  usePersistence(store, dependencies) {
    this._store = store;
    this._dependencies = dependencies;
  }

  /**
   * Enqueues a job that survives a quit.
   *
   * Returns false when this key is already queued. The keys already name one
   * unit of work per note, so enqueuing "post-call-12" twice used to run the
   * pipeline for note 12 twice; it now runs once.
   *
   * Falls back to a plain in-memory job when no store is attached, so a caller
   * never has to ask whether persistence happens to be wired up.
   */
  enqueueKind(jobKey, kind, payload = {}) {
    if (!this._store) {
      this.enqueue(jobKey, () => runJob(this._dependencies, kind, payload));
      return true;
    }

    let row;
    try {
      row = this._store.insert(jobKey, kind, payload);
    } catch (error) {
      // A queue that cannot write its row is still better than no queue: run it
      // in memory rather than dropping the user's meeting on the floor.
      debugLogger.error("Could not record background job; running it unpersisted", {
        jobKey,
        kind,
        error: error.message,
      });
      this.enqueue(jobKey, () => runJob(this._dependencies, kind, payload));
      return true;
    }

    if (!row) {
      debugLogger.info("Background job already queued", { jobKey, kind });
      return false;
    }

    this._enqueueRow(row);
    return true;
  }

  // Re-enqueues a row that is already in the table -- from enqueueKind, or from
  // recovery at startup.
  _enqueueRow(row) {
    const payload = JSON.parse(row.payload || "{}");
    this.enqueue(row.job_key, async () => {
      this._store.markRunning(row.id);
      try {
        await runJob(this._dependencies, row.kind, payload);
        this._store.markDone(row.id);
      } catch (error) {
        this._store.markFailed(row.id, error);
        throw error;
      }
    });
  }

  /**
   * Re-queues everything a previous run left behind.
   *
   * The rows go into the same single-slot queue, so they run one at a time --
   * "not several at once" is a property of the queue, not of this method.
   */
  recover() {
    if (!this._store) return 0;

    let rows = [];
    try {
      rows = this._store.recoverInterrupted();
    } catch (error) {
      debugLogger.error("Could not recover background jobs", { error: error.message });
      return 0;
    }

    for (const row of rows) {
      this._enqueueRow(row);
    }
    return rows.length;
  }

  get length() {
    return this._queue.length;
  }

  get activeJob() {
    return this._activeJob;
  }

  enqueue(jobId, fn) {
    this._queue.push({ id: jobId, fn });
    if (!this._running) this._process();
  }

  // Clears the in-memory queue only. Persisted rows deliberately stay `pending`
  // so the next launch picks them up -- losing them on quit is the defect this
  // exists to fix, and this is the method called on quit.
  cancelPending() {
    this._queue.length = 0;
  }

  async drain() {
    if (!this._running && this._queue.length === 0) return;
    return new Promise((resolve) => {
      const check = () => {
        if (!this._running && this._queue.length === 0) {
          this.removeListener("_tick", check);
          resolve();
        }
      };
      this.on("_tick", check);
      check();
    });
  }

  async _process() {
    if (this._running) return;
    this._running = true;

    while (this._queue.length > 0) {
      const { id, fn } = this._queue.shift();
      this._activeJob = id;
      this.emit("status", { jobId: id, status: "running" });

      try {
        await fn();
        this.emit("status", { jobId: id, status: "complete" });
      } catch (err) {
        this.emit("status", { jobId: id, status: "error", error: err.message });
      }

      this._activeJob = null;
      this.emit("_tick");
    }

    this._running = false;
    this.emit("_tick");
  }
}

module.exports = { BackgroundJobQueue };
