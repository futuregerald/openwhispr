const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { requireSqlite } = require("../support/sqlite.js");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-voiceprints-"));
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
const { retranscribeNoteTranscript } = require("../../src/helpers/retranscribeNoteTranscript.js");

function freshDatabase() {
  requireSqlite();
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-voiceprints-"));
  return new DatabaseManager();
}

function insertNote(db, transcript = []) {
  const info = db.db
    .prepare("INSERT INTO notes (title, transcript) VALUES (?, ?)")
    .run("A meeting", JSON.stringify(transcript));
  return Number(info.lastInsertRowid);
}

// Re-transcription hands saveNoteSpeakerEmbeddings the centroids as plain number
// arrays (Array.from(centroid)). Driven end to end against the real database, so
// the bind itself is what is under test, not a stub of it.
test("re-transcription stores its cluster voiceprints in the real database", async () => {
  const db = freshDatabase();
  const noteId = insertNote(db, [
    { text: "hello", source: "system", timestamp: 0, speaker: "speaker_0", speakerName: "Alice" },
  ]);
  const note = db.getNote(noteId);
  note.system_audio_path = "/audio/system.opus";

  const result = await retranscribeNoteTranscript({
    note,
    whisperManager: {
      getModelPath: () => "/models/large.bin",
      transcribeLocalWhisper: async () => ({
        success: true,
        text: "alpha",
        segments: [{ start: 0.5, end: 2, text: "alpha" }],
      }),
    },
    diarizationManager: {
      isAvailable: () => true,
      diarize: async () => [{ speaker: "raw_a", start: 0, end: 4 }],
      mergeWithTranscript: (segments) => segments.map((seg) => ({ ...seg, speaker: "speaker_0" })),
    },
    databaseManager: db,
    convertToWav: async () => {},
    fileExists: () => true,
    readFile: () => Buffer.from("fake wav"),
    speakerEmbeddings: {
      isAvailable: () => true,
      extractEmbedding: async () => Float32Array.from([0.6, 0.8, 0, 0]),
      computeCentroid: (embeddings) => embeddings[0],
    },
  });

  assert.equal(result.outcome, "written");
  const rows = db.getNoteSpeakerEmbeddings(noteId);
  assert.equal(rows.length, 1, "the re-transcribed voiceprint never reached the database");
  const stored = new Float32Array(
    rows[0].embedding.buffer,
    rows[0].embedding.byteOffset,
    rows[0].embedding.byteLength / 4
  );
  assert.deepEqual(Array.from(stored), Array.from(Float32Array.from([0.6, 0.8, 0, 0])));
});

const IPCHandlers = require("../../src/helpers/ipcHandlers.js");
const { MODEL_ID } = require("../../src/helpers/speakerEmbeddings.js");

const vec = (values) => Buffer.from(Float32Array.from(values).buffer);
const floatsOf = (buf) =>
  Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
const close = (actual, expected, eps = 1e-5) =>
  actual.length === expected.length && actual.every((v, i) => Math.abs(v - expected[i]) < eps);

const columnsOf = (db, table) =>
  new Set(
    db.db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((c) => c.name)
  );

const profileRow = (db, id) => db.db.prepare("SELECT * FROM speaker_profiles WHERE id = ?").get(id);
const samplesOf = (db, profileId) =>
  db.db
    .prepare("SELECT * FROM speaker_profile_samples WHERE profile_id = ? ORDER BY id")
    .all(profileId);
const profileCount = (db) => db.db.prepare("SELECT COUNT(*) AS n FROM speaker_profiles").get().n;

function handlersFor(db) {
  const handlers = Object.create(IPCHandlers.prototype);
  Object.assign(handlers, {
    databaseManager: db,
    _retroactiveMapping: () => {},
    _tryAutoLabelOneOnOne: () => {},
    notesRegenerationScheduler: null,
  });
  return handlers;
}

test("the voiceprint schema carries samples, model ids and speech time", () => {
  const db = freshDatabase();
  const samples = columnsOf(db, "speaker_profile_samples");
  for (const column of [
    "id",
    "profile_id",
    "embedding",
    "duration_s",
    "note_id",
    "speaker_id",
    "model_id",
    "created_at",
  ]) {
    assert.ok(samples.has(column), `speaker_profile_samples.${column} missing`);
  }
  const profiles = columnsOf(db, "speaker_profiles");
  assert.ok(profiles.has("model_id"));
  assert.ok(profiles.has("total_speech_s"));
  const embeddings = columnsOf(db, "note_speaker_embeddings");
  assert.ok(embeddings.has("model_id"));
  assert.ok(embeddings.has("speech_s"));
});

