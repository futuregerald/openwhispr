const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { requireSqlite } = require("../support/sqlite.js");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-recording-marks-"));
const registered = new Map();

const fakeElectron = {
  ipcMain: {
    handle: (channel, fn) => registered.set(channel, fn),
    on: () => {},
    removeHandler: () => {},
  },
  app: {
    getPath: () => userDataDir,
    getAppPath: () => process.cwd(),
    getVersion: () => "0.0.0",
    isPackaged: false,
    isReady: () => false,
    on: () => {},
    whenReady: () => Promise.resolve(),
  },
  BrowserWindow: class {
    static getAllWindows() {
      return [];
    }
  },
  shell: {},
  dialog: {},
  clipboard: {},
  net: { fetch: () => Promise.reject(new Error("no network in tests")) },
  safeStorage: { isEncryptionAvailable: () => false },
  systemPreferences: { getMediaAccessStatus: () => "granted" },
  nativeTheme: {},
  screen: {},
  session: {},
  desktopCapturer: {},
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") return fakeElectron;
  return originalLoad.call(this, request, parent, isMain);
};

process.env.NODE_ENV = "test";

const IPCHandlers = require(path.join(__dirname, "../../src/helpers/ipcHandlers.js"));
const DatabaseManager = require(path.join(__dirname, "../../src/helpers/database.js"));
const { markZeroForNote } = require(path.join(__dirname, "../../src/helpers/recordingMarks.js"));
const { MAX_CALL_SPLITS } = require(path.join(__dirname, "../../src/helpers/noteCallSplit.js"));

function setup() {
  requireSqlite();
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-recording-marks-"));
  registered.clear();
  const handlers = Object.create(IPCHandlers.prototype);
  const databaseManager = new DatabaseManager();
  Object.assign(handlers, {
    databaseManager,
    broadcastToWindows: () => {},
    _noteFilesEnabled: false,
    _asyncVectorUpsert: () => {},
    _asyncMirrorWrite: () => {},
  });
  handlers.setupHandlers();
  return { handlers, databaseManager };
}

const newNote = (databaseManager) =>
  databaseManager.saveNote("Weekly sync", "", "meeting", null, null, null).note.id;

const T0 = 1_790_000_000_000;
const NO_ZEROS = { system: null, mic: null, firstLine: null };

test("a new note has no marks", () => {
  const { databaseManager } = setup();
  const noteId = newNote(databaseManager);
  assert.equal(databaseManager.getNote(noteId).recording_marks, null);
  assert.deepEqual(databaseManager.getRecordingMarks(noteId), { at: [], zeros: NO_ZEROS });
});

test("marks are appended and kept sorted, as epoch milliseconds", () => {
  const { databaseManager } = setup();
  const noteId = newNote(databaseManager);

  assert.deepEqual(databaseManager.addRecordingMark(noteId, T0 + 120_000), {
    success: true,
    marks: [T0 + 120_000],
  });
  assert.deepEqual(databaseManager.addRecordingMark(noteId, T0 + 400_500), {
    success: true,
    marks: [T0 + 120_000, T0 + 400_500],
  });
  assert.deepEqual(databaseManager.addRecordingMark(noteId, T0 + 250_000), {
    success: true,
    marks: [T0 + 120_000, T0 + 250_000, T0 + 400_500],
  });
  assert.deepEqual(databaseManager.getRecordingMarks(noteId).at, [
    T0 + 120_000,
    T0 + 250_000,
    T0 + 400_500,
  ]);
});

test("a mark within ten seconds of another is refused as too-soon", () => {
  const { databaseManager } = setup();
  const noteId = newNote(databaseManager);
  databaseManager.addRecordingMark(noteId, T0);

  for (const offsetMs of [0, 5_000, -4_500, 9_900]) {
    assert.deepEqual(databaseManager.addRecordingMark(noteId, T0 + offsetMs), {
      success: false,
      reason: "too-soon",
      marks: [T0],
    });
  }
  assert.equal(databaseManager.addRecordingMark(noteId, T0 + 10_000).success, true);
});

