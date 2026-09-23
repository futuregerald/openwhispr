const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { requireSqlite } = require("../support/sqlite.js");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-note-body-"));
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
const { resolveNoteBody } = require("../../src/helpers/noteBody.js");

function createDb() {
  requireSqlite();
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-note-body-"));
  return new DatabaseManager();
}

function makeNote(dbm, columns = {}, { index = true } = {}) {
  const { note } = dbm.saveNote(columns.title ?? "Note", columns.content ?? "", "meeting");
  const sets = [];
  const values = [];
  for (const [column, value] of Object.entries(columns)) {
    if (column === "title" || column === "content") continue;
    sets.push(`${column} = ?`);
    values.push(value);
  }
  if (columns.content !== undefined) {
    sets.push("content = ?");
    values.push(columns.content);
  }
  if (sets.length) {
    dbm.db.prepare(`UPDATE notes SET ${sets.join(", ")} WHERE id = ?`).run(...values, note.id);
  }
  if (index) reshredNote(dbm.db, note.id);
  return dbm.getNote(note.id);
}

test("enhanced content is the body when it exists", () => {
  const dbm = createDb();
  const note = makeNote(dbm, {
    enhanced_content: "## Decisions\n\nWe ship on Friday.",
    content: "rough jottings",
    transcript: JSON.stringify([{ text: "spoken words", timestamp: 0, speaker: "speaker_0" }]),
  });

  const body = resolveNoteBody(dbm.db, note);

  assert.equal(body.body_kind, "enhanced");
  assert.match(body.body, /We ship on Friday/);
});

test("plain content is the body when there is no enhanced version", () => {
  const dbm = createDb();
  const note = makeNote(dbm, {
    content: "a personal note I typed",
    transcript: JSON.stringify([{ text: "spoken words", timestamp: 0, speaker: "speaker_0" }]),
  });

  const body = resolveNoteBody(dbm.db, note);

  assert.equal(body.body_kind, "plain");
  assert.equal(body.body, "a personal note I typed");
});

test("a rendered transcript is the body when nothing else is written", () => {
  const dbm = createDb();
  const note = makeNote(dbm, {
    transcript: JSON.stringify([
      { text: "morning all", timestamp: 0, speaker: "speaker_0", speakerName: "Jorge" },
      { text: "shall we start", timestamp: 30, speaker: "speaker_1", speakerName: "Molly" },
    ]),
  });

  const body = resolveNoteBody(dbm.db, note);

  assert.equal(body.body_kind, "transcript");
  assert.match(body.body, /Jorge/);
  assert.match(body.body, /morning all/);
  assert.match(body.body, /Molly/);
});

test("a note with none of the three layers reports empty rather than a blank enhanced body", () => {
  const dbm = createDb();
  const note = makeNote(dbm, {});

  const body = resolveNoteBody(dbm.db, note);

  assert.equal(body.body_kind, "empty");
  assert.equal(body.body, "");
  assert.equal(body.body_chars, 0);
});

test("whitespace-only enhanced content falls through instead of claiming to be enhanced", () => {
  const dbm = createDb();
  const note = makeNote(dbm, {
    enhanced_content: "   \n\t  ",
    content: "the real text",
  });

  const body = resolveNoteBody(dbm.db, note);

  assert.equal(
    body.body_kind,
    "plain",
    "an agent told it is reading finished notes hedges differently than one reading nothing"
  );
  assert.equal(body.body, "the real text");
});

test("a transcript with no renderable speech falls through to empty", () => {
  const dbm = createDb();
  const note = makeNote(dbm, {
    transcript: JSON.stringify([
      { text: "   ", timestamp: 0, speaker: "speaker_0" },
      { text: "", timestamp: 3, speaker: "speaker_1" },
    ]),
  });

  const body = resolveNoteBody(dbm.db, note);

  assert.equal(
    body.body_kind,
    "empty",
    "formatMd emits a header before any segment, so emptiness must be tested on the segments"
  );
  assert.equal(body.body, "");
});

test("epoch-millisecond transcripts render sane hours, not five-digit ones", () => {
  const dbm = createDb();
  const origin = 1758500000000;
  const note = makeNote(dbm, {
    transcript: JSON.stringify([
      { text: "first thing", timestamp: origin + 5000, speaker: "speaker_0", speakerName: "Jorge" },
      { text: "much later", timestamp: origin + 3700000, speaker: "speaker_0", speakerName: "Jorge" },
    ]),
    transcript_origin_ms: origin,
  });

  const body = resolveNoteBody(dbm.db, note);

  assert.match(body.body, /00:00:05/);
  assert.match(body.body, /01:01:40/);
  assert.ok(
    !/\d{3,}:\d{2}:\d{2}/.test(body.body),
    "passing raw epoch milliseconds to formatTimestamp produces five-digit hours"
  );
});

