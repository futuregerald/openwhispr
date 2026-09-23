const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { requireSqlite } = require("../support/sqlite.js");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-enumeration-"));
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
const { reshredNote } = require("../../src/helpers/transcriptSegmentIndex.js");

function createDb() {
  requireSqlite();
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-enumeration-"));
  return new DatabaseManager();
}

function insertEvent(dbm, event) {
  dbm.db
    .prepare(
      `INSERT OR REPLACE INTO calendar_events
       (id, calendar_id, summary, start_time, end_time, is_all_day, status, hangout_link,
        conference_data, organizer_email, attendees_count, attendees)
       VALUES (?, 'primary', ?, ?, ?, ?, 'confirmed', ?, NULL, ?, ?, ?)`
    )
    .run(
      event.id,
      event.summary,
      event.start_time,
      event.end_time,
      event.is_all_day ? 1 : 0,
      event.hangout_link ?? null,
      event.organizer_email ?? null,
      event.attendees ? JSON.parse(event.attendees).length : 0,
      event.attendees ?? null
    );
}

test("folder note counts exclude soft-deleted notes", () => {
  const dbm = createDb();
  const { note: kept } = dbm.saveNote("Kept", "", "personal");
  const { note: gone } = dbm.saveNote("Gone", "", "personal");
  dbm.updateNote(gone.id, { deleted_at: new Date().toISOString() });

  const folder = dbm.getFolderSummaries().find((row) => row.id === kept.folder_id);

  assert.equal(folder.note_count, 1, "a deleted note must not inflate the folder count");
  assert.ok("is_default" in folder);
});

test("meeting types omit their template and keyword rules", () => {
  const dbm = createDb();

  const types = dbm.getMeetingTypeSummaries();

  assert.ok(types.length > 0, "built-in meeting types are seeded");
  for (const type of types) {
    assert.ok(!("template" in type), "a template is a model prompt and an injection surface");
    assert.ok(!("keyword_rules" in type));
    assert.deepEqual(Object.keys(type).sort(), ["id", "is_builtin", "name"]);
  }
});

test("calendar events parse an offset-bearing start time and link their note", () => {
  const dbm = createDb();
  insertEvent(dbm, {
    id: "evt-1",
    summary: "Platform sync",
    start_time: "2026-09-15T14:00:00+02:00",
    end_time: "2026-09-15T15:00:00+02:00",
    organizer_email: "jorge@example.com",
    hangout_link: "https://meet.example.com/abc",
    attendees: JSON.stringify([
      { email: "jorge@example.com", displayName: "Jorge Chayan", responseStatus: "accepted" },
      { email: "molly@example.com", displayName: "Molly Finn", responseStatus: "tentative" },
    ]),
  });
  const { note } = dbm.saveNote("Platform sync", "", "meeting");
  dbm.updateNote(note.id, { calendar_event_id: "evt-1" });

  const [event] = dbm.getCalendarEventsForMcp({});

  assert.equal(event.id, "evt-1");
  assert.equal(event.linked_note_id, note.id);
  assert.equal(event.attendees_count, 2);
  assert.equal(event.attendees[0].display_name, "Jorge Chayan");
  assert.equal(event.attendees[1].response_status, "tentative");
  assert.equal(event.is_all_day, false);
  assert.equal(event.hangout_link, "https://meet.example.com/abc");
});

test("an all-day event keeps its zoneless date rather than being converted", () => {
  const dbm = createDb();
  insertEvent(dbm, {
    id: "evt-allday",
    summary: "Company offsite",
    start_time: "2026-09-16",
    end_time: "2026-09-17",
    is_all_day: true,
  });

  const [event] = dbm.getCalendarEventsForMcp({ eventId: "evt-allday" });

  assert.equal(event.start_time, "2026-09-16", "an all-day event has no offset to parse");
  assert.equal(event.is_all_day, true);
});

test("calendar events can be narrowed by date, note and event id", () => {
  const dbm = createDb();
  insertEvent(dbm, {
    id: "evt-early",
    summary: "Early",
    start_time: "2026-09-10T09:00:00Z",
    end_time: "2026-09-10T10:00:00Z",
  });
  insertEvent(dbm, {
    id: "evt-late",
    summary: "Late",
    start_time: "2026-09-25T09:00:00Z",
    end_time: "2026-09-25T10:00:00Z",
  });

  const ranged = dbm.getCalendarEventsForMcp({
    since: "2026-09-20T00:00:00Z",
    until: "2026-09-30T00:00:00Z",
  });

  assert.deepEqual(
    ranged.map((event) => event.id),
    ["evt-late"]
  );
  assert.deepEqual(
    dbm.getCalendarEventsForMcp({ eventId: "evt-early" }).map((event) => event.id),
    ["evt-early"]
  );
});

