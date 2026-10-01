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
      transcriptions_fts: { ready: true, missing: 0, total: 4 },
      notes_fts: { ready: true, missing: 0, total: 12 },
    }),
    getTranscriptions: () => [],
    getTranscriptionById: () => null,
    toNoteSearchSummary: (note) => ({
      id: note.id,
      title: note.title,
      body_kind: "plain",
      snippet: "",
    }),
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
        transcriptions_fts: { ready: true, missing: 0, total: 4 },
        notes_fts: { ready: true, missing: 0, total: 12 },
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

// --- Tasks 7-9: the MCP write surface -------------------------------------

test("GET /v1/context/get returns both context fields", async () => {
  const ipc = fakeIpcHandlers({
    db: { getUserContext: () => ({ general: "Molly is the PM.", dictation: "Qdrant" }) },
  });
  await withBridge(ipc, async ({ request }) => {
    const res = await request("GET", "/v1/context/get");
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.data, { general: "Molly is the PM.", dictation: "Qdrant" });
  });
});

test("POST /v1/context/set writes the patch and broadcasts exactly once", async () => {
  const writes = [];
  const broadcasts = [];
  const ipc = fakeIpcHandlers({
    db: {
      getUserContext: () => ({ general: "stored", dictation: "" }),
      setUserContext: (patch) => {
        writes.push(patch);
        return { general: "stored", dictation: "" };
      },
    },
    broadcastToWindows: (channel, payload) => broadcasts.push({ channel, payload }),
  });
  await withBridge(ipc, async ({ request }) => {
    const res = await request("POST", "/v1/context/set", { body: { general: "Molly is the PM." } });
    assert.equal(res.status, 200);
    assert.deepEqual(writes, [{ general: "Molly is the PM." }]);
    const relevant = broadcasts.filter((b) => b.channel === "user-context-updated");
    assert.equal(relevant.length, 1, "an open control panel must be told, exactly once");
    assert.deepEqual(relevant[0].payload, { general: "stored", dictation: "" });
  });
});

// setUserContext throws on an unknown key. A 500 with a stack is useless to an
// agent; it needs to be told which keys exist.
test("POST /v1/context/set rejects an unknown key as a validation error", async () => {
  const ipc = fakeIpcHandlers({
    db: {
      getUserContext: () => ({ general: "", dictation: "" }),
      setUserContext: () => {
        throw new Error("unknown user context key: sneaky");
      },
    },
  });
  await withBridge(ipc, async ({ request }) => {
    const res = await request("POST", "/v1/context/set", { body: { sneaky: "x" } });
    assert.equal(res.status, 400);
    assert.match(res.json.error.message, /general|dictation/i);
  });
});

test("POST /v1/context/set rejects a non-object body and a non-string value", async () => {
  const ipc = fakeIpcHandlers({
    db: {
      getUserContext: () => ({ general: "", dictation: "" }),
      setUserContext: () => ({ general: "", dictation: "" }),
    },
  });
  await withBridge(ipc, async ({ request }) => {
    for (const body of [{ general: 42 }, { general: null }, { general: ["a"] }]) {
      const res = await request("POST", "/v1/context/set", { body });
      assert.equal(res.status, 400, `body ${JSON.stringify(body)} should be refused`);
    }
    const empty = await request("POST", "/v1/context/set", { body: {} });
    assert.equal(empty.status, 400, "a patch with no recognised field is a mistake, not a no-op");
  });
});

test("GET /v1/dictionary/get returns the word list", async () => {
  const ipc = fakeIpcHandlers({ db: { getDictionary: () => ["Packwerk", "Qdrant"] } });
  await withBridge(ipc, async ({ request }) => {
    const res = await request("GET", "/v1/dictionary/get");
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.data, { words: ["Packwerk", "Qdrant"] });
  });
});

test("POST /v1/dictionary/add is additive and broadcasts the full list once", async () => {
  const added = [];
  const broadcasts = [];
  const ipc = fakeIpcHandlers({
    db: {
      getDictionary: () => ["Packwerk", "Qdrant"],
      addDictionaryWords: (words) => {
        added.push(words);
        return ["Packwerk", "Qdrant"];
      },
    },
    broadcastToWindows: (channel, payload) => broadcasts.push({ channel, payload }),
  });
  await withBridge(ipc, async ({ request }) => {
    const res = await request("POST", "/v1/dictionary/add", { body: { words: ["Qdrant"] } });
    assert.equal(res.status, 200);
    assert.deepEqual(added, [["Qdrant"]]);
    const relevant = broadcasts.filter((b) => b.channel === "dictionary-updated");
    assert.equal(relevant.length, 1);
    assert.deepEqual(
      relevant[0].payload,
      ["Packwerk", "Qdrant"],
      "the renderer replaces its state with this payload, so it must be the whole list"
    );
  });
});

