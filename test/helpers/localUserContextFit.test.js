const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-ctx-fit-"));
const originalLoad = Module._load;

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: {
        getPath: () => userDataDir,
        getAppPath: () => process.cwd(),
        isReady: () => false,
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

process.env.NODE_ENV = "test";

const modelManager = require("../../src/helpers/modelManagerBridge").default;

// The cleanup prompt is 2,227 chars (619 tokens) and the input budget at the
// 2048 context floor is 1,228 tokens, so 2,193 chars of dictation is the most
// that fits before any context is added.
const CLEANUP_PROMPT = "C".repeat(2227);
const LONG_DICTATION = "d".repeat(2193);

function stubbedManager({ contextSize }) {
  const sent = [];
  modelManager.ensureInitialized = () => {};
  modelManager.modelsDir = userDataDir;
  modelManager.findModelById = () => ({
    model: { fileName: "fake.gguf", name: "fake" },
    provider: { id: "fake" },
  });
  modelManager.checkModelValid = async () => true;
  modelManager.currentServerModelId = "fake-model";
  modelManager.serverManager = {
    contextSize,
    ready: true,
    isAvailable: () => true,
    inference: async (messages) => {
      sent.push(messages);
      return "ok";
    },
  };
  return sent;
}

test("a dictation context that will not fit is dropped, and the call still runs", async () => {
  const sent = stubbedManager({ contextSize: 2048 });

  const result = await modelManager.runInference("fake-model", LONG_DICTATION, {
    systemPrompt: CLEANUP_PROMPT,
    userContext: "Mauricio Reis, not Maurizio Race",
    userContextKind: "dictation",
  });

  assert.equal(result, "ok", "the call must not be refused");
  assert.equal(sent.length, 1);
  assert.ok(
    !sent[0][0].content.includes("USER CONTEXT"),
    "an over-budget block must never be sent"
  );
  assert.equal(sent[0][0].content, CLEANUP_PROMPT);
});

test("a dictation context that fits is carried in the system message", async () => {
  const sent = stubbedManager({ contextSize: 8192 });

  await modelManager.runInference("fake-model", "hello", {
    systemPrompt: CLEANUP_PROMPT,
    userContext: "Mauricio Reis, not Maurizio Race",
    userContextKind: "dictation",
  });

  assert.match(sent[0][0].content, /Mauricio Reis, not Maurizio Race/);
  assert.match(sent[0][0].content, /END OF USER CONTEXT\./);
});

test("no user context leaves the system message byte-identical", async () => {
  const sent = stubbedManager({ contextSize: 8192 });
  await modelManager.runInference("fake-model", "hello", { systemPrompt: CLEANUP_PROMPT });
  assert.equal(sent[0][0].content, CLEANUP_PROMPT);
});
