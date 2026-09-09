const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { requireSqlite } = require("../support/sqlite.js");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-attr-repair-"));
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
const {
  findNotesNeedingAttributionRepair,
  repairNoteAttribution,
  readRepairSummary,
  appendRepairSummary,
  clearRepairSummary,
} = require("../../src/helpers/noteAttributionRepair.js");
const fixture = require("../fixtures/preRepairMeetingTranscript.json");

function createDb() {
  requireSqlite();
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-attr-repair-"));
  return new DatabaseManager();
}

function noteWithTranscript(db, segments, title = "Standup") {
  const note = db.saveNote(title, "body", "meeting").note;
  db.db
    .prepare("UPDATE notes SET transcript = ? WHERE id = ?")
    .run(JSON.stringify(segments), note.id);
  return note.id;
}

function ageNote(db, id, when) {
  db.db.prepare("UPDATE notes SET updated_at = ? WHERE id = ?").run(when, id);
}

const brokenSegments = () => JSON.parse(JSON.stringify(fixture.segments));

function refusingUpdateNote(db) {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === "updateNote") {
        throw new Error("repair reached updateNote, which would restamp updated_at");
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

test("repair attributes every orphaned mic segment in a stored note", () => {
  const db = createDb();
  const id = noteWithTranscript(db, brokenSegments());

  const result = repairNoteAttribution({
    noteId: id,
    databaseManager: refusingUpdateNote(db),
    broadcast: () => {},
    userDataDir,
  });

  assert.equal(result.repaired, true);
  assert.equal(result.micAttributed, 356);
  assert.equal(result.timestampsNormalised, 672);
  assert.equal(result.skippedMixedUnits, false);

  const stored = JSON.parse(db.getNote(id).transcript);
  assert.equal(stored.filter((s) => s.source === "mic" && !s.speaker).length, 0);
  assert.equal(stored.length, 672);
});

test("repair leaves updated_at alone so the note list keeps its order", () => {
  const db = createDb();
  const olderId = noteWithTranscript(db, brokenSegments(), "Old meeting");
  const newerId = noteWithTranscript(db, [], "Yesterday's note");
  ageNote(db, olderId, "2024-01-01 00:00:00");
  ageNote(db, newerId, "2026-09-08 12:00:00");

  const before = db.getNote(olderId).updated_at;
  const orderBefore = db.getNotes().map((n) => n.id);

  repairNoteAttribution({
    noteId: olderId,
    databaseManager: refusingUpdateNote(db),
    broadcast: () => {},
    userDataDir,
  });

  assert.equal(db.getNote(olderId).updated_at, before);
  assert.deepEqual(db.getNotes().map((n) => n.id), orderBefore);
  assert.equal(orderBefore[0], newerId, "the newest note must still be first");
});

test("the repair is committed to the database before anything is broadcast", () => {
  const db = createDb();
  const id = noteWithTranscript(db, brokenSegments());
  const storedWhenBroadcast = [];

  repairNoteAttribution({
    noteId: id,
    databaseManager: refusingUpdateNote(db),
    broadcast: () => storedWhenBroadcast.push(db.getNote(id).transcript),
    userDataDir,
  });

  assert.equal(storedWhenBroadcast.length, 1);
  assert.equal(
    JSON.parse(storedWhenBroadcast[0]).filter((s) => s.source === "mic" && !s.speaker).length,
    0,
    "a renderer that loads notes after the repair must read repaired rows from the database"
  );
});

test("the broadcast carries the repaired note for a window that is already open", () => {
  const db = createDb();
  const id = noteWithTranscript(db, brokenSegments());
  const broadcasts = [];

  repairNoteAttribution({
    noteId: id,
    databaseManager: refusingUpdateNote(db),
    broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
    userDataDir,
  });

  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].channel, "note-updated");
  assert.equal(broadcasts[0].payload.id, id);
  assert.equal(
    JSON.parse(broadcasts[0].payload.transcript).filter((s) => s.source === "mic" && !s.speaker)
      .length,
    0
  );
});

test("a second repair writes nothing and broadcasts nothing", () => {
  const db = createDb();
  const id = noteWithTranscript(db, brokenSegments());
  const wrapped = refusingUpdateNote(db);

  repairNoteAttribution({ noteId: id, databaseManager: wrapped, broadcast: () => {}, userDataDir });
  const afterFirst = db.getNote(id).transcript;

  const broadcasts = [];
  const second = repairNoteAttribution({
    noteId: id,
    databaseManager: wrapped,
    broadcast: () => broadcasts.push(1),
    userDataDir,
  });

  assert.equal(second.repaired, false);
  assert.equal(broadcasts.length, 0);
  assert.equal(db.getNote(id).transcript, afterFirst, "a second pass must be byte-identical");
});

