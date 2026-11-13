const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { requireSqlite } = require("../support/sqlite.js");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-line-cut-"));
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: { getPath: () => userDataDir, getAppPath: () => process.cwd(), isReady: () => false },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
process.env.NODE_ENV = "test";

const DatabaseManager = require("../../src/helpers/database.js");
const { splitNoteAtBoundary } = require("../../src/helpers/splitNoteAtBoundary.js");

const loadModule = () => import("../../src/helpers/lineCut.js");

// Timestamps and source order of a real 201-line, 13m39s note (one remote speaker,
// one local mic). Text, ids and speaker names are invented.
const REAL_SHAPED_STAMPS = [
  4.501, 10.496, 14.305, 17.847, 20.299, 22.603, 26.902, 29.696, 35.702, 41.696, 47.702, 53.003,
  54.998, 58.998, 65.003, 70.998, 77.003, 82.603, 88.395, 91.297, 97.303, 100.502, 104.001, 108.203,
  114.198, 118.797, 122.603, 124.262, 126.305, 132.3, 134.795, 140.3, 143.5, 146.604, 152.396,
  157.196, 159.201, 164.396, 168.097, 174.103, 179.201, 183.799, 187.799, 192.259, 199.5, 205.505,
  207.799, 212.097, 218.103, 222.7, 228.706, 231.596, 237.303, 242.7, 244.706, 247.596, 253.602,
  256.396, 259.596, 264.301, 268.004, 269.506, 275.5, 279.5, 285.005, 287.799, 293.805, 299.202,
  305.197, 309.698, 311.703, 317.698, 323.106, 325.506, 331.501, 335.8, 339.501, 341.805, 346.701,
  348.706, 351.501, 357.304, 363.298, 369.304, 375.299, 379.704, 383, 384.031, 388.6, 393.716,
  393.998, 400.003, 404.301, 406.606, 410.499, 413.507, 419, 429.4, 433.902, 439.502, 443.679,
  444.003, 448.892, 452.504, 454.505, 458.778, 463.626, 467.907, 468.83, 471.503, 474.403, 478.105,
  482.905, 488.803, 490.905, 494.702, 498.905, 504.638, 508.505, 513.902, 518.151, 518.201, 520.152,
  522.793, 528.105, 532.905, 537.689, 539.753, 543.189, 548.912, 553.103, 554.652, 557.7, 559.705,
  562.539, 565.236, 569.685, 573.006, 574.693, 582.938, 587.3, 588.592, 593.305, 598.607, 602.607,
  608.602, 609.19, 612.934, 614.936, 620.949, 627.599, 633.604, 638.843, 639.503, 644.863, 649.508,
  652.506, 657.508, 657.638, 662.672, 665.109, 669.543, 673.446, 681.508, 683.503, 687.504, 690.256,
  694.678, 698.79, 699.503, 702.801, 704.811, 709.199, 709.735, 714.607, 718.799, 723.802, 729.402,
  734.202, 739.301, 742.859, 744.101, 747.797, 749.402, 751.504, 756.901, 762.405, 764.4, 770.405,
  772.603, 776.4, 779.909, 783.6, 787.909, 793.904, 799.6, 802.407, 807.706, 808.038, 813.306,
  819.505,
];
const REAL_SHAPED_SOURCES =
  "sssmsssssssssssssssssssssssmsssssssssssssssmssssssssssssssssmssssssssssssssssssssssssssmsmssssssssssmsmsmmmsmssssssssmssmsmmmmmmmmsmssmmmsmmsmssssmmmmssmsmsssmmmmmsssmmmsmmsmssssssmsmsssssssssssssmsmsm";
const REAL_ORIGIN_MS = 1792086591860;

function realShapedSegments() {
  return REAL_SHAPED_STAMPS.map((timestamp, index) => {
    const isMic = REAL_SHAPED_SOURCES[index] === "m";
    return {
      id: `line-${index}`,
      text: `Invented remark number ${index} about the rollout.`,
      source: isMic ? "mic" : "system",
      speaker: isMic ? "you" : "speaker_0",
      speakerName: isMic ? "You" : "Alex",
      timestamp,
    };
  });
}

const seeded = (seed) => {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
};

const plain = (stamps) => stamps.map((timestamp, index) => ({ id: `s${index}`, timestamp }));

const everyIndexOnce = (report, total) => {
  const all = report.pieces.flatMap((piece) => piece.indices);
  assert.equal(all.length, total);
  assert.deepEqual(
    [...all].sort((a, b) => a - b),
    Array.from({ length: total }, (_, i) => i)
  );
};

