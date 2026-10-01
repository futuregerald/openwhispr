const test = require("node:test");
const assert = require("node:assert/strict");

const loadVariant = async () => {
  const module = await import("../../src/helpers/mcpConfigVariant.js");
  return module.mcpConfigVariant;
};

test("both toggles off selects the plain read entry", async () => {
  const mcpConfigVariant = await loadVariant();

  assert.equal(mcpConfigVariant({ fallback: false, write: false }), "read");
});

test("the write toggle alone selects the write entry", async () => {
  const mcpConfigVariant = await loadVariant();

  assert.equal(mcpConfigVariant({ fallback: false, write: true }), "readWrite");
});

test("the no-node toggle alone selects the fallback entry", async () => {
  const mcpConfigVariant = await loadVariant();

  assert.equal(mcpConfigVariant({ fallback: true, write: false }), "fallbackRead");
});

test("both toggles on selects the fallback write entry", async () => {
  const mcpConfigVariant = await loadVariant();

  assert.equal(mcpConfigVariant({ fallback: true, write: true }), "fallbackReadWrite");
});

test("absent toggles select read, so an unset state never grants write access", async () => {
  const mcpConfigVariant = await loadVariant();

  assert.equal(mcpConfigVariant({}), "read");
});
