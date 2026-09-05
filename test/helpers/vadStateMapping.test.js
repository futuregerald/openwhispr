const test = require("node:test");
const assert = require("node:assert/strict");

const debugLogger = require("../../src/helpers/debugLogger");
const { LiveSpeakerIdentifier } = require("../../src/helpers/liveSpeakerIdentifier");

// Captures what the identifier warns about, so a silent failure is a test
// failure. The whole point of this file is that a VAD which quietly runs
// stateless looks identical to one that is working.
function captureWarnings(run) {
  const warnings = [];
  const original = debugLogger.warn;
  debugLogger.warn = (message, meta) => warnings.push({ message, meta });
  return Promise.resolve()
    .then(() => run(warnings))
    .finally(() => {
      debugLogger.warn = original;
    });
}

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
      // The i-th state output is scaled by (i + 1) as well, so the two state
      // tensors are distinguishable FROM EACH OTHER. Stamping them identically
      // -- as this fake did -- made a cross-wire invisible: feeding `c` the
      // `new_h` tensor left all 795 tests green, including the one named for
      // pairing by name rather than position.
      const stamp = seen.length;
      const out = { [outputNames[0]]: { data: Float32Array.from([0.9]) } };
      outputNames.slice(1).forEach((name, index) => {
        out[name] = { data: new Float32Array(size).fill(stamp * (index + 1)) };
      });
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

// `afterRun1` is written out literally rather than derived from the pairing the
// code under test reports, so a cross-wire cannot quietly agree with its own
// expectation. The first state output is stamped 1, the second 2.
for (const [label, inputs, outputs, afterRun1] of [
  [
    "new_h/new_c — the bundled export",
    ["x", "h", "c", "sr"],
    ["prob", "new_h", "new_c"],
    { h: 1, c: 2 },
  ],
  ["hn/cn", ["x", "h", "c", "sr"], ["prob", "hn", "cn"], { h: 1, c: 2 }],
  ["state/stateN", ["x", "state", "sr"], ["prob", "stateN"], { state: 1 }],
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
        session.seen[1][name].every((v) => v === afterRun1[name]),
        `${name} should carry its OWN run-1 output (${afterRun1[name]}) into run 2, ` +
          `got ${session.seen[1][name][0]}`
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
  // new_c is declared first and stamped 1; new_h second and stamped 2. Position
  // would give h <- new_c, i.e. h === 1. These two numbers are the whole test.
  assert.ok(session.seen[1].h.every((v) => v === 2), `h took ${session.seen[1].h[0]}`);
  assert.ok(session.seen[1].c.every((v) => v === 1), `c took ${session.seen[1].c[0]}`);
});

test("reports a state input that pairs with nothing", () => {
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
  // silero-vad v4 as exported to ONNX by k2-fsa, per the model file's own note.
  const session = fakeSession(["x", "h", "c", "sr"], ["prob", "new_h", "new_c"]);
  const identifier = identifierWith(session);

  const problems = identifier.describeVadStatePairing();

  assert.equal(problems.ok, true);
  assert.deepEqual(problems.unpaired, []);
  assert.deepEqual(problems.pairs, { h: "new_h", c: "new_c" });
});

test("two inputs claiming one output is reported, not resolved by arrival order", () => {
  // The output list comes from a substring filter, so names that fail to
  // distinguish the state inputs are possible. Pairing the first arrival and
  // moving on would be a coin flip presented as a decision.
  const session = fakeSession(["x", "h", "hc"], ["prob", "hc"]);
  const identifier = new LiveSpeakerIdentifier();
  identifier.session = session;
  identifier.vadStateInputs = ["h", "hc"];
  identifier.vadStateOutputs = ["hc"];

  const pairing = identifier.describeVadStatePairing();

  assert.equal(pairing.ok, false);
  assert.deepEqual(pairing.pairs, {});
  assert.deepEqual(pairing.unpaired.sort(), ["h", "hc"]);
});

test("an output that pairs by name but is the wrong size is not fed back as state", async () => {
  // A probability output named "speech" ends in "h", so it matches state input
  // "h" and survives the /state|h|c/i filter. Its single element would throw at
  // tensor creation on the next window if it were accepted.
  const session = fakeSession(["x", "h"], ["speech"]);
  session.run = async () => ({ speech: { data: Float32Array.from([0.9]) } });
  const identifier = new LiveSpeakerIdentifier();
  identifier.session = session;
  identifier.vadStateInputs = ["h"];
  identifier.vadStateOutputs = ["speech"];
  identifier._resetVadRuntimeState();

  assert.deepEqual(identifier.vadStatePairs.pairs, { h: "speech" });

  const warnings = await captureWarnings(async (collected) => {
    await identifier._getVadProbability(window512());
    await identifier._getVadProbability(window512());
    return collected;
  });

  assert.equal(identifier.vadStates.get("h").length, 2 * 1 * 64);
  assert.ok(identifier.vadStates.get("h").every((v) => v === 0));

  // describeVadStatePairing reports ok:true here -- the names DO pair -- so the
  // load-time warning never fires and this is the only thing standing between a
  // stateless VAD and total silence.
  assert.equal(warnings.length, 1, "warned once, not once per 32 ms window");
  assert.match(warnings[0].message, /stateless/);
  assert.equal(warnings[0].meta.input, "h");
  assert.equal(warnings[0].meta.output, "speech");
  assert.equal(warnings[0].meta.expectedLength, 2 * 1 * 64);
  assert.equal(warnings[0].meta.actualLength, 1);
  assert.equal(identifier.vadStatePairs.ok, true, "the pairing itself is sound by name");
});

test("a clean run warns about nothing", async () => {
  const session = fakeSession(["x", "h", "c", "sr"], ["prob", "new_h", "new_c"]);
  const identifier = identifierWith(session);

  const warnings = await captureWarnings(async (collected) => {
    await identifier._getVadProbability(window512());
    await identifier._getVadProbability(window512());
    return collected;
  });

  assert.deepEqual(warnings, [], "a working VAD must not cry wolf 31 times a second");
});

test("the size-mismatch warning returns for the next meeting", async () => {
  const session = fakeSession(["x", "h"], ["speech"]);
  session.run = async () => ({ speech: { data: Float32Array.from([0.9]) } });
  const identifier = new LiveSpeakerIdentifier();
  identifier.session = session;
  identifier.vadStateInputs = ["h"];
  identifier.vadStateOutputs = ["speech"];

  const perMeeting = async () => {
    identifier._resetVadRuntimeState();
    return captureWarnings(async (collected) => {
      await identifier._getVadProbability(window512());
      await identifier._getVadProbability(window512());
      return collected;
    });
  };

  assert.equal((await perMeeting()).length, 1);
  assert.equal((await perMeeting()).length, 1, "a once-ever flag would hide the second meeting");
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
