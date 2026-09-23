const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-mcp-client-"));
const bridgeFile = path.join(tmpDir, "cli-bridge.json");
process.env.OPENWHISPR_MCP_BRIDGE_FILE = bridgeFile;

const bridgeClient = require("../../mcp/bridgeClient.js");

function writeBridgeFile(port, token) {
  fs.writeFileSync(bridgeFile, JSON.stringify({ version: 1, port, token }));
}

function removeBridgeFile() {
  try {
    fs.unlinkSync(bridgeFile);
  } catch {}
}

async function withServer(handler, run) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, method: req.method, auth: req.headers.authorization });
    handler(req, res, seen);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await run({ port, seen });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

function okHandler(req, res) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ data: { ok: true } }));
}

test("the server file loads with no dependency outside node: builtins", () => {
  const source = fs.readFileSync(path.join(__dirname, "../../mcp/bridgeClient.js"), "utf8");
  const requires = [...source.matchAll(/require\(\s*"([^"]+)"\s*\)/g)].map((match) => match[1]);

  assert.ok(requires.length > 0);
  for (const specifier of requires) {
    assert.ok(
      specifier.startsWith("node:"),
      `${specifier} would make the MCP server depend on the app bundle it cannot resolve from Resources/mcp/`
    );
  }
});

test("a missing bridge file is a clean message rather than a stack trace", async () => {
  removeBridgeFile();

  const result = await bridgeClient.requestJson("GET", "/v1/health");

  assert.equal(result.ok, false);
  assert.equal(result.error, bridgeClient.messages.NOT_RUNNING);
  assert.ok(!("stack" in result));
});

test("a malformed bridge file is treated as not running", async () => {
  fs.writeFileSync(bridgeFile, "{not json");

  const result = await bridgeClient.requestJson("GET", "/v1/health");

  assert.equal(result.error, bridgeClient.messages.NOT_RUNNING);
});

test("the token is re-read from disk on every call", async () => {
  await withServer(okHandler, async ({ port, seen }) => {
    writeBridgeFile(port, "first-token");
    await bridgeClient.requestJson("GET", "/v1/health");

    writeBridgeFile(port, "second-token");
    await bridgeClient.requestJson("GET", "/v1/health");

    assert.equal(seen[0].auth, "Bearer first-token");
    assert.equal(
      seen[1].auth,
      "Bearer second-token",
      "CliBridge.start regenerates the token on every app launch"
    );
  });
});

test("a refused connection reports the stale-file hint", async () => {
  let deadPort;
  await withServer(okHandler, async ({ port }) => {
    deadPort = port;
  });
  writeBridgeFile(deadPort, "token");

  const result = await bridgeClient.requestJson("GET", "/v1/health");

  assert.equal(result.ok, false);
  assert.equal(result.error, bridgeClient.messages.STALE_BRIDGE);
});

test("a single 401 triggers exactly one re-read and one retry", async () => {
  let calls = 0;
  await withServer(
    (req, res) => {
      calls += 1;
      if (calls === 1) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: "unauthorized", message: "Unauthorized" } }));
        return;
      }
      okHandler(req, res);
    },
    async ({ port, seen }) => {
      writeBridgeFile(port, "stale-token");
      const pending = bridgeClient.requestJson("GET", "/v1/health");
      writeBridgeFile(port, "fresh-token");
      const result = await pending;

      assert.equal(calls, 2, "exactly one retry, never a loop");
      assert.equal(seen[1].auth, "Bearer fresh-token");
      assert.equal(result.ok, true);
    }
  );
});

test("a persistent 401 reports the restart message rather than retrying forever", async () => {
  let calls = 0;
  await withServer(
    (req, res) => {
      calls += 1;
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { code: "unauthorized", message: "Unauthorized" } }));
    },
    async ({ port }) => {
      writeBridgeFile(port, "token");

      const result = await bridgeClient.requestJson("GET", "/v1/health");

      assert.equal(calls, 2);
      assert.equal(result.error, bridgeClient.messages.RESTARTED);
    }
  );
});

test("a hung server times out instead of hanging the agent", async () => {
  await withServer(
    () => {},
    async ({ port }) => {
      writeBridgeFile(port, "token");

      const result = await bridgeClient.requestJson("GET", "/v1/health", { timeoutMs: 50 });

      assert.equal(result.ok, false);
      assert.equal(result.error, bridgeClient.messages.TIMED_OUT);
    }
  );
});

test("a bridge error body is surfaced as its message", async () => {
  await withServer(
    (req, res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { code: "validation_error", message: "Invalid date" } }));
    },
    async ({ port }) => {
      writeBridgeFile(port, "token");

      const result = await bridgeClient.requestJson("GET", "/v1/notes/summaries?since=bad");

      assert.equal(result.ok, false);
      assert.equal(result.error, "Invalid date");
      assert.equal(result.status, 400);
    }
  );
});

test("a successful call returns the parsed payload", async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: 1 }], has_more: false }));
    },
    async ({ port }) => {
      writeBridgeFile(port, "token");

      const result = await bridgeClient.requestJson("GET", "/v1/notes/summaries");

      assert.equal(result.ok, true);
      assert.deepEqual(result.data.data, [{ id: 1 }]);
    }
  );
});

test("a POST body is sent with its content length", async () => {
  await withServer(
    (req, res) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: { echoed: JSON.parse(raw) } }));
      });
    },
    async ({ port }) => {
      writeBridgeFile(port, "token");

      const result = await bridgeClient.requestJson("POST", "/v1/notes/create", {
        body: { title: "From MCP" },
      });

      assert.deepEqual(result.data.data.echoed, { title: "From MCP" });
    }
  );
});
