const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { requireSqlite } = require("../support/sqlite.js");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-split-boundary-"));
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
const { detectCallBoundaries } = require("../../src/helpers/callBoundaries.js");
const { splitNoteAtBoundary } = require("../../src/helpers/splitNoteAtBoundary.js");

function createDb() {
  requireSqlite();
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-split-boundary-"));
  return new DatabaseManager();
}

// The real note 95: a 2h42m recording holding two back-to-back calls separated by
// one 105.4s silence, with complete speaker turnover and real farewell/opening text.
// `base`/`scale` switch the stored time base: relative seconds (the real data) or
// epoch milliseconds (the other base `deriveTimestamps` has to cope with).
const FILLER = [
  "the migration runs nightly",
  "and we watch the queue depth",
  "the backfill finished at four",
  "we capped the retries at three",
  "the index is still building",
  "staging looks identical now",
];

const FAREWELL_TAIL = {
  27: "so that is everything from my side",
  28: "I have to drop out, I'm going to have lunch",
  29: "Thank you. Good one.",
};

const OPENING_HEAD = {
  0: "You already three minutes late.",
  1: "that's perfectly fine. That's on time.",
  2: "Fill me in what's happening with life.",
};

const PARENT_ORIGIN_MS = 1790870467607;

// The real first stamp of note 95, so a slice offset of 0 would be visibly wrong.
const RELATIVE_FIRST_STAMP = 45.099;

const speakersFor = (names, ids) => (i) => ({
  speakerName: names[i % names.length],
  speaker: ids[i % ids.length],
});

function note95Shape({ base = RELATIVE_FIRST_STAMP, scale = 1 } = {}) {
  const stamp = (seconds) => base + seconds * scale;
  const beforeSpeaker = speakersFor(["Jorge", "Regina"], ["SPEAKER_00", "SPEAKER_01"]);
  const afterSpeaker = speakersFor(["Fabian", "Molly"], ["SPEAKER_02", "SPEAKER_03"]);
  const out = [];
  for (let i = 0; i < 30; i += 1) {
    out.push({
      id: `before-${i}`,
      source: "system",
      ...beforeSpeaker(i),
      text: FAREWELL_TAIL[i] ?? FILLER[i % FILLER.length],
      timestamp: stamp(i * 20),
    });
  }
  for (let i = 0; i < 30; i += 1) {
    out.push({
      id: `after-${i}`,
      source: "system",
      ...afterSpeaker(i),
      text: OPENING_HEAD[i] ?? FILLER[i % FILLER.length],
      timestamp: stamp(685.4 + i * 20),
    });
  }
  return out;
}

function seedWeldedNote(db, { base, scale, folderId, segments } = {}) {
  const transcriptSegments = segments ?? note95Shape({ base, scale });
  const saved = db.saveNote(
    "Team sync",
    "parent body",
    "meeting",
    "/tmp/openwhispr-test/welded.webm",
    9803.4,
    folderId ?? null
  );
  assert.equal(saved.success, true);
  const noteId = saved.note.id;
  const updated = db.updateNote(noteId, {
    transcript: JSON.stringify(transcriptSegments),
    transcript_origin_ms: PARENT_ORIGIN_MS,
    transcript_origin_source: "audio:system",
    mic_audio_path: "/tmp/openwhispr-test/mic.webm",
    system_audio_path: "/tmp/openwhispr-test/system.webm",
    calendar_event_id: "evt-welded-morning",
    meeting_type_id: 7,
  });
  assert.equal(updated.success, true);
  return { noteId, transcriptSegments };
}

function reportFor(transcriptSegments) {
  const report = detectCallBoundaries(transcriptSegments);
  assert.equal(report.refused, undefined);
  assert.equal(report.boundaries.length, 1);
  return report;
}

