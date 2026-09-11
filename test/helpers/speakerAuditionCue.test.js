const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveSpeakerAuditionCue } = require("../../src/helpers/speakerAuditionCue.js");

const SYS = { systemDuration: 3600, micDuration: 3600 };

const seg = (speaker, timestamp, source = "system", text = "x") => ({
  speaker,
  timestamp,
  source,
  text,
});

// The whole justification for "longest early turn": note 20's speaker_1 says "Monday." for
// 0.14 s as its first segment, then holds the floor properly later. Seeking to the first
// segment plays a word and stops.
test("seeks to the speaker's longest early turn, not their first segment", () => {
  const segments = [
    seg("speaker_1", 10), // "Monday." — next system segment is 0.14 s later
    seg("speaker_0", 10.14),
    seg("speaker_1", 20), // the real turn: 25 s of floor
    seg("speaker_0", 45),
  ];

  const cue = resolveSpeakerAuditionCue(segments, "speaker_1", SYS);

  assert.equal(cue.seconds, 20);
  assert.equal(cue.track, "system");
});

// The failure mode of computing turn length from ONE speaker's segments: the gap to that
// speaker's own next segment makes the 0.14 s utterance look like a 10 s turn.
test("turn length comes from the next segment in the track, not the speaker's own next", () => {
  const segments = [
    seg("speaker_1", 10), // 0.14 s of floor; speaker_1 does not speak again until 200
    seg("speaker_0", 10.14),
    seg("speaker_0", 100),
    seg("speaker_1", 200), // 5 s of floor
    seg("speaker_0", 205),
  ];

  const cue = resolveSpeakerAuditionCue(segments, "speaker_1", SYS);

  assert.equal(cue.seconds, 200, "must not select the 0.14 s segment");
});

test("refuses an epoch-valued timestamp, because mixed-unit notes still carry them", () => {
  const segments = [seg("speaker_1", 1788877057845), seg("speaker_0", 1788877060000)];

  assert.equal(resolveSpeakerAuditionCue(segments, "speaker_1", SYS), null);
});

test("a mic-source speaker auditions from the mic track", () => {
  const segments = [seg("you", 10, "mic"), seg("you", 40, "mic")];

  const cue = resolveSpeakerAuditionCue(segments, "you", SYS);

  assert.equal(cue.track, "mic");
});

// mic - sys: a longer mic file means the mic started earlier, so the same instant sits
// further into it. Approximate (~+/-1s of end-skew), which is why the clip is wide.
test("the mic cue is shifted by the difference in track lengths", () => {
  const segments = [seg("you", 10, "mic"), seg("you", 40, "mic")];

  const cue = resolveSpeakerAuditionCue(segments, "you", {
    systemDuration: 3600,
    micDuration: 3604.428,
  });

  assert.ok(Math.abs(cue.seconds - 14.428) < 1e-6, `got ${cue.seconds}`);
});

test("a mic cue shifted below zero is clamped rather than left negative", () => {
  const segments = [seg("you", 1, "mic"), seg("you", 40, "mic")];

  const cue = resolveSpeakerAuditionCue(segments, "you", {
    systemDuration: 3600,
    micDuration: 3597.827, // -2.173, note 37's measured offset
  });

  assert.equal(cue.seconds, 0);
});

// Note 33 has 291 of 1080 segments past the end of its 1823.2 s track. currentTime beyond
// the end clamps and fires `ended`: a play button that produces silence with no error.
test("falls back to the latest in-range segment when the best cue is past the end", () => {
  const segments = [
    seg("speaker_1", 100),
    seg("speaker_0", 105),
    seg("speaker_1", 5000), // past the end of a 1823 s track
    seg("speaker_0", 5100),
  ];

  const cue = resolveSpeakerAuditionCue(segments, "speaker_1", {
    systemDuration: 1823.2,
    micDuration: 1823.2,
  });

  assert.equal(cue.seconds, 100);
});

test("the range check uses the track actually being played, not the system track", () => {
  const segments = [seg("you", 1700, "mic"), seg("you", 1750, "mic")];

  // System is long enough; the mic file is not.
  const cue = resolveSpeakerAuditionCue(segments, "you", {
    systemDuration: 3600,
    micDuration: 1000,
  });

  assert.equal(cue, null, "a cue past the end of the mic file must not be offered");
});

