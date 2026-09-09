const test = require("node:test");
const assert = require("node:assert/strict");

const { repairSegments } = require("../../src/helpers/repairNoteSegments.js");
const fixture = require("../fixtures/preRepairMeetingTranscript.json");

const EPOCH_MS_FLOOR = 1e9;

const clone = (segments) => JSON.parse(JSON.stringify(segments));

function preRepair() {
  return clone(fixture.segments);
}

function mixedUnits() {
  const segments = preRepair();
  const origin = Math.min(...segments.map((s) => s.timestamp));
  return segments.map((segment) =>
    segment.source === "system"
      ? { ...segment, timestamp: (segment.timestamp - origin) / 1000 }
      : segment
  );
}

test("every un-attributed mic segment comes back owned by the user", () => {
  const result = repairSegments(preRepair());

  const orphans = result.segments.filter((s) => s.source === "mic" && !s.speaker);
  assert.equal(orphans.length, 0, `${orphans.length} mic segments still have no speaker`);
  assert.equal(result.micAttributed, 356);

  const repairedMic = result.segments.find((s) => s.source === "mic");
  assert.equal(repairedMic.speaker, "you");
  assert.equal(repairedMic.speakerStatus, "confirmed");
  assert.equal(repairedMic.speakerIsPlaceholder, false);
});

test("a mic segment the user already labelled is left exactly as it was", () => {
  const locked = {
    text: "w0000",
    source: "mic",
    timestamp: 1788877057845,
    speaker: "speaker_3",
    speakerName: "Rowan",
    speakerStatus: "locked",
    speakerLocked: true,
    speakerLockSource: "user",
  };

  const result = repairSegments([locked, ...preRepair()]);

  assert.deepEqual(
    { ...result.segments[0], timestamp: locked.timestamp },
    locked,
    "a locked mic segment must keep the label the user chose"
  );
  assert.equal(result.micAttributed, 356);
});

test("a mic segment locked without a cluster id still keeps the user's label", () => {
  const locked = {
    text: "w0000",
    source: "mic",
    timestamp: 1788877057845,
    speakerName: "Rowan",
    speakerStatus: "locked",
    speakerLocked: true,
    speakerLockSource: "user",
  };

  const result = repairSegments([locked, ...preRepair()]);

  assert.equal(result.segments[0].speaker, undefined, "repair must not claim locked speech");
  assert.equal(result.segments[0].speakerName, "Rowan");
  assert.equal(result.segments[0].speakerStatus, "locked");
  assert.equal(result.micAttributed, 356);
});

test("an all-epoch note is converted to relative seconds from its earliest stamp", () => {
  const before = preRepair();
  const result = repairSegments(before);

  assert.equal(result.skippedMixedUnits, false);
  assert.equal(result.timestampsNormalised, before.length);

  const stamps = result.segments.map((s) => s.timestamp);
  assert.equal(
    stamps.filter((t) => t > EPOCH_MS_FLOOR).length,
    0,
    "no stamp may still be epoch ms"
  );
  assert.equal(Math.min(...stamps), 0, "the earliest segment is the origin");
  assert.equal(
    stamps.filter((t) => t < 0).length,
    0,
    "a negative stamp makes formatSrtTimestamp emit -1:-1:-41,910 and breaks SRT export"
  );
});

test("the origin is the earliest stamp, not the first system segment", () => {
  const before = preRepair();
  const firstSystem = before.find((s) => s.source === "system").timestamp;
  assert.ok(before[0].timestamp < firstSystem, "the fixture must keep its mic-first shape");

  const result = repairSegments(before);

  assert.equal(result.segments[0].timestamp, 0);
  assert.equal(
    result.segments.find((s) => s.source === "system").timestamp,
    (firstSystem - before[0].timestamp) / 1000
  );
});

test("a mixed-unit note keeps its stamps and says so", () => {
  const before = mixedUnits();
  const result = repairSegments(before);

  assert.equal(result.skippedMixedUnits, true);
  assert.equal(result.timestampsNormalised, 0);
  assert.deepEqual(
    result.segments.map((s) => s.timestamp),
    before.map((s) => s.timestamp),
    "converting a mixed-unit note needs a per-segment origin nobody has"
  );
  assert.equal(result.micAttributed, 356, "mic attribution still applies to a mixed note");
});

test("a note already in relative seconds is not reported as mixed", () => {
  const before = preRepair().map((s, i) => ({ ...s, timestamp: i * 2.5 }));
  const result = repairSegments(before);

  assert.equal(result.skippedMixedUnits, false);
  assert.equal(result.timestampsNormalised, 0);
});

