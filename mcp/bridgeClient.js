const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const DEFAULT_TIMEOUT_MS = 10000;

const NOT_RUNNING = "OpenWhispr is not running. Start the OpenWhispr app and try again.";
const STALE_BRIDGE =
  "OpenWhispr is not running. Start the OpenWhispr app and try again. (the bridge file is stale; quit and relaunch OpenWhispr)";
const RESTARTED = "OpenWhispr restarted mid-request. Try again.";
const TIMED_OUT = "OpenWhispr did not respond in time. Try again.";

// /v1/health has returned { ok: true, version: 1 } since the CLI bridge shipped, and 1.24.0
// returns exactly that too -- so `version` cannot distinguish a bridge that has the MCP
// routes from one that does not. `mcp` is additive for that reason: bumping `version` would
// be a contract change for the out-of-repo CLI, which may assert on it.
//
// Without this check an older bridge answers /v1/notes/list through its
// param("GET","/v1/notes/","","id") route, parses "list" as an id, and the agent is told
// "Invalid note id" -- which reads as a broken tool rather than an out-of-date app.
const REQUIRED_MCP_CAPABILITY = 2;
const TOO_OLD =
  "This version of OpenWhispr does not support the MCP server. Update OpenWhispr and try again.";

function bridgeFilePath() {
  return (
    process.env.OPENWHISPR_MCP_BRIDGE_FILE ||
    path.join(os.homedir(), ".openwhispr", "cli-bridge.json")
  );
}

function readBridgeFile() {
  try {
    const raw = fs.readFileSync(bridgeFilePath(), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.port !== "number" || typeof parsed.token !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function sendOnce({ method, routePath, body, port, token, timeoutMs }) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: routePath,
        method,
        agent: false,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }
            : {}),
        },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () => {
          let parsed = null;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            resolve({
              ok: false,
              status: response.statusCode,
              error: "OpenWhispr returned a malformed response.",
            });
            return;
          }
          resolve({ ok: response.statusCode < 400, status: response.statusCode, data: parsed });
        });
      }
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy();
      resolve({ ok: false, status: 0, error: TIMED_OUT, timedOut: true });
    });

    request.on("error", (error) => {
      resolve({ ok: false, status: 0, error: error.message, connectionFailed: true });
    });

    if (payload) request.write(payload);
    request.end();
  });
}

async function sendJson(method, routePath, options = {}) {
  const { body = null, timeoutMs = DEFAULT_TIMEOUT_MS } = options;

  const bridge = readBridgeFile();
  if (!bridge) return { ok: false, error: NOT_RUNNING };

  let response = await sendOnce({
    method,
    routePath,
    body,
    port: bridge.port,
    token: bridge.token,
    timeoutMs,
  });

  if (response.timedOut) return { ok: false, error: TIMED_OUT };

  if (response.connectionFailed) {
    const moved = readBridgeFile();
    if (!moved) return { ok: false, error: NOT_RUNNING };
    if (moved.port === bridge.port && moved.token === bridge.token) {
      return { ok: false, error: STALE_BRIDGE };
    }
    response = await sendOnce({
      method,
      routePath,
      body,
      port: moved.port,
      token: moved.token,
      timeoutMs,
    });
    if (response.timedOut) return { ok: false, error: TIMED_OUT };
    if (response.connectionFailed) return { ok: false, error: STALE_BRIDGE };
  }

  if (response.status === 401) {
    const refreshed = readBridgeFile();
    if (!refreshed) return { ok: false, error: NOT_RUNNING };
    response = await sendOnce({
      method,
      routePath,
      body,
      port: refreshed.port,
      token: refreshed.token,
      timeoutMs,
    });
    if (response.timedOut) return { ok: false, error: TIMED_OUT };
    if (response.connectionFailed) return { ok: false, error: STALE_BRIDGE };
    if (response.status === 401) return { ok: false, error: RESTARTED };
  }

  if (!response.ok) {
    const message =
      response.data?.error?.message || response.error || "OpenWhispr returned an error.";
    return { ok: false, error: message, status: response.status };
  }

  return { ok: true, data: response.data };
}

// Only a SUCCESSFUL handshake is cached. The MCP server process is long-lived -- one per
// client session, outliving app restarts -- so caching "not running" or a mismatch would
// leave every tool failing for the rest of the session even after the app came up, which is
// strictly worse than the error this check replaces.
let verifiedBridge = null;
let inFlightCheck = null;

function currentBridgeKey() {
  const bridge = readBridgeFile();
  return bridge ? `${bridge.port}:${bridge.token}` : null;
}

function skipVersionCheck() {
  return process.env.OPENWHISPR_MCP_SKIP_VERSION_CHECK === "1";
}

async function ensureSupportedBridge(timeoutMs) {
  const key = currentBridgeKey();
  if (key && verifiedBridge === key) return { ok: true };
  if (inFlightCheck) return inFlightCheck;

  inFlightCheck = (async () => {
    const response = await sendJson("GET", "/v1/health", { timeoutMs });
    if (!response.ok) return response;
    if (Number(response.data?.data?.mcp ?? 0) < REQUIRED_MCP_CAPABILITY) {
      return { ok: false, error: TOO_OLD };
    }
    verifiedBridge = key;
    return { ok: true };
  })();

  try {
    return await inFlightCheck;
  } finally {
    inFlightCheck = null;
  }
}

async function requestJson(method, routePath, options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS } = options;

  if (!skipVersionCheck()) {
    const supported = await ensureSupportedBridge(timeoutMs);
    if (!supported.ok) return supported;
  }

  return sendJson(method, routePath, options);
}

function _resetVersionCacheForTests() {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("_resetVersionCacheForTests is for tests only; NODE_ENV is not 'test'");
  }
  verifiedBridge = null;
  inFlightCheck = null;
}

module.exports = {
  requestJson,
  _resetVersionCacheForTests,
  readBridgeFile,
  bridgeFilePath,
  messages: { NOT_RUNNING, STALE_BRIDGE, RESTARTED, TIMED_OUT, TOO_OLD },
};
