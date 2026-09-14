const test = require("node:test");
const assert = require("node:assert/strict");

const {
  foldMinorSpeakers,
  MIN_SPEAKER_SECONDS,
  MIN_SPEAKER_SHARE,
} = require("../../src/helpers/foldMinorSpeakers");

const seg = (speaker, start, end) => ({ speaker, start, end });
const speakers = (segments) => [...new Set(segments.map((s) => s.speaker))].sort();

// Every fixture below relies on the floor being min(30 s, 30% of total speech):
// "joins the nearest" 102 s -> 30; "summed" 100 s -> 30; note 41 shape 36 s -> 10.8,
// only `a` (19) clears it; short two-person 45 s -> 13.5, both clear it; "every
// speaker under" 36.5 s -> 10.95, none clears it; the boundary pair 129.9 s / 130 s -> 30.

test("a speaker with less than the floor of speech joins the nearest real speaker", () => {
  const input = [seg("a", 0, 40), seg("phantom", 41, 43), seg("b", 100, 160)];

  const folded = foldMinorSpeakers(input);

  assert.deepEqual(speakers(folded), ["a", "b"]);
  assert.equal(folded[1].speaker, "a", "41-43 s sits next to a, not b");
  assert.deepEqual([folded[1].start, folded[1].end], [41, 43], "timing is untouched");
});

test("seconds are summed across a speaker's segments before comparing with the floor", () => {
  const input = [seg("a", 0, 60), seg("b", 100, 120), seg("b", 200, 220)];

  assert.deepEqual(speakers(foldMinorSpeakers(input)), ["a", "b"], "b has 40 s in total");
});

test("one voice split four ways, as in note 41, folds to one", () => {
  const input = [seg("a", 0, 19), seg("b", 30, 40), seg("c", 50, 54), seg("d", 60, 63)];

  assert.deepEqual(speakers(foldMinorSpeakers(input)), ["a"]);
});

test("a short two-person recording keeps both people", () => {
  const input = [seg("a", 0, 25), seg("b", 26, 46)];

  assert.deepEqual(speakers(foldMinorSpeakers(input)), ["a", "b"], "45 s total, b speaks 20 s");
});

test("when every speaker is under the floor, the one with the most speech is kept", () => {
  const input = [seg("a", 0, 9.5), seg("b", 10, 19), seg("c", 20, 29), seg("d", 30, 39)];

  assert.deepEqual(speakers(foldMinorSpeakers(input)), ["a"]);
});

test("30 s sits between the measured phantoms and the measured people", () => {
  assert.equal(MIN_SPEAKER_SECONDS, 30);
  assert.equal(MIN_SPEAKER_SHARE, 0.3);
  const justUnder = [seg("a", 0, 100), seg("b", 200, 229.9)];
  const atFloor = [seg("a", 0, 100), seg("b", 200, 230)];

  assert.deepEqual(speakers(foldMinorSpeakers(justUnder)), ["a"]);
  assert.deepEqual(speakers(foldMinorSpeakers(atFloor)), ["a", "b"]);
});

test("segment order and count are preserved and the input is not mutated", () => {
  const input = [seg("b", 100, 160), seg("phantom", 95, 97), seg("a", 0, 60)];
  const before = JSON.stringify(input);

  const folded = foldMinorSpeakers(input);

  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(
    folded.map((s) => s.start),
    [100, 95, 0]
  );
});

test("empty and non-array input is returned as given", () => {
  assert.deepEqual(foldMinorSpeakers([]), []);
  assert.equal(foldMinorSpeakers(null), null);
});

const DiarizationManager = require("../../src/helpers/diarization.js");

test("every diarization the manager runs comes back with phantom speakers folded", async () => {
  const manager = Object.create(DiarizationManager.prototype);
  manager.getDiarizationEngine = () => "fluidaudio";
  manager.getFluidAudioBinaryPath = () => "/bin/fluidaudio";
  manager._diarizeFluidAudio = async () => [seg("speaker_1", 0, 60), seg("speaker_2", 61, 63)];

  const segments = await manager._diarizeNow("/tmp/a.wav", {});

  assert.deepEqual(speakers(segments), ["speaker_1"]);
});

test("the sherpa fallback is folded too", async () => {
  const manager = Object.create(DiarizationManager.prototype);
  manager.getDiarizationEngine = () => "sherpa";
  manager._diarizeSherpa = async () => [seg("speaker_0", 0, 60), seg("speaker_1", 61, 63)];

  const segments = await manager._diarizeNow("/tmp/a.wav", {});

  assert.deepEqual(speakers(segments), ["speaker_0"]);
});

// Upload forwards a user-chosen exact count (fileTranscription.ts -> diarize-audio-file ->
// --min-speakers N --max-speakers N). Folding after the engine honoured it would silently
// undo the setting.
test("an exact speaker count the user asked for is never folded", async () => {
  const manager = Object.create(DiarizationManager.prototype);
  manager.getDiarizationEngine = () => "fluidaudio";
  manager.getFluidAudioBinaryPath = () => "/bin/fluidaudio";
  manager._diarizeFluidAudio = async () => [seg("speaker_1", 0, 600), seg("speaker_2", 601, 626)];

  const segments = await manager._diarizeNow("/tmp/a.wav", { numSpeakers: 2 });

  assert.deepEqual(speakers(segments), ["speaker_1", "speaker_2"]);
});

test("a phantom that overlaps two kept speakers joins the one it overlaps more", () => {
  const input = [seg("a", 0, 40.5), seg("phantom", 40, 42), seg("b", 41, 80)];

  const folded = foldMinorSpeakers(input);

  assert.equal(folded[1].speaker, "b", "0.5 s overlaps a, 1 s overlaps b");
});

// The near-floor log is the only evidence the fold margin holds on real meetings. A kept
// speaker's folded total includes the phantoms merged into it, so the log must read the
// totals from before the fold or a tight margin disappears from view.
test("the near-floor log reports a kept speaker's own speech, not what it absorbed", async () => {
  const debugLogger = require("../../src/helpers/debugLogger");
  const notices = [];
  const originalNotice = debugLogger.notice;
  debugLogger.notice = (message, meta) => notices.push({ message, meta });
  try {
    const manager = Object.create(DiarizationManager.prototype);
    manager.getDiarizationEngine = () => "fluidaudio";
    manager.getFluidAudioBinaryPath = () => "/bin/fluidaudio";
    manager._diarizeFluidAudio = async () => [
      seg("speaker_a", 0, 31),
      seg("speaker_phantom", 32, 52),
      seg("speaker_b", 100, 400),
    ];

    await manager._diarizeNow("/tmp/a.wav", {});
  } finally {
    debugLogger.notice = originalNotice;
  }

  const nearFloor = notices.find(
    (n) => n.message === "Diarization kept speakers near the fold floor"
  );
  assert.ok(nearFloor, "speaker_a kept 31 s against a 30 s floor, so it must be reported");
  assert.deepEqual(nearFloor.meta.nearFloor, { speaker_a: 31 });
});