test("the ninth mark is refused as limit-reached", () => {
  const { databaseManager } = setup();
  const noteId = newNote(databaseManager);
  for (let i = 0; i < MAX_CALL_SPLITS; i += 1) {
    assert.equal(databaseManager.addRecordingMark(noteId, T0 + i * 30_000).success, true);
  }
  const refused = databaseManager.addRecordingMark(noteId, T0 + 1_000_000);
  assert.equal(refused.success, false);
  assert.equal(refused.reason, "limit-reached");
  assert.equal(databaseManager.getRecordingMarks(noteId).at.length, MAX_CALL_SPLITS);
});

test("a time that is not a finite positive number is refused", () => {
  const { databaseManager } = setup();
  const noteId = newNote(databaseManager);
  for (const at of [-1, 0, NaN, Infinity, "12", null, undefined]) {
    const result = databaseManager.addRecordingMark(noteId, at);
    assert.equal(result.success, false);
    assert.equal(result.reason, "invalid-time");
  }
  assert.deepEqual(databaseManager.getRecordingMarks(noteId).at, []);
});

test("a mark on a note that does not exist is refused", () => {
  const { databaseManager } = setup();
  const result = databaseManager.addRecordingMark(9999, T0);
  assert.equal(result.success, false);
  assert.equal(result.reason, "note-not-found");
});

test("zeros are stored beside the marks and survive a later mark", () => {
  const { databaseManager } = setup();
  const noteId = newNote(databaseManager);
  databaseManager.addRecordingMark(noteId, T0 + 60_000);

  const zeros = { system: T0 - 5_000, mic: T0 - 4_000, firstLine: T0 + 2_000 };
  assert.deepEqual(databaseManager.setRecordingMarkZeros(noteId, zeros), { success: true });
  databaseManager.addRecordingMark(noteId, T0 + 200_000);

  assert.deepEqual(databaseManager.getRecordingMarks(noteId), {
    at: [T0 + 60_000, T0 + 200_000],
    zeros,
  });
});

test("zeros that are not finite numbers are stored as null", () => {
  const { databaseManager } = setup();
  const noteId = newNote(databaseManager);
  databaseManager.addRecordingMark(noteId, T0);
  databaseManager.setRecordingMarkZeros(noteId, { system: "x", mic: NaN, firstLine: T0 + 1 });
  assert.deepEqual(databaseManager.getRecordingMarks(noteId).zeros, {
    system: null,
    mic: null,
    firstLine: T0 + 1,
  });
});

test("zeros are not stored for a note that has no marks", () => {
  const { databaseManager } = setup();
  const noteId = newNote(databaseManager);
  assert.deepEqual(databaseManager.setRecordingMarkZeros(noteId, { system: T0 }), {
    success: false,
    reason: "no-marks",
  });
  assert.equal(databaseManager.getNote(noteId).recording_marks, null);
});

test("clearing removes every mark and zero and leaves updated_at alone", () => {
  const { databaseManager } = setup();
  const noteId = newNote(databaseManager);
  databaseManager.addRecordingMark(noteId, T0);
  databaseManager.setRecordingMarkZeros(noteId, { system: T0 });
  const updatedAtBefore = databaseManager.getNote(noteId).updated_at;

  assert.deepEqual(databaseManager.clearRecordingMarks(noteId), { success: true });
  assert.equal(databaseManager.getNote(noteId).recording_marks, null);
  assert.deepEqual(databaseManager.getRecordingMarks(noteId), { at: [], zeros: NO_ZEROS });
  assert.equal(databaseManager.getNote(noteId).updated_at, updatedAtBefore);
});

