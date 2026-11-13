const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/transcriptOverlay.js");

const lines = (count) =>
  Array.from({ length: count }, (_, i) => ({ id: `stored-${i}`, text: `line ${i}`, timestamp: i }));

test("an overlay with as many lines as the stored transcript still matches", async () => {
  const { overlayStillMatches } = await load();
  assert.equal(overlayStillMatches(JSON.stringify(lines(5)), lines(5)), true);
});

test("an overlay longer than the stored transcript after a cut no longer matches", async () => {
  const { overlayStillMatches } = await load();
  assert.equal(overlayStillMatches(JSON.stringify(lines(3)), lines(8)), false);
});

test("an overlay shorter than the stored transcript does not match", async () => {
  const { overlayStillMatches } = await load();
  assert.equal(overlayStillMatches(JSON.stringify(lines(8)), lines(3)), false);
});

test("a stored transcript emptied to [] does not match a non-empty overlay", async () => {
  const { overlayStillMatches } = await load();
  assert.equal(overlayStillMatches("[]", lines(2)), false);
});

test("a plain-text, blank or missing stored transcript has no line structure to contradict", async () => {
  const { overlayStillMatches } = await load();
  assert.equal(overlayStillMatches("just some words", lines(2)), true);
  assert.equal(overlayStillMatches("", lines(2)), true);
  assert.equal(overlayStillMatches(null, lines(2)), true);
  assert.equal(overlayStillMatches(undefined, lines(2)), true);
});

test("a stored JSON value that is not an array has no line structure to contradict", async () => {
  const { overlayStillMatches } = await load();
  assert.equal(overlayStillMatches('{"a":1}', lines(2)), true);
});

test("a non-array overlay never matches a stored array", async () => {
  const { overlayStillMatches } = await load();
  assert.equal(overlayStillMatches(JSON.stringify(lines(2)), null), false);
});
