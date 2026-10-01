const test = require("node:test");
const assert = require("node:assert/strict");

const loadVariant = async () => {
  const module = await import("../../src/helpers/mcpConfigVariant.js");
  return module.mcpConfigVariant;
};

test("the write toggle off selects the read entry", async () => {
  const mcpConfigVariant = await loadVariant();

  assert.equal(mcpConfigVariant({ write: false }), "read");
});

test("the write toggle on selects the write entry", async () => {
  const mcpConfigVariant = await loadVariant();

  assert.equal(mcpConfigVariant({ write: true }), "readWrite");
});

test("an absent toggle selects read, so an unset state never grants write access", async () => {
  const mcpConfigVariant = await loadVariant();

  assert.equal(mcpConfigVariant({}), "read");
  assert.equal(mcpConfigVariant(), "read");
});