function splitSeeded(db, options = {}) {
  const { base, scale, folderId, onNoteCreated } = options;
  const { noteId, transcriptSegments } = seedWeldedNote(db, { base, scale, folderId });
  const report = reportFor(transcriptSegments);
  const created = [];
  const result = splitNoteAtBoundary({
    databaseManager: db,
    noteId,
    report,
    boundaryIndex: 0,
    onNoteCreated: onNoteCreated ?? ((note) => created.push(note)),
  });
  return { noteId, transcriptSegments, report, result, created };
}

const segmentsOf = (db, id) => JSON.parse(db.getNote(id).transcript);

test("every segment lands in exactly one of the two notes", () => {
  const db = createDb();
  const { noteId, transcriptSegments, result } = splitSeeded(db);

  assert.equal(result.success, true);

  const parentIds = segmentsOf(db, noteId).map((s) => s.id);
  const childIds = segmentsOf(db, result.childNoteId).map((s) => s.id);

  const union = [...parentIds, ...childIds];
  assert.equal(new Set(union).size, union.length, "a segment was duplicated across the two notes");
  assert.deepEqual(
    [...union].sort(),
    transcriptSegments.map((s) => s.id).sort(),
    "the two notes together are not exactly the original transcript"
  );
  assert.equal(parentIds.length, 30);
  assert.equal(childIds.length, 30);
  assert.deepEqual(childIds[0], "after-0");
});

test("the child's timestamps are the parent's, never rebased to zero", () => {
  const db = createDb();
  const { result } = splitSeeded(db);

  const child = segmentsOf(db, result.childNoteId);
  const expected = note95Shape()
    .slice(30)
    .map((s) => s.timestamp);
  assert.deepEqual(
    child.map((s) => s.timestamp),
    expected
  );
  assert.ok(child[0].timestamp > 700, `child starts at ${child[0].timestamp}, looks rebased`);
});

test("the child inherits the parent's transcript origin verbatim", () => {
  const db = createDb();
  const { noteId, result } = splitSeeded(db);

  const child = db.getNote(result.childNoteId);
  assert.equal(child.transcript_origin_ms, PARENT_ORIGIN_MS);
  assert.equal(child.transcript_origin_source, "audio:system");
  assert.equal(child.transcript_origin_ms, db.getNote(noteId).transcript_origin_ms);
});

test("the child's created_at is the parent's origin plus its first offset, in UTC", () => {
  const db = createDb();
  const { result } = splitSeeded(db);

  // 1790870467607 + round(730.499 * 1000) = 1790871198106 = 2026-10-01T16:13:18Z.
  assert.equal(db.getNote(result.childNoteId).created_at, "2026-10-01 16:13:18");
});

test("the shared audio paths are copied to the child", () => {
  const db = createDb();
  const { result } = splitSeeded(db);

  const child = db.getNote(result.childNoteId);
  assert.equal(child.mic_audio_path, "/tmp/openwhispr-test/mic.webm");
  assert.equal(child.system_audio_path, "/tmp/openwhispr-test/system.webm");
  assert.equal(child.source_file, "/tmp/openwhispr-test/welded.webm");
});

test("folder_id is copied, not replaced by the default meetings folder", () => {
  const db = createDb();
  const folder = db.createFolder("Morning calls");
  assert.equal(folder.success, true);
  const folderId = folder.folder.id;

  const { noteId, result } = splitSeeded(db, { folderId });

  assert.equal(db.getNote(noteId).folder_id, folderId);
  assert.equal(db.getNote(result.childNoteId).folder_id, folderId);
});

test("calendar_event_id is not copied to the child", () => {
  const db = createDb();
  const { noteId, result } = splitSeeded(db);

  assert.equal(db.getNote(noteId).calendar_event_id, "evt-welded-morning");
  assert.equal(db.getNote(result.childNoteId).calendar_event_id, null);
});

test("meeting_type_id is not copied, so the child is classified on its own text", () => {
  const db = createDb();
  const { result } = splitSeeded(db);

  assert.equal(db.getNote(result.childNoteId).meeting_type_id, null);
});

