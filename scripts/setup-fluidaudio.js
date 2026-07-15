#!/usr/bin/env node
/**
 * setup-fluidaudio.js
 *
 * Builds the FluidAudio CLI (Swift/CoreML) and installs it into resources/bin as
 * `fluidaudio-diarize-<platform>-<arch>`, the optional macOS diarization backend
 * (see src/helpers/diarization.js and docs/FLUIDAUDIO-INTEGRATION.md).
 *
 * FluidAudio is macOS-only (CoreML / Apple Neural Engine). On other platforms this
 * script is a no-op and OpenWhispr uses the cross-platform sherpa-onnx backend.
 *
 * Usage:
 *   node scripts/setup-fluidaudio.js            # build + install (skips if present)
 *   node scripts/setup-fluidaudio.js --force    # rebuild even if present
 *
 * Requirements (macOS): Xcode Command Line Tools (`xcode-select --install`) which
 * provide Swift 6+. No full Xcode needed.
 *
 * Override the pinned version with FLUIDAUDIO_REF=<git tag/branch/sha>.
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const FLUIDAUDIO_REPO = "https://github.com/FluidInference/FluidAudio.git";
const FLUIDAUDIO_REF = process.env.FLUIDAUDIO_REF || "v0.15.5";

const force = process.argv.includes("--force");
const repoRoot = path.resolve(__dirname, "..");
const binDir = path.join(repoRoot, "resources", "bin");
const binName = `fluidaudio-diarize-${process.platform}-${process.arch}`;
const binPath = path.join(binDir, binName);

function log(msg) {
  console.log(`[fluidaudio] ${msg}`);
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited with code ${res.status}`);
  }
}

function which(cmd) {
  const res = spawnSync("command", ["-v", cmd], { shell: true, encoding: "utf8" });
  return res.status === 0 ? res.stdout.trim() : null;
}

function main() {
  if (process.platform !== "darwin") {
    log(`FluidAudio is macOS-only; skipping on ${process.platform}. OpenWhispr will use sherpa-onnx.`);
    return;
  }

  if (fs.existsSync(binPath) && !force) {
    log(`Already installed: ${path.relative(repoRoot, binPath)} (use --force to rebuild).`);
    return;
  }

  if (!which("swift")) {
    console.error(
      "[fluidaudio] Swift not found. Install the Xcode Command Line Tools:\n" +
        "    xcode-select --install\n" +
        "  Then re-run: npm run setup:fluidaudio\n" +
        "  (Optional: OpenWhispr still works without FluidAudio, using sherpa-onnx.)"
    );
    process.exit(1);
  }

  const buildRoot = path.join(os.homedir(), ".cache", "openwhispr", "fluidaudio-src");
  fs.mkdirSync(path.dirname(buildRoot), { recursive: true });

  if (!fs.existsSync(path.join(buildRoot, ".git"))) {
    log(`Cloning FluidAudio (${FLUIDAUDIO_REF}) into ${buildRoot} ...`);
    run("git", ["clone", FLUIDAUDIO_REPO, buildRoot]);
  }
  log(`Checking out ${FLUIDAUDIO_REF} ...`);
  run("git", ["-C", buildRoot, "fetch", "--tags", "--quiet"]);
  run("git", ["-C", buildRoot, "checkout", "--quiet", FLUIDAUDIO_REF]);

  log("Building fluidaudiocli (swift build -c release) — first build takes a few minutes ...");
  run("swift", ["build", "-c", "release", "--product", "fluidaudiocli"], { cwd: buildRoot });

  const built = path.join(buildRoot, ".build", "release", "fluidaudiocli");
  if (!fs.existsSync(built)) {
    throw new Error(`Build succeeded but binary not found at ${built}`);
  }

  fs.mkdirSync(binDir, { recursive: true });
  fs.copyFileSync(built, binPath);
  fs.chmodSync(binPath, 0o755);

  // Ad-hoc codesign so macOS Gatekeeper lets the local dev run execute it.
  run("codesign", ["-s", "-", "--force", "--timestamp=none", binPath]);

  log(`Installed ${path.relative(repoRoot, binPath)}`);
  log("Done. FluidAudio will be auto-selected as the diarization engine on this Mac.");
  log("Its CoreML models (~100MB) download automatically on first use.");
}

try {
  main();
} catch (err) {
  console.error(`[fluidaudio] Setup failed: ${err.message}`);
  console.error("[fluidaudio] OpenWhispr will still work using the sherpa-onnx backend.");
  process.exit(1);
}
