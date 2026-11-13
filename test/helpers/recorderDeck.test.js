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

test("a successful mark replaces the marks and records the press time", async () => {
  const { recordMarkerResult } = await load();
  const next = recordMarkerResult({ marks: [], times: [] }, { success: true, marks: [12.5] }, 777);
  assert.deepEqual(next, { marks: [12.5], times: [777], refusal: null });
  const again = recordMarkerResult(next, { success: true, marks: [12.5, 40] }, 888);
  assert.deepEqual(again, { marks: [12.5, 40], times: [777, 888], refusal: null });
});

test("a refused mark keeps the book and reports the reason", async () => {
  const { recordMarkerResult } = await load();
  const book = { marks: [12.5], times: [777] };
  assert.deepEqual(recordMarkerResult(book, { success: false, reason: "too-soon" }, 900), {
    marks: [12.5],
    times: [777],
    refusal: "too-soon",
  });
});

test("a failed call with no reason is reported as unknown", async () => {
  const { recordMarkerResult } = await load();
  assert.equal(recordMarkerResult({ marks: [], times: [] }, undefined, 1).refusal, "unknown");
  assert.equal(
    recordMarkerResult({ marks: [], times: [] }, { success: false }, 1).refusal,
    "unknown"
  );
});

test("press times stay aligned when main reports a different number of marks than the book", async () => {
  const { recordMarkerResult } = await load();
  const shrunk = recordMarkerResult(
    { marks: [1, 2, 3], times: [10, 20, 30] },
    { success: true, marks: [1, 2] },
    40
  );
  assert.equal(shrunk.times.length, shrunk.marks.length);
  const grown = recordMarkerResult({ marks: [], times: [] }, { success: true, marks: [1, 2] }, 50);
  assert.deepEqual(grown.times, [50, 50]);
});

const makeHarness = (overrides = {}) => {
  let state = {
    isRecording: true,
    isMarking: false,
    markers: [],
    markerTimes: [],
    markerRefusal: null,
    ...overrides,
  };
  return {
    getState: () => state,
    setState: (patch) => {
      state = { ...state, ...patch };
    },
    nowMs: () => 4242,
  };
};

test("pressMarker records the marks and the press time on success", async () => {
  const { pressMarker } = await load();
  const h = makeHarness();
  await pressMarker({ ...h, requestMark: async () => ({ success: true, marks: [31.5] }) });
  assert.deepEqual(h.getState(), {
    isRecording: true,
    isMarking: false,
    markers: [31.5],
    markerTimes: [4242],
    markerRefusal: null,
  });
});

test("pressMarker keeps the marks and surfaces the reason when main refuses", async () => {
  const { pressMarker } = await load();
  const h = makeHarness({ markers: [5], markerTimes: [2000] });
  await pressMarker({ ...h, requestMark: async () => ({ success: false, reason: "too-soon" }) });
  const state = h.getState();
  assert.deepEqual(state.markers, [5]);
  assert.deepEqual(state.markerTimes, [2000]);
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
  await pressMarker({ ...makeHarness({ isRecording: false }), requestMark });
  await pressMarker({ ...makeHarness({ isMarking: true }), requestMark });
  assert.equal(calls, 0);
});

test("pressMarker marks the press in flight while waiting", async () => {
  const { pressMarker } = await load();
  const h = makeHarness();
  let seenWhileWaiting;
  await pressMarker({
    ...h,
    requestMark: async () => {
      seenWhileWaiting = h.getState().isMarking;
      return { success: true, marks: [1] };
    },
  });
  assert.equal(seenWhileWaiting, true);
});

test("pressMarker clears the in-flight flag and reports unknown when the call throws", async () => {
  const { pressMarker } = await load();
  const h = makeHarness();
  let reported;
  await pressMarker({
    ...h,
    requestMark: async () => {
      throw new Error("boom");
    },
    onError: (error) => {
      reported = error.message;
    },
  });
  assert.equal(reported, "boom");
  assert.equal(h.getState().isMarking, false);
  assert.equal(h.getState().markerRefusal, "unknown");
});

test("pressMarker discards a result that arrives after the recording stopped", async () => {
  const { pressMarker } = await load();
  const h = makeHarness();
  await pressMarker({
    ...h,
    requestMark: async () => {
      h.setState({ isRecording: false });
      return { success: true, marks: [9] };
    },
  });
  assert.deepEqual(h.getState().markers, []);
  assert.equal(h.getState().isMarking, false);
});
