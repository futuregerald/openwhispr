const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const debugLogger = require("./debugLogger");
const { isPortAvailable } = require("../utils/serverUtils");

const MAX_NOTE_FIELD_CHARS = 100000;

const PORT_RANGE_START = 8200;
const PORT_RANGE_END = 8219;
const HOST = "127.0.0.1";
const BRIDGE_FILE_VERSION = 1;
const MAX_REQUEST_BODY_BYTES = 1 * 1024 * 1024;
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

const NO_CONTENT = Symbol("CliBridge.NoContent");

function getBridgeFilePath() {
  return path.join(os.homedir(), ".openwhispr", "cli-bridge.json");
}

async function findAvailablePort() {
  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
    if (await isPortAvailable(port)) return port;
  }
  throw new Error(`No available ports in range ${PORT_RANGE_START}-${PORT_RANGE_END}`);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > MAX_REQUEST_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON payload"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendNoContent(res) {
  res.writeHead(204);
  res.end();
}

function sendV1Error(res, statusCode, code, message) {
  sendJson(res, statusCode, { error: { code, message } });
}

function parseIdParam(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

function validationError(message) {
  const err = new Error(message);
  err.code = "VALIDATION";
  return err;
}

const MAX_ID_PARAM = Number.MAX_SAFE_INTEGER;

function numberParam(query, name, fallback, { min = 0, max = 1000 } = {}) {
  const raw = query.get(name);
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw validationError(`Invalid ${name}: ${raw}`);
  }
  return value;
}

function unwrapMutationResult(result, label) {
  if (!result?.success || !result[label]) {
    throw new Error(result?.error || `Failed to write ${label}`);
  }
  return result[label];
}

class CliBridge {
  constructor(ipcHandlers) {
    this.ipcHandlers = ipcHandlers;
    this.server = null;
    this.port = null;
    this.token = null;
    this.bridgeFilePath = getBridgeFilePath();
    this.routes = this._buildRouteTable();
  }

  async start() {
    if (this.server) return;

    this.token = crypto.randomBytes(32).toString("hex");
    this.port = await findAvailablePort();
    this.server = http.createServer((req, res) => {
      this._handleRequest(req, res).catch((err) => {
        debugLogger.error("CLI bridge handler error", { error: err.message }, "cli-bridge");
        if (!res.headersSent) {
          sendV1Error(res, 500, "internal_error", "Internal server error");
        }
      });
    });

    await new Promise((resolve, reject) => {
      const onError = (err) => {
        this.server = null;
        reject(err);
      };
      this.server.once("error", onError);
      this.server.listen(this.port, HOST, () => {
        this.server.removeListener("error", onError);
        resolve();
      });
    });

    this._writeBridgeFile();
    debugLogger.info("CLI bridge started", { port: this.port }, "cli-bridge");
  }

  async stop() {
    if (!this.server) return;
    await new Promise((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections?.();
    });
    this.server = null;
    this.port = null;
    this.token = null;
    this._removeBridgeFile();
    debugLogger.info("CLI bridge stopped", {}, "cli-bridge");
  }

  _writeBridgeFile() {
    const dir = path.dirname(this.bridgeFilePath);
    fs.mkdirSync(dir, { recursive: true });
    const payload = JSON.stringify({
      version: BRIDGE_FILE_VERSION,
      port: this.port,
      token: this.token,
    });
    fs.writeFileSync(this.bridgeFilePath, payload, { mode: 0o600 });
    // Re-apply mode in case the filesystem ignored the mode arg on create.
    // No-op on Windows ACLs but harmless; swallow errors from exotic filesystems.
    try {
      fs.chmodSync(this.bridgeFilePath, 0o600);
    } catch (err) {
      debugLogger.debug("CLI bridge chmod failed", { error: err.message }, "cli-bridge");
    }
  }

  _removeBridgeFile() {
    try {
      fs.unlinkSync(this.bridgeFilePath);
    } catch (err) {
      if (err.code !== "ENOENT") {
        debugLogger.debug("CLI bridge file removal failed", { error: err.message }, "cli-bridge");
      }
    }
  }

