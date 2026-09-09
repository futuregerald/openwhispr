const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { requireSqlite } = require("../support/sqlite.js");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-backfill-"));
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: { getPath: () => userDataDir, getAppPath: () => process.cwd(), isReady: () => false },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

process.env.NODE_ENV = "test";

const DatabaseManager = require("../../src/helpers/database.js");
const {
  findTranscriptOriginBackfills,
  applyTranscriptOriginBackfill,
  deriveOrigin,
} = require("../../src/helpers/transcriptOriginBackfill.js");

const ORIGIN = 1788877057845;

function createDb() {
  requireSqlite();
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-backfill-"));
  return new DatabaseManager();
}

const openDatabase = (file) => {
  const Database = requireSqlite();
  return new Database(file, { readonly: true });
};

// Epoch-stamped, exactly as the four repaired notes looked before Phase C touched them.
function epochSegments() {
  return [
    { id: "a", source: "system", speaker: "speaker_0", timestamp: ORIGIN },
    { id: "b", source: "mic", speaker: "you", timestamp: ORIGIN + 12500 },
    { id: "c", source: "system", speaker: "speaker_1", timestamp: ORIGIN + 30250 },
  ];
}

// The same transcript after the repair re-based it onto min(stamps).
function relativeSegments() {
  const origin = ORIGIN;
  return epochSegments().map((segment) => ({
    ...segment,
    timestamp: (segment.timestamp - origin) / 1000,
  }));
}

