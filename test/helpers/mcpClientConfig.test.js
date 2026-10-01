const test = require("node:test");
const assert = require("node:assert/strict");

const { buildClientConfigs } = require("../../src/helpers/mcpConfig.js");

const SERVER = "/r/mcp/server.js";
const EXEC = "/e/OpenWhispr";

function entry(json) {
  return JSON.parse(json).mcpServers.openwhispr;
}

test("the read entry runs the server with the app's own runtime, not a PATH lookup", () => {
  const { read } = buildClientConfigs({ serverPath: SERVER, execPath: EXEC });

  assert.deepEqual(entry(read), {
    command: EXEC,
    args: [SERVER],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  });
});

test("no entry asks a client to find node on its PATH", () => {
  const configs = buildClientConfigs({ serverPath: SERVER, execPath: EXEC });

  for (const [name, json] of Object.entries(configs)) {
    assert.notEqual(
      entry(json).command,
      "node",
      `${name} would die with spawn node ENOENT in a client launched from the Dock, which does not inherit the shell PATH`
    );
  }
});

test("the read entry carries no write flag", () => {
  const { read } = buildClientConfigs({ serverPath: SERVER, execPath: EXEC });

  assert.ok(
    !read.includes("OPENWHISPR_MCP_WRITE"),
    "the entry a user copies by default must not grant write access"
  );
});

test("the readWrite entry adds the write flag the server checks for, keeping the runtime flag", () => {
  const { readWrite } = buildClientConfigs({ serverPath: SERVER, execPath: EXEC });

  assert.deepEqual(entry(readWrite).env, {
    ELECTRON_RUN_AS_NODE: "1",
    OPENWHISPR_MCP_WRITE: "1",
  });
});

test("a path with a space is carried raw, not shell-quoted", () => {
  const spaced = "/Applications/Open Whispr.app/Contents/Resources/mcp/server.js";
  const spacedExec = "/Applications/Open Whispr.app/Contents/MacOS/OpenWhispr";

  const { read } = buildClientConfigs({ serverPath: spaced, execPath: spacedExec });

  assert.equal(entry(read).args[0], spaced);
  assert.equal(entry(read).command, spacedExec);
  assert.ok(
    !read.includes("'"),
    "a single quote means the shell quoting from buildCommands leaked into the JSON, where it would become part of the path"
  );
});

test("a Windows path survives the round trip with its backslashes intact", () => {
  const windows = "C:\\Users\\g\\AppData\\Local\\Programs\\OpenWhispr\\resources\\mcp\\server.js";
  const windowsExec = "C:\\Users\\g\\AppData\\Local\\Programs\\OpenWhispr\\OpenWhispr.exe";

  const { read } = buildClientConfigs({ serverPath: windows, execPath: windowsExec });

  assert.equal(entry(read).args[0], windows);
  assert.equal(entry(read).command, windowsExec);
});

test("the entry is pretty-printed, because the card renders it as a block to read", () => {
  const { read } = buildClientConfigs({ serverPath: SERVER, execPath: EXEC });

  assert.ok(read.includes('\n  "mcpServers"'), "a single-line blob is unreadable in the card");
});
