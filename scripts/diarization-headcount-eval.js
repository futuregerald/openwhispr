#!/usr/bin/env node
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");

const DiarizationManager = require("../src/helpers/diarization.js");
const { foldMinorSpeakers } = require("../src/helpers/foldMinorSpeakers.js");

const REPO_ROOT = path.resolve(__dirname, "..");
const DB_PATH = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "open-whispr",
  "transcriptions.db"
);
const FFMPEG = path.join(REPO_ROOT, "node_modules", "ffmpeg-static", "ffmpeg");
const BINARY = path.join(
  REPO_ROOT,
  "resources",
  "bin",
  `fluidaudio-diarize-${process.platform}-${process.arch}`
);
const CACHE_DIR = path.join(os.homedir(), ".cache", "openwhispr", "headcount-eval");

function parseList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseMap(value) {
  const map = new Map();
  for (const entry of parseList(value)) {
    const [note, count] = entry.split("=");
    map.set(Number(note), Number(count));
  }
  return map;
}

function parseArgs(argv) {
  const args = { notes: [], truth: new Map(), expect: new Map(), binary: null, threshold: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--notes") args.notes = parseList(value).map(Number);
    else if (flag === "--truth") args.truth = parseMap(value);
    else if (flag === "--expect") args.expect = parseMap(value);
    else if (flag === "--binary") {
      if (value === undefined || value.startsWith("--")) {
        console.error(`--binary expects a path, got: ${value === undefined ? "(missing)" : value}`);
        process.exit(2);
      }
      args.binary = value;
    } else if (flag === "--threshold") {
      if (value === undefined || value.startsWith("--")) {
        console.error(
          `--threshold expects a number, got: ${value === undefined ? "(missing)" : value}`
        );
        process.exit(2);
      }
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        console.error(`--threshold expects a number, got: ${value}`);
        process.exit(2);
      }
      args.threshold = parsed;
    } else continue;
    i += 1;
  }
  return args;
}

function decodeSystemTrack(db, noteId) {
  const row = db.prepare("SELECT system_audio_path FROM notes WHERE id = ?").get(noteId);
  if (!row?.system_audio_path || !fs.existsSync(row.system_audio_path)) return null;
  fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
  const wav = path.join(CACHE_DIR, `note-${noteId}.wav`);
  if (!fs.existsSync(wav)) {
    const partial = `${wav}.partial`;
    execFileSync(FFMPEG, [
      "-loglevel",
      "error",
      "-y",
      "-i",
      row.system_audio_path,
      "-ar",
      "16000",
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      "-f",
      "wav",
      partial,
    ]);
    fs.renameSync(partial, wav);
  }
  return wav;
}

function countSpeakers(wav, noteId, { binary, threshold } = {}) {
  const outJson = path.join(CACHE_DIR, `note-${noteId}-${process.pid}.json`);
  const args = DiarizationManager.buildFluidAudioArgs({ wavPath: wav, outJson, mode: "offline" });
  if (threshold != null) {
    const thresholdIndex = args.indexOf("--threshold");
    if (thresholdIndex === -1) {
      throw new Error(
        "threshold override given but buildFluidAudioArgs did not include --threshold"
      );
    }
    args[thresholdIndex + 1] = String(threshold);
  }
  execFileSync(binary, args, { stdio: "pipe", maxBuffer: 64 * 1024 * 1024 });
  const segments = DiarizationManager.prototype._parseFluidAudioOutput(
    fs.readFileSync(outJson, "utf8")
  );
  fs.unlinkSync(outJson);
  return new Set(foldMinorSpeakers(segments).map((segment) => segment.speaker)).size;
}

function main() {
  const { notes, truth, expect, binary, threshold } = parseArgs(process.argv.slice(2));
  if (notes.length === 0) {
    console.error(
      "usage: diarization-headcount-eval.js --notes 12,22 --truth 12=1,22=1 [--expect 12=1,22=1]"
    );
    process.exit(2);
  }

  const unknownExpectations = [...expect.keys()].filter((noteId) => !notes.includes(noteId));
  if (unknownExpectations.length > 0) {
    console.error(`--expect names notes not in --notes: ${unknownExpectations.join(", ")}`);
    process.exit(2);
  }

  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  let summedError = 0;
  let mismatches = 0;

  const effectiveThreshold = threshold ?? DiarizationManager.FLUIDAUDIO_OFFLINE_THRESHOLD;
  const effectiveBinary = binary ?? BINARY;
  console.log(`threshold ${effectiveThreshold}, offline mode, folded, binary ${effectiveBinary}`);
  console.log("note | speakers | truth | error | expected");
  try {
    for (const noteId of notes) {
      const wav = decodeSystemTrack(db, noteId);
      if (!wav) {
        console.log(`${noteId} | no system audio`);
        mismatches += 1;
        continue;
      }
      const speakers = countSpeakers(wav, noteId, { binary: effectiveBinary, threshold });
      const realCount = truth.get(noteId);
      const error = Number.isFinite(realCount) ? Math.abs(speakers - realCount) : null;
      if (error !== null && realCount > 2) summedError += error;
      const wanted = expect.get(noteId);
      const matches = expect.size === 0 || wanted === speakers;
      if (!matches) mismatches += 1;
      console.log(
        `${noteId} | ${speakers} | ${realCount ?? "-"} | ${error ?? "-"} | ${wanted ?? "-"}${matches ? "" : "  MISMATCH"}`
      );
    }
  } finally {
    db.close();
  }

  console.log(`summed error over notes with more than two other people: ${summedError}`);
  console.log(`decoded meeting audio is cached in ${CACHE_DIR} — delete it when done`);
  if (mismatches > 0) {
    console.error(`${mismatches} note(s) did not match the expected count`);
    process.exit(1);
  }
}

main();
