const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/callBoundaries.js");

const segment = (speakerName, text, timestamp) => ({
  id: `seg-${speakerName}-${timestamp}`,
  source: "system",
  speakerName,
  text,
  timestamp,
});

// Filler lines deliberately free of every farewell and opening cue, so a fixture
// only scores the signals its test is about.
const FILLER = [
  "the migration runs nightly",
  "and we watch the queue depth",
  "the backfill finished at four",
  "we capped the retries at three",
  "the index is still building",
  "staging looks identical now",
];

const run = (speakers, texts, startAt, step, count) => {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const text = texts[i] ?? FILLER[i % FILLER.length];
    out.push(segment(speakers[i % speakers.length], text, startAt + i * step));
  }
  return out;
};

// Note 95's shape: one 2h+ recording holding two calls, separated by a single
// 105.4s silence, with complete speaker turnover and real farewell/opening text.
const FAREWELL_TAIL = {
  27: "so that is everything from my side",
  28: "I have to drop out, I'm going to have lunch",
  29: "Thank you. Good one.",
};

const OPENING_HEAD = {
  0: "You already three minutes late.",
  1: "that's perfectly fine. That's on time.",
  2: "Fill me in what's happening with life.",
};

const note95Shape = ({ base = 0, scale = 1, afterCount = 30, afterStep = 20 } = {}) => {
  const stamp = (seconds) => base + seconds * scale;
  const before = run(["Jorge", "Regina"], [], 0, 20, 30).map((seg, i) => ({
    ...seg,
    text: FAREWELL_TAIL[i] ?? seg.text,
    timestamp: stamp(i * 20),
  }));
  const after = run(["Fabian", "Molly"], [], 0, afterStep, afterCount).map((seg, i) => ({
    ...seg,
    text: OPENING_HEAD[i] ?? seg.text,
    timestamp: stamp(685.4 + i * afterStep),
  }));
  return [...before, ...after];
};

// Note 14's shape: many short clusters separated by long silences, including a
// 20.5-hour one, with turnover across every gap and no farewell or opening cue.
// Each cluster is long enough (308s) and the gaps wide enough that the ONLY
// thing standing between this note and ten boundaries is the minimum-session
// rule: every cluster holds 12 segments, under the 20-segment minimum.
const note14Shape = () => {
  const speakerPairs = [
    ["Alex", "Blair"],
    ["Casey", "Devon"],
  ];
  const segments = [];
  let at = 0;
  for (let cluster = 0; cluster < 10; cluster += 1) {
    segments.push(...run(speakerPairs[cluster % 2], [], at, 28, 12));
    at += 11 * 28 + (cluster === 4 ? 73800 : 1000);
  }
  return segments;
};

test("an empty transcript refuses rather than reporting a boundary", async () => {
  const { detectCallBoundaries } = await load();

  const result = detectCallBoundaries([]);

  assert.deepEqual(result.boundaries, []);
  assert.equal(result.refused, "insufficient-timestamps");
});

test("a single segment refuses: there is nothing to put either side of a gap", async () => {
  const { detectCallBoundaries } = await load();

  const result = detectCallBoundaries([segment("Jorge", "hello", 10)]);

  assert.deepEqual(result.boundaries, []);
  assert.equal(result.refused, "insufficient-timestamps");
});

test("note 95's shape yields exactly one boundary, scored by the language either side", async () => {
  const { detectCallBoundaries } = await load();

  const result = detectCallBoundaries(note95Shape());

  assert.equal(result.refused, undefined);
  assert.equal(result.unit, "relative-seconds");
  assert.equal(result.boundaries.length, 1);

  const [boundary] = result.boundaries;
  assert.equal(boundary.score, 6);
  assert.deepEqual(boundary.reasons, ["farewell-cue", "opening-cue", "speaker-turnover"]);
  assert.ok(Math.abs(boundary.gapSeconds - 105.4) < 1e-6, `gap was ${boundary.gapSeconds}`);

  assert.equal(result.pieces.length, 2);
  assert.deepEqual(
    boundary.before.indices,
    Array.from({ length: 30 }, (_, i) => i)
  );
  assert.deepEqual(
    boundary.after.indices,
    Array.from({ length: 30 }, (_, i) => 30 + i)
  );
});