test("the one-time voiceprint wipe clears old voiceprints, keeps names, and runs once", () => {
  const db = freshDatabase();
  const noteId = insertNote(db);
  const profileId = Number(
    db.db
      .prepare("INSERT INTO speaker_profiles (display_name, embedding) VALUES (?, ?)")
      .run("Dana", vec([1, 0])).lastInsertRowid
  );
  db.db
    .prepare(
      "INSERT INTO note_speaker_embeddings (note_id, speaker_id, embedding) VALUES (?, ?, ?)"
    )
    .run(noteId, "speaker_0", vec([1, 0]));
  db.setSpeakerMapping(noteId, "speaker_0", profileId, "Dana", { origin: "manual" });
  db.db.prepare("DELETE FROM schema_meta WHERE key = ?").run("voiceprints_wespeaker_resnet293");
  db.db.close();

  const reopened = new DatabaseManager();
  assert.equal(profileCount(reopened), 0, "old voiceprint profiles survived");
  assert.equal(
    reopened.db.prepare("SELECT COUNT(*) AS n FROM note_speaker_embeddings").get().n,
    0,
    "old per-note voiceprints survived"
  );
  const mapping = reopened.getSpeakerMappings(noteId)[0];
  assert.equal(mapping.display_name, "Dana", "the wipe lost a speaker name");
  assert.equal(mapping.profile_id, null);

  reopened.db
    .prepare("INSERT INTO speaker_profiles (display_name, embedding) VALUES (?, ?)")
    .run("Sam", vec([0, 1]));
  reopened.db.close();
  const again = new DatabaseManager();
  assert.equal(profileCount(again), 1, "the wipe ran a second time");
});

test("note voiceprints accept Buffer, Float32Array and plain arrays, stamped with the model", () => {
  const db = freshDatabase();
  const noteId = insertNote(db);
  db.saveNoteSpeakerEmbeddings(
    noteId,
    {
      speaker_0: vec([0.6, 0.8]),
      speaker_1: Float32Array.from([0, 1]),
      speaker_2: [1, 0],
    },
    { speaker_0: 12.5, speaker_2: 3 }
  );
  const rows = new Map(db.getNoteSpeakerEmbeddings(noteId).map((r) => [r.speaker_id, r]));
  assert.equal(rows.size, 3);
  assert.ok(close(floatsOf(rows.get("speaker_0").embedding), [0.6, 0.8]));
  assert.ok(close(floatsOf(rows.get("speaker_1").embedding), [0, 1]));
  assert.ok(close(floatsOf(rows.get("speaker_2").embedding), [1, 0]));
  for (const row of rows.values()) assert.equal(row.model_id, MODEL_ID);
  assert.equal(rows.get("speaker_0").speech_s, 12.5);
  assert.equal(rows.get("speaker_1").speech_s, null);
  assert.equal(rows.get("speaker_2").speech_s, 3);
});

test("a Float32Array view into a larger buffer stores only its own values", () => {
  const db = freshDatabase();
  const noteId = insertNote(db);
  const backing = Float32Array.from([9, 9, 0.6, 0.8, 9]);
  db.saveNoteSpeakerEmbeddings(noteId, { speaker_0: backing.subarray(2, 4) });
  assert.ok(close(floatsOf(db.getNoteSpeakerEmbeddings(noteId)[0].embedding), [0.6, 0.8]));
});

test("voiceprints made by another model are hidden from readers", () => {
  const db = freshDatabase();
  const noteId = insertNote(db);
  db.db
    .prepare(
      "INSERT INTO note_speaker_embeddings (note_id, speaker_id, embedding, model_id) VALUES (?, ?, ?, ?)"
    )
    .run(noteId, "speaker_9", vec([1, 0]), "3dspeaker-campplus");
  db.db
    .prepare("INSERT INTO speaker_profiles (display_name, embedding, model_id) VALUES (?, ?, ?)")
    .run("Old", vec([1, 0]), "3dspeaker-campplus");
  db.saveNoteSpeakerEmbeddings(noteId, { speaker_0: [0, 1] });
  db.upsertSpeakerProfile("New", null, vec([0, 1]), null, {
    durationS: 5,
    noteId,
    speakerId: "speaker_0",
  });

  assert.deepEqual(
    db.getNoteSpeakerEmbeddings(noteId).map((r) => r.speaker_id),
    ["speaker_0"]
  );
  assert.deepEqual(
    db.getSpeakerProfiles(true).map((p) => p.display_name),
    ["New"]
  );
  assert.deepEqual(
    db.getSpeakerProfiles().map((p) => p.display_name),
    ["New"]
  );
});

test("a profile is the duration-weighted mean of its normalised samples", () => {
  const db = freshDatabase();
  const noteA = insertNote(db);
  const noteB = insertNote(db);
  const first = db.upsertSpeakerProfile("Dana", null, vec([10, 0]), null, {
    durationS: 30,
    noteId: noteA,
    speakerId: "speaker_0",
  });
  const updated = db.upsertSpeakerProfile("Dana", null, vec([0, 1]), first.id, {
    durationS: 10,
    noteId: noteB,
    speakerId: "speaker_0",
  });
  assert.equal(updated.id, first.id);
  const norm = Math.hypot(30, 10);
  assert.ok(
    close(floatsOf(updated.embedding), [30 / norm, 10 / norm]),
    `got ${floatsOf(updated.embedding)}`
  );
  assert.equal(updated.sample_count, 2);
  assert.equal(updated.total_speech_s, 40);
  assert.equal(updated.model_id, MODEL_ID);
  const samples = samplesOf(db, first.id);
  assert.deepEqual(
    samples.map((s) => [s.note_id, s.speaker_id, s.duration_s, s.model_id]),
    [
      [noteA, "speaker_0", 30, MODEL_ID],
      [noteB, "speaker_0", 10, MODEL_ID],
    ]
  );
});

