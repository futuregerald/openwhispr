#!/usr/bin/env node
/**
 * verify-bundled-binaries.js
 *
 * Fails the build (exit 1) if a critical sidecar binary is missing from
 * resources/bin, so a silently-failed download can't ship a broken app (e.g.
 * a packaged app with no llama-server → local AI features error at runtime).
 *
 * Runs at the end of the prebuild/prepack/predist steps, after the downloads
 * and before electron-builder packages the app. macOS-only builds enforce the
 * macOS set; other platforms enforce their own core binaries.
 */
const fs = require("fs");
const path = require("path");

const binDir = path.resolve(__dirname, "..", "resources", "bin");
const platform = process.platform;
const arch = process.arch;
const tag = `${platform}-${arch}`;
const exe = platform === "win32" ? ".exe" : "";

// Binaries downloaded by the prebuild step whose absence breaks a core feature:
// local LLM (llama-server), transcription (whisper-server), diarization
// (sherpa-onnx), and meeting audio echo-cancellation.
const required = [
  `llama-server-${tag}${exe}`,
  `whisper-server-${tag}${exe}`,
  `sherpa-onnx-diarize-${tag}${exe}`,
  `meeting-aec-helper-${tag}${exe}`,
];

// macOS binaries dynamically link these shared libraries — without them the
// binary is present but won't launch, which looks the same as "not found".
if (platform === "darwin") {
  required.push("libllama-server-impl.dylib", "libsherpa-onnx-c-api.dylib");
}

const missing = required.filter((name) => !fs.existsSync(path.join(binDir, name)));

if (missing.length) {
  console.error(
    `\n[verify-binaries] BUILD ABORTED — ${missing.length} required binary(ies) missing ` +
      `from resources/bin (${tag}):\n` +
      missing.map((m) => `  - ${m}`).join("\n") +
      `\n\nThese are fetched by the prebuild step; a download likely failed silently.\n` +
      `Re-run the relevant download (e.g. 'npm run download:llama-server') or the whole\n` +
      `prebuild for your platform, then 'npm run verify:binaries' to confirm before building.\n`
  );
  process.exit(1);
}

console.log(`[verify-binaries] OK — all ${required.length} required binaries present for ${tag}.`);