test("an all-day event is returned for its own local date", () => {
  const dbm = createDb();
  insertEvent(dbm, {
    id: "evt-allday-range",
    summary: "Company offsite",
    start_time: "2026-09-21",
    end_time: "2026-09-22",
    is_all_day: true,
  });
  insertEvent(dbm, {
    id: "evt-allday-other",
    summary: "Different day",
    start_time: "2026-09-25",
    end_time: "2026-09-26",
    is_all_day: true,
  });

  const sameDay = dbm.getCalendarEventsForMcp({ since: "2026-09-21", until: "2026-09-21" });

  assert.deepEqual(
    sameDay.map((event) => event.id),
    ["evt-allday-range"],
    "an all-day event stores a bare date; comparing it as an instant against local midnight drops it for anyone west of UTC"
  );

  const dayBefore = dbm.getCalendarEventsForMcp({ since: "2026-09-20", until: "2026-09-20" });
  assert.deepEqual(dayBefore, []);
});

test("an all-day and a timed event on the same day are both returned", () => {
  const dbm = createDb();
  // Local noon on the 21st, expressed as an instant. A fixed offset would land on a
  // different local day depending on the machine's zone, which is the very thing the
  // all-day branch exists to get right.
  const localNoon = new Date(2026, 8, 21, 12, 0, 0).toISOString();
  insertEvent(dbm, {
    id: "evt-timed",
    summary: "Standup",
    start_time: localNoon,
    end_time: new Date(2026, 8, 21, 12, 15, 0).toISOString(),
  });
  insertEvent(dbm, {
    id: "evt-allday",
    summary: "Offsite",
    start_time: "2026-09-21",
    end_time: "2026-09-22",
    is_all_day: true,
  });

  const ids = dbm
    .getCalendarEventsForMcp({ since: "2026-09-21", until: "2026-09-21" })
    .map((event) => event.id)
    .sort();

  assert.deepEqual(ids, ["evt-allday", "evt-timed"]);
});

test("two notes linked to one event do not duplicate it or eat the limit", () => {
  const dbm = createDb();
  insertEvent(dbm, {
    id: "evt-shared",
    summary: "Shared",
    start_time: "2026-09-21T09:00:00Z",
    end_time: "2026-09-21T10:00:00Z",
  });
  const { note: first } = dbm.saveNote("First", "", "meeting");
  const { note: second } = dbm.saveNote("Second", "", "meeting");
  dbm.updateNote(first.id, { calendar_event_id: "evt-shared" });
  dbm.updateNote(second.id, { calendar_event_id: "evt-shared" });

  const events = dbm.getCalendarEventsForMcp({});

  assert.equal(events.length, 1, "a join to notes fans out one row per linked note");
  assert.equal(events[0].linked_note_id, first.id);
  assert.deepEqual(
    dbm.getCalendarEventsForMcp({ noteId: second.id }).map((event) => event.id),
    ["evt-shared"],
    "either linked note must still find its event"
  );
});

test("stats by speaker honour the same date range as the buckets", () => {
  const dbm = createDb();

  const inRange = dbm.saveNote("In range", "", "meeting").note;
  dbm.updateNote(inRange.id, {
    transcript: JSON.stringify([
      { text: "inside the window", timestamp: 0, speaker: "speaker_0", speakerName: "Jorge" },
    ]),
  });
  dbm.db.prepare("UPDATE notes SET created_at = ? WHERE id = ?").run("2026-09-15 10:00:00", inRange.id);

  const outOfRange = dbm.saveNote("Out of range", "", "meeting").note;
  dbm.updateNote(outOfRange.id, {
    transcript: JSON.stringify([
      { text: "far outside", timestamp: 0, speaker: "speaker_0", speakerName: "Jorge" },
      { text: "also outside", timestamp: 3, speaker: "speaker_0", speakerName: "Jorge" },
    ]),
  });
  dbm.db
    .prepare("UPDATE notes SET created_at = ? WHERE id = ?")
    .run("2026-01-05 10:00:00", outOfRange.id);

  reshredNote(dbm.db, inRange.id);
  reshredNote(dbm.db, outOfRange.id);

  const stats = dbm.getStats({
    groupBy: "month",
    since: "2026-09-01T00:00:00Z",
    until: "2026-10-01T00:00:00Z",
    bySpeaker: true,
  });
  const jorge = stats.by_speaker.find((row) => row.speaker === "Jorge");

  assert.equal(
    jorge.segments,
    1,
    "an unfiltered speaker query returns all-time totals labelled with the requested range"
  );
});

