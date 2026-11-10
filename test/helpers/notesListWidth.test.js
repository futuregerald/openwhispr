const test = require("node:test");
const assert = require("node:assert/strict");

const {
  NOTES_LIST_DEFAULT_WIDTH,
  NOTES_LIST_MIN_WIDTH,
  NOTES_LIST_MAX_WIDTH,
  clampNotesListWidth,
  notesListMaxWidth,
  parseStoredNotesListWidth,
} = require("../../src/helpers/notesListWidth");

test("the default and minimum are the list's original 13rem, so nobody's list shrinks", () => {
  assert.equal(NOTES_LIST_DEFAULT_WIDTH, 208);
  assert.equal(NOTES_LIST_MIN_WIDTH, 208);
  assert.equal(NOTES_LIST_MAX_WIDTH, 560);
});

test("clamps to the minimum and maximum without a container", () => {
  assert.equal(clampNotesListWidth(100), 208);
  assert.equal(clampNotesListWidth(300), 300);
  assert.equal(clampNotesListWidth(900), 560);
});

test("rounds to whole pixels", () => {
  assert.equal(clampNotesListWidth(300.6), 301);
});

test("a non-finite width falls back to the default", () => {
  assert.equal(clampNotesListWidth(NaN), 208);
  assert.equal(clampNotesListWidth(Infinity), 208);
  assert.equal(clampNotesListWidth(-Infinity), 208);
});

test("leaves the editor at least 360px of the container", () => {
  assert.equal(clampNotesListWidth(500, 800), 440);
  assert.equal(clampNotesListWidth(400, 800), 400);
});

test("in a container too narrow for both, the minimum wins over the editor's share", () => {
  assert.equal(clampNotesListWidth(300, 400), 208);
});

test("a container wide enough leaves only the maximum in force", () => {
  assert.equal(clampNotesListWidth(900, 3000), 560);
});

test("an unusable container width is ignored rather than collapsing the list", () => {
  assert.equal(clampNotesListWidth(300, 0), 300);
  assert.equal(clampNotesListWidth(300, NaN), 300);
});

test("parses a stored width, and anything unusable becomes the default", () => {
  assert.equal(parseStoredNotesListWidth(null), 208);
  assert.equal(parseStoredNotesListWidth(""), 208);
  assert.equal(parseStoredNotesListWidth("abc"), 208);
  assert.equal(parseStoredNotesListWidth("320"), 320);
  assert.equal(parseStoredNotesListWidth("9999"), 560);
  assert.equal(parseStoredNotesListWidth("50"), 208);
});

test("the real maximum is the cap without a container", () => {
  assert.equal(notesListMaxWidth(), 560);
  assert.equal(notesListMaxWidth(0), 560);
  assert.equal(notesListMaxWidth(NaN), 560);
});

test("the real maximum leaves the editor its share, but never drops below the minimum", () => {
  assert.equal(notesListMaxWidth(800), 440);
  assert.equal(notesListMaxWidth(400), 208);
  assert.equal(notesListMaxWidth(3000), 560);
});