test("both pieces record their slice of the shared audio and their parent", () => {
  const db = createDb();
  const { noteId, result } = splitSeeded(db);

  const parent = db.getNote(noteId);
  const child = db.getNote(result.childNoteId);

  assert.equal(parent.split_parent_note_id, noteId);
  assert.equal(child.split_parent_note_id, noteId);

  assert.equal(parent.slice_start_s, 45.099);
  assert.equal(parent.slice_end_s, 625.099);
  assert.equal(child.slice_start_s, 730.499);
  assert.equal(child.slice_end_s, 1310.499);
});

test("speaker rows are copied to the child, filtered to the ids it retains", () => {
  const db = createDb();
  const { noteId, transcriptSegments } = seedWeldedNote(db, {});
  for (const id of ["SPEAKER_00", "SPEAKER_01", "SPEAKER_02", "SPEAKER_03"]) {
    db.setSpeakerMapping(noteId, id, null, `Name ${id}`, { origin: "manual" });
  }
  db.saveNoteSpeakerEmbeddings(noteId, {
    SPEAKER_00: Buffer.from([1, 2, 3]),
    SPEAKER_02: Buffer.from([4, 5, 6]),
    SPEAKER_03: Buffer.from([7, 8, 9]),
  });

  const result = splitNoteAtBoundary({
    databaseManager: db,
    noteId,
    report: reportFor(transcriptSegments),
    boundaryIndex: 0,
    onNoteCreated: () => {},
  });
  assert.equal(result.success, true);

  const mappings = db.getSpeakerMappings(result.childNoteId);
  assert.deepEqual(
    mappings.map((m) => m.speaker_id).sort(),
    ["SPEAKER_02", "SPEAKER_03"],
    "the child kept a mapping for a speaker it has no segments for"
  );
  assert.equal(mappings.find((m) => m.speaker_id === "SPEAKER_02").display_name, "Name SPEAKER_02");
  assert.equal(mappings.find((m) => m.speaker_id === "SPEAKER_02").origin, "manual");

  const embeddings = db.getNoteSpeakerEmbeddings(result.childNoteId);
  assert.deepEqual(embeddings.map((e) => e.speaker_id).sort(), ["SPEAKER_02", "SPEAKER_03"]);
  assert.deepEqual([...embeddings.find((e) => e.speaker_id === "SPEAKER_02").embedding], [4, 5, 6]);

  assert.equal(db.getSpeakerMappings(noteId).length, 4);
});

test("the injected side-effect callback is handed the stored child note", () => {
  const db = createDb();
  const { result, created } = splitSeeded(db);

  assert.equal(created.length, 1);
  assert.equal(created[0].id, result.childNoteId);
  assert.equal(created[0].transcript_origin_ms, PARENT_ORIGIN_MS);
  assert.equal(created[0].slice_start_s, 730.499);
  assert.ok(created[0].transcript, "the callback was handed a note with no transcript");
});

test("a caller that forgets the side-effect callback fails loudly", () => {
  const db = createDb();
  const { noteId, transcriptSegments } = seedWeldedNote(db, {});
  const report = reportFor(transcriptSegments);

  assert.throws(
    () => splitNoteAtBoundary({ databaseManager: db, noteId, report, boundaryIndex: 0 }),
    /onNoteCreated/
  );
  assert.equal(db.getNotes("meeting", 100).length, 1);
});

test("splitting twice at the same boundary is a no-op", () => {
  const db = createDb();
  const { noteId, report, result } = splitSeeded(db);
  assert.equal(result.success, true);

  const before = db.getNotes("meeting", 100).length;
  const again = splitNoteAtBoundary({
    databaseManager: db,
    noteId,
    report,
    boundaryIndex: 0,
    onNoteCreated: () => {
      throw new Error("a second split must not create a note");
    },
  });

  assert.equal(again.success, false);
  assert.equal(again.reason, "transcript-does-not-match-report");
  assert.equal(db.getNotes("meeting", 100).length, before);
  assert.equal(segmentsOf(db, noteId).length, 30);
});

