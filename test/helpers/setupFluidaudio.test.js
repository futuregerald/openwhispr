const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  shouldBuild,
  resolveBuildTarget,
  FLUIDAUDIO_TAG,
  FLUIDAUDIO_COMMIT,
  stampFileName,
  staleEngineWarning,
  readInstalledCommit,
  isPinnedEngineInstalled,
  dirtyCloneError,
} = require("../../scripts/setup-fluidaudio.js");

test("FLUIDAUDIO_COMMIT is a 40-character lowercase hex sha", () => {
  assert.match(FLUIDAUDIO_COMMIT, /^[0-9a-f]{40}$/);
});

test("resolveBuildTarget defaults to the pinned commit when no env ref is given", () => {
  assert.deepEqual(resolveBuildTarget(undefined), {
    checkoutRef: FLUIDAUDIO_COMMIT,
    expectedCommit: FLUIDAUDIO_COMMIT,
    label: FLUIDAUDIO_TAG,
  });
  assert.deepEqual(resolveBuildTarget(""), {
    checkoutRef: FLUIDAUDIO_COMMIT,
    expectedCommit: FLUIDAUDIO_COMMIT,
    label: FLUIDAUDIO_TAG,
  });
});

test("resolveBuildTarget honours an override ref with no expected commit", () => {
  assert.deepEqual(resolveBuildTarget("v0.16.0"), {
    checkoutRef: "v0.16.0",
    expectedCommit: null,
    label: "v0.16.0",
  });
});

test("resolveBuildTarget rejects an override that looks like a CLI option", () => {
  assert.throws(
    () => resolveBuildTarget("--force"),
    /FLUIDAUDIO_REF must be a tag or commit, got: --force/
  );
  assert.throws(() => resolveBuildTarget("-x"), /FLUIDAUDIO_REF must be a tag or commit, got: -x/);
});

test("stampFileName follows the dotfile marker convention", () => {
  assert.equal(stampFileName("darwin", "arm64"), ".fluidaudio-diarize.darwin-arm64.ref");
});

test("shouldBuild: force always rebuilds", () => {
  assert.equal(
    shouldBuild({
      binaryExists: true,
      installedCommit: FLUIDAUDIO_COMMIT,
      expectedCommit: FLUIDAUDIO_COMMIT,
      force: true,
    }),
    true
  );
});

test("shouldBuild: no binary rebuilds", () => {
  assert.equal(
    shouldBuild({
      binaryExists: false,
      installedCommit: null,
      expectedCommit: FLUIDAUDIO_COMMIT,
      force: false,
    }),
    true
  );
});

test("shouldBuild: no stamp rebuilds", () => {
  assert.equal(
    shouldBuild({
      binaryExists: true,
      installedCommit: null,
      expectedCommit: FLUIDAUDIO_COMMIT,
      force: false,
    }),
    true
  );
});

test("shouldBuild: stamp not matching the expected commit rebuilds", () => {
  assert.equal(
    shouldBuild({
      binaryExists: true,
      installedCommit: "0000000000000000000000000000000000000000",
      expectedCommit: FLUIDAUDIO_COMMIT,
      force: false,
    }),
    true
  );
});

test("shouldBuild: an override with no expected commit rebuilds even with a stamp present", () => {
  assert.equal(
    shouldBuild({
      binaryExists: true,
      installedCommit: FLUIDAUDIO_COMMIT,
      expectedCommit: null,
      force: false,
    }),
    true
  );
});

test("shouldBuild: skips only when the binary exists and the stamp matches the expected commit", () => {
  assert.equal(
    shouldBuild({
      binaryExists: true,
      installedCommit: FLUIDAUDIO_COMMIT,
      expectedCommit: FLUIDAUDIO_COMMIT,
      force: false,
    }),
    false
  );
});

test("isPinnedEngineInstalled: no binary counts as fine (sherpa fallback)", () => {
  assert.equal(isPinnedEngineInstalled({ binaryExists: false, installedCommit: null }), true);
});