test("samples without any speech time still give a usable profile", () => {
  const db = freshDatabase();
  const noteA = insertNote(db);
  const noteB = insertNote(db);
  const p = db.upsertSpeakerProfile("Dana", null, vec([1, 0]), null, {
    noteId: noteA,
    speakerId: "s",
  });
  const updated = db.upsertSpeakerProfile("Dana", null, vec([0, 1]), p.id, {
    noteId: noteB,
    speakerId: "s",
  });
  assert.ok(close(floatsOf(updated.embedding), [Math.SQRT1_2, Math.SQRT1_2]));
  assert.equal(updated.total_speech_s, 0);
});

test("naming the same speaker again replaces its sample rather than adding one", () => {
  const db = freshDatabase();
  const noteId = insertNote(db);
  const p = db.upsertSpeakerProfile("Dana", null, vec([1, 0]), null, {
    durationS: 5,
    noteId,
    speakerId: "speaker_0",
  });
  const again = db.upsertSpeakerProfile("Dana", null, vec([0, 1]), p.id, {
    durationS: 7,
    noteId,
    speakerId: "speaker_0",
  });
  assert.equal(again.sample_count, 1);
  assert.equal(again.total_speech_s, 7);
  assert.ok(close(floatsOf(again.embedding), [0, 1]));
});

test("a profile keeps at most 20 samples, dropping the oldest", () => {
  const db = freshDatabase();
  const notes = Array.from({ length: 22 }, () => insertNote(db));
  let profile = null;
  for (const [i, noteId] of notes.entries()) {
    profile = db.upsertSpeakerProfile("Dana", null, vec([1, i]), profile?.id ?? null, {
      durationS: 1,
      noteId,
      speakerId: "speaker_0",
    });
  }
  assert.equal(profile.sample_count, 20);
  assert.equal(profile.total_speech_s, 20);
  const kept = samplesOf(db, profile.id).map((s) => s.note_id);
  assert.deepEqual(kept, notes.slice(2), "the oldest samples should be the ones dropped");
});

test("the database no longer reuses a profile just because the name matches", () => {
  const db = freshDatabase();
  const noteA = insertNote(db);
  const noteB = insertNote(db);
  const a = db.upsertSpeakerProfile("Alex", null, vec([1, 0]), null, {
    durationS: 5,
    noteId: noteA,
    speakerId: "speaker_0",
  });
  const b = db.upsertSpeakerProfile("Alex", null, vec([0, 1]), null, {
    durationS: 5,
    noteId: noteB,
    speakerId: "speaker_0",
  });
  assert.notEqual(a.id, b.id);
  assert.equal(profileCount(db), 2);
});

test("merging profiles moves the loser's samples to the winner and rebuilds it", () => {
  const db = freshDatabase();
  const notes = [insertNote(db), insertNote(db), insertNote(db)];
  let winner = db.upsertSpeakerProfile("Jorge", null, vec([1, 0]), null, {
    durationS: 10,
    noteId: notes[0],
    speakerId: "s",
  });
  winner = db.upsertSpeakerProfile("Jorge", null, vec([1, 0]), winner.id, {
    durationS: 10,
    noteId: notes[1],
    speakerId: "s",
  });
  const loser = db.upsertSpeakerProfile("J.", null, vec([0, 1]), null, {
    durationS: 20,
    noteId: notes[2],
    speakerId: "s",
  });

  const merged = db.mergeSpeakerProfiles(winner, loser);
  assert.equal(merged.id, winner.id);
  assert.equal(profileRow(db, loser.id), undefined, "the loser profile survived");
  assert.equal(samplesOf(db, loser.id).length, 0);
  assert.equal(merged.sample_count, 3);
  assert.equal(merged.total_speech_s, 40);
  assert.ok(close(floatsOf(merged.embedding), [Math.SQRT1_2, Math.SQRT1_2]));
});

test("set-speaker-mapping: renaming a speaker it just named renames that profile", async () => {
  const db = freshDatabase();
  const noteId = insertNote(db);
  db.saveNoteSpeakerEmbeddings(noteId, { speaker_0: [1, 0] }, { speaker_0: 20 });
  const h = handlersFor(db);

  const first = await h._setSpeakerMapping(noteId, "speaker_0", "Alx", null, null);
  const second = await h._setSpeakerMapping(noteId, "speaker_0", "Alex", null, null);

  assert.equal(second.profileId, first.profileId);
  assert.equal(profileCount(db), 1, "a typo fix created a second profile");
  assert.equal(profileRow(db, first.profileId).display_name, "Alex");
  assert.equal(samplesOf(db, first.profileId).length, 1);
  assert.equal(db.getSpeakerMappings(noteId)[0].display_name, "Alex");
});

