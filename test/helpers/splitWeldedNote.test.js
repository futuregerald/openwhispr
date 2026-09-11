const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/splitWeldedNote.js");
const loadDetector = () => import("../../src/helpers/detectWeldedSessions.js");

// Build a report the way the real caller does, so these tests exercise the detector's
// actual output shape rather than a hand-written stand-in that could drift from it.
const reportFor = async (segments, options = { minSessionSegments: 1 }) => {
  const { detectSessions } = await loadDetector();
  return detectSessions(segments, options);
};

const seg = (timestamp, text = "x") => ({ timestamp, text, speaker: "A" });

// Three clusters, hours apart: [0,1] then [2] then [3,4].
const THREE_SESSIONS = [
  seg(0, "a"),
  seg(10, "b"),
  seg(100000, "lone"),
  seg(200000, "d"),
  seg(200010, "e"),
];

test("a selected session becomes its own group owning exactly its segments", async () => {
  const { planSplit } = await load();
  const report = await reportFor(THREE_SESSIONS);

  const plan = planSplit(THREE_SESSIONS, report, [true, true, true]);

  assert.equal(plan.ok, true);
  assert.deepEqual(
    plan.groups.map((g) => g.indices),
    [[0, 1], [2], [3, 4]]
  );
});

test("the earliest group is the retained note and no other group is", async () => {
  const { planSplit } = await load();
  const report = await reportFor(THREE_SESSIONS);

  const plan = planSplit(THREE_SESSIONS, report, [true, true, true]);

  assert.deepEqual(
    plan.groups.map((g) => g.isRetained),
    [true, false, false]
  );
});

// Gerald, 2026-09-10: a single-segment fragment MAY be promoted to its own note.
test("a single-segment session selected on purpose becomes its own note", async () => {
  const { planSplit } = await load();
  const report = await reportFor(THREE_SESSIONS);

  const plan = planSplit(THREE_SESSIONS, report, [true, true, true]);

  const lone = plan.groups.find((g) => g.indices.length === 1);
  assert.deepEqual(lone.indices, [2]);
  assert.equal(lone.segments.length, 1);
});

// Gerald, 2026-09-10: fold an unselected session into the NEAREST selected one by time,
// not the preceding one. The middle session here is 100000s after session 1 and 100000s
// before session 3 — see the tie-break test for that exact case.
test("an unselected session folds into the nearest selected session by time", async () => {
  const { planSplit } = await load();
  const segments = [seg(0, "a"), seg(10, "b"), seg(100000, "lone"), seg(110000, "d"), seg(110010, "e")];
  const report = await reportFor(segments);
  assert.equal(report.sessions.length, 3, "the fixture must really be three sessions");

  // lone (t=100000) is 99990s after session 1's end and 10000s before session 3's start,
  // and both gaps exceed the 3600s threshold so it clusters alone.
  const plan = planSplit(segments, report, [true, false, true]);

  assert.equal(plan.groups.length, 2);
  const later = plan.groups.find((g) => g.indices.includes(3));
  assert.deepEqual(later.indices, [2, 3, 4], "the fragment joins the session it is nearest to");
});

test("a leading unselected session folds forward when there is no earlier selected one", async () => {
  const { planSplit } = await load();
  const report = await reportFor(THREE_SESSIONS);

  const plan = planSplit(THREE_SESSIONS, report, [false, true, true]);

  const first = plan.groups[0];
  assert.deepEqual(first.indices, [0, 1, 2], "nothing is dropped for want of a previous session");
});

test("an exact tie folds into the earlier session, deterministically", async () => {
  const { planSplit } = await load();
  // Constructed so the gaps are EQUAL: session 1 ends at 10 and session 3 starts at 200000,
  // so t = 100005 is 99995s from each. Without a real tie this test would pass on whichever
  // side happened to be nearer and prove nothing about the tie-break.
  const tied = [seg(0, "a"), seg(10, "b"), seg(100005, "lone"), seg(200000, "d"), seg(200010, "e")];
  const report = await reportFor(tied);
  assert.equal(report.sessions.length, 3, "the fixture must really be three sessions");
  assert.equal(
    report.sessions[1].startsAt - report.sessions[0].endsAt,
    report.sessions[2].startsAt - report.sessions[1].endsAt,
    "the fixture must be an exact tie, or this test proves nothing"
  );

  const a = planSplit(tied, report, [true, false, true]);
  const b = planSplit(tied, report, [true, false, true]);

  const withLone = a.groups.find((g) => g.indices.includes(2));
  assert.deepEqual(withLone.indices, [0, 1, 2], "a tie resolves to the earlier session");
  assert.deepEqual(
    a.groups.map((g) => g.indices),
    b.groups.map((g) => g.indices),
    "the same input must always produce the same plan"
  );
});

