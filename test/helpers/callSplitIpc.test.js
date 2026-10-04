const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { requireSqlite } = require("../support/sqlite.js");

// The real IPC handlers, registered against a stub electron and driven directly.
// A test that only re-read the handler's source text could not fail; this one
// calls the handler and reads the database afterwards.
let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-call-split-ipc-"));
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

const SEGMENTS_PER_CALL = 25;
const SPACING_SECONDS = 25;
const SILENCE_SECONDS = 150;

// Call A ends on a farewell (+2) and call B opens on a greeting (+2), against a
// threshold of 3. Each side holds 25 segments and spans 600s, clearing
// MIN_SESSION_SEGMENTS and MIN_PIECE_SECONDS.
function weldedSegments(callCount = 2) {
  const segments = [];
  for (let call = 0; call < callCount; call += 1) {
    const base = call * ((SEGMENTS_PER_CALL - 1) * SPACING_SECONDS + SILENCE_SECONDS);
    for (let i = 0; i < SEGMENTS_PER_CALL; i += 1) {
      let text = `Call ${call} turn ${i}: we walked the migration plan and the staffing for it.`;
      if (i === 0 && call > 0) text = "Hey, thanks for joining, can you hear me?";
      if (i === SEGMENTS_PER_CALL - 1 && call < callCount - 1) {
        text = "Alright, talk to you later, bye.";
      }
      segments.push({
        id: `seg-${call}-${i}`,
        text,
        source: "system",
        speaker: `speaker_${call}`,
        timestamp: base + i * SPACING_SECONDS,
      });
    }
  }
  return segments;
}

function singleCallSegments() {
  return weldedSegments(1);
}

function setup() {
  requireSqlite();
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-call-split-ipc-"));
  registered.clear();

  const handlers = Object.create(IPCHandlers.prototype);
  const databaseManager = new DatabaseManager();
  const broadcasts = [];
  const vectorUpserts = [];
  const enqueued = [];

  Object.assign(handlers, {
    databaseManager,
    broadcastToWindows: (channel, payload) => broadcasts.push({ channel, payload }),
    _noteFilesEnabled: false,
    _asyncVectorUpsert: (note) => vectorUpserts.push(note.id),
    _asyncMirrorWrite: () => {},
  });

  handlers.setupHandlers();
  handlers.backgroundJobQueue.enqueueKind = (key, kind, payload) => {
    enqueued.push({ key, kind, payload });
    return true;
  };

  return { handlers, databaseManager, broadcasts, vectorUpserts, enqueued };
}

// Every renderer broadcast in these handlers is deferred with setImmediate, the
// same way db-save-note defers note-added, so a synchronous assertion would read
// an empty list and prove nothing.
const flushBroadcasts = () => new Promise((resolve) => setImmediate(resolve));

const invoke = (channel, ...args) => {
  const handler = registered.get(channel);
  assert.ok(handler, `no handler registered for ${channel}`);
  return handler({}, ...args);
};

function seedNote(databaseManager, { segments, audioPath = null, title = "Team sync" }) {
  const created = databaseManager.saveNote(title, "", "meeting", null, 1400, null);
  const updates = { transcript: JSON.stringify(segments) };
  if (audioPath) updates.system_audio_path = audioPath;
  databaseManager.updateNote(created.note.id, updates);
  return created.note.id;
}

// ── Scanning ────────────────────────────────────────────────────────────────

test("the scan reports how many calls a welded recording holds", async () => {
  const { databaseManager } = setup();
  const noteId = seedNote(databaseManager, { segments: weldedSegments() });

  assert.deepEqual(await invoke("scan-note-call-boundaries", noteId), {
    success: true,
    noteId,
    boundaryCount: 1,
    callCount: 2,
  });
});

test("the scan reports one call for a recording with no boundary", async () => {
  const { databaseManager } = setup();
  const noteId = seedNote(databaseManager, { segments: singleCallSegments() });

  const result = await invoke("scan-note-call-boundaries", noteId);
  assert.equal(result.callCount, 1);
  assert.equal(result.boundaryCount, 0);
});

test("the scan refuses a note that does not exist instead of claiming one call", async () => {
  setup();
  const result = await invoke("scan-note-call-boundaries", 9999);
  assert.equal(result.success, false);
  assert.match(result.error, /not found/i);
});

// ── Splitting ───────────────────────────────────────────────────────────────

