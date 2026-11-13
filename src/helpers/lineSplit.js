import { detectCallBoundaries } from "./callBoundaries.js";
import { cutReportAt, timePositionOfIndex } from "./lineCut.js";
import { splitSafetyOf } from "./splitSafety.js";

const FAILURE_KEY_BY_REASON = {
  "no-boundary": "notes.callSplit.failed",
  "note-not-found": "notes.callSplit.failedMissing",
  "unsafe-timing": "notes.callSplit.failedUnsafe",
  "invalid-line": "notes.splitAtLine.failedInvalidLine",
  "unreadable-transcript": "notes.callSplit.failedUnreadable",
  "unresolvable-slice-bounds": "notes.callSplit.failedUnanchored",
  "transcript-does-not-match-report": "notes.callSplit.failedStale",
  "report-refused": "notes.callSplit.failedStale",
  "empty-piece": "notes.callSplit.failedStale",
  "split-failed-partway": "notes.callSplit.failedPartway",
};

export function splitFailureKey(reason) {
  return FAILURE_KEY_BY_REASON[reason] ?? "notes.callSplit.failedUnknown";
}

const parseStored = (transcript) => {
  try {
    const parsed = JSON.parse(transcript);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const linesAlign = (stored, displayed) =>
  Array.isArray(displayed) &&
  stored.length === displayed.length &&
  stored.every((segment, i) => segment?.text === displayed[i]?.text);

const earliestIndexOf = (segments) => {
  let best = 0;
  segments.forEach((segment, i) => {
    if (segment.timestamp < segments[best].timestamp) best = i;
  });
  return best;
};

export function lineSplitState(note, displayedSegments, { isRecording }) {
  if (
    isRecording ||
    !note ||
    typeof note.transcript !== "string" ||
    note.transcript.trim() === ""
  ) {
    return { kind: "hidden" };
  }
  const safety = splitSafetyOf(note);
  if (!safety.ok) {
    return safety.reason === "too-short"
      ? { kind: "hidden" }
      : { kind: "unsafe", reason: safety.reason };
  }
  const stored = parseStored(note.transcript);
  if (!stored || !linesAlign(stored, displayedSegments)) return { kind: "hidden" };
  return { kind: "available", earliestIndex: earliestIndexOf(stored) };
}

const absoluteMsOf = (stamp, unit, clockMs) => {
  if (unit === "epoch-ms") return stamp;
  return Number.isFinite(clockMs) ? clockMs + stamp * 1000 : null;
};

const secondsOf = (stamp, unit, zeroStamp) =>
  unit === "epoch-ms" ? (stamp - zeroStamp) / 1000 : stamp;

const partOf = (piece, unit, clockMs, zeroStamp) => ({
  count: piece.count,
  startsAtMs: absoluteMsOf(piece.startsAt, unit, clockMs),
  endsAtMs: absoluteMsOf(piece.endsAt, unit, clockMs),
  startSeconds: secondsOf(piece.startsAt, unit, zeroStamp),
  endSeconds: secondsOf(piece.endsAt, unit, zeroStamp),
});

export function splitPreview(segments, lineIndex, clockMs) {
  if (!Array.isArray(segments) || !Number.isInteger(lineIndex)) return null;
  const position = timePositionOfIndex(segments, lineIndex);
  if (position < 1) return null;
  const report = cutReportAt(segments, [position]);
  if (report.pieces.length !== 2) return null;
  const [first, second] = report.pieces;
  return {
    first: partOf(first, report.unit, clockMs, first.startsAt),
    second: partOf(second, report.unit, clockMs, first.startsAt),
  };
}

const firstLineInTime = (segments, indices) =>
  indices.reduce((best, index) => {
    const stamp = segments[index].timestamp;
    const bestStamp = segments[best].timestamp;
    return stamp < bestStamp || (stamp === bestStamp && index < best) ? index : best;
  });

export function detectedGapSuggestion(segments, clockMs) {
  if (!Array.isArray(segments) || segments.length === 0) return null;
  const report = detectCallBoundaries(segments);
  if (report.refused || report.boundaries.length === 0) return null;
  const boundary = report.boundaries.reduce((best, candidate) =>
    candidate.gapSeconds > best.gapSeconds ? candidate : best
  );
  const lineIndex = firstLineInTime(segments, boundary.after.indices);
  const stamp = segments[lineIndex].timestamp;
  return {
    lineIndex,
    gapSeconds: boundary.gapSeconds,
    atSeconds: secondsOf(stamp, report.unit, report.pieces[0].startsAt),
    atMs: absoluteMsOf(stamp, report.unit, clockMs),
  };
}