test("set-speaker-mapping: correcting a speaker removes its sample from the wrong profile", async () => {
  const db = freshDatabase();
  const noteA = insertNote(db);
  const noteB = insertNote(db);
  db.saveNoteSpeakerEmbeddings(noteA, { speaker_0: [1, 0] }, { speaker_0: 20 });
  db.saveNoteSpeakerEmbeddings(noteB, { speaker_0: [0, 1] }, { speaker_0: 15 });
  const h = handlersFor(db);

  const dana = await h._setSpeakerMapping(noteA, "speaker_0", "Dana", null, null);
  const wrong = await h._setSpeakerMapping(noteB, "speaker_0", "Dana", null, null);
  assert.equal(wrong.profileId, dana.profileId, "the typed name should reach the one Dana");
  assert.equal(samplesOf(db, dana.profileId).length, 2);

  const sam = await h._setSpeakerMapping(noteB, "speaker_0", "Sam", null, null);

  assert.notEqual(sam.profileId, dana.profileId);
  assert.equal(
    profileRow(db, dana.profileId).display_name,
    "Dana",
    "the shared profile was renamed"
  );
  assert.deepEqual(
    samplesOf(db, dana.profileId).map((s) => s.note_id),
    [noteA],
    "the corrected speaker's sample is still in Dana"
  );
  assert.ok(close(floatsOf(profileRow(db, dana.profileId).embedding), [1, 0]));
  assert.equal(profileRow(db, sam.profileId).display_name, "Sam");
  assert.deepEqual(
    samplesOf(db, sam.profileId).map((s) => s.note_id),
    [noteB]
  );
});

test("set-speaker-mapping: a typed name reuses the one profile with that name", async () => {
  const db = freshDatabase();
  const noteA = insertNote(db);
  const noteB = insertNote(db);
  db.saveNoteSpeakerEmbeddings(noteA, { speaker_0: [1, 0] });
  db.saveNoteSpeakerEmbeddings(noteB, { speaker_3: [1, 0] });
  const h = handlersFor(db);
  const a = await h._setSpeakerMapping(noteA, "speaker_0", "Alex", null, null);
  const b = await h._setSpeakerMapping(noteB, "speaker_3", "Alex", null, null);
  assert.equal(b.profileId, a.profileId);
  assert.equal(profileCount(db), 1);
});

test("set-speaker-mapping: with two profiles of that name, a third is created rather than guessed", async () => {
  const db = freshDatabase();
  const notes = [insertNote(db), insertNote(db), insertNote(db)];
  for (const noteId of notes) db.saveNoteSpeakerEmbeddings(noteId, { speaker_0: [1, 0] });
  db.upsertSpeakerProfile("Alex", null, vec([1, 0]), null, {
    durationS: 5,
    noteId: notes[0],
    speakerId: "speaker_0",
  });
  db.upsertSpeakerProfile("Alex", null, vec([1, 0]), null, {
    durationS: 5,
    noteId: notes[1],
    speakerId: "speaker_0",
  });
  const h = handlersFor(db);
  await h._setSpeakerMapping(notes[2], "speaker_0", "Alex", null, null);
  assert.equal(profileCount(db), 3);
});

test("set-speaker-mapping: an email outranks a profile that merely shares the name", async () => {
  const db = freshDatabase();
  const notes = [insertNote(db), insertNote(db), insertNote(db)];
  db.saveNoteSpeakerEmbeddings(notes[2], { speaker_0: [0, 1] });
  const owner = db.upsertSpeakerProfile("Dana Smith", "dana@example.com", vec([1, 0]), null, {
    durationS: 5,
    noteId: notes[0],
    speakerId: "speaker_0",
  });
  const namesake = db.upsertSpeakerProfile("Dana", null, vec([1, 0]), null, {
    durationS: 5,
    noteId: notes[1],
    speakerId: "speaker_0",
  });
  const h = handlersFor(db);
  const result = await h._setSpeakerMapping(
    notes[2],
    "speaker_0",
    "Dana",
    "DANA@example.com",
    null
  );
  assert.equal(result.profileId, owner.id);
  assert.equal(samplesOf(db, namesake.id).length, 1, "the namesake took the sample");
});

test("set-speaker-mapping: remapping to another profile takes the sample out of the old one", async () => {
  const db = freshDatabase();
  const noteA = insertNote(db);
  const noteB = insertNote(db);
  db.saveNoteSpeakerEmbeddings(noteA, { speaker_0: [1, 0] });
  db.saveNoteSpeakerEmbeddings(noteB, { speaker_0: [0, 1] });
  const h = handlersFor(db);
  const dana = await h._setSpeakerMapping(noteA, "speaker_0", "Dana", null, null);
  await h._setSpeakerMapping(noteB, "speaker_0", "Dana", null, null);
  const sam = db.upsertSpeakerProfile("Sam", null, vec([0, 1]), null, {
    durationS: 5,
    noteId: noteA,
    speakerId: "speaker_9",
  });

  await h._setSpeakerMapping(noteB, "speaker_0", "Sam", null, sam.id);

  assert.deepEqual(
    samplesOf(db, dana.profileId).map((s) => s.note_id),
    [noteA]
  );
  assert.equal(samplesOf(db, sam.id).length, 2);
});

test("set-speaker-mapping: the sample carries the speaker's speech time", async () => {
  const db = freshDatabase();
  const noteId = insertNote(db);
  db.saveNoteSpeakerEmbeddings(noteId, { speaker_0: [1, 0] }, { speaker_0: 42.5 });
  const h = handlersFor(db);
  const { profileId } = await h._setSpeakerMapping(noteId, "speaker_0", "Dana", null, null);
  assert.equal(samplesOf(db, profileId)[0].duration_s, 42.5);
  assert.equal(profileRow(db, profileId).total_speech_s, 42.5);
});