test("system segments keep every speaker field they arrived with", () => {
  const before = preRepair();
  const result = repairSegments(before);

  const systemBefore = before.filter((s) => s.source === "system");
  const systemAfter = result.segments.filter((s) => s.source === "system");
  assert.deepEqual(
    systemAfter.map(({ timestamp: _timestamp, ...rest }) => rest),
    systemBefore.map(({ timestamp: _timestamp, ...rest }) => rest)
  );
});

test("a stamp that is missing or not a number survives untouched", () => {
  const result = repairSegments([
    { text: "w0000", source: "mic", timestamp: null },
    { text: "w0001", source: "system" },
    { text: "w0002", source: "mic", timestamp: 1788877057845 },
  ]);

  assert.equal(result.segments[0].timestamp, null);
  assert.ok(!("timestamp" in result.segments[1]));
  assert.equal(result.segments[2].timestamp, 0);
  assert.equal(result.timestampsNormalised, 1);
});

test("repairing twice is byte-identical to repairing once", () => {
  const once = repairSegments(preRepair());
  const twice = repairSegments(clone(once.segments));

  assert.equal(twice.micAttributed, 0);
  assert.equal(twice.timestampsNormalised, 0);
  assert.equal(twice.skippedMixedUnits, false);
  assert.equal(
    JSON.stringify(twice.segments),
    JSON.stringify(once.segments),
    "a second repair must be a no-op, or startup rewrites the note forever"
  );
});

test("repair does not mutate the segments it was handed", () => {
  const before = preRepair();
  const snapshot = JSON.stringify(before);

  repairSegments(before);

  assert.equal(JSON.stringify(before), snapshot);
});

test("a note with nothing wrong reports no work and returns its input unchanged", () => {
  const healthy = [
    { text: "w0000", source: "mic", timestamp: 0, speaker: "you", speakerStatus: "confirmed" },
    { text: "w0001", source: "system", timestamp: 2.5, speaker: "speaker_0" },
  ];

  const result = repairSegments(clone(healthy));

  assert.equal(result.micAttributed, 0);
  assert.equal(result.timestampsNormalised, 0);
  assert.equal(JSON.stringify(result.segments), JSON.stringify(healthy));
});

test("a stamp sitting exactly on the epoch floor is not treated as epoch", () => {
  const before = [
    { text: "w0", source: "mic", timestamp: EPOCH_MS_FLOOR },
    { text: "w1", source: "system", timestamp: EPOCH_MS_FLOOR * 2, speaker: "speaker_0" },
  ];

  const result = repairSegments(before);

  assert.equal(result.timestampsNormalised, 0, "the floor itself is below the epoch cut-off");
  assert.equal(result.skippedMixedUnits, true);
  assert.deepEqual(
    result.segments.map((s) => s.timestamp),
    [EPOCH_MS_FLOOR, EPOCH_MS_FLOOR * 2]
  );
});

test("a stamp one millisecond above the epoch floor is treated as epoch", () => {
  const before = [
    { text: "w0", source: "mic", timestamp: EPOCH_MS_FLOOR + 1 },
    { text: "w1", source: "system", timestamp: EPOCH_MS_FLOOR + 2501, speaker: "speaker_0" },
  ];

  const result = repairSegments(before);

  assert.equal(result.timestampsNormalised, 2);
  assert.equal(result.skippedMixedUnits, false);
  assert.deepEqual(
    result.segments.map((s) => s.timestamp),
    [0, 2.5]
  );
});

test("the epoch origin it subtracted comes back, so wall clock stays recoverable", () => {
  const before = preRepair();
  const expected = Math.min(...before.map((segment) => segment.timestamp));

  const result = repairSegments(before);

  assert.equal(result.epochOrigin, expected);
  assert.ok(expected > EPOCH_MS_FLOOR, "fixture must be all-epoch for this to mean anything");

  const firstWithStamp = result.segments.find((segment) => Number.isFinite(segment.timestamp));
  const recovered = result.epochOrigin + firstWithStamp.timestamp * 1000;
  const originalFirst = before.find((segment) => Number.isFinite(segment.timestamp));
  assert.equal(recovered, originalFirst.timestamp);
});

test("a transcript already in relative seconds reports no origin rather than a fake one", () => {
  const result = repairSegments([
    { source: "system", speaker: "speaker_0", timestamp: 0 },
    { source: "system", speaker: "speaker_0", timestamp: 12.5 },
  ]);

  assert.equal(result.epochOrigin, null);
  assert.equal(result.timestampsNormalised, 0);
});

test("a mixed-unit transcript reports no origin, because it has more than one", () => {
  const result = repairSegments(mixedUnits());

  assert.equal(result.epochOrigin, null);
  assert.equal(result.skippedMixedUnits, true);
});
