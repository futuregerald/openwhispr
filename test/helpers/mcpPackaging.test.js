const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const repoRoot = path.join(__dirname, "../..");
const {
  getMcpConfig,
  resolveExecPath,
  WRITE_ENV_VAR,
} = require("../../src/helpers/mcpConfig.js");

test("the mcp directory ships as extraResources, outside the asar", () => {
  const config = JSON.parse(fs.readFileSync(path.join(repoRoot, "electron-builder.json"), "utf8"));

  const entry = config.extraResources.find(
    (item) => typeof item === "object" && item.from === "mcp/"
  );

  assert.ok(entry, "mcp/ must be in extraResources or the server is not shipped at all");
  assert.equal(entry.to, "mcp/");

  const files = Array.isArray(config.files) ? config.files : [];
  assert.ok(
    !files.some((pattern) => typeof pattern === "string" && pattern.startsWith("mcp/")),
    "files only shapes the asar; adding mcp/ there would bundle a second unreachable copy"
  );
});

test("every file the server needs at runtime exists on disk", () => {
  for (const file of ["mcp/server.js", "mcp/tools.js", "mcp/bridgeClient.js"]) {
    assert.ok(fs.existsSync(path.join(repoRoot, file)), `${file} is missing`);
  }
});

test("the mcp directory carries no node_modules or package.json to resolve", () => {
  const entries = fs.readdirSync(path.join(repoRoot, "mcp"));

  assert.ok(!entries.includes("node_modules"));
  assert.ok(
    !entries.includes("package.json"),
    "a package.json here would invite a dependency the server cannot resolve from Resources/mcp/"
  );
});

test("a packaged config points at the resources copy of the server", () => {
  const resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-resources-"));
  fs.mkdirSync(path.join(resourcesPath, "mcp"));
  fs.writeFileSync(path.join(resourcesPath, "mcp", "server.js"), "");

  const config = getMcpConfig({
    resourcesPath,
    appPath: repoRoot,
    isPackaged: true,
    platform: "darwin",
    execPath: "/Applications/OpenWhispr.app/Contents/MacOS/OpenWhispr",
  });

  assert.equal(config.serverPath, path.join(resourcesPath, "mcp", "server.js"));
  assert.equal(config.writeEnvVar, WRITE_ENV_VAR);
});

test("a development config points at the working tree", () => {
  const config = getMcpConfig({
    resourcesPath: "/nonexistent",
    appPath: repoRoot,
    isPackaged: false,
    platform: "darwin",
    execPath: "/usr/local/bin/electron",
  });

  assert.equal(config.serverPath, path.join(repoRoot, "mcp", "server.js"));
});

test("the copyable commands carry -s user so the server works outside one directory", () => {
  const config = getMcpConfig({
    resourcesPath: null,
    appPath: repoRoot,
    isPackaged: false,
    platform: "darwin",
    execPath: "/usr/local/bin/electron",
  });

  assert.match(config.commands.read, /^claude mcp add openwhispr -s user -- node /);
  assert.ok(
    !config.commands.read.includes(WRITE_ENV_VAR),
    "the default command must be read-only"
  );
  assert.match(config.commands.readWrite, /-e OPENWHISPR_MCP_WRITE=1/);
  assert.match(config.commands.fallbackRead, /-e ELECTRON_RUN_AS_NODE=1/);
  assert.equal(config.commands.remove, "claude mcp remove openwhispr -s user");
});

test("paths are single-quoted so shell metacharacters in an install path cannot execute", () => {
  const resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr res "));
  fs.mkdirSync(path.join(resourcesPath, "mcp"));
  fs.writeFileSync(path.join(resourcesPath, "mcp", "server.js"), "");

  const config = getMcpConfig({
    resourcesPath,
    isPackaged: true,
    platform: "darwin",
    execPath: "/Applications/Open Whispr.app/Contents/MacOS/OpenWhispr",
  });

  assert.match(config.commands.read, /-- node '/);
  assert.match(config.commands.fallbackRead, /-- '\/Applications\/Open Whispr\.app/);

  // The invariant is that the path argument is one single-quoted span with no
  // unescaped quote inside it. Inside single quotes a POSIX shell expands nothing,
  // so $(...) and backticks are inert; double quotes would have expanded both.
  for (const hostile of ["/tmp/$(touch /tmp/pwned) dir", "/tmp/`id` dir", "/tmp/it's here"]) {
    const injected = getMcpConfig({
      resourcesPath: null,
      appPath: hostile,
      isPackaged: false,
      platform: "darwin",
      execPath: "/usr/local/bin/electron",
    });
    const argument = injected.commands.read.split("-- node ")[1];

    assert.ok(argument.startsWith("'") && argument.endsWith("'"), `${hostile} was not quoted`);
    assert.ok(
      !argument.slice(1, -1).includes("'") || argument.includes("'\\''"),
      `an unescaped quote in ${hostile} would close the span early and expose the rest`
    );
  }
});

test("an AppImage uses APPIMAGE because execPath points into an ephemeral mount", () => {
  assert.equal(
    resolveExecPath({
      platform: "linux",
      execPath: "/tmp/.mount_OpenWhXYZ/openwhispr",
      appImagePath: "/home/gerald/Apps/OpenWhispr.AppImage",
    }),
    "/home/gerald/Apps/OpenWhispr.AppImage"
  );

  assert.equal(
    resolveExecPath({
      platform: "linux",
      execPath: "/usr/bin/openwhispr",
      appImagePath: null,
    }),
    "/usr/bin/openwhispr",
    "a deb or rpm install has a stable execPath"
  );

  assert.equal(
    resolveExecPath({
      platform: "darwin",
      execPath: "/Applications/OpenWhispr.app/Contents/MacOS/OpenWhispr",
      appImagePath: "/should/be/ignored",
    }),
    "/Applications/OpenWhispr.app/Contents/MacOS/OpenWhispr"
  );
});
