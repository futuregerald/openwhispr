const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/detectWeldedSessions.js");

const HOUR_MS = 3600000;
const DAY_MS = 24 * HOUR_MS;

const EPOCH_BASE = 495000 * HOUR_MS;

const segment = (text, timestamp, source = "system") => ({
  id: `seg-${text}`,
  text,
  source,
  timestamp,
});

test("mixed units: a stray relative series never widens the epoch span", async () => {
  const { detectSessions } = await load();

  const segments = [
    segment("a", 0),
    segment("b", 12.5),
    segment("c", EPOCH_BASE),
    segment("d", 900),
    segment("e", EPOCH_BASE + 60000),
    segment("f", EPOCH_BASE + 120000),
    segment("g", 1800),
  ];

  const naiveSpanHours =
    (Math.max(...segments.map((s) => s.timestamp)) -
      Math.min(...segments.map((s) => s.timestamp))) /
    HOUR_MS;
  assert.ok(naiveSpanHours > 490000 && naiveSpanHours < 500000, "fixture span guard");

  const result = detectSessions(segments);
  assert.equal(result.usable, true);
  assert.equal(result.unit, "epoch-ms");
  assert.equal(result.sessions.length, 1);
  assert.deepEqual(
    result.sessions.map((s) => [s.startIndex, s.endIndex, s.count]),
    [[2, 5, 3]]
  );
});

test("out-of-order segments inside one session stay one session", async () => {
  const { detectSessions } = await load();

  const ordered = [0, 600, 1200, 1800, 2400, 3000, 3600, 4200, 4800, 5400, 6000, 6600, 7200];
  const scrambled = [...ordered];
  scrambled.splice(3, 0, scrambled.pop());

  const segments = scrambled.map((t, i) => segment(`s${i}`, t));

  let worstBackwardsJump = 0;
  let worstForwardJump = 0;
  for (let i = 1; i < scrambled.length; i += 1) {
    const delta = scrambled[i] - scrambled[i - 1];
    worstBackwardsJump = Math.min(worstBackwardsJump, delta);
    worstForwardJump = Math.max(worstForwardJump, delta);
  }
  assert.ok(worstBackwardsJump <= -5400, "fixture must contain a real backwards jump");
  assert.ok(worstForwardJump > 3600, "unsorted, the fixture must look like a gap");

  const result = detectSessions(segments);
  assert.equal(result.usable, true);
  assert.equal(result.unit, "relative-seconds");
  assert.equal(result.sessions.length, 1);
  assert.deepEqual(
    result.sessions.map((s) => [s.startIndex, s.endIndex, s.count]),
    [[0, 12, 13]]
  );
});

test("a genuine multi-day transcript reports one session per day", async () => {
  const { detectSessions } = await load();

  const segments = [
    segment("d1a", EPOCH_BASE),
    segment("d1b", EPOCH_BASE + 60000),
    segment("d1c", EPOCH_BASE + 900000),
    segment("d2a", EPOCH_BASE + DAY_MS),
    segment("d2b", EPOCH_BASE + DAY_MS + 30000),
    segment("d3a", EPOCH_BASE + 3 * DAY_MS),
    segment("d3b", EPOCH_BASE + 3 * DAY_MS + 45000),
    segment("d3c", EPOCH_BASE + 3 * DAY_MS + 120000),
  ];

  const result = detectSessions(segments);
  assert.equal(result.usable, true);
  assert.equal(result.unit, "epoch-ms");
  assert.deepEqual(
    result.sessions.map((s) => [s.startIndex, s.endIndex, s.count, s.startsAt, s.endsAt]),
    [
      [0, 2, 3, EPOCH_BASE, EPOCH_BASE + 900000],
      [3, 4, 2, EPOCH_BASE + DAY_MS, EPOCH_BASE + DAY_MS + 30000],
      [5, 7, 3, EPOCH_BASE + 3 * DAY_MS, EPOCH_BASE + 3 * DAY_MS + 120000],
    ]
  );
});