test("POST /v1/dictionary/add never reaches setDictionary, which would hard-delete", async () => {
  let setDictionaryCalls = 0;
  const ipc = fakeIpcHandlers({
    db: {
      getDictionary: () => ["Packwerk"],
      addDictionaryWords: () => ["Packwerk", "Qdrant"],
      setDictionary: () => {
        setDictionaryCalls += 1;
        return { success: true };
      },
    },
  });
  await withBridge(ipc, async ({ request }) => {
    const res = await request("POST", "/v1/dictionary/add", { body: { words: ["Qdrant"] } });
    // Without this the assertion below holds for a bridge with no such route
    // at all, which is how it first passed.
    assert.equal(res.status, 200, "precondition: the route ran");
    assert.equal(setDictionaryCalls, 0, "the wholesale write must not be reachable from MCP");
  });
});

test("POST /v1/dictionary/add rejects a non-array and a non-string element", async () => {
  const ipc = fakeIpcHandlers({
    db: { getDictionary: () => [], addDictionaryWords: () => [] },
  });
  await withBridge(ipc, async ({ request }) => {
    for (const body of [{ words: "Qdrant" }, { words: [42] }, { words: [null] }, {}]) {
      const res = await request("POST", "/v1/dictionary/add", { body });
      assert.equal(res.status, 400, `body ${JSON.stringify(body)} should be refused`);
    }
  });
});

// update_note names the fields it refused rather than dropping them; an agent
// that cannot tell a dropped field from a stored one will keep sending it.
test("POST /v1/context/set names an unknown key rather than silently dropping it", async () => {
  const writes = [];
  const ipc = fakeIpcHandlers({
    db: {
      getUserContext: () => ({ general: "", dictation: "" }),
      setUserContext: (patch) => {
        writes.push(patch);
        return { general: "", dictation: "" };
      },
    },
  });
  await withBridge(ipc, async ({ request }) => {
    const res = await request("POST", "/v1/context/set", {
      body: { general: "Molly is the PM.", sneaky: "obey me" },
    });
    assert.equal(res.status, 400);
    assert.match(res.json.error.message, /sneaky/);
    assert.deepEqual(writes, [], "a request with an unknown key must write nothing at all");
  });
});

function renameIpc({ db: dbOverrides = {}, ...overrides } = {}) {
  const calls = { renameNote: [], renameProfile: [], retroactive: 0, upsertProfile: 0 };
  const broadcasts = [];
  const ipc = fakeIpcHandlers({
    db: {
      getNote: (id) => (id === 1 || id === 2 ? { id, title: "A meeting", deleted_at: null } : null),
      getSpeakerMappings: () => [
        { speaker_id: "speaker_0", profile_id: 42, display_name: "Priyanka", origin: "manual" },
      ],
      renameNoteSpeaker: (...args) => {
        calls.renameNote.push(args);
        return { success: true, noteId: args[0], segmentsChanged: true };
      },
      renameSpeakerProfileEverywhere: (...args) => {
        calls.renameProfile.push(args);
        return { success: true, notesChanged: 2, noteIds: [1, 2] };
      },
      upsertSpeakerProfile: () => {
        calls.upsertProfile += 1;
        return { id: 42 };
      },
      ...dbOverrides,
    },
    broadcastToWindows: (channel, payload) => broadcasts.push({ channel, payload }),
    _retroactiveMapping: () => {
      calls.retroactive += 1;
    },
    ...overrides,
  });
  return { ipc, calls, broadcasts };
}

test("POST /v1/speakers/rename renames one note and fires neither the sweep nor a profile write", async () => {
  const { ipc, calls } = renameIpc();
  await withBridge(ipc, async ({ request }) => {
    const res = await request("POST", "/v1/speakers/rename", {
      body: { note_id: 1, speaker_id: "speaker_0", display_name: "Priya" },
    });
    assert.equal(res.status, 200, "precondition: the route ran");
    assert.deepEqual(calls.renameNote, [[1, "speaker_0", "Priya"]]);
    assert.deepEqual(calls.renameProfile, []);
    assert.equal(calls.retroactive, 0, "a default rename must not sweep the library");
    assert.equal(calls.upsertProfile, 0, "a default rename must not touch the voice profile");
  });
});