test("a cut position puts every earlier line in the first piece and the rest in the second", async () => {
  const { cutReportAt } = await loadModule();
  const report = cutReportAt(plain([0, 10, 20, 30, 40]), [2]);

  assert.deepEqual(
    report.pieces.map((piece) => piece.indices),
    [
      [0, 1],
      [2, 3, 4],
    ]
  );
  assert.equal(report.boundaries.length, 1);
  assert.equal(report.boundaries[0].beforePieceIndex, 0);
  assert.equal(report.boundaries[0].afterPieceIndex, 1);
  assert.equal(report.unit, "relative-seconds");
  assert.equal(report.boundaries[0].gapStartsAt, 10);
  assert.equal(report.boundaries[0].gapEndsAt, 20);
});

test("positions are in time order, not array order", async () => {
  const { cutReportAt } = await loadModule();
  const report = cutReportAt(plain([30, 0, 20, 10]), [2]);

  assert.deepEqual(
    report.pieces.map((piece) => piece.indices),
    [
      [1, 3],
      [0, 2],
    ]
  );
});

test("equal timestamps keep array order when ordering the lines", async () => {
  const { cutReportAt } = await loadModule();
  const report = cutReportAt(plain([5, 5, 5, 5]), [2]);

  assert.deepEqual(
    report.pieces.map((piece) => piece.indices),
    [
      [0, 1],
      [2, 3],
    ]
  );
});

test("positions at either end, out of range or repeated are dropped", async () => {
  const { cutReportAt } = await loadModule();
  const segments = plain([0, 10, 20, 30]);

  for (const positions of [[0], [4], [-1], [99], [1.5], [NaN], [], [0, 4]]) {
    const report = cutReportAt(segments, positions);
    assert.equal(report.boundaries.length, 0, JSON.stringify(positions));
    assert.equal(report.pieces.length, 1);
    everyIndexOnce(report, 4);
  }

  const repeated = cutReportAt(segments, [2, 2, 2]);
  assert.equal(repeated.boundaries.length, 1);
  assert.equal(repeated.pieces.length, 2);
});

test("several positions give one boundary each, in order, whatever order they arrive in", async () => {
  const { cutReportAt } = await loadModule();
  const report = cutReportAt(plain([0, 1, 2, 3, 4, 5, 6, 7]), [6, 2, 4]);

  assert.deepEqual(
    report.pieces.map((piece) => piece.indices),
    [
      [0, 1],
      [2, 3],
      [4, 5],
      [6, 7],
    ]
  );
  assert.deepEqual(
    report.boundaries.map((b) => [b.beforePieceIndex, b.afterPieceIndex]),
    [
      [0, 1],
      [1, 2],
      [2, 3],
    ]
  );
});

test("the unit is epoch-ms when the lines carry epoch milliseconds", async () => {
  const { cutReportAt } = await loadModule();
  const base = 1790870467607;
  const report = cutReportAt(plain([base, base + 5000, base + 9000]), [1]);
  assert.equal(report.unit, "epoch-ms");
});

test("every index lands in exactly one piece for random shapes and cuts", async () => {
  const { cutReportAt } = await loadModule();
  const random = seeded(7);
  for (let round = 0; round < 300; round += 1) {
    const total = 1 + Math.floor(random() * 40);
    const stamps = Array.from({ length: total }, () => Math.floor(random() * 12) * 7);
    const cuts = Array.from(
      { length: Math.floor(random() * 6) },
      () => Math.floor(random() * (total + 4)) - 2
    );
    const report = cutReportAt(plain(stamps), cuts);

    everyIndexOnce(report, total);
    for (const piece of report.pieces) assert.ok(piece.indices.length > 0, "empty piece");
    assert.equal(report.pieces.length, report.boundaries.length + 1);
    for (const piece of report.pieces) assert.equal(piece.count, piece.indices.length);
  }
});

test("marks map to the first line at or after each offset", async () => {
  const { cutPositionsForOffsets } = await loadModule();
  const segments = plain([4.5, 10.5, 14.3, 20, 30]);

  assert.deepEqual(cutPositionsForOffsets(segments, [12]), [2]);
  assert.deepEqual(cutPositionsForOffsets(segments, [10.5]), [1]);
  assert.deepEqual(cutPositionsForOffsets(segments, [25, 12]), [2, 4]);
});

test("a mark past the last line, or before the first, gives no cut", async () => {
  const { cutPositionsForOffsets } = await loadModule();
  const segments = plain([4.5, 10.5, 14.3, 20, 30]);

  assert.deepEqual(cutPositionsForOffsets(segments, [31]), []);
  assert.deepEqual(cutPositionsForOffsets(segments, [1]), []);
  assert.deepEqual(cutPositionsForOffsets(segments, []), []);
  assert.deepEqual(cutPositionsForOffsets(segments, ["x", null, NaN]), []);
});