test("indices address the original array, not the timestamped subset", async () => {
  const { detectSessions } = await load();

  const segments = Array.from({ length: 20 }, (_, i) => segment(`s${i}`, undefined));
  segments[2].timestamp = EPOCH_BASE;
  segments[3].timestamp = EPOCH_BASE + 30000;
  segments[4].timestamp = EPOCH_BASE + 60000;
  segments[15].timestamp = EPOCH_BASE + 2 * DAY_MS;
  segments[16].timestamp = EPOCH_BASE + 2 * DAY_MS + 30000;
  segments[17].timestamp = EPOCH_BASE + 2 * DAY_MS + 60000;

  const result = detectSessions(segments);
  assert.equal(result.usable, true);
  assert.deepEqual(
    result.sessions.map((s) => [s.startIndex, s.endIndex, s.count]),
    [
      [2, 4, 3],
      [15, 17, 3],
    ]
  );
});

test("a single epoch stamp routes to the relative branch", async () => {
  const { detectSessions } = await load();

  const segments = [
    segment("a", 0),
    segment("b", 300),
    segment("c", 600),
    segment("d", EPOCH_BASE),
    segment("e", 900),
    segment("f", 1200),
  ];

  const result = detectSessions(segments);
  assert.equal(result.usable, true);
  assert.equal(result.unit, "relative-seconds");
  assert.equal(result.sessions.length, 1);
  assert.deepEqual(
    result.sessions.map((s) => [s.startIndex, s.endIndex, s.count]),
    [[0, 5, 5]]
  );
});

test("fewer than two usable stamps is unjudgeable, never one session", async () => {
  const { detectSessions } = await load();

  for (const segments of [
    [],
    [segment("a", undefined), segment("b", null)],
    [segment("a", 12), segment("b", undefined)],
    [segment("a", EPOCH_BASE)],
    [segment("a", Number.NaN), segment("b", Number.POSITIVE_INFINITY)],
  ]) {
    const result = detectSessions(segments);
    assert.equal(result.usable, false, JSON.stringify(segments));
    assert.equal(result.reason, "insufficient-timestamps");
    assert.deepEqual(result.sessions, []);
  }
});

test("gapSeconds is honoured in both units", async () => {
  const { detectSessions } = await load();

  const relative = [segment("a", 0), segment("b", 100), segment("c", 400)];
  assert.equal(detectSessions(relative, { gapSeconds: 200 }).sessions.length, 2);
  assert.equal(detectSessions(relative, { gapSeconds: 400 }).sessions.length, 1);

  const epoch = [
    segment("a", EPOCH_BASE),
    segment("b", EPOCH_BASE + 100000),
    segment("c", EPOCH_BASE + 400000),
  ];
  assert.equal(detectSessions(epoch, { gapSeconds: 200 }).sessions.length, 2);
  assert.equal(detectSessions(epoch, { gapSeconds: 400 }).sessions.length, 1);
});

test("minSessionSegments labels short clusters as fragments without dropping them", async () => {
  const { detectSessions } = await load();

  const segments = [
    segment("a", EPOCH_BASE),
    segment("b", EPOCH_BASE + 1000),
    segment("c", EPOCH_BASE + 2000),
    segment("d", EPOCH_BASE + 3000),
    segment("e", EPOCH_BASE + 4000),
    segment("f", EPOCH_BASE + 2 * DAY_MS),
  ];

  const result = detectSessions(segments, { minSessionSegments: 5 });
  assert.deepEqual(
    result.sessions.map((s) => [s.count, s.isFragment]),
    [
      [5, false],
      [1, true],
    ]
  );
});

test("startIndex is the cluster's lowest original index, not its earliest segment's", async () => {
  const { detectSessions } = await load();

  const segments = [
    segment("a", 50),
    segment("b", 60),
    segment("c", 70),
    segment("d", 10),
    segment("e", 20),
  ];

  const earliestByTime = segments
    .map((s, index) => ({ index, timestamp: s.timestamp }))
    .sort((x, y) => x.timestamp - y.timestamp)[0];
  assert.equal(earliestByTime.index, 3, "fixture: the earliest segment must not sit first");

  const result = detectSessions(segments);
  assert.equal(result.sessions.length, 1, "fixture: these must form one cluster");
  assert.deepEqual(
    result.sessions.map((s) => [s.startIndex, s.endIndex, s.count]),
    [[0, 4, 5]]
  );
});