test("a note with no usable transcript is left alone", () => {
  const db = createDb();
  const plain = db.saveNote("Dictation", "just text").note;
  db.db.prepare("UPDATE notes SET transcript = ? WHERE id = ?").run("just text", plain.id);

  const result = repairNoteAttribution({
    noteId: plain.id,
    databaseManager: refusingUpdateNote(db),
    broadcast: () => {},
    userDataDir,
  });

  assert.equal(result.repaired, false);
  assert.equal(db.getNote(plain.id).transcript, "just text");
});

test("a missing note is reported rather than thrown", () => {
  const db = createDb();

  const result = repairNoteAttribution({
    noteId: 9999,
    databaseManager: refusingUpdateNote(db),
    broadcast: () => {},
    userDataDir,
  });

  assert.equal(result.repaired, false);
});

test("only notes that actually need work are listed for repair", () => {
  const db = createDb();
  const broken = noteWithTranscript(db, brokenSegments(), "Broken");
  const healthy = noteWithTranscript(
    db,
    [
      { text: "w0000", source: "mic", timestamp: 0, speaker: "you" },
      { text: "w0001", source: "system", timestamp: 2.5, speaker: "speaker_0" },
    ],
    "Healthy"
  );
  db.saveNote("Plain dictation", "no transcript at all");

  const candidates = findNotesNeedingAttributionRepair(db);

  assert.deepEqual(
    candidates.map((c) => c.id),
    [broken]
  );
  assert.equal(candidates[0].micAttributed, 356);
  assert.ok(!candidates.some((c) => c.id === healthy));
});

test("a mixed-unit note is listed only when its mic speech is still un-owned", () => {
  const db = createDb();
  const segments = brokenSegments();
  const origin = Math.min(...segments.map((s) => s.timestamp));
  const mixed = segments.map((s) =>
    s.source === "system" ? { ...s, timestamp: (s.timestamp - origin) / 1000 } : s
  );
  const mixedAttributed = mixed.map((s) =>
    s.source === "mic" ? { ...s, speaker: "you", speakerStatus: "confirmed" } : s
  );

  const stillBroken = noteWithTranscript(db, mixed, "Mixed and un-owned");
  const alreadyOwned = noteWithTranscript(db, mixedAttributed, "Mixed but owned");

  const candidates = findNotesNeedingAttributionRepair(db);

  assert.deepEqual(
    candidates.map((c) => c.id),
    [stillBroken],
    "mixed units alone are not a reason to rewrite a note"
  );
  assert.ok(!candidates.some((c) => c.id === alreadyOwned));
});

test("a repaired mixed-unit note keeps its stamps and records that it did", () => {
  const db = createDb();
  const segments = brokenSegments();
  const origin = Math.min(...segments.map((s) => s.timestamp));
  const mixed = segments.map((s) =>
    s.source === "system" ? { ...s, timestamp: (s.timestamp - origin) / 1000 } : s
  );
  const id = noteWithTranscript(db, mixed, "Mixed");

  const result = repairNoteAttribution({
    noteId: id,
    databaseManager: refusingUpdateNote(db),
    broadcast: () => {},
    userDataDir,
  });

  assert.equal(result.skippedMixedUnits, true);
  assert.equal(result.timestampsNormalised, 0);
  assert.deepEqual(
    JSON.parse(db.getNote(id).transcript).map((s) => s.timestamp),
    mixed.map((s) => s.timestamp)
  );
});

test("the first repair takes a verified backup and later ones do not", () => {
  const db = createDb();
  const first = noteWithTranscript(db, brokenSegments(), "First");
  const second = noteWithTranscript(db, brokenSegments(), "Second");
  const wrapped = refusingUpdateNote(db);

  const a = repairNoteAttribution({
    noteId: first,
    databaseManager: wrapped,
    broadcast: () => {},
    userDataDir,
  });
  const b = repairNoteAttribution({
    noteId: second,
    databaseManager: wrapped,
    broadcast: () => {},
    userDataDir,
  });

  assert.ok(a.backupPath, "the first repair write must be preceded by a backup");
  assert.ok(fs.existsSync(a.backupPath));
  assert.equal(b.backupPath, null, "one backup per launch is enough");
  assert.equal(fs.readdirSync(path.join(userDataDir, "backups")).length, 1);
});

test("nothing is written when the backup cannot be verified", () => {
  const db = createDb();
  const id = noteWithTranscript(db, brokenSegments());
  const before = db.getNote(id).transcript;

  assert.throws(
    () =>
      repairNoteAttribution({
        noteId: id,
        databaseManager: refusingUpdateNote(db),
        broadcast: () => {},
        userDataDir,
        backup: () => {
          throw new Error("Backup verification failed: truncated");
        },
      }),
    /backup verification failed/i
  );

  assert.equal(db.getNote(id).transcript, before, "no backup means no rewrite");
});

