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
const { markZeroMs } = require(path.join(__dirname, "../../src/helpers/recordingMarks.js"));
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

test("a new note has no marks", () => {
  const { databaseManager } = setup();
  const noteId = newNote(databaseManager);
  assert.equal(databaseManager.getNote(noteId).recording_marks, null);
  assert.deepEqual(databaseManager.getRecordingMarks(noteId), []);
});

test("marks are appended and kept sorted, as seconds", () => {
  const { databaseManager } = setup();
  const noteId = newNote(databaseManager);

  assert.deepEqual(databaseManager.addRecordingMark(noteId, 120), { success: true, marks: [120] });
  assert.deepEqual(databaseManager.addRecordingMark(noteId, 400.5), {
    success: true,
    marks: [120, 400.5],
  });
  assert.deepEqual(databaseManager.addRecordingMark(noteId, 250), {
    success: true,
    marks: [120, 250, 400.5],
  });
  assert.deepEqual(databaseManager.getRecordingMarks(noteId), [120, 250, 400.5]);
});

test("a mark within ten seconds of another is refused as too-soon", () => {
  const { databaseManager } = setup();
  const noteId = newNote(databaseManager);
  databaseManager.addRecordingMark(noteId, 100);

  for (const offset of [100, 105, 95.5, 109.9]) {
    assert.deepEqual(databaseManager.addRecordingMark(noteId, offset), {
      success: false,
      reason: "too-soon",
      marks: [100],
    });
  }
  assert.equal(databaseManager.addRecordingMark(noteId, 110).success, true);
});

test("the ninth mark is refused as limit-reached", () => {
  const { databaseManager } = setup();
  const noteId = newNote(databaseManager);
  for (let i = 0; i < MAX_CALL_SPLITS; i += 1) {
    assert.equal(databaseManager.addRecordingMark(noteId, 20 + i * 30).success, true);
  }
  const refused = databaseManager.addRecordingMark(noteId, 1000);
  assert.equal(refused.success, false);
  assert.equal(refused.reason, "limit-reached");
  assert.equal(databaseManager.getRecordingMarks(noteId).length, MAX_CALL_SPLITS);
});

test("an offset that is not a finite non-negative number is refused", () => {
  const { databaseManager } = setup();
  const noteId = newNote(databaseManager);
  for (const offset of [-1, NaN, Infinity, "12", null, undefined]) {
    const result = databaseManager.addRecordingMark(noteId, offset);
    assert.equal(result.success, false);
    assert.equal(result.reason, "invalid-offset");
  }
  assert.deepEqual(databaseManager.getRecordingMarks(noteId), []);
});

test("a mark on a note that does not exist is refused", () => {
  const { databaseManager } = setup();
  const result = databaseManager.addRecordingMark(9999, 30);
  assert.equal(result.success, false);
  assert.equal(result.reason, "note-not-found");
});

test("clearing removes every mark and leaves updated_at alone", () => {
  const { databaseManager } = setup();
  const noteId = newNote(databaseManager);
  databaseManager.addRecordingMark(noteId, 60);
  databaseManager.addRecordingMark(noteId, 200);
  const updatedAtBefore = databaseManager.getNote(noteId).updated_at;

  assert.deepEqual(databaseManager.clearRecordingMarks(noteId), { success: true });
  assert.equal(databaseManager.getNote(noteId).recording_marks, null);
  assert.deepEqual(databaseManager.getRecordingMarks(noteId), []);
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

  assert.deepEqual(databaseManager.getRecordingMarks(noteId), []);
  assert.deepEqual(databaseManager.addRecordingMark(noteId, 40), { success: true, marks: [40] });
});

test("a marks column that is not a list of numbers reads as the numbers it holds", () => {
  const { databaseManager } = setup();
  const noteId = newNote(databaseManager);
  const store = (raw) =>
    databaseManager.db
      .prepare("UPDATE notes SET recording_marks = ? WHERE id = ?")
      .run(raw, noteId);

  store('{"0":30}');
  assert.deepEqual(databaseManager.getRecordingMarks(noteId), []);
  store('[30,"x",null,45]');
  assert.deepEqual(databaseManager.getRecordingMarks(noteId), [30, 45]);
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
  databaseManager.addRecordingMark(noteId, 75);

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

test("the zero is the first system chunk when there is one", () => {
  assert.equal(markZeroMs({ systemStartedAt: 5000, firstLocalLineTimestamp: 9000 }), 5000);
});

test("with no system audio the zero is the first local line's timestamp", () => {
  assert.equal(markZeroMs({ systemStartedAt: null, firstLocalLineTimestamp: 9000 }), 9000);
  assert.equal(markZeroMs({ firstLocalLineTimestamp: 9000 }), 9000);
});

test("with neither there is no zero", () => {
  assert.equal(markZeroMs({ systemStartedAt: null, firstLocalLineTimestamp: null }), null);
  assert.equal(markZeroMs({}), null);
  assert.equal(markZeroMs({ systemStartedAt: NaN, firstLocalLineTimestamp: undefined }), null);
});

test("a marker is stored as seconds since the system zero", () => {
  const { handlers, databaseManager } = setup();
  const noteId = newNote(databaseManager);

  const result = handlers._addRecordingMarker({
    noteId,
    systemStartedAt: 1_000_000,
    firstLocalLineTimestamp: 1_002_000,
    now: 1_000_000 + 95_500,
  });

  assert.deepEqual(result, { success: true, marks: [95.5] });
  assert.deepEqual(databaseManager.getRecordingMarks(noteId), [95.5]);
});

test("a mic-only marker is measured from the first local line", () => {
  const { handlers, databaseManager } = setup();
  const noteId = newNote(databaseManager);

  const result = handlers._addRecordingMarker({
    noteId,
    systemStartedAt: null,
    firstLocalLineTimestamp: 2_000_000,
    now: 2_000_000 + 61_000,
  });

  assert.deepEqual(result, { success: true, marks: [61] });
});

test("a marker with neither a system chunk nor a local line yet is refused", () => {
  const { handlers, databaseManager } = setup();
  const noteId = newNote(databaseManager);

  const result = handlers._addRecordingMarker({
    noteId,
    systemStartedAt: null,
    firstLocalLineTimestamp: null,
    now: Date.now(),
  });

  assert.equal(result.success, false);
  assert.equal(result.reason, "no-audio-yet");
  assert.deepEqual(databaseManager.getRecordingMarks(noteId), []);
});

test("a marker for no note is refused as no-recording", () => {
  const { handlers } = setup();
  const result = handlers._addRecordingMarker({
    noteId: null,
    systemStartedAt: 1000,
    firstLocalLineTimestamp: null,
    now: 5000,
  });
  assert.equal(result.success, false);
  assert.equal(result.reason, "no-recording");
});

test("a marker made just before the zero reads as zero, not negative", () => {
  const { handlers, databaseManager } = setup();
  const noteId = newNote(databaseManager);
  const result = handlers._addRecordingMarker({
    noteId,
    systemStartedAt: 10_000,
    firstLocalLineTimestamp: null,
    now: 9_000,
  });
  assert.deepEqual(result, { success: true, marks: [0] });
});

test("the meeting-add-marker channel refuses when no meeting is recording", async () => {
  setup();
  const handler = registered.get("meeting-add-marker");
  assert.ok(handler, "meeting-add-marker must be registered");
  const result = await handler({});
  assert.equal(result.success, false);
  assert.equal(result.reason, "no-recording");
});