  async _handleRequest(req, res) {
    const remote = req.socket?.remoteAddress;
    if (!remote || !LOOPBACK_ADDRESSES.has(remote)) {
      sendV1Error(res, 403, "forbidden", "Forbidden");
      return;
    }

    const auth = Buffer.from(req.headers["authorization"] || "");
    const expected = Buffer.from(`Bearer ${this.token}`);
    if (auth.length !== expected.length || !crypto.timingSafeEqual(auth, expected)) {
      sendV1Error(res, 401, "unauthorized", "Unauthorized");
      return;
    }

    const url = new URL(req.url || "/", `http://${HOST}:${this.port}`);
    const route = this._matchRoute(req.method, url.pathname);
    if (!route) {
      sendV1Error(res, 404, "not_found", "Not found");
      return;
    }

    let body = {};
    if (req.method !== "GET" && req.method !== "DELETE") {
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendV1Error(res, 400, "validation_error", err.message);
        return;
      }
    }

    try {
      const result = await route.handler({ params: route.params, query: url.searchParams, body });
      if (result === NO_CONTENT) {
        sendNoContent(res);
        return;
      }
      const status = route.status || 200;
      sendJson(res, status, result);
    } catch (err) {
      this._sendError(res, err);
    }
  }

  _sendError(res, err) {
    if (err.code === "NOT_FOUND") {
      sendV1Error(res, 404, "not_found", err.message);
      return;
    }
    if (err.code === "VALIDATION") {
      sendV1Error(res, 400, "validation_error", err.message);
      return;
    }
    debugLogger.error("CLI bridge route error", { error: err.message }, "cli-bridge");
    sendV1Error(res, 500, "internal_error", err.message || "Internal server error");
  }

  _matchRoute(method, pathname) {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const params = route.match(pathname);
      if (params) return { ...route, params };
    }
    return null;
  }

  _buildRouteTable() {
    const exact = (method, path, handler, status) => ({
      method,
      match: (p) => (p === path ? {} : null),
      handler,
      status,
    });
    const param = (method, prefix, suffix, paramName, handler, status) => ({
      method,
      match: (p) => {
        if (!p.startsWith(prefix)) return null;
        const rest = p.slice(prefix.length);
        if (suffix) {
          if (!rest.endsWith(suffix)) return null;
          const value = rest.slice(0, rest.length - suffix.length);
          if (!value || value.includes("/")) return null;
          return { [paramName]: value };
        }
        if (rest.includes("/")) return null;
        return { [paramName]: rest };
      },
      handler,
      status,
    });

    const db = this.ipcHandlers.databaseManager;
    const ipc = this.ipcHandlers;

    const requireId = (params, label) => {
      const id = parseIdParam(params.id);
      if (id == null) {
        const err = new Error(`Invalid ${label} id`);
        err.code = "NOT_FOUND";
        throw err;
      }
      return id;
    };

    const requireQuery = (query) => {
      const q = (query.get("q") || "").trim();
      if (!q) throw validationError("Search query is required");
      return q;
    };

    const requireSuccess = (result, message) => {
      if (!result?.success) {
        const err = new Error(result?.error || message);
        err.code = "NOT_FOUND";
        throw err;
      }
    };

    return [
      exact("GET", "/v1/health", () => ({
        // `version` is frozen at 1 for the out-of-repo CLI, which may assert on it.
        // `mcp` advertises the MCP route surface so the MCP server can tell an app that
        // has those routes from one that answers /v1/notes/list as a note id lookup.
        data: { ok: true, version: 1, mcp: 2 },
      })),
      exact("GET", "/v1/notes/list", ({ query }) => {
        const noteType = query.get("note_type") || null;
        const limit = query.get("limit") ? Number(query.get("limit")) : 100;
        const folderId = query.get("folder_id") ? Number(query.get("folder_id")) : null;
        const notes = db.getNotes(noteType, limit, folderId);
        return { data: notes, has_more: false, next_cursor: null };
      }),
      exact("GET", "/v1/notes/search", ({ query }) => {
        const q = requireQuery(query);
        const limit = numberParam(query, "limit", 20);
        const notes = db.searchNotes(q, limit);
        return {
          data: notes.map((note) => db.toNoteSearchSummary(note)),
          has_more: false,
          next_cursor: null,
        };
      }),
      exact("GET", "/v1/notes/semantic-search", async ({ query }) => {
        const q = requireQuery(query);
        const limit = numberParam(query, "limit", 10);
        const notes = await ipc.semanticSearchNotes(q, limit);
        return {
          data: notes.map((note) => db.toNoteSearchSummary(note)),
          has_more: false,
          next_cursor: null,
        };
      }),
      exact("GET", "/v1/notes/summaries", ({ query }) => {
        const result = db.getNoteSummaries({
          noteType: query.get("note_type") || null,
          folderId: numberParam(query, "folder_id", null, { max: MAX_ID_PARAM }),
          since: query.get("since") || null,
          until: query.get("until") || null,
          limit: numberParam(query, "limit", 20),
        });
        return {
          data: result.notes,
          resolved_range: result.resolved_range,
          has_more: false,
          next_cursor: null,
        };
      }),
      param("GET", "/v1/notes/", "/detail", "id", ({ params, query }) => {
        const id = requireId(params, "note");
        const include = query.get("include");
        return {
          data: db.getNoteDetail(id, {
            include: include ? include.split(",").map((field) => field.trim()) : ["body"],
            maxChars: numberParam(query, "max_chars", 20000, { max: MAX_NOTE_FIELD_CHARS }),
            transcriptOffset: numberParam(query, "transcript_offset", 0, { max: MAX_ID_PARAM }),
            transcriptLimit: numberParam(query, "transcript_limit", 200),
          }),
        };
      }),
      param("GET", "/v1/notes/", "", "id", ({ params }) => {
        const id = requireId(params, "note");
        const note = db.getNote(id);
        if (!note || note.deleted_at) {
          const err = new Error(`Note ${id} not found`);
          err.code = "NOT_FOUND";
          throw err;
        }
        return { data: note };
      }),
      exact(
        "POST",
        "/v1/notes/create",
        ({ body }) => {
          const result = db.saveNote(
            body.title ?? "Untitled Note",
            body.content ?? "",
            body.note_type ?? "personal",
            body.source_file ?? null,
            body.audio_duration_seconds ?? null,
            body.folder_id ?? null
          );
          const note = unwrapMutationResult(result, "note");
          setImmediate(() => ipc.broadcastToWindows("note-added", note));
          ipc._asyncVectorUpsert(note);
          ipc._asyncMirrorWrite(note);
          return { data: note };
        },
        201
      ),
      param("PATCH", "/v1/notes/", "", "id", ({ params, body }) => {
        const id = requireId(params, "note");
        const result = db.updateNote(id, body || {});
        const note = unwrapMutationResult(result, "note");
        setImmediate(() => ipc.broadcastToWindows("note-updated", note));
        ipc._asyncVectorUpsert(note);
        ipc._asyncMirrorWrite(note);
        return { data: note };
      }),
      param("DELETE", "/v1/notes/", "", "id", ({ params }) => {
        const id = requireId(params, "note");
        const result = ipc.deleteNoteInternal(id);
        requireSuccess(result, `Note ${id} not found`);
        return NO_CONTENT;
      }),
      exact("GET", "/v1/folders/list", () => {
        return { data: db.getFolders(), has_more: false, next_cursor: null };
      }),
      exact(
        "POST",
        "/v1/folders/create",
        ({ body }) => {
          const result = db.createFolder(body?.name);
          const folder = unwrapMutationResult(result, "folder");
          setImmediate(() => ipc.broadcastToWindows("folder-created", folder));
          return { data: folder };
        },
        201
      ),
      exact("GET", "/v1/transcriptions/search", ({ query }) => {
        const q = requireQuery(query);
        const limit = numberParam(query, "limit", 10);
        return {
          data: db.searchTranscriptions(q, limit).map((row) => db.toTranscriptionSummary(row)),
          has_more: false,
          next_cursor: null,
        };
      }),
      exact("GET", "/v1/transcripts/search", ({ query }) => {
        const results = db.searchTranscriptSegments({
          query: query.get("q") || null,
          speaker: query.get("speaker") || null,
          noteId: numberParam(query, "note_id", null, { max: MAX_ID_PARAM }),
          since: query.get("since") || null,
          until: query.get("until") || null,
          limit: numberParam(query, "limit", 20),
          offset: numberParam(query, "offset", 0, { max: MAX_ID_PARAM }),
          contextSegments: numberParam(query, "context", 0),
        });
        return { data: results, has_more: false, next_cursor: null };
      }),
      exact("GET", "/v1/people/resolve", ({ query }) => {
        const name = (query.get("name") || "").trim();
        if (!name) throw validationError("A name is required");
        const limit = numberParam(query, "limit", 5);
        return { data: db.resolvePerson(name, limit) };
      }),
      exact("GET", "/v1/people/activity", ({ query }) => {
        const kinds = query.get("kinds");
        return {
          data: db.getPersonActivity({
            personId: query.get("person_id") || null,
            name: query.get("name") || null,
            kinds: kinds ? kinds.split(",").map((kind) => kind.trim()) : undefined,
            since: query.get("since") || null,
            until: query.get("until") || null,
            limit: numberParam(query, "limit", 20),
          }),
        };
      }),
      exact("GET", "/v1/people/list", ({ query }) => {
        return {
          data: db.listPeople({
            sort: query.get("sort") || "mentions",
            limit: numberParam(query, "limit", 25),
          }),
          has_more: false,
          next_cursor: null,
        };
      }),
      exact("GET", "/v1/folders/summaries", () => {
        return { data: db.getFolderSummaries(), has_more: false, next_cursor: null };
      }),
      exact("GET", "/v1/meeting-types/list", () => {
        return { data: db.getMeetingTypeSummaries(), has_more: false, next_cursor: null };
      }),
      exact("GET", "/v1/calendar/events", ({ query }) => {
        return {
          data: db.getCalendarEventsForMcp({
            since: query.get("since") || null,
            until: query.get("until") || null,
            noteId: numberParam(query, "note_id", null, { max: MAX_ID_PARAM }),
            eventId: query.get("event_id") || null,
            limit: numberParam(query, "limit", 20),
          }),
          has_more: false,
          next_cursor: null,
        };
      }),
      exact("GET", "/v1/stats", ({ query }) => {
        return {
          data: db.getStats({
            groupBy: query.get("group_by") || "week",
            since: query.get("since") || null,
            until: query.get("until") || null,
            bySpeaker: query.get("by_speaker") === "1" || query.get("by_speaker") === "true",
          }),
        };
      }),
      exact("GET", "/v1/index/status", () => {
        return { data: db.getSearchIndexStatus() };
      }),
      exact("GET", "/v1/transcriptions/list", ({ query }) => {
        const limit = query.get("limit") ? Number(query.get("limit")) : 50;
        return {
          data: db.getTranscriptions(limit).map((row) => db.toTranscriptionSummary(row)),
          has_more: false,
          next_cursor: null,
        };
      }),
      param("GET", "/v1/transcriptions/", "", "id", ({ params }) => {
        const id = requireId(params, "transcription");
        const transcription = db.getTranscriptionById(id);
        if (!transcription || transcription.deleted_at) {
          const err = new Error(`Transcription ${id} not found`);
          err.code = "NOT_FOUND";
          throw err;
        }
        return { data: transcription };
      }),
      param("DELETE", "/v1/transcriptions/", "", "id", ({ params }) => {
        const id = requireId(params, "transcription");
        const result = ipc.deleteTranscriptionInternal(id);
        requireSuccess(result, `Transcription ${id} not found`);
        return NO_CONTENT;
      }),
      param("DELETE", "/v1/transcriptions/", "/audio", "id", ({ params }) => {
        const id = requireId(params, "transcription");
        const result = ipc.audioStorageManager.deleteAudio(id);
        if (!result?.success) {
          throw new Error(`Failed to delete audio for transcription ${id}`);
        }
        db.updateTranscriptionAudio(id, {
          hasAudio: 0,
          audioDurationMs: null,
          provider: null,
          model: null,
        });
        return NO_CONTENT;
      }),
    ];
  }
}

module.exports = CliBridge;
module.exports.getBridgeFilePath = getBridgeFilePath;