test("an epoch-millisecond note splits into the same slice of audio seconds", () => {
  const db = createDb();
  const { noteId, result } = splitSeeded(db, { base: PARENT_ORIGIN_MS, scale: 1000 });

  assert.equal(result.success, true);
  const parent = db.getNote(noteId);
  const child = db.getNote(result.childNoteId);

  assert.equal(parent.slice_start_s, 0);
  assert.equal(parent.slice_end_s, 580);
  assert.equal(child.slice_start_s, 685.4);
  assert.equal(child.slice_end_s, 1265.4);

  assert.equal(child.transcript_origin_ms, PARENT_ORIGIN_MS);
  // 1790870467607 + 685400 = 1790871153007 = 2026-10-01T16:12:33Z.
  assert.equal(child.created_at, "2026-10-01 16:12:33");
  assert.equal(segmentsOf(db, result.childNoteId)[0].timestamp, PARENT_ORIGIN_MS + 685400);
});

test("the transcript index is reshredded for both notes, not left on the parent", () => {
  const db = createDb();
  const { noteId, result } = splitSeeded(db);

  const count = (id) =>
    db.db.prepare("SELECT COUNT(*) AS c FROM transcript_segments WHERE note_id = ?").get(id).c;
  assert.equal(count(noteId), 30);
  assert.equal(count(result.childNoteId), 30);
});

test("a refused report is refused by the splitter too", () => {
  const db = createDb();
  const { noteId } = seedWeldedNote(db, {});

  const result = splitNoteAtBoundary({
    databaseManager: db,
    noteId,
    report: {
      unit: "relative-seconds",
      pieces: [],
      boundaries: [],
      refused: "unassigned-segments",
    },
    boundaryIndex: 0,
    onNoteCreated: () => {
      throw new Error("a refused report must not create a note");
    },
  });

  assert.equal(result.success, false);
  assert.equal(result.reason, "report-refused");
  assert.equal(db.getNotes("meeting", 100).length, 1);
});

test("setNoteCreatedAt refuses a value that is not a UTC sqlite timestamp", () => {
  const db = createDb();
  const { noteId } = seedWeldedNote(db, {});
  const before = db.getNote(noteId).created_at;

  for (const bad of [
    "2026-10-01T16:13:18Z",
    "2026-10-01 16:13:18.500",
    "2026-13-45 99:99:99",
    "",
    null,
  ]) {
    assert.equal(db.setNoteCreatedAt(noteId, bad).success, false, `accepted ${String(bad)}`);
  }
  assert.equal(db.getNote(noteId).created_at, before);

  assert.equal(db.setNoteCreatedAt(noteId, "2026-10-01 16:13:18").success, true);
  assert.equal(db.getNote(noteId).created_at, "2026-10-01 16:13:18");
});

test("updateNote refuses a slice bound or parent id whose value cannot be real", () => {
  const db = createDb();
  const { noteId } = seedWeldedNote(db, {});

  assert.equal(db.updateNote(noteId, { slice_start_s: Number.NaN }).success, false);
  assert.equal(db.updateNote(noteId, { slice_end_s: -1 }).success, false);
  assert.equal(db.updateNote(noteId, { split_parent_note_id: 0 }).success, false);
  assert.equal(db.updateNote(noteId, { call_split_dismissed: 2 }).success, false);

  const row = db.getNote(noteId);
  assert.equal(row.slice_start_s, null);
  assert.equal(row.split_parent_note_id, null);
  assert.equal(row.call_split_dismissed, null);

  assert.equal(db.updateNote(noteId, { call_split_dismissed: 1 }).success, true);
  assert.equal(db.getNote(noteId).call_split_dismissed, 1);
});
