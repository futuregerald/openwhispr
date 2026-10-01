const test = require("node:test");
const assert = require("node:assert/strict");

const { buildClientConfigs } = require("../../src/helpers/mcpConfig.js");

const SERVER = "/r/mcp/server.js";
const EXEC = "/e/OpenWhispr";

function entry(json) {
  return JSON.parse(json).mcpServers.openwhispr;
}

test("the read entry is valid JSON that runs the server under node", () => {
  const { read } = buildClientConfigs({ serverPath: SERVER, execPath: EXEC });

  assert.deepEqual(entry(read), { command: "node", args: [SERVER] });
});

test("the read entry carries no write flag", () => {
  const { read } = buildClientConfigs({ serverPath: SERVER, execPath: EXEC });

  assert.ok(
    !read.includes("OPENWHISPR_MCP_WRITE"),
    "the entry a user copies by default must not grant write access"
  );
});

test("the readWrite entry sets the write flag to the string the server checks for", () => {
  const { readWrite } = buildClientConfigs({ serverPath: SERVER, execPath: EXEC });

  assert.deepEqual(entry(readWrite).env, { OPENWHISPR_MCP_WRITE: "1" });
});

test("the fallback entry runs the app binary as node instead of requiring node", () => {
  const { fallbackRead } = buildClientConfigs({ serverPath: SERVER, execPath: EXEC });

  assert.deepEqual(entry(fallbackRead), {
    command: EXEC,
    args: [SERVER],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  });
});

test("the fallback write entry carries both environment variables", () => {
  const { fallbackReadWrite } = buildClientConfigs({ serverPath: SERVER, execPath: EXEC });

  assert.deepEqual(entry(fallbackReadWrite).env, {
    ELECTRON_RUN_AS_NODE: "1",
    OPENWHISPR_MCP_WRITE: "1",
  });
});

test("a path with a space is carried raw, not shell-quoted", () => {
  const spaced = "/Applications/Open Whispr.app/Contents/Resources/mcp/server.js";

  const { read, fallbackRead } = buildClientConfigs({
    serverPath: spaced,
    execPath: "/Applications/Open Whispr.app/Contents/MacOS/OpenWhispr",
  });

  assert.equal(entry(read).args[0], spaced);
  assert.ok(
    !read.includes("'"),
    "a single quote means the shell quoting from buildCommands leaked into the JSON, where it would become part of the path"
  );
  assert.equal(entry(fallbackRead).command, "/Applications/Open Whispr.app/Contents/MacOS/OpenWhispr");
});

test("a Windows path survives the round trip with its backslashes intact", () => {
  const windows = "C:\\Users\\g\\AppData\\Local\\Programs\\OpenWhispr\\resources\\mcp\\server.js";

  const { read } = buildClientConfigs({ serverPath: windows, execPath: "C:\\x\\OpenWhispr.exe" });

  assert.equal(entry(read).args[0], windows);
});

test("the entry is pretty-printed, because the card renders it as a block to read", () => {
  const { read } = buildClientConfigs({ serverPath: SERVER, execPath: EXEC });

  assert.ok(read.includes('\n  "mcpServers"'), "a single-line blob is unreadable in the card");
});
