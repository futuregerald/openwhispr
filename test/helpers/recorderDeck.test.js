const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/recorderDeck.js");

test("formatElapsed renders H:MM:SS and clamps negatives", async () => {
  const { formatElapsed } = await load();
  assert.equal(formatElapsed(0), "0:00:00");
  assert.equal(formatElapsed(59_999), "0:00:59");
  assert.equal(formatElapsed(61_000), "0:01:01");
  assert.equal(formatElapsed(3_725_000), "1:02:05");
  assert.equal(formatElapsed(-5_000), "0:00:00");
  assert.equal(formatElapsed(Number.NaN), "0:00:00");
});

test("deckTracks starts with one open track and splits at each mark time", async () => {
  const { deckTracks } = await load();
  assert.deepEqual(deckTracks(1000, []), [{ number: "01", startsAtMs: 1000, endsAtMs: null }]);
  assert.deepEqual(deckTracks(1000, [5000, 9000]), [
    { number: "01", startsAtMs: 1000, endsAtMs: 5000 },
    { number: "02", startsAtMs: 5000, endsAtMs: 9000 },
    { number: "03", startsAtMs: 9000, endsAtMs: null },
  ]);
});

test("deckTracks is empty before the recording has started", async () => {
  const { deckTracks } = await load();
  assert.deepEqual(deckTracks(null, [1, 2]), []);
});

test("NEXT is enabled with no marks and no press in flight", async () => {
  const { markerKeyState } = await load();
  assert.deepEqual(
    markerKeyState({ isMarking: false, markCount: 0, lastMarkAtMs: null, nowMs: 5 }),
    {
      enabled: true,
      reason: null,
    }
  );
});

test("NEXT is disabled while a press is in flight", async () => {
  const { markerKeyState } = await load();
  const state = markerKeyState({ isMarking: true, markCount: 0, lastMarkAtMs: null, nowMs: 5 });
  assert.deepEqual(state, { enabled: false, reason: "marking" });
});

test("NEXT is disabled at the mark limit", async () => {
  const { markerKeyState, MAX_MARKS } = await load();
  assert.equal(MAX_MARKS, 8);
  const state = markerKeyState({ isMarking: false, markCount: 8, lastMarkAtMs: 0, nowMs: 99_999 });
  assert.deepEqual(state, { enabled: false, reason: "limit-reached" });
  assert.equal(
    markerKeyState({ isMarking: false, markCount: 7, lastMarkAtMs: 0, nowMs: 99_999 }).enabled,
    true
  );
});

test("NEXT is disabled for 10 seconds after a mark and enabled at 10 seconds", async () => {
  const { markerKeyState } = await load();
  const at = (nowMs) =>
    markerKeyState({ isMarking: false, markCount: 1, lastMarkAtMs: 1000, nowMs });
  assert.deepEqual(at(10_999), { enabled: false, reason: "too-soon" });
  assert.deepEqual(at(11_000), { enabled: true, reason: null });
});

test("a successful mark replaces the marks with what main reports", async () => {
  const { recordMarkerResult } = await load();
  const next = recordMarkerResult({ marks: [] }, { success: true, marks: [1_790_000_012_500] });
  assert.deepEqual(next, { marks: [1_790_000_012_500], refusal: null });
  const again = recordMarkerResult(next, {
    success: true,
    marks: [1_790_000_012_500, 1_790_000_040_000],
  });
  assert.deepEqual(again.marks, [1_790_000_012_500, 1_790_000_040_000]);
});

test("a refused mark keeps the book and reports the reason", async () => {
  const { recordMarkerResult } = await load();
  const book = { marks: [12_500] };
  assert.deepEqual(recordMarkerResult(book, { success: false, reason: "too-soon" }), {
    marks: [12_500],
    refusal: "too-soon",
  });
});

test("a failed call with no reason is reported as unknown", async () => {
  const { recordMarkerResult } = await load();
  assert.equal(recordMarkerResult({ marks: [] }, undefined).refusal, "unknown");
  assert.equal(recordMarkerResult({ marks: [] }, { success: false }).refusal, "unknown");
});

let nextHandle = 1;

const makeHarness = (overrides = {}) => {
  let state = {
    isRecording: true,
    recordingNoteId: 7,
    isMarking: false,
    markers: [],
    markerRefusal: null,
    ...overrides,
  };
  const scheduled = [];
  return {
    getState: () => state,
    setState: (patch) => {
      state = { ...state, ...patch };
    },
    scheduled,
    schedule: (fn, ms) => {
      const entry = { fn, ms, handle: nextHandle };
      nextHandle += 1;
      scheduled.push(entry);
      return entry.handle;
    },
    cancel: (handle) => {
      const entry = scheduled.find((candidate) => candidate.handle === handle);
      if (entry) entry.cancelled = true;
    },
  };
};

