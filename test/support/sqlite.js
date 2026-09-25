const BINDING_FAILURE_HINTS = ["NODE_MODULE_VERSION", "Could not locate the bindings file"];

function isNativeBindingUnavailable(error) {
  if (!error) return false;
  const message = String(error.message || error);
  return BINDING_FAILURE_HINTS.some((hint) => message.includes(hint));
}

function describeBindingFailure(error) {
  return [
    "better-sqlite3 could not be loaded, so the database tests cannot run.",
    "",
    "These tests used to call t.skip() here, which made a broken native binding",
    "look like a passing suite. They now fail instead. Two known causes:",
    "",
    "  1. The binding was rebuilt for Electron's ABI. `npm run build`, `npm run pack`,",
    "     `npm run dev:main` and `postinstall` all run `electron-builder install-app-deps`.",
    "  2. The binding was never built at all, e.g. `npm ci --ignore-scripts`.",
    "",
    "`npm test` repairs both cases on its own via its pretest hook, so seeing this",
    "means node --test was driven directly, bypassing npm.",
    "",
    "Fix either case with:            npm rebuild better-sqlite3",
    "To run the Electron app again:   npm run rebuild:native",
    "",
    `Original error: ${String(error?.message || error)}`,
  ].join("\n");
}

function requireSqlite() {
  let Database;
  try {
    Database = require("better-sqlite3");
    const probe = new Database(":memory:");
    probe.close();
  } catch (error) {
    if (isNativeBindingUnavailable(error)) {
      throw new Error(describeBindingFailure(error), { cause: error });
    }
    throw error;
  }
  return Database;
}

module.exports = { isNativeBindingUnavailable, describeBindingFailure, requireSqlite };
