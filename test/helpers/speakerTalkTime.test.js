const test = require("node:test");
const assert = require("node:assert");
const { computeSpeakerStats } = require("../../src/helpers/speakerTalkTime");

const systemSeg = (timestamp, speaker, extra = {}) => ({
  source: "system",
  timestamp,
  speaker,
  text: "x",
  ...extra,
});

test("a speaker with three long turns outranks one with twenty one-word turns", () => {
  const segments = [];
  let t = 0;
  for (let i = 0; i < 3; i += 1) {
    segments.push(systemSeg(t, "A"));
    t += 40;
  }
  for (let i = 0; i < 20; i += 1) {
    segments.push(systemSeg(t, "B"));
    t += 1;
  }
  segments.push(systemSeg(t, "A"));

  const stats = computeSpeakerStats(segments);
  assert.strictEqual(stats[0].id, "A");
  assert.strictEqual(stats[0].segmentCount, 4);
  assert.strictEqual(stats[1].id, "B");
  assert.strictEqual(stats[1].segmentCount, 20);
  assert.ok(
    stats[0].talkTimePercent > stats[1].talkTimePercent,
    `expected A to out-talk B, got ${JSON.stringify(stats)}`
  );
  assert.ok(stats[0].talkTimePercent >= 80, `expected A near 89%, got ${stats[0].talkTimePercent}`);
});

test("durations come from the next segment of the same source, not the next segment overall", () => {
  const segments = [
    { source: "system", timestamp: 0, speaker: "A", text: "long" },
    { source: "mic", timestamp: 1, speaker: "you", text: "short" },
    { source: "mic", timestamp: 2, speaker: "you", text: "short" },
    { source: "system", timestamp: 60, speaker: "B", text: "long" },
    { source: "mic", timestamp: 61, speaker: "you", text: "short" },
    { source: "system", timestamp: 120, speaker: "B", text: "tail" },
  ];
  const stats = computeSpeakerStats(segments);
  const a = stats.find((s) => s.id === "A");
  assert.strictEqual(a.talkTimeSeconds, 60);
});

test("percentages sum to a whole and ignore segments with no speaker", () => {
  const segments = [
    systemSeg(0, "A"),
    systemSeg(10, undefined),
    systemSeg(20, "B"),
    systemSeg(30, "B"),
  ];
  const stats = computeSpeakerStats(segments);
  assert.deepStrictEqual(stats.map((s) => s.id).sort(), ["A", "B"]);
  assert.strictEqual(
    stats.reduce((sum, s) => sum + s.segmentCount, 0),
    3
  );
});

test("epoch-millisecond timestamps produce the same ranking as relative seconds", () => {
  const base = 1788877057845;
  const segments = [];
  let t = base;
  for (let i = 0; i < 3; i += 1) {
    segments.push(systemSeg(t, "A"));
    t += 40000;
  }
  for (let i = 0; i < 20; i += 1) {
    segments.push(systemSeg(t, "B"));
    t += 1000;
  }
  segments.push(systemSeg(t, "A"));

  const stats = computeSpeakerStats(segments);
  assert.strictEqual(stats[0].id, "A");
  assert.ok(stats[0].talkTimePercent >= 80, `got ${stats[0].talkTimePercent}`);
});

test("a timestamp that jumps clocks mid-source does not hand anyone the whole meeting", () => {
  const segments = [
    { source: "mic", timestamp: 10, speaker: "you", text: "a" },
    { source: "mic", timestamp: 15, speaker: "you", text: "b" },
    { source: "mic", timestamp: 1788888655862, speaker: "boom", text: "c" },
    { source: "mic", timestamp: 20, speaker: "you", text: "d" },
    { source: "mic", timestamp: 25, speaker: "you", text: "e" },
    { source: "system", timestamp: 12, speaker: "A", text: "f" },
    { source: "system", timestamp: 40, speaker: "A", text: "g" },
  ];
  const stats = computeSpeakerStats(segments);
  const worst = Math.max(...stats.map((s) => s.talkTimePercent));
  assert.ok(worst < 90, `a clock jump gave one speaker ${worst}%: ${JSON.stringify(stats)}`);
  assert.strictEqual(stats[0].id, "A", "the speaker with the real 28s gap should lead");
});

test("the last segment of a source falls back rather than counting as zero", () => {
  const segments = [systemSeg(0, "A"), systemSeg(10, "B")];
  const stats = computeSpeakerStats(segments);
  const b = stats.find((s) => s.id === "B");
  assert.ok(b.talkTimeSeconds > 0, "trailing segment must still contribute talk time");
});

test("a named non-placeholder segment names the whole cluster", () => {
  const segments = [
    systemSeg(0, "spk_1", { speakerIsPlaceholder: true }),
    systemSeg(10, "spk_1", { speakerName: "Fabian", speakerIsPlaceholder: false }),
    systemSeg(20, "spk_1", { speakerIsPlaceholder: true }),
  ];
  const [only] = computeSpeakerStats(segments);
  assert.strictEqual(only.name, "Fabian");
  assert.strictEqual(only.isPlaceholder, false);
});

test("no segments yields no speakers", () => {
  assert.deepStrictEqual(computeSpeakerStats([]), []);
  assert.deepStrictEqual(computeSpeakerStats(undefined), []);
});