test("returns null when the speaker has no usable segment, so the button disables", () => {
  assert.equal(resolveSpeakerAuditionCue([], "speaker_1", SYS), null);
  assert.equal(
    resolveSpeakerAuditionCue([seg("speaker_0", 10)], "speaker_1", SYS),
    null,
    "a speaker with no segments of their own"
  );
  assert.equal(
    resolveSpeakerAuditionCue([{ speaker: "speaker_1", text: "no timestamp" }], "speaker_1", SYS),
    null
  );
});

test("returns null when the track it would play has no known duration", () => {
  const segments = [seg("speaker_1", 10), seg("speaker_0", 40)];

  assert.equal(resolveSpeakerAuditionCue(segments, "speaker_1", { systemDuration: null }), null);
});

// The point of "early": in a long meeting a speaker's single longest turn may be forty
// minutes in. Auditioning should sample them near where they start, not hunt the whole file.
test("prefers an early turn over a longer one much later in the meeting", () => {
  const segments = [];
  for (let i = 0; i < 15; i += 1) {
    // Each of speaker_1's first 12 turns holds the floor for 4 s.
    segments.push(seg("speaker_1", i * 100));
    segments.push(seg("speaker_0", i * 100 + 4));
  }
  // Their 15th turn is the longest in the meeting, 25 s, at t=2800.
  segments.push(seg("speaker_1", 2800));
  segments.push(seg("speaker_0", 2825));

  const cue = resolveSpeakerAuditionCue(segments, "speaker_1", SYS);

  assert.ok(cue.seconds <= 1100, `expected an early cue, got ${cue.seconds}`);
});

// A speaker can appear on both sources. Choosing one track for the whole speaker means a
// single stray segment decides which FILE gets played, and drags every other segment's cue
// onto a track whose zero it was never measured against.
test("each candidate is judged against the track its own segment came from", () => {
  const segments = [
    seg("you", 10, "mic"), // 30 s of floor on the mic track
    seg("you", 40, "mic"),
    seg("you", 500, "system"), // one stray system segment, 1 s of floor
    seg("speaker_0", 501),
  ];

  const cue = resolveSpeakerAuditionCue(segments, "you", {
    systemDuration: 3600,
    micDuration: 3604.428,
  });

  assert.equal(cue.track, "mic", "the mic segments hold the floor far longer");
  assert.ok(Math.abs(cue.seconds - 14.428) < 1e-6, `mic shift must apply: ${cue.seconds}`);
});

test("a system cue is never shifted by the mic offset", () => {
  const segments = [seg("speaker_1", 10), seg("speaker_0", 40)];

  const cue = resolveSpeakerAuditionCue(segments, "speaker_1", {
    systemDuration: 3600,
    micDuration: 3604.428,
  });

  assert.equal(cue.track, "system");
  assert.equal(cue.seconds, 10, "the mic offset must not touch a system cue");
});

test("a segment is dropped when the track it belongs to has no duration", () => {
  const segments = [seg("you", 10, "mic"), seg("you", 40, "mic")];

  assert.equal(
    resolveSpeakerAuditionCue(segments, "you", { systemDuration: 3600, micDuration: null }),
    null
  );
});

test("a non-numeric timestamp is skipped rather than coerced", () => {
  const segments = [
    { speaker: "speaker_1", timestamp: "10", source: "system", text: "x" },
    seg("speaker_0", 40),
  ];

  assert.equal(resolveSpeakerAuditionCue(segments, "speaker_1", SYS), null);
});

// "The first N segments" has to mean the earliest by time, not the first N in array order.
// A transcript interleaves two sources whose clocks are merged after the fact, so array
// order is not guaranteed to be chronological.
test("the early cap keeps the earliest segments by time, not by array position", () => {
  const segments = [];
  // Listed first, but 50 minutes in, and holding the floor longer than anything early.
  segments.push(seg("speaker_1", 3000));
  segments.push(seg("speaker_0", 3030));
  for (let i = 1; i <= 14; i += 1) {
    segments.push(seg("speaker_1", i * 10));
    segments.push(seg("speaker_0", i * 10 + 2));
  }

  const cue = resolveSpeakerAuditionCue(segments, "speaker_1", SYS);

  assert.ok(cue.seconds < 200, `expected an early cue, got ${cue.seconds}`);
});
