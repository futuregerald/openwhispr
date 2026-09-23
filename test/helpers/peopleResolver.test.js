const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { requireSqlite } = require("../support/sqlite.js");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-people-"));
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
const peopleResolver = require("../../src/helpers/peopleResolver.js");

function createDb() {
  requireSqlite();
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-people-"));
  return new DatabaseManager();
}

function addContact(dbm, email, displayName) {
  dbm.db
    .prepare("INSERT OR REPLACE INTO contacts (email, display_name) VALUES (?, ?)")
    .run(email, displayName);
}

function addProfile(dbm, displayName, email = null) {
  return dbm.db
    .prepare(
      "INSERT INTO speaker_profiles (display_name, email, embedding, sample_count) VALUES (?, ?, ?, ?)"
    )
    .run(displayName, email, Buffer.from([1, 2, 3]), 4).lastInsertRowid;
}

function spokenNote(dbm, segments, title = "Meeting") {
  const { note } = dbm.saveNote(title, "", "meeting");
  dbm.db
    .prepare("UPDATE notes SET transcript = ? WHERE id = ?")
    .run(JSON.stringify(segments), note.id);
  reshredNote(dbm.db, note.id);
  return note.id;
}

test("an email query matches exactly and nothing else runs", () => {
  const dbm = createDb();
  addContact(dbm, "jorge@example.com", "Jorge Chayan");
  addContact(dbm, "molly@example.com", "Molly Finn");

  const result = peopleResolver.resolve(dbm.db, "JORGE@Example.com");

  assert.equal(result.person.display_name, "Jorge Chayan");
  assert.equal(result.ambiguous, false);
  assert.ok(result.person.emails.includes("jorge@example.com"));
});

test("a full name matches at the highest tier and is unambiguous", () => {
  const dbm = createDb();
  addContact(dbm, "jorge@example.com", "Jorge Chayan");
  addContact(dbm, "molly@example.com", "Molly Finn");

  const result = peopleResolver.resolve(dbm.db, "jorge chayan");

  assert.equal(result.person.display_name, "Jorge Chayan");
  assert.equal(result.ambiguous, false);
  assert.equal(result.person.match_reason, "full name");
});

test("a prefix query resolves in token order", () => {
  const dbm = createDb();
  addContact(dbm, "jorge@example.com", "Jorge Chayan");

  const result = peopleResolver.resolve(dbm.db, "jorge c");

  assert.equal(result.person.display_name, "Jorge Chayan");
});

test("a bare first name shared by several people is flagged ambiguous", () => {
  const dbm = createDb();
  addContact(dbm, "jorge.chayan@example.com", "Jorge Chayan");
  addContact(dbm, "jorge.ortiz@example.com", "Jorge Ortiz");

  const result = peopleResolver.resolve(dbm.db, "jorge");

  assert.equal(result.ambiguous, true);
  assert.ok(result.candidates.length >= 2);
  assert.match(result.reason, /first name/i);
});

test("two people sharing a name but not an email stay separate identities", () => {
  const dbm = createDb();
  addContact(dbm, "jorge.a@example.com", "Jorge Chayan");
  addContact(dbm, "jorge.b@example.com", "Jorge Chayan");

  const result = peopleResolver.resolve(dbm.db, "jorge chayan");

  assert.equal(result.candidates.length, 2, "names alone must never merge two identities");
  assert.equal(result.ambiguous, true);
});

test("a mapping, its profile and a matching contact merge into one identity", () => {
  const dbm = createDb();
  addContact(dbm, "jorge@example.com", "Jorge Chayan");
  const profileId = addProfile(dbm, "Jorge", "jorge@example.com");
  const noteId = spokenNote(dbm, [
    { text: "I think we should ship it", timestamp: 0, speaker: "speaker_1" },
  ]);
  dbm.setSpeakerMapping(noteId, "speaker_1", profileId, "Jorge Chayan");
  reshredNote(dbm.db, noteId);

  const result = peopleResolver.resolve(dbm.db, "jorge chayan");

  assert.equal(result.candidates.length, 1, "profile_id and email links collapse the three sources");
  assert.deepEqual(result.person.sources.sort(), ["contacts", "speaker_profiles", "transcripts"]);
  assert.equal(result.person.spoken_segments, 1);
});

test("a diacritic-insensitive query still matches", () => {
  const dbm = createDb();
  addContact(dbm, "jose@example.com", "José Álvarez");

  const result = peopleResolver.resolve(dbm.db, "jose alvarez");

  assert.equal(result.person.display_name, "José Álvarez");
});

