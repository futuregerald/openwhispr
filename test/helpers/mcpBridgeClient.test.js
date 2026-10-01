const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-mcp-client-"));
const bridgeFile = path.join(tmpDir, "cli-bridge.json");
process.env.OPENWHISPR_MCP_BRIDGE_FILE = bridgeFile;

// The reset hook below is inert outside a test environment, so this must be set before the
// module is required, as the database tests in this suite already do.
process.env.NODE_ENV = "test";

const bridgeClient = require("../../mcp/bridgeClient.js");

// Most tests here are about transport -- retries, timeouts, payload parsing -- and assert on
// exact request counts, so the handshake probe would corrupt what they measure. They opt out
// of it; the handshake tests below opt back in by deleting this. Doing it per test rather
// than relying on an earlier test having warmed the cache keeps the file order-independent.
test.beforeEach(() => {
  bridgeClient._resetVersionCacheForTests();
  process.env.OPENWHISPR_MCP_SKIP_VERSION_CHECK = "1";
});

test.afterEach(() => {
  delete process.env.OPENWHISPR_MCP_SKIP_VERSION_CHECK;
});

function withHandshake() {
  delete process.env.OPENWHISPR_MCP_SKIP_VERSION_CHECK;
  bridgeClient._resetVersionCacheForTests();
}

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

// Driving the packaged 1.25.0 MCP server against a 1.24.0 bridge told the agent
// "Invalid note id" for list_notes, because the old bridge's param("GET","/v1/notes/","","id")
// route swallows /v1/notes/list and parses "list" as an id. /v1/health has always returned
// version 1, so only an additive capability field can distinguish them.
function healthAwareHandler(mcpValue, onOther) {
  return (req, res) => {
    if (req.url === "/v1/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      const body = { ok: true, version: 1 };
      if (mcpValue !== undefined) body.mcp = mcpValue;
      res.end(JSON.stringify({ data: body }));
      return;
    }
    onOther(req, res);
  };
}

test("a bridge without the mcp capability is reported as too old, not as a route error", async () => {
  withHandshake();
  await withServer(
    healthAwareHandler(undefined, (req, res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Invalid note id" } }));
    }),
    async ({ port }) => {
      writeBridgeFile(port, "tok");
      const result = await bridgeClient.requestJson("GET", "/v1/notes/list");
      assert.equal(result.ok, false);
      assert.match(result.error, /update OpenWhispr/i);
      assert.doesNotMatch(result.error, /Invalid note id/);
    }
  );
});

test("a bridge that advertises the capability is used normally", async () => {
  withHandshake();
  await withServer(healthAwareHandler(3, okHandler), async ({ port, seen }) => {
    writeBridgeFile(port, "tok");
    const first = await bridgeClient.requestJson("GET", "/v1/notes/list");
    assert.equal(first.ok, true);

    const second = await bridgeClient.requestJson("GET", "/v1/notes/list");
    assert.equal(second.ok, true);

    assert.equal(
      seen.filter((entry) => entry.url === "/v1/health").length,
      1,
      "a successful handshake is cached for the process, not re-probed per call"
    );
  });
});

test("concurrent first calls share one handshake probe", async () => {
  withHandshake();
  await withServer(healthAwareHandler(3, okHandler), async ({ port, seen }) => {
    writeBridgeFile(port, "tok");
    const results = await Promise.all(
      Array.from({ length: 5 }, () => bridgeClient.requestJson("GET", "/v1/notes/list"))
    );
    assert.ok(results.every((r) => r.ok));
    assert.equal(
      seen.filter((entry) => entry.url === "/v1/health").length,
      1,
      "five cold-cache tools must not each probe /v1/health"
    );
  });
});

// The MCP server process is long-lived -- one per Claude Code session, outliving app
// restarts. Caching an unreachable bridge would leave every tool broken for the session
// even after the app started, which is worse than the bug the handshake replaces.
// Both of these must run against ONE server. The cache is keyed `${port}:${token}` and
// withServer binds a fresh ephemeral port per call, so two withServer phases would never share
// a key -- the test would pass even if a negative result were cached, which is exactly the
// invariant it exists to pin.
test("an unreachable bridge is never cached, so a later attempt recovers", async () => {
  withHandshake();
  let healthCalls = 0;
  await withServer(
    (req, res) => {
      if (req.url === "/v1/health") {
        healthCalls += 1;
        if (healthCalls === 1) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "starting up" } }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: { ok: true, version: 1, mcp: 3 } }));
        return;
      }
      okHandler(req, res);
    },
    async ({ port }) => {
      writeBridgeFile(port, "tok");

      const cold = await bridgeClient.requestJson("GET", "/v1/notes/list");
      assert.equal(cold.ok, false, "the probe itself failed");

      const warm = await bridgeClient.requestJson("GET", "/v1/notes/list");
      assert.equal(warm.ok, true, "a failed probe must not be cached");
      assert.equal(healthCalls, 2, "the second call has to re-probe, not reuse the failure");
    }
  );
});