// --- membership, added for the note-14 split (Phase D) ---
//
// The split needs to know WHICH segments belong to each session, not just where the
// cluster's lowest and highest indices happen to fall. The JSDoc on detectSessions already
// warns that [startIndex..endIndex] is not a partition; these tests pin the fields that make
// the "every segment lands in exactly one note" invariant provable rather than assumed.

test("each session reports the exact indices it owns, ascending", async () => {
  const { detectSessions } = await load();
  const segments = [
    { timestamp: 0 },
    { timestamp: 10 },
    { timestamp: 20 },
    { timestamp: 100000 },
    { timestamp: 100010 },
  ];

  const { sessions } = detectSessions(segments, { minSessionSegments: 1 });

  assert.deepStrictEqual(
    sessions.map((s) => s.indices),
    [
      [0, 1, 2],
      [3, 4],
    ]
  );
});

test("segments with no usable timestamp are reported as unassigned, not silently dropped", async () => {
  const { detectSessions } = await load();
  const segments = [
    { timestamp: 0 },
    { timestamp: 10 },
    { text: "no stamp at all" },
    { timestamp: null },
    { timestamp: Number.NaN },
  ];

  const report = detectSessions(segments, { minSessionSegments: 1 });

  assert.deepStrictEqual(report.unassigned, [2, 3, 4]);
});

// The dangerous case. When a note carries >= 2 epoch stamps the detector keeps ONLY the
// epoch series and discards every relative one. Those segments are in no cluster and no
// index window, so a splitter trusting `usable: true` would delete them permanently.
// They must surface in `unassigned` so the split can refuse to run.
test("the discarded minority time base is reported as unassigned, not lost", async () => {
  const { detectSessions } = await load();
  const segments = [
    { timestamp: 1785518002177 },
    { timestamp: 1785518012177 },
    { timestamp: 5 },
    { timestamp: 6 },
    { timestamp: 7 },
  ];

  const report = detectSessions(segments, { minSessionSegments: 1 });

  assert.strictEqual(report.unit, "epoch-ms");
  assert.strictEqual(report.usable, true);
  assert.deepStrictEqual(report.unassigned, [2, 3, 4], "the relative stamps must not vanish");
});

test("every segment is accounted for exactly once across sessions and unassigned", async () => {
  const { detectSessions } = await load();
  const segments = [
    { timestamp: 0 },
    { text: "orphan" },
    { timestamp: 30 },
    { timestamp: 900000 },
    { timestamp: null },
    { timestamp: 900030 },
  ];

  const report = detectSessions(segments, { minSessionSegments: 1 });

  const owned = report.sessions.flatMap((s) => s.indices);
  const all = [...owned, ...report.unassigned].sort((a, b) => a - b);

  assert.deepStrictEqual(all, [0, 1, 2, 3, 4, 5], "nothing lost, nothing counted twice");
  assert.strictEqual(new Set(all).size, segments.length, "no index in two places");
});

test("an unusable report still accounts for every segment", async () => {
  const { detectSessions } = await load();
  const segments = [{ text: "a" }, { timestamp: 5 }];

  const report = detectSessions(segments);

  assert.strictEqual(report.usable, false);
  assert.deepStrictEqual(report.sessions, []);
  assert.deepStrictEqual(report.unassigned, [0, 1], "an unusable note orphans everything");
});

// mergeTranscriptSegments ends with [...preserved, ...unmatchedIncoming], so the stored
// array is NOT time-ordered: a later array index can hold an earlier timestamp. The cluster
// is built from the time-sorted series, so without an explicit sort `indices` comes back in
// TIME order. A consumer slicing the transcript by these indices would reorder the note's
// segments. This fixture puts value order and index order deliberately at odds.
test("indices are in array order even when the stored array is not in time order", async () => {
  const { detectSessions } = await load();
  const segments = [{ timestamp: 20 }, { timestamp: 0 }, { timestamp: 10 }];

  const { sessions } = detectSessions(segments, { minSessionSegments: 1 });

  assert.strictEqual(sessions.length, 1, "all three are inside one gap-free cluster");
  assert.deepStrictEqual(
    sessions[0].indices,
    [0, 1, 2],
    "indices must ascend by array position, not by timestamp"
  );
});
