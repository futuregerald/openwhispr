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

// This is the ONLY test in the suite that executes setupHandlers(), and the electron stub
// above is what makes calling it possible outside Electron. It exists to catch a handler
// whose module-scope require throws, or which destructures an export that no longer exists
// — the exact breakage a later edit to the require block at the top of ipcHandlers.js can
// cause. The constructor calls setupHandlers() unguarded, so without this the failure first
// appears at app launch. PR CI runs `npm test` and nothing else, so nothing else would catch it.
//
// It replaces speakerMergeIpcWiring.test.js, whose rename-speaker / merge-speakers handlers
// were deleted once the speaker panel moved that work into the renderer.
test("every IPC handler registers without throwing", () => {
  const handlers = Object.create(IPCHandlers.prototype);
  Object.assign(handlers, {
    databaseManager: {
      getNote: () => null,
      updateNote: () => {},
      saveNote: () => ({ success: true }),
    },
    broadcastToWindows: () => {},
  });

  assert.doesNotThrow(() => handlers.setupHandlers());
  assert.ok(registered.size > 0, "setupHandlers must actually register channels");
});