test("set-speaker-mapping without a voiceprint still records the name", async () => {
  const db = freshDatabase();
  const noteId = insertNote(db);
  const h = handlersFor(db);
  const result = await h._setSpeakerMapping(noteId, "speaker_0", "Dana", null, null);
  assert.equal(result.profileId, null);
  assert.equal(db.getSpeakerMappings(noteId)[0].display_name, "Dana");
  assert.equal(profileCount(db), 0);
});

test("main's embedding persist records each speaker's speech time", () => {
  const db = freshDatabase();
  const noteId = insertNote(db);
  const h = handlersFor(db);
  h._persistSpeakerEmbeddings(noteId, { speaker_0: [0.6, 0.8] }, { speaker_0: 31 });
  const row = db.getNoteSpeakerEmbeddings(noteId)[0];
  assert.equal(row.speech_s, 31);
});

test("post-call diarization hands each renumbered speaker's total speech to the persist", async () => {
  const persisted = [];
  const handlers = Object.create(IPCHandlers.prototype);
  Object.assign(handlers, {
    speakerDiarizationEnabled: true,
    diarizationManager: {
      isAvailable: () => true,
      convertRawPcmToWav: async () => "/tmp/ow-voiceprint-test.wav",
      diarize: async () => [
        { speaker: "raw_b", start: 0, end: 4 },
        { speaker: "raw_a", start: 4, end: 6 },
        { speaker: "raw_b", start: 6, end: 9 },
      ],
      capSpeakerClusters: (segments) => segments,
      mergeWithTranscript: (segments) => segments,
    },
    speakerEmbeddings: {
      isAvailable: () => true,
      extractEmbedding: async () => Float32Array.from([1, 0]),
      computeCentroid: (embeddings) => embeddings[0],
      cosineSimilarity: () => 0,
    },
    databaseManager: { getSpeakerProfiles: () => [] },
    _resolveSpeakerExpectation: () => ({ maxSpeakers: null }),
    _persistDiarizedTranscript: (...args) => {
      persisted.push(args);
      return [];
    },
    _enqueuePostCallPipeline: () => {},
  });

  await handlers._startOrSkipDiarization(
    "session-1",
    "/tmp/ow-voiceprint-test.pcm",
    0,
    [{ id: "s1", text: "hi", source: "system", timestamp: 0 }],
    null,
    null,
    null,
    7
  );

  assert.equal(persisted.length, 1);
  const [, , embeddings, , speechSeconds] = persisted[0];
  assert.deepEqual(Object.keys(embeddings).sort(), ["speaker_0", "speaker_1"]);
  assert.deepEqual(speechSeconds, { speaker_0: 7, speaker_1: 2 });
});

test("re-transcription records each resolved speaker's speech time", async () => {
  const db = freshDatabase();
  const noteId = insertNote(db, [
    { text: "hello", source: "system", timestamp: 0, speaker: "speaker_0", speakerName: "Alice" },
  ]);
  const note = db.getNote(noteId);
  note.system_audio_path = "/audio/system.opus";

  await retranscribeNoteTranscript({
    note,
    whisperManager: {
      getModelPath: () => "/models/large.bin",
      transcribeLocalWhisper: async () => ({
        success: true,
        text: "alpha",
        segments: [{ start: 0.5, end: 2, text: "alpha" }],
      }),
    },
    diarizationManager: {
      isAvailable: () => true,
      diarize: async () => [
        { speaker: "raw_a", start: 0, end: 4 },
        { speaker: "raw_a", start: 10, end: 12.5 },
      ],
      mergeWithTranscript: (segments) => segments.map((seg) => ({ ...seg, speaker: "speaker_0" })),
    },
    databaseManager: db,
    convertToWav: async () => {},
    fileExists: () => true,
    readFile: () => Buffer.from("fake wav"),
    speakerEmbeddings: {
      isAvailable: () => true,
      extractEmbedding: async () => Float32Array.from([0.6, 0.8]),
      computeCentroid: (embeddings) => embeddings[0],
    },
  });

  const rows = db.getNoteSpeakerEmbeddings(noteId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].speech_s, 6.5);
});

test("a profile refuses samples of a different dimension", () => {
  const db = freshDatabase();
  const noteA = insertNote(db);
  const noteB = insertNote(db);
  const p = db.upsertSpeakerProfile("Dana", null, vec([1, 0]), null, {
    durationS: 5,
    noteId: noteA,
    speakerId: "s",
  });
  assert.throws(
    () =>
      db.upsertSpeakerProfile("Dana", null, vec([1, 0, 0]), p.id, {
        durationS: 5,
        noteId: noteB,
        speakerId: "s",
      }),
    RangeError
  );
  assert.equal(samplesOf(db, p.id).length, 1, "the rejected sample was kept");
});

