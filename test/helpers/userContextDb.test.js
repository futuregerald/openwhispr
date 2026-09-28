const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { requireSqlite } = require("../support/sqlite.js");

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-user-context-db-"));
const originalLoad = Module._load;

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: {
        getPath: () => userDataDir,
        getAppPath: () => process.cwd(),
        isReady: () => false,
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

process.env.NODE_ENV = "test";

const Database = requireSqlite();
const DatabaseManager = require("../../src/helpers/database.js");

// The DDL is exported rather than duplicated here so the schema under test cannot
// drift from the schema that ships. initDatabase() builds ~20 tables plus FTS
// indexes, which is far too much to boot per test.
function managerWithContextTable() {
  const db = new Database(":memory:");
  db.exec(DatabaseManager.USER_CONTEXT_DDL);
  const manager = Object.create(DatabaseManager.prototype);
  manager.db = db;
  return manager;
}

test("user context defaults to empty strings for both keys", () => {
  assert.deepEqual(managerWithContextTable().getUserContext(), { general: "", dictation: "" });
});

test("setUserContext patches one key and leaves the other alone", () => {
  const manager = managerWithContextTable();
  manager.setUserContext({ general: "Team: Molly (PM), Mauricio (SWE)" });
  assert.deepEqual(manager.getUserContext(), {
    general: "Team: Molly (PM), Mauricio (SWE)",
    dictation: "",
  });
  manager.setUserContext({ dictation: "Mauricio Reis, not Maurizio Race" });
  assert.equal(manager.getUserContext().general, "Team: Molly (PM), Mauricio (SWE)");
  assert.equal(manager.getUserContext().dictation, "Mauricio Reis, not Maurizio Race");
});

// Asserts the whole patch is rejected, which pins validation ahead of the
// transaction rather than inside it.
test("an unknown key is rejected, and nothing is written", () => {
  const manager = managerWithContextTable();
  assert.throws(
    () => manager.setUserContext({ general: "kept?", nonsense: "x" }),
    /unknown user context key/i
  );
  assert.deepEqual(manager.getUserContext(), { general: "", dictation: "" });
});
