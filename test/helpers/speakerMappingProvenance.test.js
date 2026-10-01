const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { requireSqlite } = require("../support/sqlite.js");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-speaker-prov-"));
const originalLoad = Module._load;

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: {
        getPath: () => userDataDir,
        getAppPath: () => process.cwd(),
        isReady: () => false,
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

process.env.NODE_ENV = "test";

const DatabaseManager = require("../../src/helpers/database.js");
const IPCHandlers = require("../../src/helpers/ipcHandlers.js");

function freshDatabase() {
  requireSqlite();
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-speaker-prov-"));
  return new DatabaseManager();
}

function insertNote(db) {
  const info = db.db
    .prepare("INSERT INTO notes (title, transcript) VALUES (?, ?)")
    .run("A meeting", JSON.stringify([]));
  return info.lastInsertRowid;
}

// The first coverage _reconcileLiveSpeakerState has ever had: before this,
// grep -rln _reconcileLiveSpeakerState test/ returned nothing.
function reconcileHarness(db) {
  const handlers = Object.create(IPCHandlers.prototype);
  Object.assign(handlers, { databaseManager: db, _applySpeakerName: () => {} });
  return handlers;
}

const columnsOf = (db, table) =>
  new Map(
    db.db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((c) => [c.name, c])
  );

test("speaker_mappings carries origin and confidence, defaulting to unknown", () => {
  const db = freshDatabase();
  const byName = columnsOf(db, "speaker_mappings");
  assert.ok(byName.has("origin"), "origin column missing");
  assert.ok(byName.has("confidence"), "confidence column missing");
  assert.equal(byName.get("origin").dflt_value, "'unknown'");
});

// The migration runs on every launch, so a non-idempotent one bricks the app on
// restart -- which no single-open test can catch.
test("the provenance migration survives a reopen", () => {
  const db = freshDatabase();
  const noteId = insertNote(db);
  db.db
    .prepare("INSERT INTO speaker_mappings (note_id, speaker_id, display_name) VALUES (?, ?, ?)")
    .run(noteId, "speaker_0", "Dana");
  db.db.close();

  const reopened = new DatabaseManager();
  const byName = columnsOf(reopened, "speaker_mappings");
  assert.ok(byName.has("origin"));
  assert.ok(byName.has("confidence"));
  const row = reopened.getSpeakerMappings(noteId)[0];
  assert.equal(row.origin, "unknown", "a row written before the column existed must stay unknown");
  assert.equal(row.confidence, null);
});

test("setSpeakerMapping refuses to write without provenance", () => {
  const db = freshDatabase();
  const noteId = insertNote(db);
  assert.throws(() => db.setSpeakerMapping(noteId, "speaker_0", null, "Dana"), /origin/i);
});

test("setSpeakerMapping refuses an unrecognised origin", () => {
  const db = freshDatabase();
  const noteId = insertNote(db);
  assert.throws(
    () => db.setSpeakerMapping(noteId, "speaker_0", null, "Dana", { origin: "guess" }),
    /origin/i
  );
});

test("an auto mapping stores its similarity, a manual one stores none", () => {
  const db = freshDatabase();
  const noteId = insertNote(db);
  db.setSpeakerMapping(noteId, "speaker_0", null, "Dana", { origin: "auto", confidence: 0.71 });
  // A confidence IS passed: without one, null comes out either way and the
  // second half of this test cannot fail.
  db.setSpeakerMapping(noteId, "speaker_1", null, "Sam", { origin: "manual", confidence: 0.71 });
  const rows = db.getSpeakerMappings(noteId);
  const dana = rows.find((r) => r.speaker_id === "speaker_0");
  const sam = rows.find((r) => r.speaker_id === "speaker_1");
  assert.equal(dana.origin, "auto");
  assert.ok(Math.abs(dana.confidence - 0.71) < 1e-9);
  assert.equal(sam.origin, "manual");
  assert.equal(sam.confidence, null);
});

// INSERT OR REPLACE replaces the whole row, so an optional argument would let a
// re-write silently reset provenance.
test("rewriting a mapping cannot silently drop its provenance", () => {
  const db = freshDatabase();
  const noteId = insertNote(db);
  db.setSpeakerMapping(noteId, "speaker_0", null, "Dana", { origin: "manual" });
  assert.throws(() => db.setSpeakerMapping(noteId, "speaker_0", null, "Dana"), /origin/i);
  assert.equal(db.getSpeakerMappings(noteId)[0].origin, "manual");
});

// Drives the real branch rather than re-passing carried.origin by hand: a test
// that supplies the value it then asserts on cannot fail, and this one could not.
test("the live reconcile path carries a manual mapping forward without downgrading it", () => {
  const db = freshDatabase();
  const noteId = insertNote(db);
  // The row sits on the LIVE speaker's id, which is what the carry-forward
  // branch looks up before moving it onto the note's new cluster id.
  db.setSpeakerMapping(noteId, "live_0", null, "Dana", { origin: "manual" });

  reconcileHarness(db)._reconcileLiveSpeakerState(
    { live_0: { displayName: "Dana", profileId: null, noteId, embedding: [1, 0] } },
    { speaker_0: [1, 0] },
    []
  );

  const moved = db.getSpeakerMappings(noteId).find((r) => r.speaker_id === "speaker_0");
  assert.ok(moved, "the mapping was not carried forward at all");
  assert.equal(moved.origin, "manual", "a name the user typed was relabelled as a guess");
});

test("the live reconcile path will not overwrite a manual mapping with a guess", () => {
  const db = freshDatabase();
  const noteId = insertNote(db);
  db.setSpeakerMapping(noteId, "speaker_0", null, "Dana", { origin: "manual" });

  reconcileHarness(db)._reconcileLiveSpeakerState(
    { live_9: { displayName: "Someone Else", profileId: null, noteId, embedding: [1, 0] } },
    { speaker_0: [1, 0] },
    []
  );

  const row = db.getSpeakerMappings(noteId).find((r) => r.speaker_id === "speaker_0");
  assert.equal(row.display_name, "Dana", "a manual name was overwritten by a guess");
  assert.equal(row.origin, "manual");
});

// mergeSpeakerProfiles rewrites display_name with a raw UPDATE, bypassing
// setSpeakerMapping entirely -- a sixth write site.
test("merging profiles drops a confidence that no longer describes the name", () => {
  const db = freshDatabase();
  const noteId = insertNote(db);
  const unit = (s) => Buffer.from(Float32Array.from([s, Math.sqrt(1 - s * s)]).buffer);
  db.upsertSpeakerProfile("Jorge Chayan", null, unit(1), null);
  db.upsertSpeakerProfile("J. Chayan", null, unit(0.99), null);
  // getSpeakerProfiles omits the embedding column, and mergeSpeakerProfiles
  // needs it, so read the rows directly.
  const rowFor = (name) =>
    db.db.prepare("SELECT * FROM speaker_profiles WHERE display_name = ?").get(name);
  const winner = rowFor("Jorge Chayan");
  const loser = rowFor("J. Chayan");

  db.setSpeakerMapping(noteId, "speaker_0", loser.id, "J. Chayan", {
    origin: "auto",
    confidence: 0.71,
  });
  db.mergeSpeakerProfiles(winner, loser);

  const row = db.getSpeakerMappings(noteId).find((r) => r.speaker_id === "speaker_0");
  assert.equal(row.confidence, null, "a similarity computed against another name survived a merge");
  assert.equal(row.origin, "auto", "origin should be inherited through a merge, not reset");
});

// --- Task 2 / Task 3: the `agent` origin ---------------------------------
// An MCP rename is neither a user typing a name nor the matcher guessing one.
// It needs its own value so a later audit can find what a model decided.

test("setSpeakerMapping accepts an agent origin and stores no confidence", () => {
  const db = freshDatabase();
  const noteId = insertNote(db);
  // A confidence IS passed, or the assertion below holds for an
  // implementation that simply never stores one for any origin.
  db.setSpeakerMapping(noteId, "speaker_0", null, "Priya", {
    origin: "agent",
    confidence: 0.91,
  });
  const row = db.getSpeakerMappings(noteId).find((r) => r.speaker_id === "speaker_0");
  assert.equal(row.origin, "agent");
  assert.equal(row.confidence, null, "an agent rename carries no similarity score");
});

test("widening the allowlist for agent did not open it to anything else", () => {
  const db = freshDatabase();
  const noteId = insertNote(db);
  for (const origin of ["agents", "Agent", "AGENT", "", "guess", null, undefined, 0]) {
    assert.throws(
      () => db.setSpeakerMapping(noteId, "speaker_0", null, "Priya", { origin }),
      /origin/i,
      `origin ${JSON.stringify(origin)} should be refused`
    );
  }
});

test("live reconciliation leaves an agent name alone, exactly as it leaves a manual one", () => {
  const db = freshDatabase();
  const noteId = insertNote(db);
  db.setSpeakerMapping(noteId, "speaker_0", null, "Priya", { origin: "agent" });

  reconcileHarness(db)._reconcileLiveSpeakerState(
    { live_9: { displayName: "Someone Else", profileId: null, noteId, embedding: [1, 0] } },
    { speaker_0: [1, 0] },
    []
  );

  const row = db.getSpeakerMappings(noteId).find((r) => r.speaker_id === "speaker_0");
  assert.equal(row.display_name, "Priya", "an agent rename was overwritten by a guess");
  assert.equal(row.origin, "agent", "origin was downgraded to auto");
});

test("live reconciliation still overwrites an auto name, so the guard is not blanket", () => {
  const db = freshDatabase();
  const noteId = insertNote(db);
  db.setSpeakerMapping(noteId, "speaker_0", null, "Guessed", {
    origin: "auto",
    confidence: 0.7,
  });

  reconcileHarness(db)._reconcileLiveSpeakerState(
    { live_9: { displayName: "Someone Else", profileId: null, noteId, embedding: [1, 0] } },
    { speaker_0: [1, 0] },
    []
  );

  const row = db.getSpeakerMappings(noteId).find((r) => r.speaker_id === "speaker_0");
  assert.equal(row.display_name, "Someone Else", "an auto row should still be re-scorable");
});