test("a 1:1 auto-label reaches the attendee's existing profile and records speech time", async () => {
  const db = freshDatabase();
  const earlier = insertNote(db);
  const existing = db.upsertSpeakerProfile("Priya", null, vec([1, 0]), null, {
    durationS: 40,
    noteId: earlier,
    speakerId: "speaker_0",
  });
  const noteId = insertNote(db, [{ text: "hi", source: "system", speaker: "speaker_0" }]);
  db.db
    .prepare("UPDATE notes SET participants = ? WHERE id = ?")
    .run(JSON.stringify([{ displayName: "Priya" }]), noteId);
  db.saveNoteSpeakerEmbeddings(noteId, { speaker_0: [1, 0] }, { speaker_0: 25 });

  const h = Object.create(IPCHandlers.prototype);
  Object.assign(h, {
    databaseManager: db,
    _retroactiveMapping: () => {},
    broadcastToWindows: () => {},
  });
  h._tryAutoLabelOneOnOne(noteId);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(profileCount(db), 1, "the attendee got a second profile");
  assert.equal(db.getSpeakerMappings(noteId)[0].profile_id, existing.id);
  const sample = samplesOf(db, existing.id).find((s) => s.note_id === noteId);
  assert.ok(sample, "the 1:1 speaker added no sample");
  assert.equal(sample.duration_s, 25);
});

test("merging two profiles that both hold the same speaker keeps one sample for it", () => {
  const db = freshDatabase();
  const noteId = insertNote(db);
  const winner = db.upsertSpeakerProfile("Jorge", null, vec([1, 0]), null, {
    durationS: 10,
    noteId,
    speakerId: "speaker_0",
  });
  const loser = db.upsertSpeakerProfile("J.", null, vec([0, 1]), null, {
    durationS: 10,
    noteId,
    speakerId: "speaker_0",
  });
  const merged = db.mergeSpeakerProfiles(winner, loser);
  assert.equal(merged.sample_count, 1);
  assert.equal(merged.total_speech_s, 10);
});

function oneOnOneNote(db, attendee, embedding = [1, 0], speechS = 25) {
  const noteId = insertNote(db, [{ text: "hi", source: "system", speaker: "speaker_0" }]);
  db.db
    .prepare("UPDATE notes SET participants = ? WHERE id = ?")
    .run(JSON.stringify([attendee]), noteId);
  db.saveNoteSpeakerEmbeddings(noteId, { speaker_0: embedding }, { speaker_0: speechS });
  return noteId;
}