function backupsDir() {
  const dir = path.join(userDataDir, "backups");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeBackup(name, segmentsById, mtimeMs) {
  const Database = requireSqlite();
  const file = path.join(backupsDir(), name);
  const db = new Database(file);
  db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, transcript TEXT)");
  const stmt = db.prepare("INSERT INTO notes (id, transcript) VALUES (?, ?)");
  for (const [id, segments] of Object.entries(segmentsById)) {
    stmt.run(Number(id), segments === null ? null : JSON.stringify(segments));
  }
  db.close();
  if (mtimeMs) fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

function noteWithTranscript(db, segments) {
  const note = db.saveNote("Weekend catch-up", "body", "meeting").note;
  db.db.prepare("UPDATE notes SET transcript = ? WHERE id = ?").run(
    JSON.stringify(segments),
    note.id
  );
  return note.id;
}

function find(db) {
  return findTranscriptOriginBackfills({
    databaseManager: db,
    backupsDir: path.join(userDataDir, "backups"),
    openDatabase,
  });
}

test("recovers the origin of a repaired note from the repair's own backup", () => {
  const db = createDb();
  const id = noteWithTranscript(db, relativeSegments());
  writeBackup("transcriptions-attribution-repair-2026-09-09T14-28-03.db", {
    [id]: epochSegments(),
  });

  const found = find(db);

  assert.equal(found.length, 1);
  assert.equal(found[0].noteId, id);
  assert.equal(found[0].originMs, ORIGIN);

  const result = applyTranscriptOriginBackfill({ ...found[0], databaseManager: db });
  assert.equal(result.applied, true);

  const note = db.getNote(id);
  assert.equal(note.transcript_origin_ms, ORIGIN);
  assert.equal(note.transcript_origin_source, "first-segment");
  db.close?.();
});

test("a newer, already re-based backup does not block recovery from an older one", () => {
  const db = createDb();
  const id = noteWithTranscript(db, relativeSegments());
  // Written by a LATER launch's repair: this note is already re-based here, so it cannot
  // answer. Taking the newest backup would read exactly this one.
  writeBackup("transcriptions-attribution-repair-2026-09-10T09-00-00.db", {
    [id]: relativeSegments(),
  }, Date.now());
  writeBackup("transcriptions-attribution-repair-2026-09-09T14-28-03.db", {
    [id]: epochSegments(),
  }, Date.now() - 86400000);

  const found = find(db);

  assert.equal(found.length, 1, "the older, usable backup must be the one that answers");
  assert.equal(found[0].originMs, ORIGIN);
  db.close?.();
});

test("skips a note whose live copy still holds epoch stamps, whose span can never match", () => {
  const db = createDb();
  const id = noteWithTranscript(db, epochSegments());
  writeBackup("transcriptions-attribution-repair-2026-09-09T14-28-03.db", {
    [id]: epochSegments(),
  });

  assert.deepEqual(find(db), []);
  db.close?.();
});

test("skips a note whose span no longer matches, because the transcript changed after repair", () => {
  const db = createDb();
  const drifted = relativeSegments();
  drifted[drifted.length - 1].timestamp += 0.002;
  const id = noteWithTranscript(db, drifted);
  writeBackup("transcriptions-attribution-repair-2026-09-09T14-28-03.db", {
    [id]: epochSegments(),
  });

  assert.deepEqual(find(db), []);
  db.close?.();
});

test("skips a note that gained an unstamped segment, which no stamp count would notice", () => {
  const db = createDb();
  const live = relativeSegments();
  live.push({ id: "d", source: "system", speaker: "speaker_1" });
  const id = noteWithTranscript(db, live);
  writeBackup("transcriptions-attribution-repair-2026-09-09T14-28-03.db", {
    [id]: epochSegments(),
  });

  assert.deepEqual(find(db), []);
  db.close?.();
});

test("with no usable backup it enqueues nothing, leaving the note eligible for a later launch", () => {
  const db = createDb();
  const id = noteWithTranscript(db, relativeSegments());
  backupsDir();

  assert.deepEqual(find(db), [], "nothing to do yet");

  // The note must still be a candidate — not recorded as handled.
  assert.equal(
    db.listNotesMissingTranscriptOrigin().some((row) => row.id === id),
    true,
    "the note must stay eligible so a backup arriving later can still answer"
  );

  writeBackup("transcriptions-attribution-repair-2026-09-09T14-28-03.db", {
    [id]: epochSegments(),
  });
  assert.equal(find(db).length, 1, "and it is recovered once a usable backup exists");
  db.close?.();
});

test("recording a recovered origin does not restamp updated_at", () => {
  const db = createDb();
  const olderId = noteWithTranscript(db, relativeSegments());
  const newerId = noteWithTranscript(db, relativeSegments());
  db.db.prepare("UPDATE notes SET updated_at = ? WHERE id = ?").run("2024-01-01 00:00:00", olderId);
  db.db.prepare("UPDATE notes SET updated_at = ? WHERE id = ?").run("2026-09-08 12:00:00", newerId);
  writeBackup("transcriptions-attribution-repair-2026-09-09T14-28-03.db", {
    [olderId]: epochSegments(),
  });
  const before = db.getNote(olderId).updated_at;
  const orderBefore = db.getNotes().map((note) => note.id);

  const found = find(db);
  applyTranscriptOriginBackfill({ ...found[0], databaseManager: db });

  assert.equal(db.getNote(olderId).updated_at, before);
  assert.deepEqual(db.getNotes().map((note) => note.id), orderBefore);
  db.close?.();
});

test("when two backups both answer, the oldest wins, because a later one may be re-based", () => {
  const db = createDb();
  const id = noteWithTranscript(db, relativeSegments());
  // Both are epoch-stamped and internally consistent, so both pass every guard. Only the
  // order decides, and the older copy is the one taken before any re-basing happened.
  const shifted = epochSegments().map((segment) => ({
    ...segment,
    timestamp: segment.timestamp + 5000,
  }));
  writeBackup("transcriptions-attribution-repair-2026-09-10T09-00-00.db", { [id]: shifted },
    Date.now());
  writeBackup("transcriptions-attribution-repair-2026-09-09T14-28-03.db", { [id]: epochSegments() },
    Date.now() - 86400000);

  const found = find(db);

  assert.equal(found.length, 1);
  assert.equal(found[0].originMs, ORIGIN, "the older backup's origin must win");
  assert.ok(found[0].backup.includes("2026-09-09"), `took ${found[0].backup}`);
  db.close?.();
});

const { JOB_KINDS, runJob, isKnownJobKind } = require("../../src/helpers/jobDispatch.js");
const { JobStore } = require("../../src/helpers/jobStore.js");
const { BackgroundJobQueue } = require("../../src/helpers/backgroundJobQueue.js");
const IPCHandlers = require("../../src/helpers/ipcHandlers.js");

test("the backfill kind is a persisted kind the dispatcher knows", () => {
  assert.equal(typeof JOB_KINDS.BACKFILL_TRANSCRIPT_ORIGIN, "string");
  assert.equal(isKnownJobKind(JOB_KINDS.BACKFILL_TRANSCRIPT_ORIGIN), true);

  const seen = [];
  runJob(
    {
      ipcHandlers: {
        backfillTranscriptOrigin: (noteId, originMs) => seen.push({ noteId, originMs }),
      },
    },
    JOB_KINDS.BACKFILL_TRANSCRIPT_ORIGIN,
    { noteId: 36, originMs: ORIGIN }
  );

  assert.deepEqual(seen, [{ noteId: 36, originMs: ORIGIN }]);
});

// recover() does not merely enqueue: enqueue() calls _process(), which runs synchronously
// up to its first real await, and the repair handler is fully synchronous. So a repair left
// pending by an interrupted launch runs INSIDE recover(). It mints a backup, and minting
// prunes the oldest -- the copy the origins are read from. Stubbing recover() out, as an
// earlier version of this test did, cannot see any of that.
test("origins are derived before a pending repair can run and prune the backup", () => {
  const Database = requireSqlite();
  const jobsDb = new Database(":memory:");
  jobsDb.exec(`
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, job_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const store = new JobStore(jobsDb);
  store.insert("repair-attribution-14", JOB_KINDS.REPAIR_NOTE_ATTRIBUTION, { noteId: 14 });

  const order = [];
  const queue = new BackgroundJobQueue();
  const handlers = Object.create(IPCHandlers.prototype);
  Object.assign(handlers, {
    backgroundJobQueue: queue,
    databaseManager: {},
    _enqueueTranscriptOriginBackfills: () => order.push("derive"),
    _enqueueNoteAttributionRepairs: () => {},
  });
  queue.usePersistence(store, {
    postCallPipelineManager: { run: async () => {}, runSingleStep: async () => {} },
    ipcHandlers: { repairNoteAttribution: () => order.push("repair") },
  });

  handlers.recoverBackgroundJobs();

  assert.deepEqual(order, ["derive", "repair"]);
  jobsDb.close();
});

// deriveOrigin is the safety-critical half: a wrong origin is worse than none, because a
// consumer prints it as wall clock. Each case below is an input where an earlier version
// returned an origin it had no evidence for.

const bk = (...stamps) => JSON.stringify(stamps.map((t, i) => (t === null ? { id: i } : { id: i, timestamp: t })));
const live = (...stamps) => stamps.map((t, i) => (t === null ? { id: i } : { id: i, timestamp: t }));

test("deriveOrigin accepts the genuine re-based pair", () => {
  assert.equal(deriveOrigin(bk(ORIGIN, ORIGIN + 30250), live(0, 30.25)), ORIGIN);
});

test("deriveOrigin refuses a live copy that is not zero-based", () => {
  assert.equal(deriveOrigin(bk(ORIGIN, ORIGIN + 30250), live(30.25, 30.25)), null);
});

test("deriveOrigin refuses when the stamp moved to a different segment", () => {
  assert.equal(deriveOrigin(bk(ORIGIN, null), live(null, 0)), null);
});

test("deriveOrigin refuses a single-segment note, whose span proves nothing", () => {
  assert.equal(deriveOrigin(bk(ORIGIN), live(0)), null);
});

test("deriveOrigin refuses when every stamp is identical, so the span carries no evidence", () => {
  assert.equal(deriveOrigin(bk(ORIGIN, ORIGIN, ORIGIN), live(0, 0, 0)), null);
});

test("deriveOrigin refuses a backup that is already in relative seconds", () => {
  assert.equal(deriveOrigin(bk(0, 30.25), live(0, 30.25)), null);
});

// The span check passes here -- 30250 ms is 30.25 s -- so only the epoch floor stands
// between this and an origin of 0, which reads back as 1970.
test("deriveOrigin refuses a relative backup even when its span matches exactly", () => {
  assert.equal(deriveOrigin(bk(0, 30250), live(0, 30.25)), null);
});

// Same span, same zero base, one segment quietly lost its stamp. Only the stamp-count
// check can see it.
test("deriveOrigin refuses when a segment lost its stamp but the span still lines up", () => {
  assert.equal(
    deriveOrigin(bk(ORIGIN, ORIGIN + 15000, ORIGIN + 30250), live(0, null, 30.25)),
    null
  );
});

test("deriveOrigin refuses when neither copy carries a usable stamp", () => {
  assert.equal(deriveOrigin(bk(null, null), live(null, null)), null);
});

test("deriveOrigin refuses when the two copies stamp a different number of segments", () => {
  assert.equal(deriveOrigin(bk(ORIGIN, ORIGIN + 30250), live(0, null)), null);
});

test("deriveOrigin refuses a transcript that is not a segment array", () => {
  assert.equal(deriveOrigin("just a string", live(0, 30.25)), null);
  assert.equal(deriveOrigin("[]", live(0, 30.25)), null);
});

test("a note in the trash is not a backfill candidate", () => {
  const db = createDb();
  const id = noteWithTranscript(db, relativeSegments());
  writeBackup("transcriptions-attribution-repair-2026-09-09T14-28-03.db", { [id]: epochSegments() });
  db.db.prepare("UPDATE notes SET deleted_at = ? WHERE id = ?").run("2026-09-09 10:00:00", id);

  assert.deepEqual(find(db), []);
  db.close?.();
});

test("a retranscribed note is not re-derived against a backup it no longer matches", () => {
  const db = createDb();
  const id = noteWithTranscript(db, relativeSegments());
  writeBackup("transcriptions-attribution-repair-2026-09-09T14-28-03.db", { [id]: epochSegments() });
  // What retranscription writes: no origin, and a source saying why it has none.
  db.updateNote(id, { transcript_origin_ms: null, transcript_origin_source: "unanchored" });

  assert.deepEqual(find(db), [], "'cleared' must be distinguishable from 'never derived'");
  db.close?.();
});

test("a non-numeric origin is refused rather than written", () => {
  const db = createDb();
  const id = noteWithTranscript(db, relativeSegments());

  const result = applyTranscriptOriginBackfill({
    noteId: id,
    originMs: Number.NaN,
    databaseManager: db,
  });

  assert.equal(result.applied, false);
  assert.equal(db.getNote(id).transcript_origin_ms, null);
  db.close?.();
});
