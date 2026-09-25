const test = require("node:test");
const assert = require("node:assert");

const { classifyInferenceError } = require("../../src/helpers/inferenceErrorClass");
const { runPass } = require("../../src/helpers/inferencePassGuards");

const noSleep = async () => {};

const throwing = (error) => async () => {
  throw error;
};

const memoryError = () => {
  const error = new Error(
    "Not enough memory to load this model: it needs 5.0 GB and only 3.3 GB is usable right now."
  );
  error.code = "LLAMA_INSUFFICIENT_MEMORY";
  return error;
};

test("a memory refusal is fatal, not genuine", () => {
  assert.equal(classifyInferenceError(memoryError()), "fatal");
});

// `genuine` retries twice and then returns { text: null }, which the debrief
// turns into a skipped section -- discarding the code, the numbers and the
// remedy. Only `fatal` reaches the user.
test("a memory refusal propagates instead of becoming a gap marker", async () => {
  let calls = 0;
  const infer = async () => {
    calls++;
    throw memoryError();
  };

  await assert.rejects(
    () => runPass({ infer, prompt: "p", options: {}, sleep: noSleep }),
    (error) => {
      assert.equal(error.code, "LLAMA_INSUFFICIENT_MEMORY");
      assert.match(error.message, /Not enough memory/);
      return true;
    }
  );

  assert.equal(calls, 1, "a fatal failure must not be retried");
});

test("a genuine failure still returns a gap rather than throwing", async () => {
  const error = new Error("context too long");
  error.code = "LOCAL_CONTEXT_EXCEEDED";

  const result = await runPass({
    infer: throwing(error),
    prompt: "p",
    options: {},
    sleep: noSleep,
  });

  assert.equal(result.text, null);
  assert.equal(result.error.code, "LOCAL_CONTEXT_EXCEEDED");
});
