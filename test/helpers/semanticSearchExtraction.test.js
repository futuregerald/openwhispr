const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

let vectorIndexStub = {
  isReady: () => false,
  search: async () => [],
};

const fakeElectron = {
  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {} },
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
Module._load = function patchedLoad(request, ...rest) {
  if (request === "electron") return fakeElectron;
  if (request === "./vectorIndex") return vectorIndexStub;
  return originalLoad.call(this, request, ...rest);
};

const IPCHandlers = require(path.join(__dirname, "../../src/helpers/ipcHandlers.js"));

function makeHandlers(notes, { ftsResults = null } = {}) {
  const byId = new Map(notes.map((note) => [note.id, note]));
  const handlers = Object.create(IPCHandlers.prototype);
  Object.assign(handlers, {
    databaseManager: {
      searchNotes: (_query, limit) => (ftsResults ?? notes).slice(0, limit),
      getNote: (id) => byId.get(id) ?? null,
    },
  });
  return handlers;
}

function note(id, extra = {}) {
  return { id, title: `Note ${id}`, deleted_at: null, ...extra };
}

test("falls back to keyword search when the vector index is not ready", async () => {
  vectorIndexStub = {
    isReady: () => false,
    search: async () => {
      throw new Error("search must not be called when the index is not ready");
    },
  };
  const handlers = makeHandlers([note(1), note(2)]);

  const results = await handlers.semanticSearchNotes("anything", 5);

  assert.deepEqual(
    results.map((row) => row.id),
    [1, 2]
  );
});

test("fuses keyword and vector ranks with K=60 and keeps the better-ranked note first", async () => {
  vectorIndexStub = {
    isReady: () => true,
    search: async () => [
      { noteId: 3, score: 0.9 },
      { noteId: 1, score: 0.8 },
    ],
  };
  const handlers = makeHandlers([note(1), note(2), note(3)], {
    ftsResults: [note(2), note(1)],
  });

  const results = await handlers.semanticSearchNotes("query", 3);

  assert.deepEqual(
    results.map((row) => row.id),
    [1, 2, 3],
    "note 1 appears in both lists so reciprocal ranks add and it leads"
  );
});

test("vector hits below the 0.3 score floor are discarded before fusion", async () => {
  vectorIndexStub = {
    isReady: () => true,
    search: async () => [
      { noteId: 9, score: 0.25 },
      { noteId: 1, score: 0.95 },
    ],
  };
  const handlers = makeHandlers([note(1), note(9)], { ftsResults: [] });

  const results = await handlers.semanticSearchNotes("query", 5);

  assert.deepEqual(
    results.map((row) => row.id),
    [1],
    "a low-confidence semantic match must not reach the agent as a result"
  );
});

test("a rejecting vector search falls back to keyword results without throwing", async () => {
  vectorIndexStub = {
    isReady: () => true,
    search: async () => {
      throw new Error("qdrant is down");
    },
  };
  const handlers = makeHandlers([note(1), note(2)]);

  const results = await handlers.semanticSearchNotes("query", 5);

  assert.deepEqual(
    results.map((row) => row.id),
    [1, 2]
  );
});

test("a vector-only hit on a soft-deleted note is not returned", async () => {
  vectorIndexStub = {
    isReady: () => true,
    search: async () => [{ noteId: 7, score: 0.99 }],
  };
  const handlers = makeHandlers([note(1), note(7, { deleted_at: "2026-09-01T00:00:00Z" })], {
    ftsResults: [note(1)],
  });

  const results = await handlers.semanticSearchNotes("query", 5);

  assert.deepEqual(
    results.map((row) => row.id),
    [1],
    "getNote has no deleted_at filter, so the RRF path has to apply one itself"
  );
});

test("the IPC channel still registers and delegates to the extracted method", () => {
  const registered = new Map();
  fakeElectron.ipcMain.handle = (channel, fn) => registered.set(channel, fn);

  const handlers = Object.create(IPCHandlers.prototype);
  Object.assign(handlers, {
    databaseManager: {
      getNote: () => null,
      updateNote: () => {},
      saveNote: () => ({ success: true }),
      searchNotes: () => [],
    },
    broadcastToWindows: () => {},
  });
  handlers.setupHandlers();

  assert.ok(registered.has("db-semantic-search-notes"), "the channel name must not change");
  assert.equal(typeof handlers.semanticSearchNotes, "function");
});