test("segments with no resolved speaker produce no person at all", () => {
  const dbm = createDb();
  spokenNote(dbm, [
    { text: "unattributed one", timestamp: 0, speaker: "speaker_4", speakerIsPlaceholder: true },
    { text: "unattributed two", timestamp: 3, speaker: "speaker_5", speakerIsPlaceholder: true },
    { text: "attributed", timestamp: 6, speaker: "speaker_0", speakerName: "Jorge Chayan" },
  ]);

  const people = peopleResolver.list(dbm.db, { limit: 50 });

  assert.deepEqual(
    people.map((person) => [person.display_name, person.spoken_segments]),
    [["Jorge Chayan", 1]],
    "an unnamed cluster must not become a nameless person carrying two segments"
  );
  for (const person of people) {
    assert.ok(person.display_name.trim().length > 0, "no identity may have a blank name");
  }

  assert.equal(peopleResolver.resolve(dbm.db, "speaker 5").person, null);
});

test("evidence weight puts the person who actually speaks ahead of a bare contact row", () => {
  const dbm = createDb();
  addContact(dbm, "quiet.jordan@example.com", "Jordan Blake");
  const loud = spokenNote(
    dbm,
    Array.from({ length: 30 }, (_, i) => ({
      text: `point number ${i}`,
      timestamp: i,
      speaker: "speaker_0",
      speakerName: "Jordan Blakely",
    }))
  );
  assert.ok(loud);

  const result = peopleResolver.resolve(dbm.db, "jordan");

  assert.equal(result.person.display_name, "Jordan Blakely");
  assert.equal(result.person.spoken_segments, 30);
});

test("activity returns spoken quotes, mentions and attendance for a resolved person", () => {
  const dbm = createDb();
  addContact(dbm, "jorge@example.com", "Jorge Chayan");
  const spokeIn = spokenNote(
    dbm,
    [{ text: "the migration lands on Friday", timestamp: 0, speaker: "speaker_0", speakerName: "Jorge Chayan" }],
    "Platform sync"
  );

  const { note: mentioning } = dbm.saveNote("Retro", "Jorge Chayan raised the rollback risk", "personal");
  const { note: attended } = dbm.saveNote("Roadmap", "", "meeting");
  dbm.updateNote(attended.id, {
    participants: JSON.stringify([{ email: "jorge@example.com", displayName: "Jorge Chayan" }]),
  });

  const resolved = peopleResolver.resolve(dbm.db, "jorge chayan");
  const activity = peopleResolver.activity(dbm.db, { personId: resolved.person.person_id });

  assert.equal(activity.spoken.length, 1);
  assert.equal(activity.spoken[0].note_id, spokeIn);
  assert.match(activity.spoken[0].text, /migration lands/);
  assert.ok(activity.mentioned.some((row) => row.note_id === mentioning.id));
  assert.ok(activity.attended.some((row) => row.note_id === attended.id));
});

test("activity can be narrowed to one kind", () => {
  const dbm = createDb();
  addContact(dbm, "jorge@example.com", "Jorge Chayan");
  spokenNote(dbm, [
    { text: "only spoken here", timestamp: 0, speaker: "speaker_0", speakerName: "Jorge Chayan" },
  ]);
  dbm.saveNote("Retro", "Jorge Chayan was mentioned", "personal");

  const resolved = peopleResolver.resolve(dbm.db, "jorge chayan");
  const activity = peopleResolver.activity(dbm.db, {
    personId: resolved.person.person_id,
    kinds: ["spoken"],
  });

  assert.equal(activity.spoken.length, 1);
  assert.deepEqual(activity.mentioned, []);
  assert.deepEqual(activity.attended, []);
});

test("list ranks people by mention volume and carries no body text", () => {
  const dbm = createDb();
  addContact(dbm, "quiet@example.com", "Quiet Person");
  spokenNote(
    dbm,
    Array.from({ length: 5 }, (_, i) => ({
      text: `line ${i}`,
      timestamp: i,
      speaker: "speaker_0",
      speakerName: "Talkative Person",
    }))
  );

  const people = peopleResolver.list(dbm.db, { sort: "mentions", limit: 10 });

  assert.equal(people[0].display_name, "Talkative Person");
  for (const person of people) {
    assert.ok(!("text" in person));
    assert.ok(!("preview" in person));
  }
});

test("activity for a person with no evidence returns empty lists rather than throwing", () => {
  const dbm = createDb();
  addContact(dbm, "ghost@example.com", "Ghost Person");

  const resolved = peopleResolver.resolve(dbm.db, "ghost person");
  const activity = peopleResolver.activity(dbm.db, { personId: resolved.person.person_id });

  assert.deepEqual(activity.spoken, []);
  assert.deepEqual(activity.attended, []);
});
