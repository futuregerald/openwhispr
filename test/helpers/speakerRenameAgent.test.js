const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { requireSqlite } = require("../support/sqlite.js");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-rename-agent-"));
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
const { resolveSpeaker, buildSpeakerMappings } = require("../../src/helpers/transcriptFormatter.js");
const {
  reshredNote,
  segmentRowsForNote,
} = require("../../src/helpers/transcriptSegmentIndex.js");

function freshDatabase() {
  requireSqlite();
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-rename-agent-"));
  return new DatabaseManager();
}

// The defect this file exists for only shows on a segment that ALREADY carries a
// confirmed name -- which is what the auto-matcher and the UI rename both write.
// A placeholder segment would be renamed correctly by the mapping row alone.
const NAMED_SEGMENTS = [
  {
    speaker: "speaker_0",
    speakerName: "Priyanka",
    speakerIsPlaceholder: false,
    text: "I will take the migration.",
    timestamp: 1000,
  },
  {
    speaker: "speaker_1",
    speakerName: "Dana",
    speakerIsPlaceholder: false,
    text: "Thanks.",
    timestamp: 2000,
  },
];

function insertNote(db, segments = NAMED_SEGMENTS, title = "A meeting") {
  const info = db.db
    .prepare("INSERT INTO notes (title, transcript) VALUES (?, ?)")
    .run(title, JSON.stringify(segments));
  return Number(info.lastInsertRowid);
}

const segmentsOf = (db, noteId) => JSON.parse(db.getNote(noteId).transcript);

// The precedence that made a mapping-only rename invisible: both main-process
// resolvers read the SEGMENT first, and only the note-editor label reads the
// mapping first.
function exportedName(db, noteId, speakerId) {
  const segments = segmentsOf(db, noteId);
  const mappings = buildSpeakerMappings(db.getSpeakerMappings(noteId));
  const segment = segments.find((s) => s.speaker === speakerId);
  return resolveSpeaker(segment, mappings);
}

function indexedNames(db, noteId) {
  reshredNote(db.db, noteId);
  return segmentRowsForNote(db.db, noteId).map((row) => row.speaker_name);
}

test("a note-only rename reaches exports, not just the editor label", () => {
  const db = freshDatabase();
  const noteId = insertNote(db);

  db.renameNoteSpeaker(noteId, "speaker_0", "Priya");

  assert.equal(
    exportedName(db, noteId, "speaker_0"),
    "Priya",
    "the exported transcript still carried the old name"
  );
  const row = db.getSpeakerMappings(noteId).find((m) => m.speaker_id === "speaker_0");
  assert.equal(row.display_name, "Priya");
  assert.equal(row.origin, "agent");
});

test("a note-only rename reaches the transcript search index the agent reads back", () => {
  const db = freshDatabase();
  const noteId = insertNote(db);

  db.renameNoteSpeaker(noteId, "speaker_0", "Priya");

  const names = indexedNames(db, noteId);
  assert.ok(names.includes("Priya"), `indexed names were ${JSON.stringify(names)}`);
  assert.ok(!names.includes("Priyanka"), "the old name survived in the search index");
});

test("a rename clears a pending suggestion rather than leaving it to reappear", () => {
  const db = freshDatabase();
  const noteId = insertNote(db, [
    {
      speaker: "speaker_0",
      speakerName: "Speaker 1",
      speakerIsPlaceholder: true,
      suggestedName: "Priyanka",
      suggestedProfileId: 7,
      text: "Hello.",
      timestamp: 1000,
    },
  ]);

  db.renameNoteSpeaker(noteId, "speaker_0", "Priya");

  const seg = segmentsOf(db, noteId)[0];
  assert.equal(seg.speakerName, "Priya");
  assert.equal(seg.speakerIsPlaceholder, false);
  assert.ok(!seg.suggestedName, "a stale suggestion was left on the segment");
  assert.ok(!seg.suggestedProfileId);
});

test("a rename leaves every other speaker alone", () => {
  const db = freshDatabase();
  const noteId = insertNote(db);

  db.renameNoteSpeaker(noteId, "speaker_0", "Priya");

  assert.equal(exportedName(db, noteId, "speaker_1"), "Dana");
  assert.equal(
    db.getSpeakerMappings(noteId).filter((m) => m.speaker_id === "speaker_1").length,
    0,
    "an unrelated speaker gained a mapping row"
  );
});