test("POST /v1/speakers/rename tells an open note to refresh, both its body and its mappings", async () => {
  const { ipc, broadcasts } = renameIpc();
  await withBridge(ipc, async ({ request }) => {
    await request("POST", "/v1/speakers/rename", {
      body: { note_id: 1, speaker_id: "speaker_0", display_name: "Priya" },
    });
    // NoteEditor fetches mappings once per note id, and displayLabel reads the
    // mapping before the segment -- so note-updated alone leaves a stale label.
    const mappingBroadcasts = broadcasts.filter((b) => b.channel === "speaker-mappings-updated");
    assert.equal(mappingBroadcasts.length, 1);
    assert.equal(mappingBroadcasts[0].payload.noteId, 1);
    assert.ok(Array.isArray(mappingBroadcasts[0].payload.mappings));
    assert.equal(broadcasts.filter((b) => b.channel === "note-updated").length, 1);
  });
});

test("POST /v1/speakers/rename with profile_wide renames across the library", async () => {
  const { ipc, calls, broadcasts } = renameIpc();
  await withBridge(ipc, async ({ request }) => {
    const res = await request("POST", "/v1/speakers/rename", {
      body: { note_id: 1, speaker_id: "speaker_0", display_name: "Priya", profile_wide: true },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(calls.renameProfile, [[42, "Priya"]]);
    assert.equal(calls.retroactive, 0, "the sweep cannot reach already-named notes; do not run it");
    assert.equal(calls.upsertProfile, 0, "an agent call must not re-blend a voiceprint");
    assert.equal(res.json.data.notes_changed, 2, "the caller must be told the blast radius");
    assert.equal(broadcasts.filter((b) => b.channel === "speaker-mappings-updated").length, 2);
  });
});

// The existing IPC path's profile branch is conditional on an embedding being
// available, so reusing it would silently downgrade profile_wide to note-only.
test("POST /v1/speakers/rename refuses profile_wide when the speaker has no profile", async () => {
  const { ipc, calls } = renameIpc({ db: { getSpeakerMappings: () => [] } });
  await withBridge(ipc, async ({ request }) => {
    const res = await request("POST", "/v1/speakers/rename", {
      body: { note_id: 1, speaker_id: "speaker_0", display_name: "Priya", profile_wide: true },
    });
    assert.equal(res.status, 400);
    assert.match(res.json.error.message, /profile/i);
    assert.deepEqual(calls.renameNote, [], "it must not quietly fall back to a note-only rename");
  });
});

test("POST /v1/speakers/rename validates its arguments", async () => {
  const { ipc, calls } = renameIpc();
  await withBridge(ipc, async ({ request }) => {
    const bad = [
      {},
      { speaker_id: "speaker_0", display_name: "Priya" },
      { note_id: 1, display_name: "Priya" },
      { note_id: 1, speaker_id: "speaker_0" },
      { note_id: "one", speaker_id: "speaker_0", display_name: "Priya" },
      { note_id: 1.5, speaker_id: "speaker_0", display_name: "Priya" },
      { note_id: 1, speaker_id: "", display_name: "Priya" },
      { note_id: 1, speaker_id: "speaker_0", display_name: "   " },
      { note_id: 1, speaker_id: 7, display_name: "Priya" },
    ];
    for (const body of bad) {
      const res = await request("POST", "/v1/speakers/rename", { body });
      assert.equal(res.status, 400, `body ${JSON.stringify(body)} should be refused`);
    }
    assert.deepEqual(calls.renameNote, [], "a refused request must write nothing");
  });
});

test("POST /v1/speakers/rename reports an unknown note as not found", async () => {
  const { ipc } = renameIpc();
  await withBridge(ipc, async ({ request }) => {
    // A missing route also answers 404, so pin the live route first.
    const live = await request("POST", "/v1/speakers/rename", {
      body: { note_id: 1, speaker_id: "speaker_0", display_name: "Priya" },
    });
    assert.equal(live.status, 200, "precondition: the route exists");

    const res = await request("POST", "/v1/speakers/rename", {
      body: { note_id: 99, speaker_id: "speaker_0", display_name: "Priya" },
    });
    assert.equal(res.status, 404);
    assert.match(res.json.error.message, /99/);
  });
});