test("marks cannot be written through updateNote", () => {
  const { databaseManager } = setup();
  const noteId = newNote(databaseManager);
  const result = databaseManager.updateNote(noteId, { recording_marks: "[1,2,3]" });
  assert.equal(result.success, false);
  assert.equal(databaseManager.getNote(noteId).recording_marks, null);
});

test("a garbled marks column reads as no marks and is replaced by the next mark", () => {
  const { databaseManager } = setup();
  const noteId = newNote(databaseManager);
  databaseManager.db
    .prepare("UPDATE notes SET recording_marks = ? WHERE id = ?")
    .run("nope", noteId);

  assert.deepEqual(databaseManager.getRecordingMarks(noteId), { at: [], zeros: NO_ZEROS });
  assert.deepEqual(databaseManager.addRecordingMark(noteId, T0), { success: true, marks: [T0] });
});

test("a marks column that holds other shapes reads as the numbers it holds", () => {
  const { databaseManager } = setup();
  const noteId = newNote(databaseManager);
  const store = (raw) =>
    databaseManager.db
      .prepare("UPDATE notes SET recording_marks = ? WHERE id = ?")
      .run(raw, noteId);

  store("[30,45]");
  assert.deepEqual(databaseManager.getRecordingMarks(noteId).at, []);
  store(JSON.stringify({ at: [T0, "x", null, T0 + 20_000], zeros: { system: "y" } }));
  assert.deepEqual(databaseManager.getRecordingMarks(noteId), {
    at: [T0, T0 + 20_000],
    zeros: NO_ZEROS,
  });
});

test("a split child never inherits the parent's marks", async () => {
  const { splitNoteAtBoundary } = require("../../src/helpers/splitNoteAtBoundary.js");
  const { cutReportAt } = await import("../../src/helpers/lineCut.js");
  const { databaseManager } = setup();
  const noteId = newNote(databaseManager);
  const segments = Array.from({ length: 6 }, (_, i) => ({
    id: `l${i}`,
    text: `invented ${i}`,
    source: "system",
    speaker: "speaker_0",
    timestamp: i * 30,
  }));
  databaseManager.updateNote(noteId, { transcript: JSON.stringify(segments) });
  databaseManager.addRecordingMark(noteId, T0 + 75_000);

  const result = splitNoteAtBoundary({
    databaseManager,
    noteId,
    report: cutReportAt(segments, [3]),
    boundaryIndex: 0,
    onNoteCreated: () => {},
  });

  assert.equal(result.success, true);
  assert.equal(databaseManager.getNote(result.childNoteId).recording_marks, null);
});

const line = (source, timestamp = 0) => ({
  id: `${source}-${timestamp}`,
  text: "x",
  source,
  timestamp,
});
const noteWith = (overrides) => ({
  transcript: JSON.stringify([line("system")]),
  transcript_origin_ms: null,
  transcript_origin_source: null,
  ...overrides,
});
const ZEROS = { system: T0, mic: T0 + 3_000, firstLine: T0 + 9_000 };

test("a retranscribed system note is measured from the system file's start", () => {
  const note = noteWith({ transcript_origin_source: "unanchored" });
  assert.equal(markZeroForNote(note, ZEROS), ZEROS.system);
});

test("a retranscribed mic-only note is measured from the mic file's start", () => {
  const note = noteWith({
    transcript: JSON.stringify([line("mic"), line("mic", 5)]),
    transcript_origin_source: "unanchored",
  });
  assert.equal(markZeroForNote(note, ZEROS), ZEROS.mic);
});

test("a live note with a clock is measured from its clock, not from any file start", () => {
  const note = noteWith({
    transcript_origin_ms: T0 + 1_234,
    transcript_origin_source: "audio:system",
  });
  assert.equal(markZeroForNote(note, ZEROS), T0 + 1_234);
});

test("a live note with no clock is measured from its first line", () => {
  const note = noteWith({ transcript: JSON.stringify([line("mic"), line("mic", 5)]) });
  assert.equal(markZeroForNote(note, ZEROS), ZEROS.firstLine);
});

