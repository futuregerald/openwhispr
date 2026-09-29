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

// These two are a PAIR. The positive one alone is vacuous: if the matcher never
// sees a newline-spanning quote it reports 0 unverified because it checked
// nothing, and the test passes with the whole quote pass deleted. The negative
// one is what proves the span was actually examined.
test("a line-wrapped quotation that is truthful is returned byte for byte", () => {
  const body = "Dana said “we shipped it\nin March”.";
  const r = verifyDebriefSection(body, TRANSCRIPT);
  assert.equal(r.text, body, "a verified wrapped quotation was altered");
  assert.equal(r.unverifiedQuotes, 0);
});

test("a line-wrapped quotation that is fabricated is still caught", () => {
  const r = verifyDebriefSection("Dana said “we shipped it\nin January”.", TRANSCRIPT);
  assert.equal(r.unverifiedQuotes, 1, "a newline exempted the quotation from checking");
  assert.equal(r.text, "Dana said we shipped it\nin January.");
});

test("punctuation drift does not cost a truthful quotation its marks", () => {
  const body = 'Dana said "we shipped it in March two weeks late".';
  const r = verifyDebriefSection(body, TRANSCRIPT);
  assert.equal(r.unverifiedQuotes, 0, "a dropped comma was read as a fabrication");
  assert.equal(r.text, body);
});

test("an unterminated quotation cannot swallow the rest of the section", () => {
  const body = 'He said "one\ntwo\nthree, and then the meeting moved on.';
  const r = verifyDebriefSection(body, TRANSCRIPT);
  assert.equal(r.text, body);
  assert.equal(r.unverifiedQuotes, 0);
});

test("an elided quotation verifies part by part", () => {
  const r = verifyDebriefSection('Dana said "we shipped it ... two weeks late".', TRANSCRIPT);
  assert.equal(r.unverifiedQuotes, 0);
});

test("an elision with one fabricated half is caught", () => {
  const r = verifyDebriefSection('Dana said "we shipped it ... under budget".', TRANSCRIPT);
  assert.equal(r.unverifiedQuotes, 1);
  assert.equal(r.text, "Dana said we shipped it ... under budget.");
});

test("an unpaired quotation mark is left alone", () => {
  const r = verifyDebriefSection('Dana said "we shipped it in March.', TRANSCRIPT);
  assert.equal(r.text, 'Dana said "we shipped it in March.');
  assert.equal(r.unverifiedQuotes, 0);
});

test("an apostrophe is not a quotation delimiter", () => {
  const r = verifyDebriefSection("Dana's team shipped it; she wasn't late by much.", TRANSCRIPT);
  assert.equal(r.unverifiedQuotes, 0);
  assert.equal(r.text, "Dana's team shipped it; she wasn't late by much.");
});

test("an empty body is returned untouched", () => {
  const r = verifyDebriefSection("", TRANSCRIPT);
  assert.deepEqual(r, { text: "", unverifiedQuotes: 0, invalidTimestamps: 0 });
});

test("a real citation survives", () => {
  const r = verifyDebriefSection("Dana answered at [00:42].", TRANSCRIPT);
  assert.equal(r.text, "Dana answered at [00:42].");
  assert.equal(r.invalidTimestamps, 0);
});

test("a citation of a moment that does not exist is removed", () => {
  const r = verifyDebriefSection("Dana answered at [07:13].", TRANSCRIPT);
  assert.equal(r.text, "Dana answered at.");
  assert.equal(r.invalidTimestamps, 1);
});

test("an unpadded citation of a real moment is canonicalised, not removed", () => {
  const r = verifyDebriefSection("Dana answered at [0:42].", TRANSCRIPT);
  assert.equal(r.text, "Dana answered at [00:42].");
  assert.equal(r.invalidTimestamps, 0);
});

test("an hh:mm:ss citation is rewritten when the moment is real", () => {
  const r = verifyDebriefSection("You asked at [00:01:35].", TRANSCRIPT);
  assert.equal(r.text, "You asked at [01:35].");
  assert.equal(r.invalidTimestamps, 0);
});

test("a bracketed analysis label is not treated as a citation", () => {
  const r = verifyDebriefSection("See [DRIVER] and [the plan](x).", TRANSCRIPT);
  assert.equal(r.text, "See [DRIVER] and [the plan](x).");
  assert.equal(r.invalidTimestamps, 0);
});

test("removing a citation leaves nested list indentation intact", () => {
  const r = verifyDebriefSection("- a\n  - nested [07:13]\n    - deeper", TRANSCRIPT);
  assert.equal(r.invalidTimestamps, 1);
  assert.equal(
    r.text,
    "- a\n  - nested\n    - deeper",
    "the tidy flattened a nested list into three siblings"
  );
});

// Stated, not an oversight: a malformed stamp falls outside CITATION and is left
// alone. Widening the pattern to catch it would also catch ordinary brackets.
test("a malformed stamp is left alone rather than guessed at", () => {
  const r = verifyDebriefSection("Dana answered at [09:99].", TRANSCRIPT);
  assert.equal(r.text, "Dana answered at [09:99].");
  assert.equal(r.invalidTimestamps, 0);
});

// Two trailing spaces are a hard line break in Markdown, so whitespace left
// behind by a removed citation is not cosmetic.
test("a removed citation leaves no trailing whitespace behind", () => {
  const r = verifyDebriefSection("- nested [07:13]\n- next", TRANSCRIPT);
  assert.equal(r.text, "- nested\n- next");
});
