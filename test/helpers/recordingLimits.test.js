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
