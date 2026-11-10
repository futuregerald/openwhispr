const test = require("node:test");
const assert = require("node:assert/strict");
const { mock } = require("node:test");

const health = require("../../src/helpers/meetingDetectionHealth");
const CallStateDetector = require("../../src/helpers/callStateDetector");

// A recording may only be ended on evidence that a call was happening. Without
// that rule every in-person recording and every camera-off desktop-app call would
// be stopped about 24 seconds in, because "no meeting tab open" looks the same as
// "the call is over".

const END_POLL_MS = 12000;
const settle = () => new Promise((resolve) => setImmediate(resolve));

test.beforeEach(() => health.reset());

function createDetector(t, results) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  t.after(() => mock.timers.reset());

  const queue = [...results];
  const urlChecker = async () => {
    const next = queue.length ? queue.shift() : { matched: false };
    if (next instanceof Error) throw next;
    return next;
  };
  const detector = new CallStateDetector({ urlChecker });
  const ended = [];
  detector.on("call-ended", () => ended.push(Date.now()));
  return { detector, ended };
}

async function poll(t, times) {
  for (let i = 0; i < times; i += 1) {
    t.mock.timers.tick(END_POLL_MS);
    await settle();
  }
}

const camera = (detector, active) =>
  detector._onData(`${JSON.stringify({ device: "camera", active })}\n`);

const MATCH = { matched: true };
const NO_MATCH = { matched: false };

test("a call that held the camera ends once the camera is released", async (t) => {
  const { detector, ended } = createDetector(t, []);
  detector.setSelfRecording(true);
  camera(detector, true);
  camera(detector, false);

  await poll(t, 2);
  assert.equal(ended.length, 1);

  await poll(t, 2);
  assert.equal(ended.length, 1, "call-ended must be emitted once");
});

test("a meeting URL seen on two polls and then gone ends the recording", async (t) => {
  const { detector, ended } = createDetector(t, [MATCH, MATCH, NO_MATCH, NO_MATCH]);
  detector.setSelfRecording(true);

  await poll(t, 4);

  assert.equal(ended.length, 1);
});

test("a recording that never saw a call is never ended by a missing URL", async (t) => {
  const { detector, ended } = createDetector(t, Array(6).fill(NO_MATCH));
  detector.setSelfRecording(true);

  await poll(t, 6);

  assert.equal(ended.length, 0);
  assert.equal(detector.hasObservedCall(), false);
});

test("a denied URL check is no evidence that the call is over", async (t) => {
  const { detector, ended } = createDetector(t, [
    MATCH,
    MATCH,
    ...Array(6).fill({ matched: false, denied: true }),
  ]);
  detector.setSelfRecording(true);

  await poll(t, 8);

  assert.equal(ended.length, 0);
});

test("an unavailable URL check is no evidence that the call is over", async (t) => {
  const { detector, ended } = createDetector(t, [
    MATCH,
    MATCH,
    ...Array(6).fill({ matched: false, unavailable: true }),
  ]);
  detector.setSelfRecording(true);

  await poll(t, 8);

  assert.equal(ended.length, 0);
});

test("a throwing URL checker is no evidence that the call is over", async (t) => {
  const { detector, ended } = createDetector(t, [
    MATCH,
    MATCH,
    ...Array(6).fill(new Error("osascript failed")),
  ]);
  detector.setSelfRecording(true);

  await poll(t, 8);

  assert.equal(ended.length, 0);
});

test("evidence from a previous recording does not carry into the next one", async (t) => {
  const { detector } = createDetector(t, [MATCH, MATCH]);
  detector.setSelfRecording(true);
  await poll(t, 2);
  assert.equal(detector.hasObservedCall(), true);

  detector.setSelfRecording(false);
  detector.setSelfRecording(true);

  assert.equal(detector.hasObservedCall(), false);
});

test("a camera released before the recording started does not count as the call", async (t) => {
  const { detector, ended } = createDetector(t, []);
  camera(detector, true);
  camera(detector, false);
  detector.setSelfRecording(true);

  await poll(t, 6);

  assert.equal(ended.length, 0, "a stale camera flag would end an in-person recording");
});

test("a camera already on when the recording starts counts as the call", async (t) => {
  const { detector, ended } = createDetector(t, []);
  camera(detector, true);
  detector.setSelfRecording(true);
  camera(detector, false);

  await poll(t, 2);

  assert.equal(ended.length, 1);
});

test("a single matched poll is a launcher tab, not a call", async (t) => {
  const { detector, ended } = createDetector(t, [MATCH, ...Array(6).fill(NO_MATCH)]);
  detector.setSelfRecording(true);

  await poll(t, 7);

  assert.equal(ended.length, 0);
});

test("matches that are not consecutive never add up to a call", async (t) => {
  const { detector, ended } = createDetector(t, [
    MATCH,
    NO_MATCH,
    MATCH,
    NO_MATCH,
    MATCH,
    ...Array(4).fill(NO_MATCH),
  ]);
  detector.setSelfRecording(true);

  await poll(t, 9);

  assert.equal(ended.length, 0);
});