test("a zero that was never recorded gives no zero", () => {
  const retranscribedMic = noteWith({
    transcript: JSON.stringify([line("mic")]),
    transcript_origin_source: "unanchored",
  });
  assert.equal(markZeroForNote(retranscribedMic, { ...ZEROS, mic: null }), null);
  assert.equal(markZeroForNote(noteWith({}), { ...ZEROS, firstLine: null }), null);
  assert.equal(markZeroForNote(noteWith({ transcript: "plain words" }), ZEROS), null);
});

test("a marker is stored as the instant it was pressed", () => {
  const { handlers, databaseManager } = setup();
  const noteId = newNote(databaseManager);

  const result = handlers._addRecordingMarker({ noteId, now: T0 + 95_500 });

  assert.deepEqual(result, { success: true, marks: [T0 + 95_500] });
  assert.deepEqual(databaseManager.getRecordingMarks(noteId).at, [T0 + 95_500]);
});

test("a marker needs no audio to have arrived yet", () => {
  const { handlers, databaseManager } = setup();
  const noteId = newNote(databaseManager);
  assert.equal(handlers._addRecordingMarker({ noteId, now: T0 }).success, true);
});

test("a marker for no note is refused as no-recording", () => {
  const { handlers } = setup();
  const result = handlers._addRecordingMarker({ noteId: null, now: T0 });
  assert.equal(result.success, false);
  assert.equal(result.reason, "no-recording");
});

test("the zeros are stored when the recording stops, from what main measured", () => {
  const { handlers, databaseManager } = setup();
  const noteId = newNote(databaseManager);
  handlers._addRecordingMarker({ noteId, now: T0 + 60_000 });

  handlers._recordMarkZeros({
    noteId,
    systemStartedAt: T0 - 2_000,
    micStartedAt: T0 - 1_000,
    firstLineTimestamp: T0 + 4_000,
  });

  assert.deepEqual(databaseManager.getRecordingMarks(noteId).zeros, {
    system: T0 - 2_000,
    mic: T0 - 1_000,
    firstLine: T0 + 4_000,
  });
});

test("a first line stamped in seconds is no zero and is stored as null", () => {
  const { handlers, databaseManager } = setup();
  const noteId = newNote(databaseManager);
  handlers._addRecordingMarker({ noteId, now: T0 });
  handlers._recordMarkZeros({
    noteId,
    systemStartedAt: null,
    micStartedAt: T0,
    firstLineTimestamp: 12,
  });
  assert.equal(databaseManager.getRecordingMarks(noteId).zeros.firstLine, null);
});

test("stopping a recording with no marks stores nothing", () => {
  const { handlers, databaseManager } = setup();
  const noteId = newNote(databaseManager);
  handlers._recordMarkZeros({
    noteId,
    systemStartedAt: T0,
    micStartedAt: T0,
    firstLineTimestamp: T0,
  });
  assert.equal(databaseManager.getNote(noteId).recording_marks, null);
  handlers._recordMarkZeros({ noteId: null, systemStartedAt: T0 });
});

test("a database error while storing the zeros never stops the recording from stopping", () => {
  const { handlers, databaseManager } = setup();
  const noteId = newNote(databaseManager);
  handlers._addRecordingMarker({ noteId, now: T0 });
  databaseManager.setRecordingMarkZeros = () => {
    throw new Error("disk full");
  };
  assert.doesNotThrow(() =>
    handlers._recordMarkZeros({
      noteId,
      systemStartedAt: T0,
      micStartedAt: T0,
      firstLineTimestamp: T0,
    })
  );
});

test("the meeting-add-marker channel refuses when no meeting is recording", async () => {
  setup();
  const handler = registered.get("meeting-add-marker");
  assert.ok(handler, "meeting-add-marker must be registered");
  const result = await handler({});
  assert.equal(result.success, false);
  assert.equal(result.reason, "no-recording");
});
