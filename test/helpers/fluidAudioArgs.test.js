const test = require("node:test");
const assert = require("node:assert/strict");

const DiarizationManager = require("../../src/helpers/diarization.js");

const { buildFluidAudioArgs, FLUIDAUDIO_OFFLINE_THRESHOLD } = DiarizationManager;
const base = { wavPath: "/tmp/a.wav", outJson: "/tmp/a.json" };

test("offline mode passes the clustering threshold measured against real headcounts", () => {
  assert.equal(FLUIDAUDIO_OFFLINE_THRESHOLD, 0.9);
  const args = buildFluidAudioArgs({ ...base, mode: "offline" });
  const at = args.indexOf("--threshold");
  assert.notEqual(at, -1);
  assert.equal(args[at + 1], "0.9");
});

test("streaming mode does not pass the offline threshold, whose scale it does not share", () => {
  assert.equal(buildFluidAudioArgs({ ...base, mode: "streaming" }).includes("--threshold"), false);
});

// This proves only that the builder has no way to accept a threshold. Forwarding one at the
// call site in _diarizeFluidAudio would not be caught here.
test("the builder has no way to take a caller's threshold", () => {
  const args = buildFluidAudioArgs({ ...base, mode: "offline", threshold: 0.55 });
  assert.equal(args.filter((arg) => arg === "--threshold").length, 1);
  assert.equal(args[args.indexOf("--threshold") + 1], "0.9");
});

test("speaker bounds are passed as before", () => {
  assert.deepEqual(buildFluidAudioArgs({ ...base, mode: "offline", numSpeakers: 3 }).slice(-4), [
    "--min-speakers",
    "3",
    "--max-speakers",
    "3",
  ]);
  assert.deepEqual(buildFluidAudioArgs({ ...base, mode: "offline", maxSpeakers: 6 }).slice(-2), [
    "--max-speakers",
    "6",
  ]);
  assert.deepEqual(buildFluidAudioArgs({ ...base, mode: "streaming", numSpeakers: 3 }).slice(-2), [
    "--num-clusters",
    "3",
  ]);
});