async function autoLabelOneOnOne(db, noteId) {
  const h = Object.create(IPCHandlers.prototype);
  Object.assign(h, {
    databaseManager: db,
    _retroactiveMapping: () => {},
    broadcastToWindows: () => {},
  });
  h._tryAutoLabelOneOnOne(noteId);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

const mappingOf = (db, noteId, speakerId = "speaker_0") =>
  db.getSpeakerMappings(noteId).find((m) => m.speaker_id === speakerId);

const DANA = { displayName: "Dana", email: "dana@x.com" };

test("renaming an auto-labelled 1:1 speaker is a correction, so a later 1:1 with the attendee never reaches the new name", async () => {
  const db = freshDatabase();
  const note1 = oneOnOneNote(db, DANA);
  await autoLabelOneOnOne(db, note1);
  const danaId = mappingOf(db, note1).profile_id;
  assert.equal(profileRow(db, danaId).email, "dana@x.com");

  const eve = await handlersFor(db)._setSpeakerMapping(note1, "speaker_0", "Eve", null, null);

  assert.notEqual(eve.profileId, danaId, "the attendee's profile was renamed to Eve");
  assert.equal(profileRow(db, eve.profileId).display_name, "Eve");
  assert.equal(profileRow(db, eve.profileId).email, null, "Eve inherited the attendee's email");
  const danaAfter = profileRow(db, danaId);
  if (danaAfter) {
    assert.equal(danaAfter.display_name, "Dana");
    assert.equal(danaAfter.email, "dana@x.com");
    assert.equal(
      samplesOf(db, danaId).some((s) => s.note_id === note1),
      false
    );
  }

  const note2 = oneOnOneNote(db, DANA);
  await autoLabelOneOnOne(db, note2);
  assert.notEqual(mappingOf(db, note2).profile_id, eve.profileId, "a 1:1 with Dana reached Eve");
  assert.equal(profileRow(db, eve.profileId).display_name, "Eve");
  assert.deepEqual(
    samplesOf(db, eve.profileId).map((s) => s.note_id),
    [note1]
  );
});

test("correcting one of an attendee's 1:1 speakers keeps the attendee's name, email and other samples", async () => {
  const db = freshDatabase();
  const note0 = oneOnOneNote(db, DANA);
  const note1 = oneOnOneNote(db, DANA);
  await autoLabelOneOnOne(db, note0);
  await autoLabelOneOnOne(db, note1);
  const danaId = mappingOf(db, note0).profile_id;
  assert.equal(mappingOf(db, note1).profile_id, danaId);

  const eve = await handlersFor(db)._setSpeakerMapping(note1, "speaker_0", "Eve", null, null);

  assert.notEqual(eve.profileId, danaId);
  assert.equal(profileRow(db, danaId).display_name, "Dana");
  assert.equal(profileRow(db, danaId).email, "dana@x.com");
  assert.deepEqual(
    samplesOf(db, danaId).map((s) => s.note_id),
    [note0]
  );
});

test("a speaker the user named can still be renamed when the supplied email is the profile's own", async () => {
  const db = freshDatabase();
  const noteId = insertNote(db);
  db.saveNoteSpeakerEmbeddings(noteId, { speaker_0: [1, 0] }, { speaker_0: 20 });
  const h = handlersFor(db);
  const first = await h._setSpeakerMapping(noteId, "speaker_0", "Dana", "dana@x.com", null);
  const second = await h._setSpeakerMapping(noteId, "speaker_0", "Dana S.", "dana@x.com", null);
  assert.equal(second.profileId, first.profileId);
  assert.equal(profileCount(db), 1);
});

const ALEX_A = { displayName: "Alex", email: "alex.a@x.com" };
const ALEX_B = { displayName: "Alex", email: "alex.b@x.com" };

function seedAlexA(db) {
  const earlier = insertNote(db);
  return db.upsertSpeakerProfile("Alex", ALEX_A.email, vec([1, 0]), null, {
    durationS: 30,
    noteId: earlier,
    speakerId: "speaker_0",
  });
}

test("a 1:1 with a different Alex never reuses or re-emails the existing Alex", async () => {
  const db = freshDatabase();
  const alexA = seedAlexA(db);
  const noteId = oneOnOneNote(db, ALEX_B);
  await autoLabelOneOnOne(db, noteId);
  assert.notEqual(mappingOf(db, noteId).profile_id, alexA.id);
  assert.equal(profileRow(db, alexA.id).email, ALEX_A.email);
  assert.equal(samplesOf(db, alexA.id).length, 1);
  assert.equal(profileCount(db), 2);
});

test("picking a participant Alex with another email creates a profile rather than reusing the existing Alex", async () => {
  const db = freshDatabase();
  const alexA = seedAlexA(db);
  const noteId = insertNote(db);
  db.saveNoteSpeakerEmbeddings(noteId, { speaker_0: [1, 0] }, { speaker_0: 20 });
  const result = await handlersFor(db)._setSpeakerMapping(
    noteId,
    "speaker_0",
    "Alex",
    ALEX_B.email,
    null
  );
  assert.notEqual(result.profileId, alexA.id);
  assert.equal(profileRow(db, alexA.id).email, ALEX_A.email);
  assert.equal(profileRow(db, result.profileId).email, ALEX_B.email);
});

// A typed name carries no email, so nothing says this is a different Alex. Creating a second
// Alex here would give one voice two profiles, and the margin rule would then never name him.
test("a typed name without an email reaches the one namesake, even one who has an email", async () => {
  const db = freshDatabase();
  const alexA = seedAlexA(db);
  const noteId = insertNote(db);
  db.saveNoteSpeakerEmbeddings(noteId, { speaker_0: [1, 0] }, { speaker_0: 20 });
  const result = await handlersFor(db)._setSpeakerMapping(noteId, "speaker_0", "Alex", null, null);
  assert.equal(result.profileId, alexA.id);
  assert.equal(profileRow(db, alexA.id).email, ALEX_A.email);
});

test("removing a profile's last sample deletes the profile and keeps the names it gave notes", () => {
  const db = freshDatabase();
  const noteId = insertNote(db);
  const p = db.upsertSpeakerProfile("Dana", null, vec([1, 0]), null, {
    durationS: 10,
    noteId,
    speakerId: "speaker_0",
  });
  db.setSpeakerMapping(noteId, "speaker_0", p.id, "Dana", { origin: "manual" });

  db.removeSpeakerProfileSample(p.id, noteId, "speaker_0");

  assert.equal(profileRow(db, p.id), undefined, "a profile with no samples survived");
  const mapping = mappingOf(db, noteId);
  assert.equal(mapping.profile_id, null);
  assert.equal(mapping.display_name, "Dana");
});

test("fixing a typo by picking the existing profile leaves no empty typo profile behind", async () => {
  const db = freshDatabase();
  const noteA = insertNote(db);
  const noteB = insertNote(db);
  db.saveNoteSpeakerEmbeddings(noteA, { speaker_0: [1, 0] }, { speaker_0: 20 });
  db.saveNoteSpeakerEmbeddings(noteB, { speaker_0: [1, 0] }, { speaker_0: 20 });
  const h = handlersFor(db);
  const alex = await h._setSpeakerMapping(noteA, "speaker_0", "Alex", null, null);
  const alx = await h._setSpeakerMapping(noteB, "speaker_0", "Alx", null, null);
  assert.notEqual(alx.profileId, alex.profileId);

  await h._setSpeakerMapping(noteB, "speaker_0", "Alex", null, alex.profileId);

  assert.equal(profileRow(db, alx.profileId), undefined, "the typo profile survived empty");
  assert.equal(profileCount(db), 1);
  assert.equal(samplesOf(db, alex.profileId).length, 2);
});

test("a typed name reaches the one profile that differs only in case or accents, keeping its name", async () => {
  const db = freshDatabase();
  const noteA = insertNote(db);
  const noteB = insertNote(db);
  const noteC = insertNote(db);
  for (const noteId of [noteA, noteB, noteC]) {
    db.saveNoteSpeakerEmbeddings(noteId, { speaker_0: [1, 0] }, { speaker_0: 20 });
  }
  const h = handlersFor(db);
  const alex = await h._setSpeakerMapping(noteA, "speaker_0", "Alex", null, null);
  const zoe = await h._setSpeakerMapping(noteB, "speaker_0", "Zoë", null, null);

  const lower = await h._setSpeakerMapping(noteC, "speaker_0", "alex", null, null);
  assert.equal(lower.profileId, alex.profileId);
  assert.equal(profileRow(db, alex.profileId).display_name, "Alex");

  const noteD = insertNote(db);
  db.saveNoteSpeakerEmbeddings(noteD, { speaker_0: [1, 0] }, { speaker_0: 20 });
  const plain = await h._setSpeakerMapping(noteD, "speaker_0", "zoe", null, null);
  assert.equal(plain.profileId, zoe.profileId);
  assert.equal(profileCount(db), 2);
});

test("a correction whose new profile fails to save leaves the old sample and mapping in place", async () => {
  const db = freshDatabase();
  const note0 = insertNote(db);
  const note1 = insertNote(db);
  db.saveNoteSpeakerEmbeddings(note0, { speaker_0: [1, 0] }, { speaker_0: 20 });
  db.saveNoteSpeakerEmbeddings(note1, { speaker_0: [1, 0] }, { speaker_0: 20 });
  const h = handlersFor(db);
  const dana = await h._setSpeakerMapping(note0, "speaker_0", "Dana", null, null);
  await h._setSpeakerMapping(note1, "speaker_0", "Dana", null, null);
  assert.equal(samplesOf(db, dana.profileId).length, 2);

  db.upsertSpeakerProfile = () => {
    throw new Error("disk full");
  };
  await assert.rejects(async () => h._setSpeakerMapping(note1, "speaker_0", "Sam", null, null));

  assert.deepEqual(
    samplesOf(db, dana.profileId).map((s) => s.note_id),
    [note0, note1]
  );
  assert.equal(mappingOf(db, note1).display_name, "Dana");
  assert.equal(mappingOf(db, note1).profile_id, dana.profileId);
});

test("a sample with no recorded speech time still pulls the profile toward its voice", () => {
  const db = freshDatabase();
  const noteA = insertNote(db);
  const noteB = insertNote(db);
  const p = db.upsertSpeakerProfile("Dana", null, vec([1, 0]), null, {
    durationS: 10,
    noteId: noteA,
    speakerId: "speaker_0",
  });
  const after = db.upsertSpeakerProfile("Dana", null, vec([0, 1]), p.id, {
    durationS: 0,
    noteId: noteB,
    speakerId: "speaker_0",
  });
  const norm = Math.hypot(10, 1);
  assert.ok(
    close(floatsOf(after.embedding), [10 / norm, 1 / norm]),
    `profile was ${floatsOf(after.embedding)}`
  );
  assert.equal(after.total_speech_s, 10);
});

test("renaming a speaker the user linked to an attendee does not carry the attendee's email to the new name", async () => {
  const db = freshDatabase();
  const noteId = insertNote(db);
  db.saveNoteSpeakerEmbeddings(noteId, { speaker_0: [1, 0] }, { speaker_0: 20 });
  const h = handlersFor(db);
  const dana = await h._setSpeakerMapping(noteId, "speaker_0", "Dana", "dana@x.com", null);

  const eve = await h._setSpeakerMapping(noteId, "speaker_0", "Eve", null, null);

  assert.notEqual(eve.profileId, dana.profileId);
  assert.equal(profileRow(db, eve.profileId).email, null);
  const danaAfter = profileRow(db, dana.profileId);
  assert.ok(!danaAfter || danaAfter.display_name === "Dana", "the attendee's profile was renamed");
});

test("an email that no profile has creates a profile even when an email-less namesake exists", async () => {
  const db = freshDatabase();
  const earlier = insertNote(db);
  const namesake = db.upsertSpeakerProfile("Alex", null, vec([1, 0]), null, {
    durationS: 30,
    noteId: earlier,
    speakerId: "speaker_0",
  });
  const noteId = insertNote(db);
  db.saveNoteSpeakerEmbeddings(noteId, { speaker_0: [1, 0] }, { speaker_0: 20 });
  const result = await handlersFor(db)._setSpeakerMapping(
    noteId,
    "speaker_0",
    "Alex",
    ALEX_B.email,
    null
  );
  assert.notEqual(result.profileId, namesake.id);
  assert.equal(profileRow(db, namesake.id).email, null);
  assert.equal(samplesOf(db, namesake.id).length, 1);
});

test("renaming a speaker the app labelled, even without an email, never renames the attendee's profile", async () => {
  const db = freshDatabase();
  const note1 = oneOnOneNote(db, { displayName: "Priya" });
  await autoLabelOneOnOne(db, note1);
  const priyaId = mappingOf(db, note1).profile_id;
  assert.equal(mappingOf(db, note1).origin, "auto");

  const eve = await handlersFor(db)._setSpeakerMapping(note1, "speaker_0", "Eve", null, null);

  assert.notEqual(eve.profileId, priyaId, "the attendee's profile was renamed to Eve");
  const note2 = oneOnOneNote(db, { displayName: "Priya" });
  await autoLabelOneOnOne(db, note2);
  assert.notEqual(mappingOf(db, note2).profile_id, eve.profileId, "a 1:1 with Priya reached Eve");
  assert.equal(profileRow(db, eve.profileId).display_name, "Eve");
});
