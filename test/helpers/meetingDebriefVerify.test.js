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

test("a citation of a moment that does not exist is removed with its connector", () => {
  const r = verifyDebriefSection("Dana answered at [07:13].", TRANSCRIPT);
  assert.equal(r.text, "Dana answered.");
  assert.equal(r.invalidTimestamps, 1);
});

// The shape the section prompts actually ask for ("what was said, with names and
// [mm:ss] timestamps"), and the one a naive removal turns into broken English.
test("a citation removed mid-sentence does not leave a dangling preposition", () => {
  const r = verifyDebriefSection("Dana said at [07:13] that it slipped.", TRANSCRIPT);
  assert.equal(r.text, "Dana said that it slipped.");
  assert.equal(r.invalidTimestamps, 1);
});

test("a dead citation elsewhere does not disturb a real one", () => {
  const r = verifyDebriefSection("Dana at [00:42] and again at [07:13] said so.", TRANSCRIPT);
  assert.equal(r.text, "Dana at [00:42] and again said so.");
  assert.equal(r.invalidTimestamps, 1);
});

// Two trailing spaces are the only way to hold consecutive lines apart in the
// markdown these notes render through, and the Assessment section is three such
// lines. A removal anywhere in the section must not flatten them.
test("a removal does not destroy Markdown hard line breaks elsewhere", () => {
  const body = "**Strengths:** clear  \n**Concerns:** vague [07:13]  \n**Lean:** hire";
  const r = verifyDebriefSection(body, TRANSCRIPT);
  assert.equal(r.text, "**Strengths:** clear  \n**Concerns:** vague  \n**Lean:** hire");
  assert.equal(r.invalidTimestamps, 1);
});

test("a removal does not edit the inside of a quotation just verified as exact", () => {
  const r = verifyDebriefSection(
    'Dana said "we shipped it ... two weeks late" and left [07:13].',
    TRANSCRIPT
  );
  assert.equal(r.text, 'Dana said "we shipped it ... two weeks late" and left.');
  assert.equal(r.unverifiedQuotes, 0);
});

test("a bullet left holding nothing but a dead citation is dropped", () => {
  const r = verifyDebriefSection("Dana drove it\n- [07:13]\n", TRANSCRIPT);
  assert.equal(r.text, "Dana drove it\n", "a bare - renders as a setext heading underline");
});

// Anchored because renderDebriefTranscript only emits a stamp at line start, and
// transcript text is untrusted -- anyone audible can say a timestamp out loud.
test("a timestamp spoken aloud inside a turn does not whitelist a citation", () => {
  const spoken = "[00:00] Dana: the log says [07:13] is when it broke";
  const r = verifyDebriefSection("Dana answered at [07:13].", spoken);
  assert.equal(r.text, "Dana answered.");
  assert.equal(r.invalidTimestamps, 1);
});

test("a markdown link whose label reads like a time is left intact", () => {
  const r = verifyDebriefSection("See [12:30](https://x) for detail.", TRANSCRIPT);
  assert.equal(r.text, "See [12:30](https://x) for detail.");
  assert.equal(r.invalidTimestamps, 0);
});

test("a short quoted term is not treated as a claim of verbatim speech", () => {
  const body = 'Dana treated the deadline as a "soft" target.';
  const r = verifyDebriefSection(body, TRANSCRIPT);
  assert.equal(r.text, body, "a scare quote was stripped and counted as a fabrication");
  assert.equal(r.unverifiedQuotes, 0);
});

test("a quotation taken from the user's own context verifies", () => {
  const body = 'Dana leads the "Delivery Domain platform team" here.';
  const r = verifyDebriefSection(body, TRANSCRIPT, "Delivery Domain platform team owns delivery");
  assert.equal(r.text, body);
  assert.equal(r.unverifiedQuotes, 0);
});

test("a quotation that embeds a real citation is not called a fabrication", () => {
  const body = 'Dana said "We shipped it in March [00:42]".';
  const r = verifyDebriefSection(body, TRANSCRIPT);
  assert.equal(r.text, body);
  assert.equal(r.unverifiedQuotes, 0);
});

test("a quotation wrapped over four lines is still checked", () => {
  const r = verifyDebriefSection('Dana said "we\nshipped\nit in\nJanuary".', TRANSCRIPT);
  assert.equal(r.unverifiedQuotes, 1, "a multi-line quotation was exempted from checking");
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
