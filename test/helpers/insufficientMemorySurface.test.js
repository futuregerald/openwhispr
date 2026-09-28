const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..", "..");
const LOCALES = path.join(REPO, "src", "locales");

const read = (p) => fs.readFileSync(path.join(REPO, p), "utf8");

const MESSAGE_KEY = "hooks.audioRecording.errorDescriptions.insufficientMemory";

const localeDirs = () =>
  fs
    .readdirSync(LOCALES, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

test("the dictation path surfaces a memory refusal instead of swallowing it", () => {
  const source = read("src/helpers/audioManager.js");
  assert.match(
    source,
    /if \(error\.code === "LLAMA_INSUFFICIENT_MEMORY"\) \{\s*this\.onError\?\.\(/,
    "the reasoning catch-all must raise an error for a memory refusal, not fall through to raw text"
  );
  assert.ok(source.includes(MESSAGE_KEY));
});

// A key referenced but never defined has shipped from this repo before, and
// i18n:check only compares locales against each other -- it cannot see a key
// that no locale defines.
test("every locale defines the key that path references", () => {
  const dirs = localeDirs();
  assert.ok(dirs.length >= 10, `expected at least 10 locales, found ${dirs.length}`);

  for (const dir of dirs) {
    const file = path.join(LOCALES, dir, "translation.json");
    const resolved = MESSAGE_KEY.split(".").reduce(
      (node, part) => (node == null ? undefined : node[part]),
      JSON.parse(fs.readFileSync(file, "utf8"))
    );
    assert.equal(typeof resolved, "string", `${dir} is missing ${MESSAGE_KEY}`);
    assert.ok(resolved.trim().length > 0, `${dir} has an empty ${MESSAGE_KEY}`);
  }
});

test("the IPC paths carry the code rather than a bare message", () => {
  const source = read("src/helpers/ipcHandlers.js");

  assert.match(
    source,
    /return \{ success: false, error: error\.message, code: error\.code \};/,
    "llama-server-start must forward error.code"
  );
  assert.match(
    source,
    /"Failed to restart server after GPU change",[\s\S]{0,140}return \{ success: false, error: err\.message, code: err\.code \};/,
    "a GPU-change restart that fails must not report success"
  );
});
