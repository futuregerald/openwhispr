const test = require("node:test");
const assert = require("node:assert/strict");

const loadModule = () => import("../../src/helpers/splitSafety.js");

const EPOCH_BASE_MS = 1790870467607;
const CLOCK_MS = 1790870467607;

const lines = (stamps) =>
  stamps.map((timestamp, index) => ({
    id: `line-${index}`,
    text: `invented line ${index}`,
    source: "system",
    speaker: "speaker_0",
    timestamp,
  }));

const noteOf = (stamps, extra = {}) => ({
  transcript: JSON.stringify(Array.isArray(stamps) ? lines(stamps) : stamps),
  transcript_origin_ms: CLOCK_MS,
  updated_at: "2026-10-01 12:00:00",
  ...extra,
});

const lastLineSeconds = 600;
const cleanStamps = [4.5, 10.5, 14.3, 120, lastLineSeconds];
const updatedAtMsFor = (note) => Date.parse(`${note.updated_at.replace(" ", "T")}Z`);

test("a relative-seconds note whose clock agrees with its last write is safe", async () => {
  const { splitSafetyOf } = await loadModule();
  const note = noteOf(cleanStamps, {
    transcript_origin_ms: Date.parse("2026-10-01T11:45:00Z"),
  });
  assert.deepEqual(splitSafetyOf(note), { ok: true });
});

test("a relative-seconds note with no clock is safe when nothing else is wrong", async () => {
  const { splitSafetyOf } = await loadModule();
  const note = noteOf(cleanStamps, { transcript_origin_ms: null });
  assert.deepEqual(splitSafetyOf(note), { ok: true });
});

test("a note whose lines are all epoch milliseconds is safe", async () => {
  const { splitSafetyOf } = await loadModule();
  const note = noteOf([EPOCH_BASE_MS, EPOCH_BASE_MS + 5000, EPOCH_BASE_MS + 9000]);
  assert.deepEqual(splitSafetyOf(note), { ok: true });
});

test("plain text is refused as plain-text", async () => {
  const { splitSafetyOf } = await loadModule();
  assert.deepEqual(splitSafetyOf({ transcript: "just a paragraph of words" }), {
    ok: false,
    reason: "plain-text",
  });
  assert.deepEqual(splitSafetyOf({ transcript: "" }), { ok: false, reason: "plain-text" });
  assert.deepEqual(splitSafetyOf({ transcript: null }), { ok: false, reason: "plain-text" });
  assert.deepEqual(splitSafetyOf({ transcript: '{"not":"an array"}' }), {
    ok: false,
    reason: "plain-text",
  });
  assert.deepEqual(splitSafetyOf(null), { ok: false, reason: "plain-text" });
});

test("fewer than two lines is refused as too-short", async () => {
  const { splitSafetyOf } = await loadModule();
  assert.deepEqual(splitSafetyOf(noteOf([5])), { ok: false, reason: "too-short" });
  assert.deepEqual(splitSafetyOf(noteOf([])), { ok: false, reason: "too-short" });
});

test("a line without a finite timestamp is refused as missing-timestamps", async () => {
  const { splitSafetyOf } = await loadModule();
  const stored = lines(cleanStamps);
  delete stored[2].timestamp;
  assert.deepEqual(splitSafetyOf(noteOf(stored)), { ok: false, reason: "missing-timestamps" });

  const stringStamp = lines(cleanStamps);
  stringStamp[1].timestamp = "10.5";
  assert.deepEqual(splitSafetyOf(noteOf(stringStamp)), { ok: false, reason: "missing-timestamps" });
});

test("seconds and epoch milliseconds in one transcript are mixed-units, with or without a clock", async () => {
  const { splitSafetyOf } = await loadModule();
  const stamps = [4.5, 10.5, EPOCH_BASE_MS + 2000, EPOCH_BASE_MS + 9000];
  assert.deepEqual(splitSafetyOf(noteOf(stamps)), { ok: false, reason: "mixed-units" });
  assert.deepEqual(splitSafetyOf(noteOf(stamps, { transcript_origin_ms: null })), {
    ok: false,
    reason: "mixed-units",
  });
});

test("a relative line below zero is refused as negative-offset", async () => {
  const { splitSafetyOf } = await loadModule();
  const note = noteOf([-3, 10.5, 14.3, 120], { transcript_origin_ms: null });
  assert.deepEqual(splitSafetyOf(note), { ok: false, reason: "negative-offset" });
});

test("a clock that puts the last line far past the note's last write is clock-overwritten", async () => {
  const { splitSafetyOf } = await loadModule();
  const note = noteOf(cleanStamps);
  note.transcript_origin_ms = updatedAtMsFor(note) + 5 * 3600 * 1000;
  assert.deepEqual(splitSafetyOf(note), { ok: false, reason: "clock-overwritten" });
});

test("a last line within ten minutes of the last write is still safe", async () => {
  const { splitSafetyOf } = await loadModule();
  const note = noteOf(cleanStamps);
  note.transcript_origin_ms = updatedAtMsFor(note) - lastLineSeconds * 1000 + 9 * 60 * 1000;
  assert.deepEqual(splitSafetyOf(note), { ok: true });

  note.transcript_origin_ms = updatedAtMsFor(note) - lastLineSeconds * 1000 + 11 * 60 * 1000;
  assert.deepEqual(splitSafetyOf(note), { ok: false, reason: "clock-overwritten" });
});

test("epoch-ms lines are not judged by the relative clock rule", async () => {
  const { splitSafetyOf } = await loadModule();
  const note = noteOf([EPOCH_BASE_MS, EPOCH_BASE_MS + 5000], {
    transcript_origin_ms: Date.parse("2026-01-01T00:00:00Z"),
  });
  assert.deepEqual(splitSafetyOf(note), { ok: true });
});

test("an all-epoch transcript with no clock is pending, not ok", async () => {
  const { splitSafetyOf } = await loadModule();
  const note = noteOf([EPOCH_BASE_MS, EPOCH_BASE_MS + 5000, EPOCH_BASE_MS + 9000], {
    transcript_origin_ms: null,
  });
  assert.deepEqual(splitSafetyOf(note), { ok: false, reason: "pending" });
});