test("isPinnedEngineInstalled: stamp equals the pinned commit", () => {
  assert.equal(
    isPinnedEngineInstalled({ binaryExists: true, installedCommit: FLUIDAUDIO_COMMIT }),
    true
  );
});

test("isPinnedEngineInstalled: no stamp is not the pinned engine", () => {
  assert.equal(isPinnedEngineInstalled({ binaryExists: true, installedCommit: null }), false);
});

test("isPinnedEngineInstalled: a different stamp is not the pinned engine", () => {
  assert.equal(
    isPinnedEngineInstalled({
      binaryExists: true,
      installedCommit: "0000000000000000000000000000000000000000",
    }),
    false
  );
});

test("staleEngineWarning: null when no binary is installed", () => {
  assert.equal(staleEngineWarning({ binaryExists: false, installedCommit: null }), null);
});

test("staleEngineWarning: null when the stamp equals the pinned commit", () => {
  assert.equal(
    staleEngineWarning({ binaryExists: true, installedCommit: FLUIDAUDIO_COMMIT }),
    null
  );
});

test("staleEngineWarning: message when the installed engine is stale", () => {
  const message = staleEngineWarning({
    binaryExists: true,
    installedCommit: "0000000000000000000000000000000000000000",
  });
  assert.match(message, /0000000000000000000000000000000000000000/);
  assert.match(message, /v0\.15\.7/);
  assert.match(message, /npm run setup:fluidaudio/);
});

test("staleEngineWarning: message when the binary has no stamp", () => {
  const message = staleEngineWarning({ binaryExists: true, installedCommit: null });
  assert.match(message, /no stamp/);
  assert.match(message, /npm run setup:fluidaudio/);
});

test("readInstalledCommit: missing stamp file returns null", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fluidaudio-test-"));
  assert.equal(readInstalledCommit(tmpDir, "darwin", "arm64"), null);
});

test("readInstalledCommit: trims a trailing newline from the stamp file", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fluidaudio-test-"));
  fs.writeFileSync(path.join(tmpDir, stampFileName("darwin", "arm64")), `${FLUIDAUDIO_COMMIT}\n`);
  assert.equal(readInstalledCommit(tmpDir, "darwin", "arm64"), FLUIDAUDIO_COMMIT);
});

test("dirtyCloneError: pinned commit and a clean clone is fine", () => {
  assert.equal(
    dirtyCloneError({
      expectedCommit: FLUIDAUDIO_COMMIT,
      statusCode: 0,
      porcelain: "",
      buildRoot: "/tmp/fluidaudio-src",
    }),
    null
  );
});

test("dirtyCloneError: pinned commit and porcelain output is dirty", () => {
  const message = dirtyCloneError({
    expectedCommit: FLUIDAUDIO_COMMIT,
    statusCode: 0,
    porcelain: " M Sources/foo.swift\n",
    buildRoot: "/tmp/fluidaudio-src",
  });
  assert.match(message, /has local changes/);
  assert.match(message, /\/tmp\/fluidaudio-src/);
  assert.match(message, /git -C \/tmp\/fluidaudio-src clean -ffdx -e \.build/);
});

test("dirtyCloneError: pinned commit and a non-zero git status exit is dirty", () => {
  const message = dirtyCloneError({
    expectedCommit: FLUIDAUDIO_COMMIT,
    statusCode: 1,
    porcelain: "",
    buildRoot: "/tmp/fluidaudio-src",
  });
  assert.match(message, /has local changes/);
});

test("dirtyCloneError: an override with no expected commit skips the check even when dirty", () => {
  assert.equal(
    dirtyCloneError({
      expectedCommit: null,
      statusCode: 0,
      porcelain: " M Sources/foo.swift\n",
      buildRoot: "/tmp/fluidaudio-src",
    }),
    null
  );
});
