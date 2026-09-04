const test = require("node:test");
const assert = require("node:assert/strict");

const { LiveSpeakerIdentifier } = require("../../src/helpers/liveSpeakerIdentifier");

// The Silero VAD is an LSTM: its `h`/`c` inputs must be fed back from the
// `new_h`/`new_c` outputs of the previous window or it re-runs cold every 32 ms.
// The shipped rule paired them with `startsWith`, and "newh".startsWith("h") is
// false, so the state was zeroed on every window and the probability never once
// reached Silero's own 0.5 default on real audio. Nothing logged, because the
// pairing failure fell through an `if (output?.data)` guard.

// Mirrors onnxruntime-node: `inputMetadata` is an ARRAY of descriptors, not an
// object keyed by name. A fake that keyed it by name would exercise a shape
// path production never takes.
function fakeSession(inputNames, outputNames, stateShape = [2, 1, 64]) {
  const size = stateShape.reduce((a, b) => a * b, 1);
  const seen = [];
  return {
    inputNames,
    outputNames,
    inputMetadata: inputNames.map((name) => ({
      name,
      isTensor: true,
      type: "float32",
      shape: name === "x" ? [1, 512] : stateShape,
    })),
    seen,
    async run(feeds) {
      seen.push(
        Object.fromEntries(
          inputNames
            .filter((n) => n !== "x" && n !== "sr")
            .map((n) => [n, Array.from(feeds[n].data)])
        )
      );
      // Each run returns state filled with the run index + 1, so a carried
      // state is distinguishable from a zeroed one and from the run before it.
      const stamp = seen.length;
      const out = { [outputNames[0]]: { data: Float32Array.from([0.9]) } };
      for (const name of outputNames.slice(1)) {
        out[name] = { data: new Float32Array(size).fill(stamp) };
      }
      return out;
    },
  };
}

function identifierWith(session) {
  const identifier = new LiveSpeakerIdentifier();
  identifier.session = session;
  identifier.vadStateInputs = session.inputNames.filter((n) => /state|h|c/i.test(n));
  identifier.vadStateOutputs = session.outputNames.filter((n) => /state|h|c/i.test(n));
  identifier._resetVadRuntimeState();
  return identifier;
}

const window512 = () => new Float32Array(512);

for (const [label, inputs, outputs] of [
  ["silero v5 (new_h/new_c)", ["x", "h", "c", "sr"], ["prob", "new_h", "new_c"]],
  ["silero v4 (hn/cn)", ["x", "h", "c", "sr"], ["prob", "hn", "cn"]],
  ["unified state (stateN)", ["x", "state", "sr"], ["prob", "stateN"]],
]) {
  test(`carries recurrent state between windows — ${label}`, async () => {
    const session = fakeSession(inputs, outputs);
    const identifier = identifierWith(session);

    await identifier._getVadProbability(window512());
    await identifier._getVadProbability(window512());

    assert.equal(session.seen.length, 2);
    for (const name of inputs.filter((n) => n !== "x" && n !== "sr")) {
      assert.ok(
        session.seen[0][name].every((v) => v === 0),
        `${name} should start zeroed`
      );
      assert.ok(
        session.seen[1][name].every((v) => v === 1),
        `${name} should carry run 1's output into run 2, got ${session.seen[1][name][0]}`
      );
    }
  });
}

test("pairs by name, not by position, when the outputs are declared out of order", async () => {
  // Position would give h <- new_c. Nothing downstream would notice.
  const session = fakeSession(["x", "h", "c"], ["prob", "new_c", "new_h"]);
  const identifier = identifierWith(session);

  assert.deepEqual(identifier.describeVadStatePairing().pairs, { h: "new_h", c: "new_c" });

  await identifier._getVadProbability(window512());
  await identifier._getVadProbability(window512());
  assert.ok(session.seen[1].h.every((v) => v === 1));
  assert.ok(session.seen[1].c.every((v) => v === 1));
});

test("warns instead of guessing when a state input pairs with nothing", () => {
  // Two state inputs, one state output: positional pairing would silently feed
  // the wrong tensor back, which is the same silent-failure class as the bug.
  const session = fakeSession(["x", "h", "c"], ["prob", "memory"]);
  const identifier = new LiveSpeakerIdentifier();
  identifier.session = session;
  identifier.vadStateInputs = ["h", "c"];
  identifier.vadStateOutputs = ["memory"];

  const problems = identifier.describeVadStatePairing();

  assert.deepEqual(problems.unpaired, ["h", "c"]);
  assert.equal(problems.ok, false);
});

test("reports a clean pairing for the model that actually ships", () => {
  const session = fakeSession(["x", "h", "c", "sr"], ["prob", "new_h", "new_c"]);
  const identifier = identifierWith(session);

  const problems = identifier.describeVadStatePairing();

  assert.equal(problems.ok, true);
  assert.deepEqual(problems.unpaired, []);
  assert.deepEqual(problems.pairs, { h: "new_h", c: "new_c" });
});

test("an unmatched state input leaves its state alone rather than taking a neighbour's", async () => {
  const session = fakeSession(["x", "h", "c"], ["prob", "memory"]);
  const identifier = new LiveSpeakerIdentifier();
  identifier.session = session;
  identifier.vadStateInputs = ["h", "c"];
  identifier.vadStateOutputs = ["memory"];
  identifier._resetVadRuntimeState();

  await identifier._getVadProbability(window512());
  await identifier._getVadProbability(window512());

  for (const name of ["h", "c"]) {
    assert.ok(
      session.seen[1][name].every((v) => v === 0),
      `${name} must not be fed an unrelated tensor`
    );
  }
});