const pressWith = async (pressMarker, h, requestMark, extra = {}) =>
  pressMarker({
    getState: h.getState,
    setState: h.setState,
    schedule: h.schedule,
    cancel: h.cancel,
    requestMark,
    ...extra,
  });

test("pressMarker records the marks main reports on success", async () => {
  const { pressMarker } = await load();
  const h = makeHarness();
  await pressWith(pressMarker, h, async () => ({ success: true, marks: [31_500] }));
  assert.deepEqual(h.getState(), {
    isRecording: true,
    recordingNoteId: 7,
    isMarking: false,
    markers: [31_500],
    markerRefusal: null,
  });
});

test("pressMarker keeps the marks and surfaces the reason when main refuses", async () => {
  const { pressMarker } = await load();
  const h = makeHarness({ markers: [5] });
  await pressWith(pressMarker, h, async () => ({ success: false, reason: "too-soon" }));
  const state = h.getState();
  assert.deepEqual(state.markers, [5]);
  assert.equal(state.markerRefusal, "too-soon");
  assert.equal(state.isMarking, false);
});

test("pressMarker does nothing when not recording or when a press is in flight", async () => {
  const { pressMarker } = await load();
  let calls = 0;
  const requestMark = async () => {
    calls += 1;
    return { success: true, marks: [1] };
  };
  await pressWith(pressMarker, makeHarness({ isRecording: false }), requestMark);
  await pressWith(pressMarker, makeHarness({ isMarking: true }), requestMark);
  assert.equal(calls, 0);
});

test("pressMarker marks the press in flight while waiting", async () => {
  const { pressMarker } = await load();
  const h = makeHarness();
  let seenWhileWaiting;
  await pressWith(pressMarker, h, async () => {
    seenWhileWaiting = h.getState().isMarking;
    return { success: true, marks: [1] };
  });
  assert.equal(seenWhileWaiting, true);
});

test("pressMarker clears the in-flight flag and reports unknown when the call throws", async () => {
  const { pressMarker } = await load();
  const h = makeHarness();
  let reported;
  await pressWith(
    pressMarker,
    h,
    async () => {
      throw new Error("boom");
    },
    {
      onError: (error) => {
        reported = error.message;
      },
    }
  );
  assert.equal(reported, "boom");
  assert.equal(h.getState().isMarking, false);
  assert.equal(h.getState().markerRefusal, "unknown");
});

test("pressMarker discards a result that arrives after the recording stopped", async () => {
  const { pressMarker } = await load();
  const h = makeHarness();
  await pressWith(pressMarker, h, async () => {
    h.setState({ isRecording: false });
    return { success: true, marks: [9] };
  });
  assert.deepEqual(h.getState().markers, []);
  assert.equal(h.getState().isMarking, false);
});

test("pressMarker discards a result that arrives after a different recording started", async () => {
  const { pressMarker } = await load();
  const h = makeHarness();
  await pressWith(pressMarker, h, async () => {
    h.setState({ recordingNoteId: 8, markers: [], isMarking: false });
    return { success: true, marks: [1_790_000_000_000] };
  });
  assert.deepEqual(h.getState().markers, [], "the other note's marks are not shown on this one");
  assert.equal(h.getState().markerRefusal, null);
});

test("a refusal clears itself after five seconds", async () => {
  const { pressMarker, REFUSAL_VISIBLE_MS } = await load();
  const h = makeHarness();
  await pressWith(pressMarker, h, async () => ({ success: false, reason: "too-soon" }));
  assert.equal(h.scheduled.length, 1);
  assert.equal(h.scheduled[0].ms, 5000);
  assert.equal(REFUSAL_VISIBLE_MS, 5000);
  assert.equal(h.getState().markerRefusal, "too-soon");

  h.scheduled[0].fn();
  assert.equal(h.getState().markerRefusal, null);
});

test("the next press cancels the pending clear and a successful press clears the refusal", async () => {
  const { pressMarker } = await load();
  const h = makeHarness();
  await pressWith(pressMarker, h, async () => ({ success: false, reason: "too-soon" }));
  await pressWith(pressMarker, h, async () => ({ success: true, marks: [1_790_000_000_000] }));

  assert.equal(h.scheduled[0].cancelled, true);
  assert.equal(h.getState().markerRefusal, null);
  assert.equal(h.scheduled.length, 1, "a success schedules nothing");
});

test("a stale clear does not wipe a newer refusal", async () => {
  const { pressMarker } = await load();
  const h = makeHarness();
  await pressWith(pressMarker, h, async () => ({ success: false, reason: "too-soon" }));
  const stale = h.scheduled[0].fn;
  await pressWith(pressMarker, h, async () => ({ success: false, reason: "limit-reached" }));
  stale();
  assert.equal(h.getState().markerRefusal, "limit-reached");
});
