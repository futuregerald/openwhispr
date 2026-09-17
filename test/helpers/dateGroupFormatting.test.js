// Pinned before the first Date is constructed. The whole defect class is
// invisible at UTC+0, so an unpinned run passes vacuously on UTC CI.
process.env.TZ = "America/New_York";

const test = require("node:test");
const assert = require("node:assert/strict");

// Requires Node's native TypeScript type-stripping (Node >= 22.6 with
// --experimental-strip-types, on by default in Node 23.6+/24). CI runs Node 24.
const load = () => import("../../src/utils/dateFormatting.ts");

const t = (key) =>
  ({
    "controlPanel.history.dateGroups.today": "Today",
    "controlPanel.history.dateGroups.yesterday": "Yesterday",
    "upcoming.tomorrow": "Tomorrow",
  })[key] || key;

const pad = (n) => String(n).padStart(2, "0");

// The form SQLite's CURRENT_TIMESTAMP writes: UTC, space-separated, no zone.
function toDbString(date) {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

// The form Google returns for a timed event: local wall clock plus an offset.
function toOffsetIso(date) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const hours = pad(Math.floor(Math.abs(offset) / 60));
  const minutes = pad(Math.abs(offset) % 60);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${hours}:${minutes}`
  );
}

// Relative to the real clock, because both group helpers read `new Date()`
// internally and there is no seam to inject a fixed now.
function localDateAt(dayOffset, hour, minute) {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, hour, minute, 0);
}

test("D1: normalizeDbDate detects an offset, not just a trailing Z", async () => {
  const { normalizeDbDate } = await load();

  const withColon = normalizeDbDate("2026-09-16T10:00:00+02:00");
  assert.ok(!Number.isNaN(withColon.getTime()), "+02:00 must not become Invalid Date");
  assert.equal(withColon.toISOString(), "2026-09-16T08:00:00.000Z");

  const withoutColon = normalizeDbDate("2026-09-16T10:00:00+0200");
  assert.ok(!Number.isNaN(withoutColon.getTime()), "+0200 must not become Invalid Date");
  assert.equal(withoutColon.toISOString(), "2026-09-16T08:00:00.000Z");

  assert.equal(normalizeDbDate("2026-09-16T10:00:00Z").toISOString(), "2026-09-16T10:00:00.000Z");
});

test("D1: a zoneless SQLite timestamp is still read as UTC", async () => {
  const { normalizeDbDate } = await load();
  assert.equal(normalizeDbDate("2026-09-17 01:30:00").toISOString(), "2026-09-17T01:30:00.000Z");
});

test("D2: an evening recording groups under today, not tomorrow", async () => {
  const { formatDateGroup } = await load();
  // 21:30 local today -> stored as tomorrow's date in UTC, west of UTC.
  const stored = toDbString(localDateAt(0, 21, 30));
  assert.equal(formatDateGroup(stored, t), "Today");
});

test("D2: yesterday evening groups under yesterday", async () => {
  const { formatDateGroup } = await load();
  assert.equal(formatDateGroup(toDbString(localDateAt(-1, 21, 30)), t), "Yesterday");
});

test("regression: just after local midnight still groups under today", async () => {
  const { formatDateGroup } = await load();
  assert.equal(formatDateGroup(toDbString(localDateAt(0, 0, 15)), t), "Today");
});

test("D3: empty and unparseable input yield an invalid date, never a throw", async () => {
  const { normalizeDbDate } = await load();
  for (const input of ["", "   ", null, undefined, "not a date"]) {
    const result = normalizeDbDate(input);
    assert.ok(result instanceof Date, `${String(input)} must still return a Date`);
    assert.ok(Number.isNaN(result.getTime()), `${String(input)} must be an invalid Date`);
  }
});

test("D3: both group helpers render an empty label rather than NaN", async () => {
  const { formatDateGroup, formatUpcomingDateGroup } = await load();
  for (const input of ["", null, undefined, "not a date"]) {
    assert.equal(formatDateGroup(input, t), "", `formatDateGroup(${String(input)})`);
    assert.equal(formatUpcomingDateGroup(input, t), "", `formatUpcomingDateGroup(${String(input)})`);
  }
});

test("D4: a date-only start parses as a local calendar day, not UTC midnight", async () => {
  const { parseEventDate } = await load();
  const parsed = parseEventDate("2026-09-16");
  assert.ok(parsed, "date-only value must parse");
  assert.equal(parsed.getFullYear(), 2026);
  assert.equal(parsed.getMonth(), 8);
  assert.equal(parsed.getDate(), 16, "must stay on the 16th west of UTC");
  assert.equal(parsed.getHours(), 0);
});

test("D4: parseEventDate passes offset-bearing values through untouched", async () => {
  const { parseEventDate } = await load();
  assert.equal(
    parseEventDate("2026-09-16T10:00:00+02:00").toISOString(),
    "2026-09-16T08:00:00.000Z"
  );
});

test("D4: parseEventDate returns null for anything unreadable", async () => {
  const { parseEventDate } = await load();
  for (const input of ["", null, undefined, "nonsense", "2026-13-45"]) {
    assert.equal(parseEventDate(input), null, `parseEventDate(${String(input)})`);
  }
});

// Diverges from upstream, which lets new Date(2026, 12, 45) roll over into the
// following year rather than rejecting it. Pinned so a later "simplify back to
// upstream" edit cannot drop it silently.
test("D4: a date-only value that would roll over is rejected", async () => {
  const { parseEventDate } = await load();

  const leapDay = parseEventDate("2024-02-29");
  assert.ok(leapDay, "29 Feb in a leap year is a real date");
  assert.equal(leapDay.getMonth(), 1);
  assert.equal(leapDay.getDate(), 29);

  for (const input of ["2025-02-29", "2026-04-31", "2026-00-10", "2026-01-00"]) {
    assert.equal(parseEventDate(input), null, `parseEventDate(${input}) must not roll over`);
  }
});

test("D4: a date-only start groups on its own local day, not the day before", async () => {
  const { formatUpcomingDateGroup } = await load();
  const today = localDateAt(0, 0, 0);
  const dateOnly = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  assert.equal(formatUpcomingDateGroup(dateOnly, t), "Today");
});

test("regression: an offset-bearing calendar start is not double-shifted", async () => {
  const { formatUpcomingDateGroup } = await load();
  assert.equal(formatUpcomingDateGroup(toOffsetIso(localDateAt(1, 10, 0)), t), "Tomorrow");
  assert.equal(formatUpcomingDateGroup(toOffsetIso(localDateAt(0, 10, 0)), t), "Today");
});

test("regression: formatUpcomingDateGroup still accepts a Date", async () => {
  const { formatUpcomingDateGroup } = await load();
  assert.equal(formatUpcomingDateGroup(localDateAt(1, 10, 0), t), "Tomorrow");
});
