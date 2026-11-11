const test = require("node:test");
const assert = require("node:assert/strict");

const {
  NOTIFICATION_WINDOW_CONFIG,
  RECORDING_NOTICE_WINDOW_CONFIG,
  WindowPositionUtil,
} = require("../../src/helpers/windowConfig");

const display = { workArea: { x: 0, y: 0, width: 1920, height: 1080 } };

test("the recording notice window is taller than a meeting prompt but otherwise the same", () => {
  assert.equal(RECORDING_NOTICE_WINDOW_CONFIG.height, 160);
  assert.ok(RECORDING_NOTICE_WINDOW_CONFIG.height > NOTIFICATION_WINDOW_CONFIG.height);
  assert.equal(RECORDING_NOTICE_WINDOW_CONFIG.width, NOTIFICATION_WINDOW_CONFIG.width);
});

test("the notice window is positioned with its own height", () => {
  const notice = WindowPositionUtil.getNotificationPosition(
    display,
    RECORDING_NOTICE_WINDOW_CONFIG
  );
  const prompt = WindowPositionUtil.getNotificationPosition(display);

  assert.equal(notice.height, 160);
  assert.equal(prompt.height, NOTIFICATION_WINDOW_CONFIG.height);
});