test("every segment lands in exactly one piece", async () => {
  const { detectCallBoundaries } = await load();

  const segments = note95Shape();
  const result = detectCallBoundaries(segments);

  const seen = result.pieces.flatMap((piece) => piece.indices);
  assert.equal(seen.length, segments.length);
  assert.equal(new Set(seen).size, segments.length);
  assert.deepEqual(
    [...seen].sort((a, b) => a - b),
    Array.from({ length: segments.length }, (_, i) => i)
  );
});

test("array order is not time order: a shuffled transcript finds the same boundary", async () => {
  const { detectCallBoundaries } = await load();

  const ordered = note95Shape();
  const shuffled = [...ordered];
  // A fixed, reproducible scramble, plus a same-speaker inversion of the kind
  // 24 of the 70 real notes actually carry.
  for (let i = 0; i < shuffled.length; i += 7) {
    const j = (i * 13 + 5) % shuffled.length;
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  const result = detectCallBoundaries(shuffled);

  assert.equal(result.refused, undefined);
  assert.equal(result.boundaries.length, 1);
  const [boundary] = result.boundaries;
  assert.equal(boundary.score, 6);
  assert.ok(Math.abs(boundary.gapSeconds - 105.4) < 1e-6);
});

test("an epoch-ms note's gap is measured in seconds, not milliseconds", async () => {
  const { detectCallBoundaries } = await load();

  const result = detectCallBoundaries(note95Shape({ base: 1790870467607, scale: 1000 }));

  assert.equal(result.refused, undefined);
  assert.equal(result.unit, "epoch-ms");
  assert.equal(result.boundaries.length, 1);
  const [boundary] = result.boundaries;
  assert.ok(Math.abs(boundary.gapSeconds - 105.4) < 1e-3, `gap was ${boundary.gapSeconds}`);
  assert.equal(boundary.score, 6);
  assert.ok(boundary.before.durationSeconds > 300);
});

test("note 14's shape yields no boundary: short clusters are never call boundaries", async () => {
  const { detectCallBoundaries } = await load();

  const segments = note14Shape();
  const result = detectCallBoundaries(segments);

  assert.equal(result.refused, undefined);
  assert.deepEqual(result.boundaries, []);
  assert.equal(result.pieces.length, 1);
  assert.equal(result.pieces[0].indices.length, segments.length);
});

test("note 14's clusters would otherwise score as boundaries", async () => {
  const { detectCallBoundaries } = await load();
  const { scoreCallBoundary } = await import("../../src/helpers/callBoundaryScore.js");

  const segments = note14Shape();
  const result = detectCallBoundaries(segments, { minSessionSegments: 1 });

  assert.equal(result.boundaries.length, 9);
  for (const boundary of result.boundaries) {
    assert.ok(boundary.score >= 3, `score was ${boundary.score}`);
    assert.ok(boundary.reasons.includes("speaker-turnover"));
  }

  // Guards against a fixture that was never scoring in the first place.
  assert.equal(
    scoreCallBoundary({
      before: segments.slice(0, 12),
      after: segments.slice(12, 24),
      gapSeconds: 1000,
    }).boundary,
    true
  );
});

test("one segment with no timestamp refuses the whole note", async () => {
  const { detectCallBoundaries } = await load();

  const segments = [...note95Shape(), segment("Molly", "and that was it", null)];
  const result = detectCallBoundaries(segments);

  assert.deepEqual(result.boundaries, []);
  assert.equal(result.refused, "unassigned-segments");
});

test("a note mixing epoch-ms and relative-seconds stamps refuses", async () => {
  const { detectCallBoundaries } = await load();

  const segments = [
    ...note95Shape({ base: 1790870467607, scale: 1000 }),
    segment("Molly", "and that was it", 12),
    segment("Molly", "really it was", 44),
  ];
  const result = detectCallBoundaries(segments);

  assert.deepEqual(result.boundaries, []);
  assert.equal(result.refused, "unassigned-segments");
});

test("a confirmed boundary that would leave a sub-five-minute piece is dropped", async () => {
  const { detectCallBoundaries } = await load();

  // 20 segments at 14s keeps the second cluster above the 20-segment minimum
  // while its 266s span falls under the five-minute floor.
  const result = detectCallBoundaries(note95Shape({ afterCount: 20, afterStep: 14 }));

  assert.equal(result.refused, undefined);
  assert.deepEqual(result.boundaries, []);
  assert.equal(result.pieces.length, 1);
});

test("the five-minute floor is what drops it, not the score", async () => {
  const { detectCallBoundaries } = await load();

  const result = detectCallBoundaries(note95Shape({ afterCount: 20, afterStep: 14 }), {
    minPieceSeconds: 0,
  });

  assert.equal(result.boundaries.length, 1);
  assert.equal(result.boundaries[0].score, 6);
});

test("a farewell beyond the 120s window before the gap does not count", async () => {
  const { detectCallBoundaries } = await load();

  const segments = note95Shape().map((seg, i) =>
    i === 28 || i === 29 ? { ...seg, text: "the index is still building" } : seg
  );
  // Move the farewell 300s back from the end of the first call.
  segments[14] = { ...segments[14], text: "I have to drop out, I'm going to have lunch" };

  const result = detectCallBoundaries(segments);

  assert.equal(result.boundaries.length, 1);
  assert.deepEqual(result.boundaries[0].reasons, ["opening-cue", "speaker-turnover"]);
  assert.equal(result.boundaries[0].score, 4);
});

test("one continuous call reports no boundary and no refusal", async () => {
  const { detectCallBoundaries } = await load();

  const result = detectCallBoundaries(run(["Jorge", "Regina"], [], 0, 20, 40));

  assert.equal(result.refused, undefined);
  assert.deepEqual(result.boundaries, []);
  assert.equal(result.pieces.length, 1);
  assert.equal(result.pieces[0].indices.length, 40);
});

test("the wrapped detector defaults are the plan's: a 30s gap and a 20-segment minimum", async () => {
  const { SESSION_GAP_SECONDS, MIN_SESSION_SEGMENTS, MIN_PIECE_SECONDS } = await load();

  assert.equal(SESSION_GAP_SECONDS, 30);
  assert.equal(MIN_SESSION_SEGMENTS, 20);
  assert.equal(MIN_PIECE_SECONDS, 300);
});

test("a 29s silence is not even a candidate gap", async () => {
  const { detectCallBoundaries } = await load();

  const before = run(["Jorge", "Regina"], [], 0, 20, 30).map((seg, i) => ({
    ...seg,
    text: FAREWELL_TAIL[i] ?? seg.text,
  }));
  const after = run(["Fabian", "Molly"], [], 609, 20, 30).map((seg, i) => ({
    ...seg,
    text: OPENING_HEAD[i] ?? seg.text,
  }));

  const result = detectCallBoundaries([...before, ...after]);

  assert.equal(result.refused, undefined);
  assert.deepEqual(result.boundaries, []);
  assert.equal(result.pieces.length, 1);
});

// A welded recording built from measured real shapes: each part is a piece
// described by segment count and spacing, separated by an explicit silence.
// `step` stays at or under the 30s session gap so a part is exactly one session.
const weld = (parts) => {
  const segments = [];
  let at = 0;
  parts.forEach((part, index) => {
    if (index > 0) at += part.gapBefore;
    const piece = [];
    for (let i = 0; i < part.count; i += 1) {
      piece.push(
        segment(
          part.speakers[i % part.speakers.length],
          FILLER[i % FILLER.length],
          at + i * part.step
        )
      );
    }
    if (part.opening) piece[0] = { ...piece[0], text: part.opening };
    if (part.farewell) {
      piece[piece.length - 1] = { ...piece[piece.length - 1], text: part.farewell };
    }
    segments.push(...piece);
    at += (part.count - 1) * part.step;
  });
  return segments;
};

// Note 14's real measured shape: a 397-segment first call spanning 2019.6s, a
// 6567s silence, then a second piece spanning 332280s (92 hours). The farewell
// is real ("Alright, okay, bye.") and the speakers are the same either side, so
// the boundary scores exactly 3 — farewell-cue + long-gap — and is a genuine
// seam. What makes it useless is the shape of the result, not the score.
const note14OverlongShape = () =>
  weld([
    { count: 397, step: 5.1, speakers: ["Alex", "Blair"], farewell: "Alright, okay, bye." },
    { count: 11077, step: 30, speakers: ["Alex", "Blair"], gapBefore: 6567 },
  ]);

// Note 95's real measured piece durations: 7206s and 2380s, either side of the
// 105.4s silence. Both clear the four-hour cap comfortably.
const note95RealShape = () =>
  weld([
    {
      count: 361,
      step: 7206 / 360,
      speakers: ["Jorge", "Regina"],
      farewell: "Thank you. Good one.",
    },
    {
      count: 120,
      step: 20,
      speakers: ["Fabian", "Molly"],
      gapBefore: 105.4,
      opening: "that's perfectly fine. That's on time.",
    },
  ]);

test("note 14's real shape is refused a split: the after-piece is 92 hours long", async () => {
  const { detectCallBoundaries } = await load();

  const segments = note14OverlongShape();
  const result = detectCallBoundaries(segments);

  assert.equal(result.refused, undefined);
  assert.deepEqual(result.boundaries, []);
  assert.equal(result.pieces.length, 1);
  assert.equal(result.pieces[0].indices.length, segments.length);
});

test("note 14's real shape scores 3, so the max-piece guard is what rejects it", async () => {
  const { detectCallBoundaries, MAX_PIECE_SECONDS } = await load();

  const result = detectCallBoundaries(note14OverlongShape(), {
    maxPieceSeconds: Number.POSITIVE_INFINITY,
  });

  assert.equal(result.boundaries.length, 1);
  const [boundary] = result.boundaries;
  assert.equal(boundary.score, 3);
  assert.deepEqual(boundary.reasons, ["farewell-cue", "long-gap"]);
  assert.ok(Math.abs(boundary.gapSeconds - 6567) < 1e-6, `gap was ${boundary.gapSeconds}`);
  assert.ok(Math.abs(boundary.before.durationSeconds - 2019.6) < 1e-6);
  assert.ok(Math.abs(boundary.after.durationSeconds - 332280) < 1e-6);
  assert.ok(boundary.after.durationSeconds > MAX_PIECE_SECONDS);
});

test("note 95's real piece durations are both under the cap, so its split survives", async () => {
  const { detectCallBoundaries, MAX_PIECE_SECONDS } = await load();

  const result = detectCallBoundaries(note95RealShape());

  assert.equal(result.refused, undefined);
  assert.equal(result.boundaries.length, 1);
  const [boundary] = result.boundaries;
  assert.equal(boundary.score, 6);
  assert.deepEqual(boundary.reasons, ["farewell-cue", "opening-cue", "speaker-turnover"]);
  assert.ok(Math.abs(boundary.gapSeconds - 105.4) < 1e-6, `gap was ${boundary.gapSeconds}`);
  assert.ok(Math.abs(boundary.before.durationSeconds - 7206) < 1e-6);
  assert.ok(Math.abs(boundary.after.durationSeconds - 2380) < 1e-6);
  assert.ok(boundary.before.durationSeconds < MAX_PIECE_SECONDS);
  assert.ok(boundary.after.durationSeconds < MAX_PIECE_SECONDS);
});

test("the max-piece guard runs after the five-minute loop, on the pieces it settled", async () => {
  const { detectCallBoundaries } = await load();

  // Three pieces: 580s, 266s (under the five-minute floor) and 17970s (over the
  // four-hour cap). The floor drops the lower-scoring boundary (the first, 6
  // against 7), which merges the short piece leftward; only then does the cap
  // see the over-long third piece and drop the surviving boundary too.
  const segments = weld([
    { count: 30, step: 20, speakers: ["Alex", "Blair"], farewell: "Thank you. Good one." },
    {
      count: 20,
      step: 14,
      speakers: ["Casey", "Devon"],
      gapBefore: 105.4,
      opening: "that's perfectly fine. That's on time.",
      farewell: "Thank you. Good one.",
    },
    {
      count: 600,
      step: 30,
      speakers: ["Erin", "Frankie"],
      gapBefore: 200,
      opening: "that's perfectly fine. That's on time.",
    },
  ]);

  const unguarded = detectCallBoundaries(segments, {
    maxPieceSeconds: Number.POSITIVE_INFINITY,
  });
  assert.equal(unguarded.boundaries.length, 1);
  assert.equal(unguarded.boundaries[0].score, 7);
  assert.ok(Math.abs(unguarded.pieces[0].durationSeconds - 951.4) < 1e-6);
  assert.ok(Math.abs(unguarded.pieces[1].durationSeconds - 17970) < 1e-6);

  const result = detectCallBoundaries(segments);

  assert.equal(result.refused, undefined);
  assert.deepEqual(result.boundaries, []);
  assert.equal(result.pieces.length, 1);
  assert.equal(result.pieces[0].indices.length, segments.length);
});

test("the max piece duration is four hours, matching the auto-record safety cap", async () => {
  const { MAX_PIECE_SECONDS } = await load();

  assert.equal(MAX_PIECE_SECONDS, 14400);
  assert.equal(MAX_PIECE_SECONDS, 4 * 60 * 60);
});
