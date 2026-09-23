const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const http = require("node:http");

const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-bridge-home-"));

const originalLoad = Module._load;
Module._load = function patchedLoad(request, ...rest) {
  if (request === "os") {
    return { ...os, homedir: () => homeDir };
  }
  if (request === "electron") {
    return { app: { getPath: () => homeDir, getAppPath: () => process.cwd() } };
  }
  return originalLoad.call(this, request, ...rest);
};

const CliBridge = require("../../src/helpers/cliBridge.js");

function fakeIpcHandlers(overrides = {}) {
  const db = {
    getNotes: () => [],
    getNote: () => null,
    searchNotes: () => [],
    getNoteSummaries: () => ({ notes: [], resolved_range: { since: null, until: null } }),
    searchTranscriptSegments: () => [],
    searchTranscriptions: () => [],
    getFolders: () => [],
    getFolderSummaries: () => [],
    getMeetingTypeSummaries: () => [],
    getCalendarEventsForMcp: () => [],
    getStats: () => ({ group_by: "week", buckets: [] }),
    getSearchIndexStatus: () => ({
      transcript_segments: { indexed_notes: 0, pending_notes: 0, total_segments: 0 },
      transcriptions_fts: { ready: true },
    }),
    getTranscriptions: () => [],
    getTranscriptionById: () => null,
    toNoteSearchSummary: (note) => ({ id: note.id, title: note.title, body_kind: "plain", snippet: "" }),
    toTranscriptionSummary: (row) => ({ id: row.id, snippet: "" }),
    resolvePerson: () => ({ person: null, ambiguous: false, reason: null, candidates: [] }),
    getPersonActivity: () => ({ person: null, spoken: [], mentioned: [], attended: [] }),
    listPeople: () => [],
    ...(overrides.db || {}),
  };

  return {
    databaseManager: db,
    semanticSearchNotes: async () => [],
    broadcastToWindows: () => {},
    _asyncVectorUpsert: () => {},
    _asyncMirrorWrite: () => {},
    ...overrides,
  };
}

async function withBridge(ipcHandlers, run) {
  const bridge = new CliBridge(ipcHandlers);
  await bridge.start();
  try {
    const { port, token } = JSON.parse(fs.readFileSync(CliBridge.getBridgeFilePath(), "utf8"));
    // agent: false keeps every request on its own socket. With connection pooling a
    // request can be written to a socket whose server was already replaced by the next
    // test on the same port, which surfaces as ECONNRESET rather than a route failure.
    const request = (method, routePath, { auth = token, body } = {}) =>
      new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            path: routePath,
            method,
            agent: false,
            headers: {
              ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
              ...(payload
                ? {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(payload),
                  }
                : {}),
            },
          },
          (res) => {
            let text = "";
            res.on("data", (chunk) => {
              text += chunk;
            });
            res.on("end", () =>
              resolve({ status: res.statusCode, json: text ? JSON.parse(text) : null })
            );
          }
        );
        req.on("error", reject);
        if (payload) req.write(payload);
        req.end();
      });
    await run({ request, port, token });
  } finally {
    await bridge.stop();
  }
}

test("the bridge writes a token file and removes it on stop", async () => {
  const bridge = new CliBridge(fakeIpcHandlers());
  await bridge.start();
  const bridgeFile = CliBridge.getBridgeFilePath();

  assert.ok(fs.existsSync(bridgeFile));
  const stats = fs.statSync(bridgeFile);
  if (process.platform !== "win32") {
    assert.equal(stats.mode & 0o777, 0o600, "the token grants full local API access");
  }

  await bridge.stop();
  assert.ok(!fs.existsSync(bridgeFile));
});

test("a bad bearer token is rejected", async () => {
  await withBridge(fakeIpcHandlers(), async ({ request }) => {
    const wrong = await request("GET", "/v1/health", { auth: "x".repeat(64) });
    assert.equal(wrong.status, 401);

    const missing = await request("GET", "/v1/health", { auth: null });
    assert.equal(missing.status, 401);
  });
});