test("segments merge by speaker rather than emitting one block per utterance", () => {
  const dbm = createDb();
  const note = makeNote(dbm, {
    transcript: JSON.stringify([
      { text: "one", timestamp: 0, speaker: "speaker_0", speakerName: "Jorge" },
      { text: "two", timestamp: 1, speaker: "speaker_0", speakerName: "Jorge" },
      { text: "three", timestamp: 40, speaker: "speaker_1", speakerName: "Molly" },
    ]),
  });

  const body = resolveNoteBody(dbm.db, note);

  assert.equal(
    (body.body.match(/\*\*Jorge\*\*/g) || []).length,
    1,
    "two consecutive Jorge segments a second apart are one block"
  );
  assert.match(body.body, /one two/);
});

test("a segment with no usable timestamp renders without one rather than as 00:00:00", () => {
  const dbm = createDb();
  const note = makeNote(dbm, {
    transcript: JSON.stringify([{ text: "clockless remark", speaker: "speaker_0", speakerName: "Jorge" }]),
  });

  const body = resolveNoteBody(dbm.db, note);

  assert.match(body.body, /clockless remark/);
  assert.ok(!body.body.includes("00:00:00"), "an unknown time must not be presented as the start");
});

test("a clockless segment does not drag the block before it back to the start", () => {
  const dbm = createDb();
  const note = makeNote(dbm, {
    transcript: JSON.stringify([
      { text: "opening remark", timestamp: 0, speaker: "speaker_0", speakerName: "Jorge" },
      { text: "much later point", timestamp: 600, speaker: "speaker_0", speakerName: "Jorge" },
      { text: "no clock on this one", speaker: "speaker_0", speakerName: "Jorge" },
      { text: "twenty minutes in", timestamp: 1200, speaker: "speaker_0", speakerName: "Jorge" },
    ]),
  });

  const { body } = resolveNoteBody(dbm.db, note);

  assert.match(body, /`00:10:00`[\s\S]*much later point/);
  assert.match(body, /`00:20:00`[\s\S]*twenty minutes in/);
  assert.equal(
    (body.match(/`00:00:00`/g) || []).length,
    1,
    "merging a null-offset segment into a timestamped run used to reset the run's stamp to zero"
  );
});

test("epoch timestamps with no recorded origin render without a fabricated time", () => {
  const dbm = createDb();
  const note = makeNote(dbm, {
    transcript: JSON.stringify([
      { text: "first", timestamp: 1758500000000, speaker: "speaker_0", speakerName: "Jorge" },
      { text: "second", timestamp: 1758500600000, speaker: "speaker_1", speakerName: "Molly" },
    ]),
  });

  const { body, body_kind: kind } = resolveNoteBody(dbm.db, note);

  assert.equal(kind, "transcript");
  assert.ok(
    !body.includes("00:00:00"),
    "with no transcript_origin_ms the offset is unknown, so every block printed 00:00:00"
  );
  assert.match(body, /first/);
  assert.match(body, /second/);
});

test("unmapped speakers are reported so an agent can suggest renaming them", () => {
  const dbm = createDb();
  const unmapped = makeNote(dbm, {
    transcript: JSON.stringify([
      { text: "who am I", timestamp: 0, speaker: "speaker_1", speakerIsPlaceholder: true },
    ]),
  });
  const mapped = makeNote(dbm, {
    transcript: JSON.stringify([
      { text: "I am known", timestamp: 0, speaker: "speaker_0", speakerName: "Jorge" },
    ]),
  });

  assert.equal(resolveNoteBody(dbm.db, unmapped).has_unmapped_speakers, true);
  assert.equal(resolveNoteBody(dbm.db, mapped).has_unmapped_speakers, false);
});

test("a body longer than max_chars is truncated and says so", () => {
  const dbm = createDb();
  const note = makeNote(dbm, { content: "x".repeat(500) });

  const body = resolveNoteBody(dbm.db, note, { maxChars: 100 });

  assert.equal(body.body.length, 100);
  assert.equal(body.truncated, true);
  assert.equal(body.body_chars, 500, "body_chars reports the real size, not the truncated one");
});

test("a note whose segments are not indexed yet still renders from its transcript", () => {
  const dbm = createDb();
  const note = makeNote(
    dbm,
    {
      transcript: JSON.stringify([
        { text: "not yet indexed", timestamp: 0, speaker: "speaker_0", speakerName: "Jorge" },
      ]),
    },
    { index: false }
  );

  const body = resolveNoteBody(dbm.db, note);

  assert.equal(
    body.body_kind,
    "transcript",
    "a pending backfill must not make a note look empty to the agent"
  );
  assert.match(body.body, /not yet indexed/);
});

test("a speaker mapping supplies the label for a placeholder cluster", () => {
  const dbm = createDb();
  const note = makeNote(dbm, {
    transcript: JSON.stringify([
      { text: "mapped speech", timestamp: 0, speaker: "speaker_1", speakerIsPlaceholder: true },
    ]),
  });
  dbm.setSpeakerMapping(note.id, "speaker_1", null, "Jorge");
  reshredNote(dbm.db, note.id);

  const body = resolveNoteBody(dbm.db, dbm.getNote(note.id));

  assert.match(body.body, /\*\*Jorge\*\*/);
  assert.equal(body.has_unmapped_speakers, false);
});
