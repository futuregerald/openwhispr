const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { requireSqlite } = require("../support/sqlite.js");

const registered = new Map();
let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-recording-clock-"));
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: {
        getPath: () => userDataDir,
        getAppPath: () => process.cwd(),
        getVersion: () => "0.0.0",
        isPackaged: false,
        isReady: () => false,
        on: () => {},
        whenReady: () => Promise.resolve(),
      },
      ipcMain: {
        handle: (channel, fn) => registered.set(channel, fn),
        on: () => {},
        removeHandler: () => {},
      },
      BrowserWindow: class {
        static getAllWindows() {
          return [];
        }
        static fromWebContents() {
          return null;
        }
      },
      shell: {},
      dialog: {},
      clipboard: {},
      net: {},
      safeStorage: { isEncryptionAvailable: () => false },
      systemPreferences: {},
      nativeTheme: {},
      screen: {},
      session: {},
      desktopCapturer: {},
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
process.env.NODE_ENV = "test";

const IPCHandlers = require("../../src/helpers/ipcHandlers");
const DatabaseManager = require("../../src/helpers/database.js");
const { parseTranscriptSegments } = require("../../src/helpers/transcriptSpeakerState");

const HOUR = 3600 * 1000;
const START_A = Date.UTC(2026, 10, 13, 15, 18, 41);

function setup() {
  requireSqlite();
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-recording-clock-"));
  const databaseManager = new DatabaseManager();
  const broadcasts = [];
  const handlers = Object.create(IPCHandlers.prototype);
  Object.assign(handlers, {
    databaseManager,
    broadcastToWindows: (channel, payload) => broadcasts.push({ channel, payload }),
    _noteFilesEnabled: false,
    _asyncVectorUpsert: () => {},
    _asyncMirrorWrite: () => {},
  });
  const { note } = databaseManager.saveNote("Call", "", "meeting");
  return { handlers, databaseManager, broadcasts, noteId: note.id };
}

const lines = (prefix, count, spacing = 10) =>
  Array.from({ length: count }, (_, i) => ({
    text: `${prefix} line ${i}`,
    source: "system",
    speaker: "speaker_0",
    timestamp: i * spacing,
  }));

const stored = (databaseManager, noteId) => {
  const note = databaseManager.getNote(noteId);
  return {
    note,
    segments: parseTranscriptSegments(note.transcript ?? ""),
  };
};

test("a second recording keeps the note's clock and lands on it by wall time", () => {
  const { handlers, databaseManager, noteId } = setup();
  const first = lines("first", 5);
  const second = lines("second", 3);

  handlers._persistDiarizedTranscript(noteId, first, null, START_A);
  handlers._persistDiarizedTranscript(noteId, second, null, START_A + HOUR);

  const { note, segments } = stored(databaseManager, noteId);
  assert.equal(note.transcript_origin_ms, START_A, "the stored clock must not move");
  assert.equal(segments.length, 8, "neither recording's lines may be lost");
  first.forEach((line, i) => {
    assert.equal(segments[i].text, line.text);
    assert.equal(segments[i].timestamp, line.timestamp, "recording 1 must be unchanged");
  });
  second.forEach((line, i) => {
    const got = segments.find((s) => s.text === line.text);
    assert.equal(got.timestamp, 3600 + line.timestamp, `second line ${i} at +1h`);
  });
});

test("persisting the same recording twice changes nothing", () => {
  const { handlers, databaseManager, noteId } = setup();
  const first = lines("first", 5);
  const second = lines("second", 3);
  handlers._persistDiarizedTranscript(noteId, first, null, START_A);
  handlers._persistDiarizedTranscript(noteId, second, null, START_A + HOUR);
  const once = stored(databaseManager, noteId);

  handlers._persistDiarizedTranscript(noteId, second, null, START_A + HOUR);
  const twice = stored(databaseManager, noteId);

  assert.equal(twice.note.transcript, once.note.transcript);
  assert.equal(twice.note.transcript_origin_ms, START_A);
});

test("a first recording stores its start as the clock", () => {
  const { handlers, databaseManager, noteId } = setup();

  handlers._persistDiarizedTranscript(noteId, lines("first", 2), null, START_A);

  assert.equal(databaseManager.getNote(noteId).transcript_origin_ms, START_A);
});

