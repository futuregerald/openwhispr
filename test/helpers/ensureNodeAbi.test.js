const test = require("node:test");
const assert = require("node:assert");

const {
  nativeModuleAbi,
  abiActionFor,
  ABI_LOCKED_MODULES,
  bindingPathFor,
} = require("../../scripts/ensure-node-abi");

// The ABI is read out of the compiled file rather than by requiring it, because
// requiring a mismatched binding is exactly the crash this check exists to avoid.
test("the ABI is read out of the binary without loading it", () => {
  assert.equal(nativeModuleAbi(Buffer.from("....node_register_module_v145....", "latin1")), 145);
  assert.equal(nativeModuleAbi(Buffer.from("....node_register_module_v141....", "latin1")), 141);
  assert.equal(nativeModuleAbi(Buffer.from("no marker here", "latin1")), null);
});

test("a binding already built for this runtime is left alone", () => {
  assert.equal(abiActionFor({ bindingExists: true, bindingAbi: 141, runtimeAbi: 141 }), "ok");
});

// The case that sends people to the docs: `npm run build` leaves the binding on
// Electron's ABI, and the next `npm test` cannot load it.
test("a binding built for the other runtime is rebuilt", () => {
  assert.equal(abiActionFor({ bindingExists: true, bindingAbi: 145, runtimeAbi: 141 }), "rebuild");
});

test("a missing binding is rebuilt", () => {
  assert.equal(
    abiActionFor({ bindingExists: false, bindingAbi: null, runtimeAbi: 141 }),
    "rebuild"
  );
});

// An unreadable marker is not evidence of a mismatch. Rebuilding on it would mean
// a needless recompile before every single test run.
test("a binding whose ABI cannot be read is left alone", () => {
  assert.equal(abiActionFor({ bindingExists: true, bindingAbi: null, runtimeAbi: 141 }), "ok");
});

test("only ABI-locked modules are considered", () => {
  assert.deepEqual(ABI_LOCKED_MODULES, ["better-sqlite3"]);
  assert.match(
    bindingPathFor("better-sqlite3"),
    /better-sqlite3\/build\/Release\/better_sqlite3\.node$/
  );
});