test("GET /v1/notes/semantic-search reaches the semantic handler and not the :id route", async () => {
  let called = null;
  const ipcHandlers = fakeIpcHandlers({
    semanticSearchNotes: async (query, limit) => {
      called = { query, limit };
      return [{ id: 4, title: "Semantic hit" }];
    },
  });

  await withBridge(ipcHandlers, async ({ request }) => {
    const response = await request("GET", "/v1/notes/semantic-search?q=budget&limit=3");

    assert.equal(response.status, 200, "the :id catch-all would 404 this as an invalid note id");
    assert.deepEqual(called, { query: "budget", limit: 3 });
    assert.deepEqual(
      response.json.data,
      [{ id: 4, title: "Semantic hit", body_kind: "plain", snippet: "" }],
      "search results are projected, never whole note rows carrying audio paths and prompt text"
    );
    assert.equal(response.json.has_more, false);
    assert.equal(response.json.next_cursor, null);
  });
});

test("GET /v1/notes/summaries reaches the summaries handler and not the :id route", async () => {
  const ipcHandlers = fakeIpcHandlers({
    db: {
      getNoteSummaries: (options) => ({
        notes: [{ id: 1, title: "Summary", note_type: options.noteType }],
        resolved_range: { since: "2026-09-15 00:00:00", until: null },
      }),
    },
  });

  await withBridge(ipcHandlers, async ({ request }) => {
    const response = await request("GET", "/v1/notes/summaries?note_type=meeting&since=2026-09-15");

    assert.equal(response.status, 200);
    assert.equal(response.json.data[0].note_type, "meeting");
    assert.equal(response.json.resolved_range.since, "2026-09-15 00:00:00");
  });
});

test("GET /v1/transcriptions/search reaches the search handler and not the :id route", async () => {
  const ipcHandlers = fakeIpcHandlers({
    db: { searchTranscriptions: (query) => [{ id: 9, text: `hit for ${query}` }] },
  });

  await withBridge(ipcHandlers, async ({ request }) => {
    const response = await request("GET", "/v1/transcriptions/search?q=otter");

    assert.equal(response.status, 200);
    assert.equal(response.json.data[0].id, 9);
    assert.ok(!("text" in response.json.data[0]), "transcription rows are projected to a snippet");
  });
});

test("a missing q is 400 validation_error rather than 500", async () => {
  await withBridge(fakeIpcHandlers(), async ({ request }) => {
    const response = await request("GET", "/v1/transcriptions/search?q=");

    assert.equal(response.status, 400);
    assert.equal(response.json.error.code, "validation_error");
  });
});

test("the existing notes search also changes from 500 to 400 on an empty q", async () => {
  await withBridge(fakeIpcHandlers(), async ({ request }) => {
    const response = await request("GET", "/v1/notes/search?q=");

    assert.equal(
      response.status,
      400,
      "a contract change for the CLI, recorded here rather than discovered in the field"
    );
    assert.equal(response.json.error.code, "validation_error");
  });
});

test("an invalid date on a filtered route is a 400, not a full-range scan", async () => {
  const ipcHandlers = fakeIpcHandlers({
    db: {
      getNoteSummaries: () => {
        const error = new Error("Invalid date: 2026-13-45");
        error.code = "VALIDATION";
        throw error;
      },
    },
  });

  await withBridge(ipcHandlers, async ({ request }) => {
    const response = await request("GET", "/v1/notes/summaries?since=2026-13-45");

    assert.equal(response.status, 400);
    assert.equal(response.json.error.code, "validation_error");
  });
});

test("transcript search accepts a speaker filter with no query", async () => {
  let received = null;
  const ipcHandlers = fakeIpcHandlers({
    db: {
      searchTranscriptSegments: (options) => {
        received = options;
        return [{ note_id: 1, seq: 0, text: "hello" }];
      },
    },
  });

  await withBridge(ipcHandlers, async ({ request }) => {
    const response = await request(
      "GET",
      "/v1/transcripts/search?speaker=Jorge&note_id=1&limit=5&context=1"
    );

    assert.equal(response.status, 200);
    assert.equal(received.speaker, "Jorge");
    assert.equal(received.noteId, 1);
    assert.equal(received.limit, 5);
    assert.equal(received.contextSegments, 1);
    assert.equal(received.query, null);
  });
});

test("people routes resolve and report activity", async () => {
  await withBridge(fakeIpcHandlers(), async ({ request }) => {
    const resolve = await request("GET", "/v1/people/resolve?name=nobody");
    assert.equal(resolve.status, 200);
    assert.equal(resolve.json.data.person, null);

    const activity = await request("GET", "/v1/people/activity?name=nobody");
    assert.equal(activity.status, 200);
    assert.deepEqual(activity.json.data.spoken, []);

    const list = await request("GET", "/v1/people/list");
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.json.data));
  });
});