test("no line is ever placed after the moment it was persisted", () => {
  const sequences = [
    [[0, 5]],
    [
      [0, 5],
      [1, 4],
    ],
    [
      [0, 5],
      [1, 4],
      [1, 4],
      [3, 6],
    ],
    [
      [0, 3],
      [0.0004, 3],
      [0.5, 3],
    ],
  ];
  const durationSeconds = (count) => (count - 1) * 10;
  for (const sequence of sequences) {
    const { handlers, databaseManager, noteId } = setup();
    sequence.forEach(([offsetHours, count], step) => {
      const start = START_A + Math.round(offsetHours * HOUR);
      handlers._persistDiarizedTranscript(
        noteId,
        lines(`r${offsetHours}-${step}`, count),
        null,
        start
      );
      const persistedAt = start + durationSeconds(count) * 1000;
      const { note, segments } = stored(databaseManager, noteId);
      for (const segment of segments) {
        const wall = note.transcript_origin_ms + segment.timestamp * 1000;
        assert.ok(
          wall <= persistedAt + 1,
          `${JSON.stringify(sequence)} step ${step}: line at ${new Date(wall).toISOString()} is in the future`
        );
      }
    });
  }
});

test("epoch-ms lines left by the live autosave are read against the note's clock", () => {
  const { handlers, databaseManager, noteId } = setup();
  databaseManager.updateNote(noteId, {
    transcript: JSON.stringify([
      { text: "live one", source: "system", timestamp: START_A + 5000 },
      { text: "live two", source: "system", timestamp: START_A + 15000 },
    ]),
    transcript_origin_ms: START_A,
    transcript_origin_source: "audio:system",
  });

  handlers._persistDiarizedTranscript(noteId, lines("later", 2), null, START_A + HOUR);

  const { note, segments } = stored(databaseManager, noteId);
  assert.equal(note.transcript_origin_ms, START_A);
  assert.equal(segments.find((s) => s.text === "live one").timestamp, 5);
  assert.equal(segments.find((s) => s.text === "live two").timestamp, 15);
  assert.equal(segments.find((s) => s.text === "later line 1").timestamp, 3610);
});

const CREATED_LONG_AGO = "2026-11-10 17:03:00";

function noteCreatedAt(databaseManager, createdAt, extra = {}) {
  const { note } = databaseManager.saveNote("Call", "", "personal");
  databaseManager.setNoteCreatedAt(note.id, createdAt);
  if (Object.keys(extra).length > 0) databaseManager.updateNote(note.id, extra);
  return note.id;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("an empty note is dated when its first recording starts, and the renderer is told", async () => {
  const { handlers, databaseManager, broadcasts } = setup();
  const noteId = noteCreatedAt(databaseManager, CREATED_LONG_AGO);

  handlers._dateNoteAtFirstRecording(noteId, START_A);
  await flush();

  assert.equal(databaseManager.getNote(noteId).created_at, "2026-11-13 15:18:41");
  const update = broadcasts.find((b) => b.channel === "note-updated");
  assert.ok(update, "the renderer's list must hear about the new date");
  assert.equal(update.payload.created_at, "2026-11-13 15:18:41");
});

test("a note that already holds a recording keeps its date", async () => {
  const { handlers, databaseManager, broadcasts } = setup();
  const noteId = noteCreatedAt(databaseManager, CREATED_LONG_AGO, {
    transcript: JSON.stringify([{ text: "earlier call", source: "system", timestamp: 1 }]),
  });

  handlers._dateNoteAtFirstRecording(noteId, START_A);
  await flush();

  assert.equal(databaseManager.getNote(noteId).created_at, CREATED_LONG_AGO);
  assert.equal(broadcasts.length, 0);
});

test("a missing note id or note is ignored", () => {
  const { handlers } = setup();
  assert.doesNotThrow(() => {
    handlers._dateNoteAtFirstRecording(null, START_A);
    handlers._dateNoteAtFirstRecording(99999, START_A);
  });
});

test("a database failure while dating the note never escapes into the recording start", () => {
  const { handlers, databaseManager } = setup();
  databaseManager.setNoteCreatedAt = () => {
    throw new Error("disk full");
  };
  assert.doesNotThrow(() => handlers._dateNoteAtFirstRecording(1, START_A));
});

test("starting a local meeting recording dates an empty note at that moment", async (t) => {
  const { handlers, databaseManager } = setup();
  const noteId = noteCreatedAt(databaseManager, CREATED_LONG_AGO);
  handlers.setupHandlers();
  const start = registered.get("meeting-transcription-start");
  assert.ok(start, "the handler must be registered");

  const timers = [];
  const realSetInterval = global.setInterval;
  global.setInterval = (...args) => {
    const handle = realSetInterval(...args);
    timers.push(handle);
    return handle;
  };
  t.after(() => {
    global.setInterval = realSetInterval;
    timers.forEach(clearInterval);
  });

  const before = Date.now();
  const result = await start({ sender: {} }, { provider: "local", noteId });

  assert.equal(result.success, true, result.error);
  const createdAt = Date.parse(`${databaseManager.getNote(noteId).created_at.replace(" ", "T")}Z`);
  assert.ok(
    createdAt >= before - 1000,
    "created_at must be the recording start, not three days ago"
  );
});
