#!/usr/bin/env node
"use strict";

/**
 * Make `npm test` own its own ABI, the way the packaging scripts already own theirs.
 *
 * One compiled .node file can serve exactly one NODE_MODULE_VERSION, and this
 * checkout has two runtimes competing for it: Electron (145 at the time of
 * writing) and the system node that runs `node --test` (141). Every app-side
 * entry point — build, pack, dev:main, postinstall — already rebuilds for
 * Electron, so running the app after testing repairs itself. The test side had no
 * mirror image, so it failed and told the reader to run `npm rebuild
 * better-sqlite3` by hand. This is that mirror image.
 *
 * It is a probe, not a rebuild: the common case reads a few hundred KB and exits.
 * A rebuild only happens when the binding is genuinely for the other runtime, and
 * the next `npm run build` flips it back on its own.
 *
 * The ABI is read out of the file rather than by requiring the module, because
 * requiring a mismatched binding is the crash this exists to prevent.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

// Only modules locked to a specific NODE_MODULE_VERSION. N-API modules
// (onnxruntime-node, @napi-rs/keyring) are ABI-stable and must not be touched.
const ABI_LOCKED_MODULES = ["better-sqlite3"];

const ROOT = path.join(__dirname, "..");

const bindingPathFor = (name) =>
  path.join(ROOT, "node_modules", name, "build", "Release", `${name.replace(/-/g, "_")}.node`);

function nativeModuleAbi(buffer) {
  const match = buffer.toString("latin1").match(/node_register_module_v(\d+)/);
  return match ? Number(match[1]) : null;
}

/**
 * A null `bindingAbi` on a file that exists means the marker could not be read,
 * which is not evidence of a mismatch — rebuilding on it would recompile before
 * every test run.
 */
function abiActionFor({ bindingExists, bindingAbi, runtimeAbi }) {
  if (!bindingExists) return "rebuild";
  if (bindingAbi === null) return "ok";
  return bindingAbi === runtimeAbi ? "ok" : "rebuild";
}

function readBinding(name) {
  const binding = bindingPathFor(name);
  if (!fs.existsSync(binding)) return { bindingExists: false, bindingAbi: null };
  try {
    return { bindingExists: true, bindingAbi: nativeModuleAbi(fs.readFileSync(binding)) };
  } catch {
    return { bindingExists: true, bindingAbi: null };
  }
}

function main() {
  const runtimeAbi = Number(process.versions.modules);

  for (const name of ABI_LOCKED_MODULES) {
    const { bindingExists, bindingAbi } = readBinding(name);
    if (abiActionFor({ bindingExists, bindingAbi, runtimeAbi }) === "ok") continue;

    console.log(
      `[ensure-node-abi] ${name} is ${bindingExists ? `built for ABI ${bindingAbi}` : "not built"}, ` +
        `but node ${process.version} needs ${runtimeAbi} — rebuilding.`
    );
    // Cleared first for the same reason scripts/rebuild-native-for-electron.js
    // clears it: a rebuild that finds a populated build dir can report success
    // and change nothing.
    fs.rmSync(path.join(ROOT, "node_modules", name, "build"), { recursive: true, force: true });
    execFileSync("npm", ["rebuild", name], { cwd: ROOT, stdio: "inherit" });

    const after = readBinding(name);
    if (abiActionFor({ ...after, runtimeAbi }) !== "ok") {
      throw new Error(
        `[ensure-node-abi] ${name} is still at ABI ${after.bindingAbi} after rebuilding; ` +
          `node ${process.version} needs ${runtimeAbi}. Try: npm rebuild ${name}`
      );
    }
    console.log(`[ensure-node-abi] ${name} rebuilt for ABI ${runtimeAbi}.`);
  }
}

module.exports = { nativeModuleAbi, abiActionFor, bindingPathFor, ABI_LOCKED_MODULES };

if (require.main === module) main();
