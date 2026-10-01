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
const {
  resolveSpeaker,
  buildSpeakerMappings,
} = require("../../src/helpers/transcriptFormatter.js");
const { reshredNote, segmentRowsForNote } = require("../../src/helpers/transcriptSegmentIndex.js");

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
  db.setSpeakerMapping(second, "speaker_0", profile.id, "Priyanka", {
    origin: "auto",
    confidence: 0.8,
  });
  return { profile, first, second };
}

test("a profile-wide rename reaches a note that already had the old name", () => {
  const db = freshDatabase();
  const { profile, first, second } = twoMappedNotes(db);

  const result = db.renameSpeakerProfileEverywhere(profile.id, "Priya");

  assert.equal(result.notesChanged, 2);
  for (const noteId of [first, second]) {
    assert.equal(
      exportedName(db, noteId, "speaker_0"),
      "Priya",
      `note ${noteId} kept the old name`
    );
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

// --- review findings I3, I5, I7, I9 ---------------------------------------

// I3: the mapping row was written before the transcript was consulted, so a
// hallucinated or stale speaker id returned success and left a junk row that
// perturbs computeTranscriptHash and forces a pointless reshred.
test("renaming a speaker that is not in the note writes nothing and says so", () => {
  const db = freshDatabase();
  const noteId = insertNote(db);

  assert.throws(() => db.renameNoteSpeaker(noteId, "speaker_42", "Ghost"), /speaker_42/);

  assert.deepEqual(db.getSpeakerMappings(noteId), [], "a junk mapping row was left behind");
  assert.equal(exportedName(db, noteId, "speaker_0"), "Priyanka");
});

// A speaker can legitimately exist in note_speaker_embeddings without appearing
// in the stored transcript yet, so that counts as present.
test("a speaker known only from its embedding can still be renamed", () => {
  const db = freshDatabase();
  const noteId = insertNote(db, []);
  db.db
    .prepare(
      "INSERT INTO note_speaker_embeddings (note_id, speaker_id, embedding) VALUES (?, ?, ?)"
    )
    .run(noteId, "speaker_3", Buffer.from(Float32Array.from([1, 0]).buffer));

  const result = db.renameNoteSpeaker(noteId, "speaker_3", "Priya");

  assert.equal(result.success, true);
  const row = db.getSpeakerMappings(noteId).find((m) => m.speaker_id === "speaker_3");
  assert.equal(row.display_name, "Priya");
});

test("a speaker that already has a mapping row but no segments can be renamed", () => {
  const db = freshDatabase();
  const noteId = insertNote(db, []);
  db.setSpeakerMapping(noteId, "speaker_5", null, "Old", { origin: "manual" });

  const result = db.renameNoteSpeaker(noteId, "speaker_5", "Priya");

  assert.equal(result.success, true);
  assert.equal(
    db.getSpeakerMappings(noteId).find((m) => m.speaker_id === "speaker_5").display_name,
    "Priya"
  );
});

// I5: the transcript index was only refreshed by a 5s background timer draining
// 3 notes a tick, so an agent verifying its own write read the old name back --
// up to ~5*N/3 seconds after a profile-wide rename.
test("the search index is current the moment the rename returns", () => {
  const db = freshDatabase();
  const noteId = insertNote(db);
  // The note must ALREADY be indexed, or segmentRowsForNote computes live from
  // the transcript and the staleness this test exists for cannot appear.
  reshredNote(db.db, noteId);
  assert.ok(
    segmentRowsForNote(db.db, noteId).some((row) => row.speaker_name === "Priyanka"),
    "precondition: the stored index holds the old name"
  );

  db.renameNoteSpeaker(noteId, "speaker_0", "Priya");

  // No reshredNote() call here, deliberately: the previous version of this test
  // reshredded by hand and so could not see the staleness.
  const names = segmentRowsForNote(db.db, noteId).map((row) => row.speaker_name);
  assert.ok(names.includes("Priya"), `read back ${JSON.stringify(names)}`);
  assert.ok(!names.includes("Priyanka"));
});

test("a profile-wide rename leaves every affected note's index current", () => {
  const db = freshDatabase();
  const { profile, first, second } = twoMappedNotes(db);
  for (const noteId of [first, second]) reshredNote(db.db, noteId);
  assert.ok(
    segmentRowsForNote(db.db, first).some((row) => row.speaker_name === "Priyanka"),
    "precondition: the stored index holds the old name"
  );

  db.renameSpeakerProfileEverywhere(profile.id, "Priya");

  for (const noteId of [first, second]) {
    const names = segmentRowsForNote(db.db, noteId).map((row) => row.speaker_name);
    assert.ok(names.includes("Priya"), `note ${noteId} read back ${JSON.stringify(names)}`);
    assert.ok(!names.includes("Priyanka"), `note ${noteId} kept the old name in the index`);
  }
});

// I7: the profile UPDATE, the mappings UPDATE and the N transcript rewrites were
// three separate statements, so a failure part-way left the names renamed and an
// arbitrary prefix of transcripts not.
test("a profile-wide rename that fails part-way leaves nothing renamed", () => {
  const db = freshDatabase();
  const { profile, first, second } = twoMappedNotes(db);
  const realUpdate = db.updateNoteTranscriptKeepingUpdatedAt.bind(db);
  let calls = 0;
  db.updateNoteTranscriptKeepingUpdatedAt = (...args) => {
    calls += 1;
    if (calls === 2) throw new Error("disk full");
    return realUpdate(...args);
  };

  assert.throws(() => db.renameSpeakerProfileEverywhere(profile.id, "Priya"), /disk full/);
  db.updateNoteTranscriptKeepingUpdatedAt = realUpdate;

  assert.equal(
    db.db.prepare("SELECT display_name FROM speaker_profiles WHERE id = ?").get(profile.id)
      .display_name,
    "Priyanka",
    "the profile was renamed even though the transcripts were not"
  );
  for (const noteId of [first, second]) {
    assert.equal(
      db.getSpeakerMappings(noteId).find((m) => m.speaker_id === "speaker_0").display_name,
      "Priyanka",
      `note ${noteId}'s mapping row was renamed without its transcript`
    );
    assert.equal(exportedName(db, noteId, "speaker_0"), "Priyanka");
  }
});

// M12: soft-deleted notes were rewritten, counted in the figure reported to the
// user, and announced.
test("a profile-wide rename skips notes in the trash", () => {
  const db = freshDatabase();
  const { profile, second } = twoMappedNotes(db);
  db.db.prepare("UPDATE notes SET deleted_at = datetime('now') WHERE id = ?").run(second);

  const result = db.renameSpeakerProfileEverywhere(profile.id, "Priya");

  assert.equal(result.notesChanged, 1, "a trashed note was counted in the reported total");
  assert.ok(!result.noteIds.includes(second));
});

// M10: the segment layer recorded an agent edit as speakerLockSource "user",
// disagreeing with the mapping row's origin "agent" and making the changelog's
// "recorded separately from the ones you typed" only half true.
test("a rename records the segment lock as the agent's, not the user's", () => {
  const db = freshDatabase();
  const noteId = insertNote(db);

  db.renameNoteSpeaker(noteId, "speaker_0", "Priya");

  const seg = segmentsOf(db, noteId).find((s) => s.speaker === "speaker_0");
  assert.equal(seg.speakerLockSource, "agent");
  // Still locked, so every auto-relabel path skips it: isSpeakerLocked reads
  // speakerLocked, not the source.
  assert.equal(seg.speakerLocked, true);
  assert.equal(seg.speakerStatus, "locked");
});

test("a profile-wide rename records the same agent lock source", () => {
  const db = freshDatabase();
  const { profile, first } = twoMappedNotes(db);

  db.renameSpeakerProfileEverywhere(profile.id, "Priya");

  const seg = segmentsOf(db, first).find((s) => s.speaker === "speaker_0");
  assert.equal(seg.speakerLockSource, "agent");
  assert.equal(seg.speakerLocked, true);
});
