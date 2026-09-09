const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

const registered = new Map();
const fakeElectron = {
  ipcMain: {
    handle: (channel, fn) => registered.set(channel, fn),
    on: () => {},
    removeHandler: () => {},
  },
  app: {
    getPath: () => "/tmp",
    getVersion: () => "0.0.0",
    isPackaged: false,
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
  safeStorage: { isEncryptionAvailable: () => false },
  systemPreferences: { getMediaAccessStatus: () => "granted" },
  nativeTheme: {},
  screen: {},
  session: {},
  desktopCapturer: {},
};

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") return fakeElectron;
  return originalLoad.call(this, request, ...rest);
};

const IPCHandlers = require(path.join(__dirname, "../../src/helpers/ipcHandlers.js"));

function createSpeakerHandlers(segments) {
  let stored = JSON.stringify(segments);
  const handlers = Object.create(IPCHandlers.prototype);
  Object.assign(handlers, {
    databaseManager: {
      getNote: () => ({ id: 1, transcript: stored }),
      updateNote: (_id, patch) => {
        stored = patch.transcript;
      },
    },
    broadcastToWindows: () => {},
  });
  handlers.setupHandlers();
  return {
    merge: registered.get("merge-speakers"),
    rename: registered.get("rename-speaker"),
    read: () => JSON.parse(stored),
  };
}

const fixture = () => [
  {
    source: "system",
    timestamp: 0,
    speaker: "keep",
    speakerName: "Fabian",
    speakerIsPlaceholder: false,
    text: "a",
  },
  { source: "system", timestamp: 5, speaker: "b", text: "b" },
  { source: "system", timestamp: 10, speaker: "c", text: "c" },
  {
    source: "system",
    timestamp: 15,
    speaker: "d",
    speakerName: "Molly",
    speakerIsPlaceholder: false,
    speakerLocked: true,
    speakerLockSource: "user",
    text: "d",
  },
];

test("merge-speakers folds every selected speaker in one call and skips locked segments", async () => {
  const { merge, read } = createSpeakerHandlers(fixture());
  const result = await merge({}, 1, "keep", ["b", "c", "d"]);
  assert.deepEqual(result, { success: true, mergedCount: 2, skippedLockedCount: 1 });
  assert.deepEqual(
    read().map((s) => [s.speaker, s.speakerName]),
    [
      ["keep", "Fabian"],
      ["keep", "Fabian"],
      ["keep", "Fabian"],
      ["d", "Molly"],
    ]
  );
});

test("merge-speakers still accepts the legacy single-id argument", async () => {
  const { merge, read } = createSpeakerHandlers(fixture());
  const result = await merge({}, 1, "keep", "b");
  assert.equal(result.success, true);
  assert.equal(result.mergedCount, 1);
  assert.deepEqual(
    read().map((s) => s.speaker),
    ["keep", "keep", "c", "d"]
  );
});

test("rename-speaker leaves a locked segment alone and reports the count", async () => {
  const { rename, read } = createSpeakerHandlers(fixture());
  const renamed = await rename({}, 1, "keep", "Gerald");
  assert.deepEqual(renamed, { success: true, renamedCount: 1, skippedLockedCount: 0 });

  const lockedRename = await rename({}, 1, "d", "Someone Else");
  assert.deepEqual(lockedRename, { success: true, renamedCount: 0, skippedLockedCount: 1 });
  assert.equal(read()[3].speakerName, "Molly");
});

test("the speaker handlers report failure when the note has no transcript", async () => {
  const handlers = Object.create(IPCHandlers.prototype);
  Object.assign(handlers, {
    databaseManager: { getNote: () => ({ id: 1 }), updateNote: () => {} },
    broadcastToWindows: () => {},
  });
  handlers.setupHandlers();
  assert.deepEqual(await registered.get("merge-speakers")({}, 1, "keep", ["b"]), {
    success: false,
  });
  assert.deepEqual(await registered.get("rename-speaker")({}, 1, "keep", "x"), { success: false });
});
