const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

// The real meeting start and stop handlers, driven against a stub engine.
let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-recording-ipc-"));
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

    static fromWebContents() {
      return null;
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

function setup() {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-recording-ipc-"));
  registered.clear();

  const calls = [];
  const engine = {
    meetingRecordingStarted: (arg) => calls.push({ name: "started", arg }),
    meetingRecordingStopComplete: () => calls.push({ name: "stopComplete" }),
    endMeetingSession: (reason) => calls.push({ name: "endSession", reason }),
    setUserRecording: (active) => calls.push({ name: "setUserRecording", active }),
    handleRecordingNoticeResponse: (action) => {
      calls.push({ name: "noticeResponse", action });
      return action === "resume" ? Promise.resolve("resumed") : undefined;
    },
  };

  const handlers = Object.create(IPCHandlers.prototype);
  Object.assign(handlers, {
    databaseManager: {},
    meetingDetectionEngine: engine,
    broadcastToWindows: () => {},
    _noteFilesEnabled: false,
    _asyncVectorUpsert: () => {},
    _asyncMirrorWrite: () => {},
  });
  handlers.setupHandlers();
  return { calls };
}

const invoke = (channel, ...args) => {
  const handler = registered.get(channel);
  assert.ok(handler, `no handler registered for ${channel}`);
  return handler({ sender: {} }, ...args);
};

test("a start that fails without throwing never tells the engine a recording began", async () => {
  const { calls } = setup();

  const result = await invoke("meeting-transcription-start", {
    provider: "not-a-provider",
    noteId: 12,
  });

  assert.equal(result.success, false);
  assert.match(result.error, /Unsupported provider/);
  assert.deepEqual(
    calls.filter((c) => c.name === "started" || c.name === "setUserRecording"),
    []
  );
});

test("the stop handler tells the engine the stop is complete, even when stopping fails", async () => {
  const { calls } = setup();

  await invoke("meeting-transcription-stop", {});

  const names = calls.map((c) => c.name);
  assert.deepEqual(names, ["endSession", "stopComplete"]);
  assert.equal(calls[0].reason, "meeting-transcription-stop");
});

test("recording-notice-respond forwards the action to the engine", async () => {
  const { calls } = setup();

  await invoke("recording-notice-respond", "keep");
  await invoke("recording-notice-respond", "stop");

  assert.deepEqual(
    calls.filter((c) => c.name === "noticeResponse").map((c) => c.action),
    ["keep", "stop"]
  );
});

test("recording-notice-respond returns the engine's result for resume", async () => {
  setup();

  assert.equal(await invoke("recording-notice-respond", "resume"), "resumed");
});