test("the summary survives until the user has seen it", () => {
  createDb();

  assert.equal(readRepairSummary(userDataDir), null);

  appendRepairSummary(userDataDir, { noteId: 14, title: "Old meeting", micAttributed: 1195 });
  appendRepairSummary(userDataDir, { noteId: 27, title: "Другая", micAttributed: 444 });

  const summary = readRepairSummary(userDataDir);
  assert.equal(summary.notes.length, 2);
  assert.equal(summary.notes[0].noteId, 14);
  assert.equal(summary.notes[1].title, "Другая");
  assert.equal(summary.micAttributed, 1639);

  clearRepairSummary(userDataDir);
  assert.equal(readRepairSummary(userDataDir), null);
});

test("a repair records itself in the summary the user will be shown", () => {
  const db = createDb();
  const id = noteWithTranscript(db, brokenSegments(), "Weekly sync");

  repairNoteAttribution({
    noteId: id,
    databaseManager: refusingUpdateNote(db),
    broadcast: () => {},
    userDataDir,
  });

  const summary = readRepairSummary(userDataDir);
  assert.deepEqual(
    summary.notes.map((n) => ({ noteId: n.noteId, title: n.title, micAttributed: n.micAttributed })),
    [{ noteId: id, title: "Weekly sync", micAttributed: 356 }]
  );
});

test("the summary records where the backup went and how to restore it", () => {
  const db = createDb();
  const id = noteWithTranscript(db, brokenSegments(), "Weekly sync");

  const result = repairNoteAttribution({
    noteId: id,
    databaseManager: refusingUpdateNote(db),
    broadcast: () => {},
    userDataDir,
  });

  const summary = readRepairSummary(userDataDir);
  assert.equal(summary.backup.path, result.backupPath);
  assert.ok(path.isAbsolute(summary.backup.path));
  assert.match(summary.backup.restore, /-wal/);
  assert.match(summary.backup.restore, /-shm/);
});

test("the backup record survives later repairs that take no backup of their own", () => {
  const db = createDb();
  const first = noteWithTranscript(db, brokenSegments(), "First");
  const second = noteWithTranscript(db, brokenSegments(), "Second");
  const wrapped = refusingUpdateNote(db);

  const a = repairNoteAttribution({
    noteId: first,
    databaseManager: wrapped,
    broadcast: () => {},
    userDataDir,
  });
  repairNoteAttribution({
    noteId: second,
    databaseManager: wrapped,
    broadcast: () => {},
    userDataDir,
  });

  const summary = readRepairSummary(userDataDir);
  assert.equal(summary.notes.length, 2);
  assert.equal(summary.backup.path, a.backupPath);
});

test("a note in the trash is not listed for repair", () => {
  const db = createDb();
  const kept = noteWithTranscript(db, brokenSegments(), "Still here");
  const trashed = noteWithTranscript(db, brokenSegments(), "Deleted last week");
  db.db.prepare("UPDATE notes SET deleted_at = ? WHERE id = ?").run("2026-09-01 00:00:00", trashed);

  const candidates = findNotesNeedingAttributionRepair(db);

  assert.deepEqual(
    candidates.map((c) => c.id),
    [kept],
    "repairing a trashed note would rewrite something the user already threw away"
  );
  assert.deepEqual(
    db.listNoteTranscripts().map((row) => row.id),
    [kept]
  );
});

test("repair records the origin it subtracted, so wall clock survives the re-basing", () => {
  const db = createDb();
  const before = brokenSegments();
  const expectedOrigin = Math.min(
    ...before.filter((s) => Number.isFinite(s.timestamp)).map((s) => s.timestamp)
  );
  const id = noteWithTranscript(db, before);
  ageNote(db, id, "2024-01-01 00:00:00");
  const updatedAtBefore = db.getNote(id).updated_at;

  repairNoteAttribution({
    noteId: id,
    databaseManager: refusingUpdateNote(db),
    broadcast: () => {},
    userDataDir,
  });

  const note = db.getNote(id);
  assert.equal(note.transcript_origin_ms, expectedOrigin);
  assert.equal(note.transcript_origin_source, "first-segment");
  assert.equal(note.updated_at, updatedAtBefore, "recording the origin must not reorder notes");

  const stored = JSON.parse(note.transcript);
  const first = stored.find((s) => Number.isFinite(s.timestamp));
  const originalFirst = before.find((s) => Number.isFinite(s.timestamp));
  assert.equal(note.transcript_origin_ms + first.timestamp * 1000, originalFirst.timestamp);
});

test("a repair that re-bases nothing records no origin rather than a misleading one", () => {
  const db = createDb();
  const relative = brokenSegments().map((segment, index) => ({
    ...segment,
    timestamp: index * 0.5,
  }));
  const id = noteWithTranscript(db, relative);

  const result = repairNoteAttribution({
    noteId: id,
    databaseManager: refusingUpdateNote(db),
    broadcast: () => {},
    userDataDir,
  });

  assert.equal(result.repaired, true, "mic attribution should still have happened");
  const note = db.getNote(id);
  assert.equal(note.transcript_origin_ms, null);
  assert.equal(note.transcript_origin_source, null);
});