test("a note-only rename carries the existing profile id rather than orphaning the row", () => {
  const db = freshDatabase();
  const noteId = insertNote(db);
  const unit = (s) => Buffer.from(Float32Array.from([s, Math.sqrt(1 - s * s)]).buffer);
  const profile = db.upsertSpeakerProfile("Priyanka", null, unit(1), null);
  db.setSpeakerMapping(noteId, "speaker_0", profile.id, "Priyanka", { origin: "manual" });

  db.renameNoteSpeaker(noteId, "speaker_0", "Priya");

  const row = db.getSpeakerMappings(noteId).find((m) => m.speaker_id === "speaker_0");
  assert.equal(row.profile_id, profile.id);
  assert.equal(row.origin, "agent", "origin must record that an agent made this change");
});

test("a rename of a speaker absent from the transcript changes nothing", () => {
  const db = freshDatabase();
  const noteId = insertNote(db);
  const before = db.getNote(noteId).transcript;

  const result = db.renameNoteSpeaker(noteId, "speaker_9", "Nobody");

  assert.equal(result.segmentsChanged, false);
  assert.equal(db.getNote(noteId).transcript, before);
});

// --- profile-wide ---------------------------------------------------------
// The sweep provably cannot reach a note where the person is already named:
// getNotesWithUnmappedSpeakers only returns notes with an UNMAPPED speaker, and
// classifyRetroactiveMatch rejects an already-mapped candidate. So a real
// library-wide rename has to be an explicit update.

function twoMappedNotes(db) {
  const unit = (s) => Buffer.from(Float32Array.from([s, Math.sqrt(1 - s * s)]).buffer);
  const profile = db.upsertSpeakerProfile("Priyanka", null, unit(1), null);
  const first = insertNote(db, NAMED_SEGMENTS, "Standup");
  const second = insertNote(db, NAMED_SEGMENTS, "Planning");
  db.setSpeakerMapping(first, "speaker_0", profile.id, "Priyanka", { origin: "manual" });
  db.setSpeakerMapping(second, "speaker_0", profile.id, "Priyanka", { origin: "auto", confidence: 0.8 });
  return { profile, first, second };
}

test("a profile-wide rename reaches a note that already had the old name", () => {
  const db = freshDatabase();
  const { profile, first, second } = twoMappedNotes(db);

  const result = db.renameSpeakerProfileEverywhere(profile.id, "Priya");

  assert.equal(result.notesChanged, 2);
  for (const noteId of [first, second]) {
    assert.equal(exportedName(db, noteId, "speaker_0"), "Priya", `note ${noteId} kept the old name`);
    const row = db.getSpeakerMappings(noteId).find((m) => m.speaker_id === "speaker_0");
    assert.equal(row.display_name, "Priya");
    assert.equal(row.origin, "agent");
    assert.equal(row.confidence, null, "a similarity computed against the old name survived");
  }
  assert.equal(
    db.db.prepare("SELECT display_name FROM speaker_profiles WHERE id = ?").get(profile.id)
      .display_name,
    "Priya"
  );
});

test("a profile-wide rename does not touch the stored voiceprint", () => {
  const db = freshDatabase();
  const { profile } = twoMappedNotes(db);
  const before = db.db
    .prepare("SELECT embedding, sample_count FROM speaker_profiles WHERE id = ?")
    .get(profile.id);

  db.renameSpeakerProfileEverywhere(profile.id, "Priya");

  const after = db.db
    .prepare("SELECT embedding, sample_count FROM speaker_profiles WHERE id = ?")
    .get(profile.id);
  assert.equal(after.sample_count, before.sample_count, "sample_count was bumped");
  assert.ok(before.embedding.equals(after.embedding), "the voice embedding was re-blended");
});

test("a profile-wide rename leaves other profiles' mappings alone", () => {
  const db = freshDatabase();
  const { profile, first } = twoMappedNotes(db);
  const unit = (s) => Buffer.from(Float32Array.from([s, Math.sqrt(1 - s * s)]).buffer);
  const other = db.upsertSpeakerProfile("Dana", null, unit(0.2), null);
  db.setSpeakerMapping(first, "speaker_1", other.id, "Dana", { origin: "manual" });

  db.renameSpeakerProfileEverywhere(profile.id, "Priya");

  const row = db.getSpeakerMappings(first).find((m) => m.speaker_id === "speaker_1");
  assert.equal(row.display_name, "Dana");
  assert.equal(row.origin, "manual", "an unrelated row's provenance was rewritten");
  assert.equal(exportedName(db, first, "speaker_1"), "Dana");
});

test("a profile-wide rename of an unknown profile reports nothing changed", () => {
  const db = freshDatabase();
  twoMappedNotes(db);
  const result = db.renameSpeakerProfileEverywhere(999999, "Nobody");
  assert.equal(result.notesChanged, 0);
});
