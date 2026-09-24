const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { requireSqlite } = require("../support/sqlite.js");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-stats-duration-"));
const originalLoad = Module._load;

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: {
        getPath: () => userDataDir,
        getAppPath: () => process.cwd(),
        isReady: () => false,
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

process.env.NODE_ENV = "test";

const DatabaseManager = require("../../src/helpers/database.js");

function createDb() {
  requireSqlite();
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-stats-duration-"));
  return new DatabaseManager();
}

// Segments are written directly rather than through the indexer: the SQL that derives a
// duration from them is the unit under test, and driving the indexer would test the indexer.
function addSegments(dbm, noteId, offsetsMs, { mixedUnits = 0 } = {}) {
  const insert = dbm.db.prepare(
    `INSERT INTO transcript_segments (note_id, seq, speaker_id, text, offset_ms, timestamp_kind)
     VALUES (?, ?, 'speaker_0', 'words', ?, 'relative')`
  );
  offsetsMs.forEach((offset, i) => insert.run(noteId, i, offset));
  dbm.db
    .prepare(
      `INSERT INTO transcript_segment_index (note_id, transcript_hash, segment_count, mixed_units)
       VALUES (?, 'hash', ?, ?)`
    )
    .run(noteId, offsetsMs.length, mixedUnits);
}

function onlyBucket(dbm) {
  const { buckets } = dbm.getStats({ groupBy: "month" });
  assert.equal(buckets.length, 1, "fixture should produce exactly one bucket");
  return buckets[0];
}

test("a bucket with no derivable duration reports null, not zero", () => {
  const dbm = createDb();
  dbm.saveNote("no audio", "typed by hand", "personal");

  const bucket = onlyBucket(dbm);
  assert.equal(
    bucket.total_duration_seconds,
    null,
    "COALESCE(...,0) made 'nothing recorded' indistinguishable from 'zero minutes' (#82)"
  );
  assert.equal(bucket.notes, 1);
  assert.equal(bucket.notes_with_duration, 0);
});

test("duration is derived from gap-capped segment deltas", () => {
  const dbm = createDb();
  const { note } = dbm.saveNote("meeting", "", "meeting");
  // 0s, 10s, 20s, 30s -> 30s of speech, every gap under the cap.
  addSegments(dbm, note.id, [0, 10_000, 20_000, 30_000]);

  const bucket = onlyBucket(dbm);
  assert.equal(bucket.total_duration_seconds, 30);
  assert.equal(bucket.notes_with_duration, 1);
});

test("a wall-clock gap does not inflate the duration", () => {
  const dbm = createDb();
  const { note } = dbm.saveNote("resumed days later", "", "meeting");
  // Two short runs separated by ~20 hours, which is what note 14 in the real database looks
  // like: appended across days, so max(offset) - min(offset) reports 20h of "recording".
  addSegments(dbm, note.id, [0, 10_000, 20_000, 73_000_000, 73_010_000, 73_020_000]);

  const bucket = onlyBucket(dbm);
  assert.ok(
    bucket.total_duration_seconds < 120,
    `span-based arithmetic would report ~73000s here, got ${bucket.total_duration_seconds}`
  );
  assert.equal(
    bucket.total_duration_seconds,
    // 2 x 20s of real speech, plus the one over-cap gap counted as the 60s cap.
    100,
    "each gap contributes min(gap, cap)"
  );
});

// mixed_units reports that the RAW timestamps mixed units; deriveTimestamps has already
// normalised them, so any segment whose unit could not be resolved has offset_ms NULL and is
// excluded per row. Gating the whole note on the flag threw away 28 of 154 measurable hours on
// a real library and changed the answer for none of them.
test("a mixed-units note is still measured, because unusable segments drop out per row", () => {
  const dbm = createDb();
  const { note } = dbm.saveNote("blended units", "", "meeting");
  addSegments(dbm, note.id, [0, 10_000, 20_000], { mixedUnits: 1 });

  const bucket = onlyBucket(dbm);
  assert.equal(bucket.total_duration_seconds, 20);
  assert.equal(bucket.notes_with_duration, 1);
});

test("a segment with no resolvable offset contributes nothing", () => {
  const dbm = createDb();
  const { note } = dbm.saveNote("half unusable", "", "meeting");
  addSegments(dbm, note.id, [0, 10_000, 20_000], { mixedUnits: 1 });
  // What deriveTimestamps produces for an epoch timestamp with no origin.
  dbm.db
    .prepare(
      `INSERT INTO transcript_segments (note_id, seq, speaker_id, text, offset_ms, timestamp_kind)
       VALUES (?, 99, 'speaker_0', 'words', NULL, 'absolute')`
    )
    .run(note.id);

  const bucket = onlyBucket(dbm);
  assert.equal(bucket.total_duration_seconds, 20, "the NULL-offset segment must not add a gap");
});

// Restoring coverage the SQL review flagged as absent: a recorded length and a mixed-units
// transcript together. The flag must not interfere with COALESCE precedence.
test("an explicit recorded duration wins even for a mixed-units transcript", () => {
  const dbm = createDb();
  const { note } = dbm.saveNote("cli note, messy transcript", "", "meeting", null, 900);
  addSegments(dbm, note.id, [0, 10_000, 20_000], { mixedUnits: 1 });

  const bucket = onlyBucket(dbm);
  assert.equal(bucket.total_duration_seconds, 900);
  assert.equal(bucket.notes_with_duration, 1);
});

test("a partly-measurable bucket reports coverage instead of a bare total", () => {
  const dbm = createDb();
  const { note: measured } = dbm.saveNote("measured", "", "meeting");
  addSegments(dbm, measured.id, [0, 10_000, 20_000]);
  dbm.saveNote("no segments at all", "typed", "personal");
  dbm.saveNote("also no segments", "typed", "personal");

  const bucket = onlyBucket(dbm);
  assert.equal(bucket.notes, 3);
  assert.equal(bucket.total_duration_seconds, 20, "only the measurable note contributes");
  assert.equal(
    bucket.notes_with_duration,
    1,
    "SUM skips NULLs silently, so a total without coverage reads as if every note were measured"
  );
});

// The parameter binding is the most breakable thing in this query and every other test here
// calls getStats with no range at all, so none of them would notice a mis-bind.
test("since and until bind correctly and split the buckets", () => {
  const dbm = createDb();
  const older = dbm.saveNote("january", "", "meeting").note;
  const newer = dbm.saveNote("march", "", "meeting").note;
  dbm.db
    .prepare("UPDATE notes SET created_at = ? WHERE id = ?")
    .run("2026-01-15 10:00:00", older.id);
  dbm.db
    .prepare("UPDATE notes SET created_at = ? WHERE id = ?")
    .run("2026-03-15 10:00:00", newer.id);
  addSegments(dbm, older.id, [0, 10_000, 20_000]);
  addSegments(dbm, newer.id, [0, 10_000, 20_000, 30_000]);

  const all = dbm.getStats({ groupBy: "month" });
  assert.deepEqual(
    all.buckets.map((b) => [b.bucket, b.notes, b.total_duration_seconds]),
    [
      ["2026-01", 1, 20],
      ["2026-03", 1, 30],
    ]
  );

  const sinceOnly = dbm.getStats({ groupBy: "month", since: "2026-02-01" });
  assert.deepEqual(
    sinceOnly.buckets.map((b) => b.bucket),
    ["2026-03"]
  );
  assert.equal(sinceOnly.buckets[0].total_duration_seconds, 30);

  const untilOnly = dbm.getStats({ groupBy: "month", until: "2026-02-01" });
  assert.deepEqual(
    untilOnly.buckets.map((b) => b.bucket),
    ["2026-01"]
  );
  assert.equal(untilOnly.buckets[0].total_duration_seconds, 20);

  const both = dbm.getStats({ groupBy: "month", since: "2026-01-01", until: "2026-02-01" });
  assert.deepEqual(
    both.buckets.map((b) => b.bucket),
    ["2026-01"]
  );

  // by_speaker runs a second query with its own placeholder set, so assert on ITS rows:
  // reading buckets.length here would only catch a wrong placeholder count, not a wrong order.
  dbm.db
    .prepare("UPDATE transcript_segments SET speaker_name = 'Molly' WHERE note_id = ?")
    .run(older.id);
  dbm.db
    .prepare("UPDATE transcript_segments SET speaker_name = 'Mike' WHERE note_id = ?")
    .run(newer.id);

  const allSpeakers = dbm.getStats({ groupBy: "month", bySpeaker: true });
  assert.deepEqual(allSpeakers.by_speaker.map((r) => r.speaker).sort(), ["Mike", "Molly"]);

  const laterSpeakers = dbm.getStats({ groupBy: "month", since: "2026-02-01", bySpeaker: true });
  assert.deepEqual(
    laterSpeakers.by_speaker.map((r) => r.speaker),
    ["Mike"],
    "the speaker query must honour the same range, bound to its own parameters"
  );
});

// Offsets that go backwards mean the clock restarted mid-recording. Treating that boundary as
// zero-length rather than negative is deliberate; pinning it so the choice is visible.
test("a backwards offset contributes nothing rather than a negative duration", () => {
  const dbm = createDb();
  const { note } = dbm.saveNote("clock restarted", "", "meeting");
  addSegments(dbm, note.id, [0, 10_000, 5_000, 30_000, 20_000]);

  const bucket = onlyBucket(dbm);
  assert.equal(bucket.total_duration_seconds, 35);
  assert.equal(bucket.notes_with_duration, 1);
});

test("a single-segment note is unmeasurable, not zero", () => {
  const dbm = createDb();
  const { note } = dbm.saveNote("one segment", "", "meeting");
  addSegments(dbm, note.id, [0]);

  const bucket = onlyBucket(dbm);
  assert.equal(
    bucket.total_duration_seconds,
    null,
    "there is no per-segment end time, so one segment yields no gap to measure"
  );
  assert.equal(bucket.notes_with_duration, 0);
});

test("an explicit audio_duration_seconds still wins over the derivation", () => {
  const dbm = createDb();
  // The CLI's POST /v1/notes/create is the one caller that sets this, and it is authoritative.
  const { note } = dbm.saveNote("from the cli", "", "meeting", null, 600);
  addSegments(dbm, note.id, [0, 10_000, 20_000]);

  const bucket = onlyBucket(dbm);
  assert.equal(bucket.total_duration_seconds, 600);
  assert.equal(bucket.notes_with_duration, 1);
});
