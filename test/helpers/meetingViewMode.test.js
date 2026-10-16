const test = require("node:test");
const assert = require("node:assert/strict");

const {
  hasGeneratedNotes,
  defaultNoteViewMode,
  shouldOpenArrivedNotes,
} = require("../../src/helpers/meetingViewMode");

test("a meeting with generated notes opens on them", () => {
  assert.equal(defaultNoteViewMode("meeting", "## TL;DR\n\n- point"), "enhanced");
});

test("a meeting without generated notes opens on the typed notes", () => {
  assert.equal(defaultNoteViewMode("meeting", ""), "raw");
  assert.equal(defaultNoteViewMode("meeting", null), "raw");
  assert.equal(defaultNoteViewMode("meeting", undefined), "raw");
});

test("a personal note keeps opening on what the user typed, even after an action wrote AI text", () => {
  assert.equal(defaultNoteViewMode("personal", "## Rewritten"), "raw");
  assert.equal(defaultNoteViewMode(undefined, "## Rewritten"), "raw");
});

test("whitespace-only or non-string generated notes count as none", () => {
  assert.equal(hasGeneratedNotes("  \n\t "), false);
  assert.equal(hasGeneratedNotes(42), false);
  assert.equal(hasGeneratedNotes({}), false);
  assert.equal(hasGeneratedNotes("x"), true);
  assert.equal(defaultNoteViewMode("meeting", "  \n"), "raw");
});

const arrived = {
  noteType: "meeting",
  hadGeneratedNotes: false,
  hasGeneratedNotes: true,
  viewMode: "raw",
  userChoseView: false,
  isRecording: false,
};

test("notes that finish generating while a meeting is open are shown", () => {
  assert.equal(shouldOpenArrivedNotes(arrived), true);
});

test("the transcript the recording switched to does not hold the view once notes arrive", () => {
  assert.equal(shouldOpenArrivedNotes({ ...arrived, viewMode: "transcript" }), true);
});

test("never moves the view away from a choice the user made", () => {
  assert.equal(shouldOpenArrivedNotes({ ...arrived, userChoseView: true }), false);
});

test("never moves the view during a recording", () => {
  assert.equal(shouldOpenArrivedNotes({ ...arrived, isRecording: true }), false);
});

test("only the first arrival counts, not a later regeneration", () => {
  assert.equal(shouldOpenArrivedNotes({ ...arrived, hadGeneratedNotes: true }), false);
});

test("nothing to show means nothing to open", () => {
  assert.equal(shouldOpenArrivedNotes({ ...arrived, hasGeneratedNotes: false }), false);
});

test("personal notes are left alone", () => {
  assert.equal(shouldOpenArrivedNotes({ ...arrived, noteType: "personal" }), false);
});

test("already on the generated notes is not a switch", () => {
  assert.equal(shouldOpenArrivedNotes({ ...arrived, viewMode: "enhanced" }), false);
});