test("people resolve requires a name", async () => {
  await withBridge(fakeIpcHandlers(), async ({ request }) => {
    const response = await request("GET", "/v1/people/resolve?name=");

    assert.equal(response.status, 400);
    assert.equal(response.json.error.code, "validation_error");
  });
});

test("the enumeration routes return the shapes the tools expect", async () => {
  const ipcHandlers = fakeIpcHandlers({
    db: {
      getFolderSummaries: () => [{ id: 1, name: "Meetings", is_default: 1, note_count: 3 }],
      getMeetingTypeSummaries: () => [{ id: 2, name: "1:1", is_builtin: 1 }],
      getCalendarEventsForMcp: () => [{ id: "evt-1", summary: "Sync" }],
      getStats: (options) => ({ group_by: options.groupBy, buckets: [] }),
      getSearchIndexStatus: () => ({
        transcript_segments: { indexed_notes: 2, pending_notes: 1, total_segments: 40 },
        transcriptions_fts: { ready: true },
      }),
    },
  });

  await withBridge(ipcHandlers, async ({ request }) => {
    assert.equal((await request("GET", "/v1/folders/summaries")).json.data[0].note_count, 3);
    assert.equal((await request("GET", "/v1/meeting-types/list")).json.data[0].name, "1:1");
    assert.equal((await request("GET", "/v1/calendar/events")).json.data[0].id, "evt-1");
    assert.equal((await request("GET", "/v1/stats?group_by=day")).json.data.group_by, "day");

    const status = await request("GET", "/v1/index/status");
    assert.equal(status.json.data.transcript_segments.pending_notes, 1);
  });
});

test("the note detail route accepts the arguments its own client always sends", async () => {
  let received = null;
  const ipcHandlers = fakeIpcHandlers({
    db: {
      getNoteDetail: (id, options) => {
        received = { id, options };
        return { id, title: "Detail", body: "text", body_kind: "plain" };
      },
    },
  });

  await withBridge(ipcHandlers, async ({ request }) => {
    // get_note always sends max_chars, because clamp() substitutes its default when
    // the agent omits the argument. A bound that rejects it breaks the tool outright.
    const response = await request(
      "GET",
      "/v1/notes/1/detail?include=body,transcript&max_chars=20000&transcript_offset=0&transcript_limit=200"
    );

    assert.equal(response.status, 200, response.json && JSON.stringify(response.json));
    assert.equal(received.id, 1);
    assert.equal(received.options.maxChars, 20000);
    assert.deepEqual(received.options.include, ["body", "transcript"]);
  });
});

test("a note id past the limit bound is still addressable", async () => {
  const ipcHandlers = fakeIpcHandlers({
    db: {
      getNoteDetail: (id) => ({ id, title: "High id" }),
      searchTranscriptSegments: (options) => [{ note_id: options.noteId, seq: 0, text: "hi" }],
    },
  });

  await withBridge(ipcHandlers, async ({ request }) => {
    assert.equal((await request("GET", "/v1/notes/4321/detail")).status, 200);
    assert.equal(
      (await request("GET", "/v1/transcripts/search?note_id=4321")).status,
      200,
      "note ids come straight from list_notes and routinely exceed any limit bound"
    );
  });
});

test("a genuinely out-of-range limit is still rejected", async () => {
  await withBridge(fakeIpcHandlers(), async ({ request }) => {
    assert.equal((await request("GET", "/v1/people/list?limit=100000")).status, 400);
    assert.equal((await request("GET", "/v1/notes/summaries?limit=-5")).status, 400);
    assert.equal((await request("GET", "/v1/notes/summaries?limit=1.5")).status, 400);
  });
});

test("an unknown route is still a 404", async () => {
  await withBridge(fakeIpcHandlers(), async ({ request }) => {
    const response = await request("GET", "/v1/nothing/here");
    assert.equal(response.status, 404);
  });
});

test("a not-found error from a handler stays a 404", async () => {
  const ipcHandlers = fakeIpcHandlers({ db: { getNote: () => null } });

  await withBridge(ipcHandlers, async ({ request }) => {
    const response = await request("GET", "/v1/notes/12345");
    assert.equal(response.status, 404);
    assert.equal(response.json.error.code, "not_found");
  });
});
