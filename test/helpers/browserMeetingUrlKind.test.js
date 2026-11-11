const test = require("node:test");
const assert = require("node:assert/strict");

const { classifyMeetingUrl } = require("../../src/helpers/browserMeetingUrlChecker");

const CASES = [
  ["https://meet.google.com/abc-defg-hij", "web-call"],
  ["https://us02web.zoom.us/wc/123456789/join", "web-call"],
  ["https://zoom.us/wc/join/123456789", "web-call"],
  ["https://us02web.zoom.us/j/123456789", "launcher"],
  ["https://teams.microsoft.com/l/meetup-join/19%3ameeting", "launcher"],
  ["https://teams.microsoft.com/meet/123456789?p=abc", "launcher"],
  ["https://teams.live.com/meet/9876543210", "launcher"],
  ["https://teams.live.com/v2/?meetingjoin=true", "web-call"],
  ["https://meet.google.com/", null],
];

for (const [url, kind] of CASES) {
  test(`${url} is classified as ${kind}`, () => {
    assert.equal(classifyMeetingUrl(url), kind);
  });
}

test("a web-call URL wins over a launcher URL regardless of order", () => {
  const { pickMeetingUrl } = require("../../src/helpers/browserMeetingUrlChecker");
  const launcher = "https://us02web.zoom.us/j/123456789";
  const webCall = "https://meet.google.com/abc-defg-hij";

  assert.deepEqual(pickMeetingUrl([launcher, webCall]), { url: webCall, kind: "web-call" });
  assert.deepEqual(pickMeetingUrl([webCall, launcher]), { url: webCall, kind: "web-call" });
  assert.deepEqual(pickMeetingUrl([launcher]), { url: launcher, kind: "launcher" });
  assert.equal(pickMeetingUrl(["https://example.com"]), null);
});