test("splitting a welded note creates the sibling and schedules its own notes", async () => {
  const { databaseManager, broadcasts, vectorUpserts, enqueued } = setup();
  const noteId = seedNote(databaseManager, { segments: weldedSegments() });

  const result = await invoke("split-note-calls", noteId);
  assert.equal(result.success, true);
  assert.equal(result.childNoteIds.length, 1);
  const childId = result.childNoteIds[0];

  assert.equal(JSON.parse(databaseManager.getNote(noteId).transcript).length, SEGMENTS_PER_CALL);
  assert.equal(JSON.parse(databaseManager.getNote(childId).transcript).length, SEGMENTS_PER_CALL);

  assert.equal(
    databaseManager.getNote(childId).title,
    "",
    "an inherited title is not a placeholder, so the pipeline would refuse to title the child"
  );

  await flushBroadcasts();
  const added = broadcasts.filter((b) => b.channel === "note-added").map((b) => b.payload.id);
  assert.deepEqual(added, [childId], "the renderer only learns about a new note from note-added");
  assert.ok(
    broadcasts.some((b) => b.channel === "note-updated" && b.payload.id === noteId),
    "the parent's transcript changed in place and the renderer has no other refresh path"
  );
  assert.ok(
    vectorUpserts.includes(noteId) && vectorUpserts.includes(childId),
    "both halves must be re-embedded or search_notes still answers with the welded text"
  );

  assert.deepEqual(
    enqueued.map((job) => job.payload).sort((a, b) => a.noteId - b.noteId),
    [
      { noteId, fromStep: "classify" },
      { noteId: childId, fromStep: "classify" },
    ],
    "both halves need their own classify/title/notes, and neither needs retranscribe"
  );
});

test("splitting a three-call recording yields three notes", async () => {
  const { databaseManager } = setup();
  const noteId = seedNote(databaseManager, { segments: weldedSegments(3) });

  const result = await invoke("split-note-calls", noteId);
  assert.equal(result.success, true);
  assert.equal(result.childNoteIds.length, 2);
  for (const id of [noteId, ...result.childNoteIds]) {
    assert.equal(JSON.parse(databaseManager.getNote(id).transcript).length, SEGMENTS_PER_CALL);
  }
});

test("splitting a note with no boundary writes nothing", async () => {
  const { databaseManager, broadcasts, enqueued } = setup();
  const noteId = seedNote(databaseManager, { segments: singleCallSegments() });
  const before = databaseManager.getNote(noteId).transcript;

  const result = await invoke("split-note-calls", noteId);
  assert.equal(result.success, false);
  assert.equal(result.reason, "no-boundary");
  assert.equal(databaseManager.getNote(noteId).transcript, before);
  assert.deepEqual(
    broadcasts.filter((b) => b.channel === "note-added"),
    []
  );
  assert.deepEqual(enqueued, []);
});

// ── Dismissing ──────────────────────────────────────────────────────────────

test("dismissing the suggestion persists, so the banner stays gone", async () => {
  const { databaseManager, broadcasts } = setup();
  const noteId = seedNote(databaseManager, { segments: weldedSegments() });

  const result = await invoke("dismiss-note-call-split", noteId);
  assert.equal(result.success, true);
  assert.equal(databaseManager.getNote(noteId).call_split_dismissed, 1);
  await flushBroadcasts();
  assert.ok(broadcasts.some((b) => b.channel === "note-updated" && b.payload.id === noteId));
});

// ── Deleting shared audio (plan §6 / Phase D fix I6) ────────────────────────

test("deleting the audio clears the path on every note that shares the file", async () => {
  const { databaseManager } = setup();
  const audioPath = path.join(userDataDir, "welded.opus");
  fs.writeFileSync(audioPath, "audio");

  const parentId = seedNote(databaseManager, { segments: weldedSegments(), audioPath });
  const childId = (await invoke("split-note-calls", parentId)).childNoteIds[0];
  assert.equal(databaseManager.getNote(childId).system_audio_path, audioPath);

  const result = await invoke("delete-note-audio", parentId);
  assert.equal(result.success, true);
  assert.equal(fs.existsSync(audioPath), false, "the file itself must be gone");

  assert.equal(databaseManager.getNote(parentId).system_audio_path, null);
  assert.equal(
    databaseManager.getNote(childId).system_audio_path,
    null,
    "a sibling left pointing at a deleted file is an orphan the player cannot load"
  );
});

test("deleting the audio leaves a note that does not share the file alone", async () => {
  const { databaseManager } = setup();
  const sharedPath = path.join(userDataDir, "shared.opus");
  const otherPath = path.join(userDataDir, "other.opus");
  fs.writeFileSync(sharedPath, "audio");
  fs.writeFileSync(otherPath, "audio");

  const noteId = seedNote(databaseManager, {
    segments: singleCallSegments(),
    audioPath: sharedPath,
  });
  const unrelatedId = seedNote(databaseManager, {
    segments: singleCallSegments(),
    audioPath: otherPath,
  });

  await invoke("delete-note-audio", noteId);

  assert.equal(databaseManager.getNote(unrelatedId).system_audio_path, otherPath);
  assert.equal(fs.existsSync(otherPath), true);
});

test("deleting the audio of a note that does not exist reports it", async () => {
  setup();
  const result = await invoke("delete-note-audio", 9999);
  assert.equal(result.success, false);
  assert.match(result.error, /not found/i);
});
