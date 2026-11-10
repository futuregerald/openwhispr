const test = require("node:test");
const assert = require("node:assert/strict");

const { CAP_MS, WARN_LEAD_MS, CALL_ENDED_NOTICE_MS } = require("../../src/helpers/recordingLimits");

test("the recording limits are two hours, a five minute warning and a ten second notice", () => {
  assert.equal(CAP_MS, 2 * 60 * 60 * 1000);
  assert.equal(WARN_LEAD_MS, 5 * 60 * 1000);
  assert.equal(CALL_ENDED_NOTICE_MS, 10 * 1000);
});

test("the warning fires 115 minutes in", () => {
  assert.equal(CAP_MS - WARN_LEAD_MS, 115 * 60 * 1000);
});

const loadWithCap = (value) => {
  const modulePath = require.resolve("../../src/helpers/recordingLimits");
  const previous = process.env.OPENWHISPR_RECORDING_CAP_MS;
  if (value === undefined) delete process.env.OPENWHISPR_RECORDING_CAP_MS;
  else process.env.OPENWHISPR_RECORDING_CAP_MS = value;
  delete require.cache[modulePath];
  try {
    return require(modulePath);
  } finally {
    if (previous === undefined) delete process.env.OPENWHISPR_RECORDING_CAP_MS;
    else process.env.OPENWHISPR_RECORDING_CAP_MS = previous;
    delete require.cache[modulePath];
  }
};

test("a cap override shortens the limit for manual testing, with the warning halfway", () => {
  const limits = loadWithCap("240000");
  assert.equal(limits.CAP_MS, 240000);
  assert.equal(limits.WARN_LEAD_MS, 120000);
});

test("a cap override below two minutes is raised to two minutes", () => {
  const limits = loadWithCap("1000");
  assert.equal(limits.CAP_MS, 120000);
  assert.equal(limits.WARN_LEAD_MS, 60000);
});

test("a missing or unreadable cap override keeps two hours", () => {
  assert.equal(loadWithCap(undefined).CAP_MS, 2 * 60 * 60 * 1000);
  assert.equal(loadWithCap("soon").CAP_MS, 2 * 60 * 60 * 1000);
  assert.equal(loadWithCap("soon").WARN_LEAD_MS, 5 * 60 * 1000);
});
