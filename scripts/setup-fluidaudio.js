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
 *   node scripts/setup-fluidaudio.js            # build + install (skips when already built from the pinned commit)
 *   node scripts/setup-fluidaudio.js --force    # rebuild even if present
 *
 * Requirements (macOS): Xcode Command Line Tools (`xcode-select --install`) which
 * provide Swift 6+. No full Xcode needed.
 *
 * An override ref (FLUIDAUDIO_REF=<git tag or commit sha, not a branch>) always rebuilds and is not accepted by verify.
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const FLUIDAUDIO_REPO = "https://github.com/FluidInference/FluidAudio.git";
const FLUIDAUDIO_TAG = "v0.15.7";
const FLUIDAUDIO_COMMIT = "41540ea237350afe5117a082b5c28eda642d0612";

const force = process.argv.includes("--force");
const checkOnly = process.argv.includes("--check");
const repoRoot = path.resolve(__dirname, "..");
const binDir = path.join(repoRoot, "resources", "bin");
const binName = `fluidaudio-diarize-${process.platform}-${process.arch}`;
const binPath = path.join(binDir, binName);

function stampFileName(platform, arch) {
  return `.fluidaudio-diarize.${platform}-${arch}.ref`;
}

const stampPath = path.join(binDir, stampFileName(process.platform, process.arch));

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

function readInstalledCommit(dir, platform, arch) {
  try {
    return fs.readFileSync(path.join(dir, stampFileName(platform, arch)), "utf8").trim();
  } catch {
    return null;
  }
}

function resolveBuildTarget(envRef) {
  if (!envRef) {
    return {
      checkoutRef: FLUIDAUDIO_COMMIT,
      expectedCommit: FLUIDAUDIO_COMMIT,
      label: FLUIDAUDIO_TAG,
    };
  }
  if (envRef.startsWith("-")) {
    throw new Error(`FLUIDAUDIO_REF must be a tag or commit, got: ${envRef}`);
  }
  return { checkoutRef: envRef, expectedCommit: null, label: envRef };
}

function shouldBuild({ binaryExists, installedCommit, expectedCommit, force: forceBuild }) {
  return Boolean(
    forceBuild || !binaryExists || !expectedCommit || installedCommit !== expectedCommit
  );
}

function isPinnedEngineInstalled({ binaryExists, installedCommit }) {
  return !binaryExists || installedCommit === FLUIDAUDIO_COMMIT;
}

function staleEngineWarning({ binaryExists, installedCommit }) {
  if (isPinnedEngineInstalled({ binaryExists, installedCommit })) return null;
  const installedLabel = installedCommit || "no stamp";
  return (
    `[fluidaudio] Installed engine (${installedLabel}) does not match the pinned ` +
    `${FLUIDAUDIO_TAG} (${FLUIDAUDIO_COMMIT}). Run: npm run setup:fluidaudio`
  );
}

function dirtyCloneError({ expectedCommit, statusCode, porcelain, buildRoot }) {
  if (!expectedCommit) return null;
  if (statusCode === 0 && !porcelain) return null;
  return (
    `FluidAudio clone at ${buildRoot} has local changes; clean it ` +
    `(git -C ${buildRoot} clean -ffdx -e .build && git -C ${buildRoot} checkout -f ${expectedCommit}) and re-run`
  );
}

function main() {
  if (checkOnly && process.platform !== "darwin") {
    return;
  }

  if (process.platform !== "darwin") {
    log(
      `FluidAudio is macOS-only; skipping on ${process.platform}. OpenWhispr will use sherpa-onnx.`
    );
    return;
  }

  const binaryExists = fs.existsSync(binPath);
  const installedCommit = readInstalledCommit(binDir, process.platform, process.arch);

  if (checkOnly) {
    const warning = staleEngineWarning({ binaryExists, installedCommit });
    if (warning) console.warn(warning);
    return;
  }

  const target = resolveBuildTarget(process.env.FLUIDAUDIO_REF);

  if (
    !shouldBuild({ binaryExists, installedCommit, expectedCommit: target.expectedCommit, force })
  ) {
    log(
      `Already installed at ${installedCommit} (${target.label}): ${path.relative(repoRoot, binPath)} (use --force to rebuild).`
    );
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
    log(`Cloning FluidAudio (${target.label}) into ${buildRoot} ...`);
    run("git", ["clone", FLUIDAUDIO_REPO, buildRoot]);
  }
  log(`Checking out ${target.label} ...`);
  run("git", ["-C", buildRoot, "fetch", "--tags", "--quiet"]);
  run("git", ["-C", buildRoot, "checkout", "--quiet", target.checkoutRef]);

  const headResult = spawnSync("git", ["-C", buildRoot, "rev-parse", "HEAD"], { encoding: "utf8" });
  if (headResult.status !== 0) {
    throw new Error(`git rev-parse HEAD failed: ${headResult.stderr}`);
  }
  const head = headResult.stdout.trim();
  if (target.expectedCommit && head !== target.expectedCommit) {
    throw new Error(
      `FluidAudio ${target.label} resolved to ${head}, expected ${target.expectedCommit}`
    );
  }

  const statusResult = spawnSync("git", ["-C", buildRoot, "status", "--porcelain"], {
    encoding: "utf8",
  });
  const dirtyError = dirtyCloneError({
    expectedCommit: target.expectedCommit,
    statusCode: statusResult.status,
    porcelain: statusResult.stdout,
    buildRoot,
  });
  if (dirtyError) {
    throw new Error(dirtyError);
  }

  log("Building fluidaudiocli (swift build -c release) — first build takes a few minutes ...");
  run("swift", ["build", "-c", "release", "--product", "fluidaudiocli"], { cwd: buildRoot });

  const built = path.join(buildRoot, ".build", "release", "fluidaudiocli");
  if (!fs.existsSync(built)) {
    throw new Error(`Build succeeded but binary not found at ${built}`);
  }

  fs.mkdirSync(binDir, { recursive: true });
  fs.rmSync(stampPath, { force: true });
  fs.copyFileSync(built, binPath);
  fs.chmodSync(binPath, 0o755);

  // Ad-hoc codesign so macOS Gatekeeper lets the local dev run execute it.
  run("codesign", ["-s", "-", "--force", "--timestamp=none", binPath]);

  fs.writeFileSync(stampPath, head);

  log(`Installed ${path.relative(repoRoot, binPath)}`);
  log("Done. FluidAudio will be auto-selected as the diarization engine on this Mac.");
  log("Its CoreML models (~100MB) download automatically on first use.");
}

module.exports = {
  shouldBuild,
  resolveBuildTarget,
  FLUIDAUDIO_TAG,
  FLUIDAUDIO_COMMIT,
  stampFileName,
  staleEngineWarning,
  readInstalledCommit,
  isPinnedEngineInstalled,
  dirtyCloneError,
};

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`[fluidaudio] Setup failed: ${err.message}`);
    console.error("[fluidaudio] OpenWhispr will still work using the sherpa-onnx backend.");
    process.exit(1);
  }
}
