const test = require("node:test");
const assert = require("node:assert");

const { verifyDebriefSection } = require("../../src/helpers/meetingDebriefVerify");

const TRANSCRIPT = [
  "[00:00] You: How did the migration land?",
  "[00:42] Dana: We shipped it in March, two weeks late.",
  "[01:35] You: What slipped?",
].join("\n");

test("a quotation copied from the transcript is left alone", () => {
  const r = verifyDebriefSection('Dana said "we shipped it in March".', TRANSCRIPT);
  assert.equal(r.text, 'Dana said "we shipped it in March".');
  assert.equal(r.unverifiedQuotes, 0);
});

test("a quotation nobody said loses its quotation marks, not its words", () => {
  const r = verifyDebriefSection('Dana said "we shipped it in January".', TRANSCRIPT);
  assert.equal(r.text, "Dana said we shipped it in January.");
  assert.equal(r.unverifiedQuotes, 1);
});