test("two marks between the same pair of lines make one cut", async () => {
  const { cutPositionsForOffsets } = await loadModule();
  assert.deepEqual(cutPositionsForOffsets(plain([4, 10, 20, 30]), [12, 15]), [2]);
});

test("marks map by time order when the stored array is out of order", async () => {
  const { cutPositionsForOffsets } = await loadModule();
  assert.deepEqual(cutPositionsForOffsets(plain([30, 0, 20, 10]), [15]), [2]);
});

test("epoch-ms lines are measured against the clock", async () => {
  const { cutPositionsForOffsets } = await loadModule();
  const clock = 1790870467607;
  const segments = plain([clock + 5000, clock + 15000, clock + 25000]);

  assert.deepEqual(cutPositionsForOffsets(segments, [10], clock), [1]);
  assert.deepEqual(cutPositionsForOffsets(segments, [10], null), []);
});

function createDb() {
  requireSqlite();
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-line-cut-"));
  return new DatabaseManager();
}

const seedRealShapedNote = (db) => {
  const segments = realShapedSegments();
  const saved = db.saveNote("Weekly sync", "", "meeting", null, 820, null);
  const noteId = saved.note.id;
  db.updateNote(noteId, {
    transcript: JSON.stringify(segments),
    transcript_origin_ms: REAL_ORIGIN_MS,
    transcript_origin_source: "audio:system",
    mic_audio_path: "/tmp/openwhispr-test/mic.opus",
    system_audio_path: "/tmp/openwhispr-test/system.opus",
  });
  db.setSpeakerMapping(noteId, "speaker_0", null, "Alex", { origin: "manual" });
  db.setSpeakerMapping(noteId, "you", null, "You", { origin: "manual" });
  return { noteId, segments };
};

test("acceptance: a cut at a chosen line of a real-shaped note partitions it", async () => {
  const { cutReportAt } = await loadModule();
  const db = createDb();
  const { noteId, segments } = seedRealShapedNote(db);
  const chosenLine = 118;
  const created = [];

  const result = splitNoteAtBoundary({
    databaseManager: db,
    noteId,
    report: cutReportAt(segments, [chosenLine]),
    boundaryIndex: 0,
    onNoteCreated: (note) => created.push(note),
  });

  assert.equal(result.success, true);
  const parent = JSON.parse(db.getNote(noteId).transcript);
  const child = JSON.parse(db.getNote(result.childNoteId).transcript);

  assert.equal(parent.length, chosenLine);
  assert.equal(child.length, segments.length - chosenLine);
  const ids = [...parent, ...child].map((line) => line.id);
  assert.equal(new Set(ids).size, ids.length, "a line was duplicated");
  assert.deepEqual([...ids].sort(), segments.map((line) => line.id).sort(), "a line was lost");
  assert.equal(child[0].id, `line-${chosenLine}`);
  assert.ok(parent[parent.length - 1].timestamp <= child[0].timestamp);

  const speakersOf = (lines) => new Set(lines.map((line) => line.speaker));
  const union = new Set([...speakersOf(parent), ...speakersOf(child)]);
  assert.deepEqual(union, speakersOf(segments));
  const childMappings = db.getSpeakerMappings(result.childNoteId).map((row) => row.speaker_id);
  assert.deepEqual([...childMappings].sort(), [...speakersOf(child)].sort());

  const parentNote = db.getNote(noteId);
  const childNote = db.getNote(result.childNoteId);
  assert.ok(parentNote.slice_end_s <= childNote.slice_start_s, "audio slices overlap");
  assert.ok(parentNote.slice_start_s < parentNote.slice_end_s);
  assert.equal(parentNote.slice_start_s, segments[0].timestamp);
  assert.equal(childNote.slice_start_s, segments[chosenLine].timestamp);
  assert.equal(created.length, 1);
});

test("a report with two cuts is applied one boundary at a time, last cut first", async () => {
  const { cutReportAt } = await loadModule();
  const db = createDb();
  const { noteId, segments } = seedRealShapedNote(db);
  const report = cutReportAt(segments, [60, 140]);

  const first = splitNoteAtBoundary({
    databaseManager: db,
    noteId,
    report,
    boundaryIndex: report.boundaries.length - 1,
    onNoteCreated: () => {},
  });
  assert.equal(first.success, true);
  assert.equal(JSON.parse(db.getNote(noteId).transcript).length, 140);
  assert.equal(JSON.parse(db.getNote(first.childNoteId).transcript).length, segments.length - 140);
});
