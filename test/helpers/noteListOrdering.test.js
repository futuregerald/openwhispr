const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { requireSqlite } = require("../support/sqlite.js");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-note-order-"));
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

function freshUserDataDir() {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-note-order-"));
  return userDataDir;
}

function createDb() {
  requireSqlite();
  freshUserDataDir();
  return new DatabaseManager();
}

function noteCreatedOn(db, title, createdAt) {
  const { note } = db.saveNote(title, "content", "meeting");
  db.db.prepare("UPDATE notes SET created_at = ? WHERE id = ?").run(createdAt, note.id);
  return note.id;
}

test("getNotes sorts by meeting time, not edit time", () => {
  const db = createDb();
  const day1Id = noteCreatedOn(db, "Day 1 meeting", "2026-01-01 09:00:00");
  const day2Id = noteCreatedOn(db, "Day 2 meeting", "2026-01-02 09:00:00");
  const day3Id = noteCreatedOn(db, "Day 3 meeting", "2026-01-03 09:00:00");

  db.updateNote(day1Id, { title: "Day 1 meeting (edited)" });

  const order = db.getNotes().map((note) => note.id);
  assert.deepEqual(
    order,
    [day3Id, day2Id, day1Id],
    "editing the oldest note must not move it to the top"
  );
  db.close?.();
});

test("getNotes returns meeting dates in strictly descending order", () => {
  const db = createDb();
  const day2Id = noteCreatedOn(db, "Day 2 meeting", "2026-01-02 09:00:00");
  noteCreatedOn(db, "Day 4 meeting", "2026-01-04 09:00:00");
  noteCreatedOn(db, "Day 1 meeting", "2026-01-01 09:00:00");
  noteCreatedOn(db, "Day 3 meeting", "2026-01-03 09:00:00");

  db.updateNote(day2Id, { title: "Day 2 meeting (edited)" });

  const dates = db.getNotes().map((note) => note.created_at);
  assert.deepEqual(dates, [
    "2026-01-04 09:00:00",
    "2026-01-03 09:00:00",
    "2026-01-02 09:00:00",
    "2026-01-01 09:00:00",
  ]);
  db.close?.();
});

test("getNotes respects limit after the new ordering", () => {
  const db = createDb();
  noteCreatedOn(db, "Day 1 meeting", "2026-01-01 09:00:00");
  const day2Id = noteCreatedOn(db, "Day 2 meeting", "2026-01-02 09:00:00");
  const day3Id = noteCreatedOn(db, "Day 3 meeting", "2026-01-03 09:00:00");

  const limited = db.getNotes(null, 2).map((note) => note.id);
  assert.deepEqual(limited, [day3Id, day2Id]);
  db.close?.();
});

test("getNoteSummaries agrees with getNotes on meeting-time order", () => {
  const db = createDb();
  const day1Id = noteCreatedOn(db, "Day 1 meeting", "2026-01-01 09:00:00");
  const day2Id = noteCreatedOn(db, "Day 2 meeting", "2026-01-02 09:00:00");
  const day3Id = noteCreatedOn(db, "Day 3 meeting", "2026-01-03 09:00:00");

  db.updateNote(day1Id, { title: "Day 1 meeting (edited)" });

  const notesOrder = db.getNotes().map((note) => note.id);
  const summariesOrder = db.getNoteSummaries({ limit: 20 }).notes.map((note) => note.id);
  assert.deepEqual(summariesOrder, notesOrder);
  assert.deepEqual(summariesOrder, [day3Id, day2Id, day1Id]);
  db.close?.();
});
