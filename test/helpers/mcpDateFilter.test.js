const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { requireSqlite } = require("../support/sqlite.js");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-date-filter-"));
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
const { resolveDateBound, resolveDateRange } = require("../../src/helpers/searchDateRange.js");

function createDb() {
  requireSqlite();
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-date-filter-"));
  return new DatabaseManager();
}

function utcStamp(ms) {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

function noteCreatedAtLocal(dbm, title, localDate) {
  const { note } = dbm.saveNote(title, "body", "meeting");
  dbm.db.prepare("UPDATE notes SET created_at = ? WHERE id = ?").run(utcStamp(localDate.getTime()), note.id);
  return note.id;
}

test("a bare date resolves to local midnight, not UTC midnight", () => {
  const bound = resolveDateBound("2026-09-15");
  const expected = new Date(2026, 8, 15).getTime();

  assert.equal(bound.ms, expected);
});

test("a bare until is the exclusive next local midnight so its own day is included", () => {
  const { to } = resolveDateRange(null, "2026-09-21");
  const expected = new Date(2026, 8, 22).getTime();

  assert.equal(
    to.ms,
    expected,
    "reading until as the midnight starting the 21st silently drops the whole day"
  );
});

test("an offset-bearing ISO string is honoured rather than reinterpreted", () => {
  assert.equal(resolveDateBound("2026-09-15T12:00:00+02:00").ms, Date.parse("2026-09-15T10:00:00Z"));
  assert.equal(resolveDateBound("2026-09-15T10:00:00Z").ms, Date.parse("2026-09-15T10:00:00Z"));
});

test("a malformed date is a validation error rather than a silent rollover", () => {
  for (const bad of ["2026-13-45", "2026-02-30", "not a date"]) {
    assert.throws(
      () => resolveDateBound(bad),
      (error) => error.code === "VALIDATION",
      `${bad} must be rejected`
    );
  }
});

test("since later than until is rejected", () => {
  assert.throws(
    () => resolveDateRange("2026-09-20", "2026-09-10"),
    (error) => error.code === "VALIDATION"
  );
});

test("an evening note is filed under its local day, not tomorrow", () => {
  const dbm = createDb();
  const localEvening = new Date(2026, 8, 15, 21, 30, 0);
  const wanted = noteCreatedAtLocal(dbm, "Evening standup", localEvening);
  noteCreatedAtLocal(dbm, "Two days later", new Date(2026, 8, 17, 9, 0, 0));

  const sameDay = dbm.getNoteSummaries({ since: "2026-09-15", until: "2026-09-15" });
  const nextDay = dbm.getNoteSummaries({ since: "2026-09-16", until: "2026-09-16" });

  assert.deepEqual(
    sameDay.notes.map((note) => note.id),
    [wanted],
    "SQLite writes CURRENT_TIMESTAMP as naive UTC and V8 parses it as local; that is commit 7f92d80d"
  );
  assert.deepEqual(nextDay.notes, []);
});

test("the response echoes the resolved UTC bounds it actually used", () => {
  const dbm = createDb();

  const result = dbm.getNoteSummaries({ since: "2026-09-15", until: "2026-09-21" });

  assert.equal(result.resolved_range.since, utcStamp(new Date(2026, 8, 15).getTime()));
  assert.equal(result.resolved_range.until, utcStamp(new Date(2026, 8, 22).getTime()));
});

test("a bad date reaching getNoteSummaries is a validation error, not a full-range scan", () => {
  const dbm = createDb();
  dbm.saveNote("Present", "body", "meeting");

  assert.throws(
    () => dbm.getNoteSummaries({ since: "2026-13-45" }),
    (error) => error.code === "VALIDATION"
  );
});

test("summaries never carry a transcript and cap their preview", () => {
  const dbm = createDb();
  const { note } = dbm.saveNote("Long one", "y".repeat(2000), "meeting");
  dbm.db
    .prepare("UPDATE notes SET transcript = ? WHERE id = ?")
    .run(JSON.stringify([{ text: "z".repeat(5000), timestamp: 0 }]), note.id);

  const [summary] = dbm.getNoteSummaries({}).notes;

  assert.ok(!("transcript" in summary), "GET /v1/notes/list already ships every full transcript");
  assert.ok(summary.preview.length <= 400);
  assert.equal(summary.has_transcript, true);
  assert.equal(summary.body_kind, "plain");
  assert.equal(summary.body_chars, 2000);
});

test("a preview falls back through enhanced, plain and transcript like the body rule", () => {
  const dbm = createDb();

  const { note: enhanced } = dbm.saveNote("Enhanced", "plain text", "meeting");
  dbm.updateNote(enhanced.id, { enhanced_content: "the finished notes" });

  const { note: transcriptOnly } = dbm.saveNote("Transcript only", "", "meeting");
  dbm.updateNote(transcriptOnly.id, {
    transcript: JSON.stringify([
      { text: "spoken words only", timestamp: 0, speaker: "speaker_0", speakerName: "Jorge" },
    ]),
  });

  const { note: blank } = dbm.saveNote("Blank", "", "meeting");

  const byId = new Map(dbm.getNoteSummaries({}).notes.map((row) => [row.id, row]));

  assert.equal(byId.get(enhanced.id).body_kind, "enhanced");
  assert.match(byId.get(enhanced.id).preview, /finished notes/);
  assert.equal(byId.get(transcriptOnly.id).body_kind, "transcript");
  assert.match(byId.get(transcriptOnly.id).preview, /spoken words only/);
  assert.equal(byId.get(blank.id).body_kind, "empty");
  assert.equal(byId.get(blank.id).preview, "");
});

test("summaries exclude soft-deleted notes and honour note_type and folder filters", () => {
  const dbm = createDb();
  const { note: meeting } = dbm.saveNote("Meeting", "m", "meeting");
  const { note: personal } = dbm.saveNote("Personal", "p", "personal");
  const { note: gone } = dbm.saveNote("Deleted", "d", "meeting");
  dbm.updateNote(gone.id, { deleted_at: new Date().toISOString() });

  const meetings = dbm.getNoteSummaries({ noteType: "meeting" }).notes.map((row) => row.id);

  assert.deepEqual(meetings, [meeting.id]);

  const inFolder = dbm.getNoteSummaries({ folderId: personal.folder_id }).notes.map((row) => row.id);
  assert.ok(inFolder.includes(personal.id));
  assert.ok(!inFolder.includes(gone.id));
});

test("summaries report unmapped speakers so an agent knows renaming is available", () => {
  const dbm = createDb();
  const { note } = dbm.saveNote("Unlabelled", "", "meeting");
  dbm.updateNote(note.id, {
    transcript: JSON.stringify([
      { text: "who is this", timestamp: 0, speaker: "speaker_3", speakerIsPlaceholder: true },
    ]),
  });
  require("../../src/helpers/transcriptSegmentIndex.js").reshredNote(dbm.db, note.id);

  const [summary] = dbm.getNoteSummaries({}).notes;

  assert.equal(summary.has_unmapped_speakers, true);
});
