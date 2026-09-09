const test = require("node:test");
const assert = require("node:assert/strict");
const { fileURLToPath } = require("node:url");

const { toPlayableAudioUrl } = require("../../src/helpers/noteAudioUrl.js");

// "file://" + encodeURI(path) is correct on macOS and broken on Windows: encodeURI escapes
// the backslashes and file://C: parses the drive letter as a HOST, so the URL never resolves
// and every Windows user gets a play button that only ever errors.
test("a path with spaces round-trips back to the same path", () => {
  const p = "/Users/x/Library/Application Support/open-whispr/audio/m-system.opus";

  const url = toPlayableAudioUrl(p);

  assert.ok(url.startsWith("file:///"), url);
  assert.ok(url.includes("Application%20Support"), url);
  assert.equal(fileURLToPath(url), p);
});

test("a non-ASCII path round-trips, because userData carries the account name", () => {
  const p = "/Users/Gerald Ø/Library/Application Support/open-whispr/audio/møte.opus";

  assert.equal(fileURLToPath(toPlayableAudioUrl(p)), p);
});

test("a '#' in the path does not truncate the URL at a fragment", () => {
  const p = "/Users/x/audio/take #2.opus";

  const url = toPlayableAudioUrl(p);

  assert.ok(!url.includes("#"), `unescaped '#' would cut the URL short: ${url}`);
  assert.equal(fileURLToPath(url), p);
});

test("no path yields no url, so the control disables rather than failing at play time", () => {
  assert.equal(toPlayableAudioUrl(null), null);
  assert.equal(toPlayableAudioUrl(undefined), null);
  assert.equal(toPlayableAudioUrl(""), null);
});

// A Windows path must never come back with the drive letter as the host. This is asserted
// against the shape rather than by running on Windows.
test("a Windows path never produces file://C: with the drive as host", () => {
  const url = toPlayableAudioUrl(
    "C:\\Users\\Gerald\\AppData\\Roaming\\open-whispr\\audio\\m.opus",
    "win32"
  );

  assert.equal(url, "file:///C:/Users/Gerald/AppData/Roaming/open-whispr/audio/m.opus");
  assert.ok(!/^file:\/\/[A-Za-z]:/.test(url), `drive letter parsed as host: ${url}`);
  assert.ok(!url.includes("%5C"), `backslashes must not be percent-escaped: ${url}`);
});

test("a Windows path with spaces escapes them without touching the drive or separators", () => {
  const url = toPlayableAudioUrl("C:\\Users\\Gerald O\\App Data\\take #2.opus", "win32");

  assert.equal(url, "file:///C:/Users/Gerald%20O/App%20Data/take%20%232.opus");
});

test("a Windows UNC path keeps the server as the host, which is what UNC means", () => {
  const url = toPlayableAudioUrl("\\\\server\\share\\audio\\m.opus", "win32");

  assert.equal(url, "file://server/share/audio/m.opus");
});

// The POSIX branch is hand-written too, so pin it against Node's own conversion on this
// platform rather than trusting that it looks right.
test("the posix branch agrees with url.pathToFileURL", () => {
  const { pathToFileURL } = require("node:url");
  for (const p of [
    "/Users/x/Library/Application Support/open-whispr/audio/m-system.opus",
    "/Users/Gerald \u00d8/audio/m\u00f8te.opus",
    "/Users/x/audio/take #2.opus",
    "/Users/x/audio/100%25 done.opus",
  ]) {
    assert.equal(toPlayableAudioUrl(p, "darwin"), pathToFileURL(p).href, p);
  }
});
