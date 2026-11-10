const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { requireSqlite } = require("../support/sqlite.js");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-one-on-one-"));
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
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-one-on-one-"));
  return new DatabaseManager();
}

const profileCount = (db) => db.db.prepare("SELECT COUNT(*) AS n FROM speaker_profiles").get().n;

// A 1:1 with Priya whose system track diarized into the given clusters, each
// with its speech seconds and a voiceprint.
function oneOnOneNote(db, speechBySpeaker) {
  const speakers = Object.keys(speechBySpeaker);
  const transcript = speakers.map((speaker, i) => ({
    id: `s${i}`,
    text: `words ${i}`,
    source: "system",
    timestamp: i,
    speaker,
  }));
  transcript.push({ id: "m", text: "mine", source: "mic", timestamp: 9, speaker: "you" });
  const info = db.db
    .prepare("INSERT INTO notes (title, transcript, participants) VALUES (?, ?, ?)")
    .run("1:1", JSON.stringify(transcript), JSON.stringify([{ displayName: "Priya" }]));
  const noteId = Number(info.lastInsertRowid);
  const embeddings = Object.fromEntries(speakers.map((s, i) => [s, [1, i * 0.1]]));
  db.saveNoteSpeakerEmbeddings(noteId, embeddings, speechBySpeaker);
  return noteId;
}

async function autoLabel(db, noteId) {
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

const namedSpeakers = (db, noteId) =>
  JSON.parse(db.getNote(noteId).transcript)
    .filter((s) => s.source === "system" && s.speakerName)
    .map((s) => s.speaker);

test("two remote clusters of similar size: nobody is labelled", async () => {
  const db = freshDatabase();
  const noteId = oneOnOneNote(db, { speaker_0: 30, speaker_1: 25 });

  await autoLabel(db, noteId);

  assert.deepEqual(db.getSpeakerMappings(noteId), []);
  assert.equal(profileCount(db), 0);
  assert.deepEqual(namedSpeakers(db, noteId), []);
});

test("one dominant cluster and a fragment: only the dominant one is labelled", async () => {
  const db = freshDatabase();
  const noteId = oneOnOneNote(db, { speaker_0: 5, speaker_1: 60 });

  await autoLabel(db, noteId);

  const mappings = db.getSpeakerMappings(noteId);
  assert.deepEqual(
    mappings.map((m) => [m.speaker_id, m.display_name, m.origin]),
    [["speaker_1", "Priya", "auto"]]
  );
  assert.deepEqual(namedSpeakers(db, noteId), ["speaker_1"]);
  const samples = db.db.prepare("SELECT speaker_id FROM speaker_profile_samples").all();
  assert.deepEqual(
    samples.map((s) => s.speaker_id),
    ["speaker_1"],
    "the fragment was blended into the profile"
  );
});

test("a cluster holding exactly 80% of remote speech is dominant", async () => {
  const db = freshDatabase();
  const noteId = oneOnOneNote(db, { speaker_0: 60, speaker_1: 15 });

  await autoLabel(db, noteId);

  assert.deepEqual(
    db.getSpeakerMappings(noteId).map((m) => m.speaker_id),
    ["speaker_0"]
  );
});

test("a cluster just under 80% of remote speech is not labelled", async () => {
  const db = freshDatabase();
  const noteId = oneOnOneNote(db, { speaker_0: 59, speaker_1: 15 });

  await autoLabel(db, noteId);

  assert.deepEqual(db.getSpeakerMappings(noteId), []);
});

test("a dominant cluster with too little speech is not labelled", async () => {
  const db = freshDatabase();
  const noteId = oneOnOneNote(db, { speaker_0: 5.5 });

  await autoLabel(db, noteId);

  assert.deepEqual(db.getSpeakerMappings(noteId), []);
  assert.equal(profileCount(db), 0);
});

test("a cluster with exactly the minimum speech can be labelled", async () => {
  const db = freshDatabase();
  const noteId = oneOnOneNote(db, { speaker_0: 6 });

  await autoLabel(db, noteId);

  assert.deepEqual(
    db.getSpeakerMappings(noteId).map((m) => m.speaker_id),
    ["speaker_0"]
  );
});

test("speech of an already-mapped remote cluster counts against the share", async () => {
  const db = freshDatabase();
  const noteId = oneOnOneNote(db, { speaker_0: 50, speaker_1: 20 });
  db.setSpeakerMapping(noteId, "speaker_0", null, "Dana", { origin: "manual" });

  await autoLabel(db, noteId);

  assert.deepEqual(
    db.getSpeakerMappings(noteId).map((m) => [m.speaker_id, m.display_name]),
    [["speaker_0", "Dana"]]
  );
});
