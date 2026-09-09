const test = require("node:test");
const assert = require("node:assert/strict");

const AudioStorageManager = require("../../src/helpers/audioStorage");
const { isRetainedAudioFile } = AudioStorageManager;

test("every format the app writes audio in is swept, .pcm included", () => {
  assert.equal(typeof isRetainedAudioFile, "function");

  for (const name of [
    "OpenWhispr-2026-09-09-10-00-00-42.webm",
    "OpenWhispr-meeting-42-2026-09-09-1000-mic.opus",
    "OpenWhispr-meeting-42-2026-09-09-1000-mic.pcm",
    "OpenWhispr-meeting-42-2026-09-09-1000-system.pcm",
  ]) {
    assert.equal(isRetainedAudioFile(name), true, `${name} must be swept`);
  }
});

test("a raw PCM rescued from a failed encode is not left to accumulate forever", () => {
  assert.equal(
    isRetainedAudioFile("OpenWhispr-meeting-42-2026-09-09-1000-mic.pcm"),
    true,
    "the encode-failure path writes .pcm; dropping it from the sweep leaks the disk"
  );
});

test("files the app did not write are left alone", () => {
  for (const name of ["notes.txt", "model.bin", "OpenWhispr-42.webm.tmp", "cover.pcm.txt", ""]) {
    assert.equal(isRetainedAudioFile(name), false, `${name} must not be swept`);
  }
});