test("word counts do not credit blank or padded segment text", () => {
  const dbm = createDb();
  const { note } = dbm.saveNote("Spacing", "", "meeting");
  dbm.updateNote(note.id, {
    transcript: JSON.stringify([
      { text: "   ", timestamp: 0, speaker: "speaker_0", speakerName: "Jorge" },
      { text: " three plain words ", timestamp: 3, speaker: "speaker_0", speakerName: "Jorge" },
    ]),
  });
  reshredNote(dbm.db, note.id);

  const stats = dbm.getStats({ groupBy: "month", bySpeaker: true });
  const jorge = stats.by_speaker.find((row) => row.speaker === "Jorge");

  // The count is separator-based, so a run of several spaces still over-counts; the
  // tool description says the figure is approximate. What it must not do is award a
  // word to a blank segment or to surrounding padding.
  assert.equal(jorge.words, 3, "blank text is zero words and surrounding padding is not a word");
});

test("a malformed attendees payload degrades to an empty list rather than throwing", () => {
  const dbm = createDb();
  insertEvent(dbm, {
    id: "evt-bad",
    summary: "Broken",
    start_time: "2026-09-15T09:00:00Z",
    end_time: "2026-09-15T10:00:00Z",
  });
  dbm.db.prepare("UPDATE calendar_events SET attendees = ? WHERE id = ?").run("{not json", "evt-bad");

  const [event] = dbm.getCalendarEventsForMcp({ eventId: "evt-bad" });

  assert.deepEqual(event.attendees, []);
  assert.equal(event.attendees_count, 0);
});

test("stats return counts only and never a note body", () => {
  const dbm = createDb();
  const { note } = dbm.saveNote("Counted", "a very secret body", "meeting");
  dbm.db
    .prepare("UPDATE notes SET created_at = ?, audio_duration_seconds = ? WHERE id = ?")
    .run("2026-09-15 10:00:00", 1800, note.id);
  dbm.saveNote("Personal one", "another body", "personal");

  const stats = dbm.getStats({ groupBy: "month" });
  const serialized = JSON.stringify(stats);

  assert.ok(!serialized.includes("secret body"), "get_stats is context-cheap by construction");
  assert.ok(!serialized.includes("another body"));
  assert.equal(stats.group_by, "month");
  assert.ok(stats.buckets.length >= 1);
  const total = stats.buckets.reduce((sum, bucket) => sum + bucket.notes, 0);
  assert.equal(total, 2);
  const meetings = stats.buckets.reduce((sum, bucket) => sum + bucket.meetings, 0);
  assert.equal(meetings, 1);
});

test("stats by speaker count segments and words without quoting them", () => {
  const dbm = createDb();
  const { note } = dbm.saveNote("Spoken", "", "meeting");
  dbm.updateNote(note.id, {
    transcript: JSON.stringify([
      { text: "three words here", timestamp: 0, speaker: "speaker_0", speakerName: "Jorge" },
      { text: "two more", timestamp: 3, speaker: "speaker_0", speakerName: "Jorge" },
      { text: "one", timestamp: 6, speaker: "speaker_1", speakerName: "Molly" },
    ]),
  });
  reshredNote(dbm.db, note.id);

  const stats = dbm.getStats({ groupBy: "week", bySpeaker: true });
  const jorge = stats.by_speaker.find((row) => row.speaker === "Jorge");

  assert.equal(jorge.segments, 2);
  assert.equal(jorge.words, 5);
  assert.ok(!JSON.stringify(stats.by_speaker).includes("three words here"));
});

test("an unsupported group_by is a validation error", () => {
  const dbm = createDb();

  assert.throws(
    () => dbm.getStats({ groupBy: "fortnight" }),
    (error) => error.code === "VALIDATION"
  );
});

test("stats exclude soft-deleted notes", () => {
  const dbm = createDb();
  dbm.saveNote("Kept", "", "meeting");
  const { note: gone } = dbm.saveNote("Gone", "", "meeting");
  dbm.updateNote(gone.id, { deleted_at: new Date().toISOString() });

  const stats = dbm.getStats({ groupBy: "month" });
  const total = stats.buckets.reduce((sum, bucket) => sum + bucket.notes, 0);

  assert.equal(total, 1);
});
