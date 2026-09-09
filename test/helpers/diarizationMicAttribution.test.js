const test = require("node:test");
const assert = require("node:assert/strict");

const DiarizationManager = require("../../src/helpers/diarization.js");

// `dedupeMicAgainstSystem` is module-private, so these reach it the only way a caller
// can: through `mergeWithTranscript` on a manager whose engine is never touched.
// No `?? Object.prototype` fallback on purpose — if the module stops exporting the
// class these must break loudly rather than exercise a stub of themselves.
function stubbedManager() {
  return Object.create(DiarizationManager.prototype);
}

const DIARIZED = [{ speaker: "spk0", start: 0, end: 6000 }];

const ECHO_TEXT = "yeah and I have a small wood chipper in the garage";

// `mergeWithTranscript` is handed timestamps in RELATIVE SECONDS
// (ipcHandlers.js normalises before the call). A window expressed in milliseconds is
// ±100 minutes against those, which is the whole meeting.
test("a mic segment matching system audio 90 minutes away is not treated as echo", () => {
  const manager = stubbedManager();

  const merged = manager.mergeWithTranscript(
    [
      {
        id: "m1",
        text: ECHO_TEXT,
        source: "mic",
        timestamp: 0,
        likelyRenderBleed: true,
      },
      { id: "s1", text: ECHO_TEXT, source: "system", timestamp: 5400 },
    ],
    DIARIZED
  );

  const mic = merged.find((seg) => seg.source === "mic");
  assert.ok(mic, "the user's own speech must survive dedupe");
  assert.equal(mic.speaker, "you", "a surviving mic segment is definitionally the user");
  assert.notEqual(
    mic.dedupedAsEcho,
    true,
    "a match 90 minutes away is not echo bleed and must not be flagged as one"
  );
});

test("a mic segment matching system audio 2 seconds away is still treated as echo", () => {
  const manager = stubbedManager();

  const merged = manager.mergeWithTranscript(
    [
      {
        id: "m1",
        text: ECHO_TEXT,
        source: "mic",
        timestamp: 10,
        likelyRenderBleed: true,
      },
      { id: "s1", text: ECHO_TEXT, source: "system", timestamp: 12 },
    ],
    DIARIZED
  );

  const mic = merged.find((seg) => seg.source === "mic");
  assert.ok(mic, "echo is marked, not dropped — dropping is what loses the user's speech");
  assert.equal(mic.dedupedAsEcho, true, "genuine echo within the window must be flagged");
});

// Dropping the segment here is what made it invisible to the mic branch below, so it
// came back out of the persisted transcript un-owned and still stamped in epoch ms.
test("an echo-flagged mic segment still gets a speaker and its normalised timestamp", () => {
  const manager = stubbedManager();

  const merged = manager.mergeWithTranscript(
    [
      {
        id: "m1",
        text: ECHO_TEXT,
        source: "mic",
        timestamp: 10,
        likelyRenderBleed: true,
      },
      { id: "s1", text: ECHO_TEXT, source: "system", timestamp: 12 },
    ],
    DIARIZED
  );

  assert.equal(merged.length, 2, "no segment may be removed from the merge");
  const mic = merged.find((seg) => seg.source === "mic");
  assert.equal(mic.speaker, "you");
  assert.equal(mic.timestamp, 10, "the segment must keep the relative-seconds stamp");
});

test("double-talk suppression is matched loosely and still marked rather than dropped", () => {
  const manager = stubbedManager();

  const merged = manager.mergeWithTranscript(
    [
      {
        id: "m1",
        text: ECHO_TEXT,
        source: "mic",
        timestamp: 10,
        suppressionReason: "double_talk",
      },
      { id: "s1", text: ECHO_TEXT, source: "system", timestamp: 11 },
    ],
    DIARIZED
  );

  const mic = merged.find((seg) => seg.source === "mic");
  assert.ok(mic);
  assert.equal(mic.dedupedAsEcho, true);
  assert.equal(mic.speaker, "you");
});

test("a mic segment carrying no bleed evidence is never flagged", () => {
  const manager = stubbedManager();

  const merged = manager.mergeWithTranscript(
    [
      { id: "m1", text: ECHO_TEXT, source: "mic", timestamp: 10 },
      { id: "s1", text: ECHO_TEXT, source: "system", timestamp: 11 },
    ],
    DIARIZED
  );

  const mic = merged.find((seg) => seg.source === "mic");
  assert.notEqual(mic.dedupedAsEcho, true);
  assert.equal(mic.speaker, "you");
});

// `mergeWithTranscript` returns early when the engine found no speakers, so mic
// segments never reached the branch that owns them. Notes with a failed or empty
// diarization finish with every mic line un-attributed.
test("mic segments are attributed to the user even when diarization found nothing", () => {
  const manager = stubbedManager();

  const merged = manager.mergeWithTranscript(
    [
      { id: "m1", text: "hi back", source: "mic", timestamp: 3 },
      { id: "s1", text: "hello there", source: "system", timestamp: 1 },
    ],
    []
  );

  const mic = merged.find((seg) => seg.source === "mic");
  assert.equal(mic.speaker, "you");
  assert.equal(mic.speakerStatus, "confirmed");
  const system = merged.find((seg) => seg.source === "system");
  assert.equal(system.speaker, undefined, "with no diarization there is no cluster to assign");
});

test("the empty-diarization path never overwrites a speaker the user locked", () => {
  const manager = stubbedManager();

  const merged = manager.mergeWithTranscript(
    [
      {
        id: "m1",
        text: "hi back",
        source: "mic",
        timestamp: 3,
        speaker: "speaker_1",
        speakerName: "Fabian",
        speakerLocked: true,
        speakerLockSource: "user",
      },
    ],
    []
  );

  assert.equal(merged[0].speaker, "speaker_1", "a user-locked label must survive");
  assert.equal(merged[0].speakerName, "Fabian");
});

test("the empty-diarization path does not mutate the caller's segments", () => {
  const manager = stubbedManager();
  const input = [{ id: "m1", text: "hi back", source: "mic", timestamp: 3 }];

  manager.mergeWithTranscript(input, []);

  assert.equal(input[0].speaker, undefined, "the input array must be left untouched");
});