test("a version mismatch is never cached, so upgrading mid-session recovers", async () => {
  withHandshake();
  let healthCalls = 0;
  await withServer(
    (req, res) => {
      if (req.url === "/v1/health") {
        healthCalls += 1;
        const body = { ok: true, version: 1 };
        if (healthCalls > 1) body.mcp = 3;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: body }));
        return;
      }
      okHandler(req, res);
    },
    async ({ port }) => {
      writeBridgeFile(port, "tok");

      const stale = await bridgeClient.requestJson("GET", "/v1/notes/list");
      assert.equal(stale.ok, false);
      assert.match(stale.error, /update OpenWhispr/i);

      const upgraded = await bridgeClient.requestJson("GET", "/v1/notes/list");
      assert.equal(upgraded.ok, true, "a mismatch must not be cached");
      assert.equal(healthCalls, 2, "the second call has to re-probe");
    }
  );
});

// In the shipped configuration the server and bridge always ship together, so the check can
// essentially never fire for a user. The one place it does fire is the repo tree driven
// against an installed release -- the loop that found these defects.
test("the check can be skipped for the development loop", async () => {
  withHandshake();
  process.env.OPENWHISPR_MCP_SKIP_VERSION_CHECK = "1";
  try {
    await withServer(healthAwareHandler(undefined, okHandler), async ({ port, seen }) => {
      writeBridgeFile(port, "tok");
      const result = await bridgeClient.requestJson("GET", "/v1/notes/list");
      assert.equal(result.ok, true);
      assert.equal(
        seen.filter((entry) => entry.url === "/v1/health").length,
        0,
        "the probe should not even be issued when the check is skipped"
      );
    });
  } finally {
    delete process.env.OPENWHISPR_MCP_SKIP_VERSION_CHECK;
    bridgeClient._resetVersionCacheForTests();
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

// Task 6: the context, dictionary and speaker routes are capability 3. An app
// that only advertises 2 has none of them, and would answer /v1/context/get
// with a bare 404 -- true but useless. Refuse it with the upgrade message.
test("a bridge at the previous capability level is refused, not probed for routes it lacks", async () => {
  withHandshake();
  await withServer(
    healthAwareHandler(2, (req, res) => {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Not found" } }));
    }),
    async ({ port, seen }) => {
      writeBridgeFile(port, "tok");
      const result = await bridgeClient.requestJson("GET", "/v1/context/get");
      assert.equal(result.ok, false);
      assert.match(result.error, /update/i);
      assert.doesNotMatch(result.error, /Not found/);
      assert.equal(
        seen.filter((entry) => entry.url === "/v1/context/get").length,
        0,
        "the route must not be attempted against a bridge known to lack it"
      );
    }
  );
});

test("a capability above the floor is accepted, so a newer app is not locked out", async () => {
  withHandshake();
  await withServer(healthAwareHandler(4, okHandler), async ({ port }) => {
    writeBridgeFile(port, "tok");
    const result = await bridgeClient.requestJson("GET", "/v1/context/get");
    assert.equal(result.ok, true);
  });
});

// --- per-route capability -------------------------------------------------
// A single floor meant the capability bump refused the WHOLE read surface on an
// app that serves it perfectly well. Someone who has not updated yet should
// still be able to read their notes, and should be told which one thing needs
// the update rather than that MCP is unsupported.

test("an app at the previous capability still serves everything it supports", async () => {
  withHandshake();
  await withServer(healthAwareHandler(2, okHandler), async ({ port }) => {
    writeBridgeFile(port, "tok");
    for (const route of [
      "/v1/notes/list",
      "/v1/notes/search?q=x",
      "/v1/transcripts/search?q=x",
      "/v1/people/list",
      "/v1/stats",
    ]) {
      const result = await bridgeClient.requestJson("GET", route);
      assert.equal(result.ok, true, `${route} should still work on a capability-2 app`);
    }
  });
});

test("only the routes that need the newer app are refused, and they name the feature", async () => {
  withHandshake();
  await withServer(healthAwareHandler(2, okHandler), async ({ port, seen }) => {
    writeBridgeFile(port, "tok");
    const cases = [
      ["GET", "/v1/context/get", /context/i],
      ["POST", "/v1/context/set", /context/i],
      ["GET", "/v1/dictionary/get", /dictionary/i],
      ["POST", "/v1/dictionary/add", /dictionary/i],
      ["POST", "/v1/speakers/rename", /speaker/i],
    ];
    for (const [method, route, feature] of cases) {
      const result = await bridgeClient.requestJson(method, route);
      assert.equal(result.ok, false, `${route} should be refused`);
      assert.match(result.error, feature, `${route} should name what needs the update`);
      assert.match(result.error, /update/i);
      // Not the blanket "does not support the MCP server": the rest works.
      assert.doesNotMatch(result.error, /does not support the MCP server/i);
      assert.equal(
        seen.filter((entry) => entry.url === route).length,
        0,
        `${route} must not be attempted against an app that lacks it`
      );
    }
  });
});

test("an app with no mcp capability at all is still reported as unsupported", async () => {
  withHandshake();
  await withServer(healthAwareHandler(undefined, okHandler), async ({ port }) => {
    writeBridgeFile(port, "tok");
    const result = await bridgeClient.requestJson("GET", "/v1/notes/list");
    assert.equal(result.ok, false);
    assert.match(result.error, /does not support the MCP server/i);
  });
});

test("an app at the current capability serves the new routes", async () => {
  withHandshake();
  await withServer(healthAwareHandler(3, okHandler), async ({ port }) => {
    writeBridgeFile(port, "tok");
    for (const route of ["/v1/context/get", "/v1/dictionary/get"]) {
      const result = await bridgeClient.requestJson("GET", route);
      assert.equal(result.ok, true, `${route} should work on a capability-3 app`);
    }
  });
});

test("the health probe is still made once per bridge, not once per route", async () => {
  withHandshake();
  await withServer(healthAwareHandler(2, okHandler), async ({ port, seen }) => {
    writeBridgeFile(port, "tok");
    await bridgeClient.requestJson("GET", "/v1/notes/list");
    await bridgeClient.requestJson("GET", "/v1/context/get");
    await bridgeClient.requestJson("GET", "/v1/notes/list");
    assert.equal(
      seen.filter((entry) => entry.url === "/v1/health").length,
      1,
      "a refused route must not invalidate the cached capability"
    );
  });
});

test("routeRequirement resolves the default, the listed prefixes and the longest match", () => {
  const { routeRequirement, BASE_MCP_CAPABILITY } = bridgeClient;

  // Anything not listed is the surface that has always worked.
  for (const route of ["/v1/notes/list", "/v1/health", "/v1/stats", "", null]) {
    assert.equal(routeRequirement(route).capability, BASE_MCP_CAPABILITY, `route ${route}`);
    assert.equal(routeRequirement(route).feature, null);
  }

  assert.equal(routeRequirement("/v1/speakers/rename").capability, 3);
  assert.match(routeRequirement("/v1/speakers/rename").feature, /speaker/i);

  // A query string must not defeat the prefix match.
  assert.equal(routeRequirement("/v1/dictionary/get?limit=5").capability, 3);

  // A route that merely CONTAINS a listed prefix later on is not a match.
  assert.equal(
    routeRequirement("/v1/notes/search?q=/v1/context/get").capability,
    BASE_MCP_CAPABILITY
  );
});

// Without this, adding a route and forgetting the map entry puts us back to a
// bare 404 against an older app -- the failure that reads as a broken install.
test("every route the app added above the base capability is in the map", () => {
  const bridgeSource = fs.readFileSync(
    path.join(process.cwd(), "src/helpers/cliBridge.js"),
    "utf8"
  );
  const declared = [
    ...bridgeSource.matchAll(/"(?:GET|POST|PATCH|DELETE)",\s*"(\/v1\/[^"]+)"/g),
  ].map((match) => match[1]);
  assert.ok(declared.length > 20, `only found ${declared.length} routes; the scrape broke`);

  const mapped = bridgeClient.ROUTE_CAPABILITIES.map((entry) => entry.prefix);
  for (const prefix of mapped) {
    assert.ok(
      declared.some((route) => route.startsWith(prefix)),
      `${prefix} is in the capability map but no such route exists`
    );
  }

  // The three families this version added. A new family must be added here and
  // to the map together.
  for (const prefix of ["/v1/context/", "/v1/dictionary/", "/v1/speakers/"]) {
    assert.ok(mapped.includes(prefix), `${prefix} is served but not in the capability map`);
  }
});

// If the app advertises less than its own routes require, it refuses them.
test("the app advertises at least the highest capability any route needs", () => {
  const bridgeSource = fs.readFileSync(
    path.join(process.cwd(), "src/helpers/cliBridge.js"),
    "utf8"
  );
  const advertised = Number(bridgeSource.match(/version: 1, mcp: (\d+)/)?.[1]);
  assert.ok(Number.isInteger(advertised), "could not read the advertised mcp capability");
  const highest = Math.max(
    bridgeClient.BASE_MCP_CAPABILITY,
    ...bridgeClient.ROUTE_CAPABILITIES.map((entry) => entry.capability)
  );
  assert.ok(
    advertised >= highest,
    `the app advertises mcp ${advertised} but its own routes need ${highest}, so it would refuse them`
  );
});

// routeRequirement takes the first matching prefix, which is only well defined
// while no prefix nests inside another. Nesting one would make the answer depend
// on array order, silently.
test("no capability prefix is a prefix of another", () => {
  const prefixes = bridgeClient.ROUTE_CAPABILITIES.map((entry) => entry.prefix);
  for (const a of prefixes) {
    for (const b of prefixes) {
      if (a === b) continue;
      assert.ok(
        !b.startsWith(a),
        `${b} nests inside ${a}; routeRequirement would resolve it by array order`
      );
    }
  }
  assert.ok(prefixes.every((p) => p.startsWith("/v1/") && p.endsWith("/")));
});