// THE INVARIANT. This is the whole reason the planner exists as a separate, tested layer.
test("every segment lands in exactly one group, under every selection", async () => {
  const { planSplit } = await load();
  const report = await reportFor(THREE_SESSIONS);

  for (let mask = 1; mask < 8; mask += 1) {
    const selection = [!!(mask & 1), !!(mask & 2), !!(mask & 4)];
    const plan = planSplit(THREE_SESSIONS, report, selection);
    assert.equal(plan.ok, true, `selection ${selection} should plan`);

    const all = plan.groups.flatMap((g) => g.indices).sort((x, y) => x - y);
    assert.deepEqual(all, [0, 1, 2, 3, 4], `selection ${selection} lost or duplicated a segment`);
    assert.equal(new Set(all).size, all.length, `selection ${selection} put an index in two groups`);
  }
});

test("each group's timestamps are its originals minus a single constant", async () => {
  const { planSplit } = await load();
  const report = await reportFor(THREE_SESSIONS);

  const plan = planSplit(THREE_SESSIONS, report, [true, true, true]);

  for (const group of plan.groups) {
    const offsets = group.indices.map(
      (i, n) => THREE_SESSIONS[i].timestamp - group.segments[n].timestamp
    );
    assert.equal(new Set(offsets).size, 1, "a group must be shifted by one constant, not warped");
    assert.equal(group.segments[0].timestamp, 0, "each group starts at zero");
  }
});

test("re-basing does not mutate the caller's segments", async () => {
  const { planSplit } = await load();
  const report = await reportFor(THREE_SESSIONS);
  const before = JSON.stringify(THREE_SESSIONS);

  planSplit(THREE_SESSIONS, report, [true, true, true]);

  assert.equal(JSON.stringify(THREE_SESSIONS), before);
});

// The identity gate. Concatenating the groups back in time order must reproduce the original
// transcript exactly, once timestamps are projected out — they are the one field the split
// deliberately changes.
test("concatenating the groups reproduces the original segments apart from timestamps", async () => {
  const { planSplit } = await load();
  const report = await reportFor(THREE_SESSIONS);

  const plan = planSplit(THREE_SESSIONS, report, [true, true, true]);

  const strip = (s) => {
    const { timestamp: _timestamp, ...rest } = s;
    return rest;
  };
  const rebuilt = plan.groups.flatMap((g) => g.segments).map(strip);
  const original = THREE_SESSIONS.map(strip);

  assert.deepEqual(rebuilt, original);
});

test("a report with unassigned segments is refused, not silently split", async () => {
  const { planSplit } = await load();
  const segments = [seg(0, "a"), seg(10, "b"), { text: "no stamp" }, seg(100000, "c")];
  const report = await reportFor(segments);

  const plan = planSplit(segments, report, [true, true]);

  assert.equal(plan.ok, false);
  assert.equal(plan.reason, "unassigned-segments");
});

test("an unusable report is refused", async () => {
  const { planSplit } = await load();
  const segments = [{ text: "a" }, seg(5)];
  const report = await reportFor(segments);

  const plan = planSplit(segments, report, []);

  assert.equal(plan.ok, false);
  assert.equal(plan.reason, "unusable");
});

test("selecting nothing is refused rather than producing zero notes", async () => {
  const { planSplit } = await load();
  const report = await reportFor(THREE_SESSIONS);

  const plan = planSplit(THREE_SESSIONS, report, [false, false, false]);

  assert.equal(plan.ok, false);
  assert.equal(plan.reason, "nothing-selected");
});

test("a selection of the wrong length is refused rather than guessed at", async () => {
  const { planSplit } = await load();
  const report = await reportFor(THREE_SESSIONS);

  const plan = planSplit(THREE_SESSIONS, report, [true, true]);

  assert.equal(plan.ok, false);
  assert.equal(plan.reason, "selection-mismatch");
});
