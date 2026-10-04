// @ts-check

import { detectSessions } from "./detectWeldedSessions.js";
import { scoreCallBoundary, BOUNDARY_WINDOW_SECONDS } from "./callBoundaryScore.js";

/** @typedef {import("./callBoundaryScore.js").BoundarySegment} BoundarySegment */

/**
 * @typedef {object} CallPiece
 * @property {number[]} sessionIndices
 * @property {number[]} indices
 * @property {number} count
 * @property {number} startsAt
 * @property {number} endsAt
 * @property {number} durationSeconds
 */

/**
 * @typedef {object} CallBoundary
 * @property {number} sessionIndex
 * @property {number} gapSeconds
 * @property {number} score
 * @property {string[]} reasons
 * @property {number} gapStartsAt
 * @property {number} gapEndsAt
 * @property {number} beforePieceIndex
 * @property {number} afterPieceIndex
 * @property {CallPiece} before
 * @property {CallPiece} after
 */

/**
 * @typedef {object} CallBoundaryReport
 * @property {"epoch-ms" | "relative-seconds"} unit
 * @property {CallPiece[]} pieces
 * @property {CallBoundary[]} boundaries
 * @property {"insufficient-timestamps" | "unassigned-segments"} [refused]
 */

export const SESSION_GAP_SECONDS = 30;
export const MIN_SESSION_SEGMENTS = 20;
export const MIN_PIECE_SECONDS = 300;
export const MAX_PIECE_SECONDS = 4 * 60 * 60;

const unitDivisor = (unit) => (unit === "epoch-ms" ? 1000 : 1);

const stampOf = (segment) => Number(segment && segment.timestamp);

const orderedByTime = (segments, indices) =>
  indices.map((index) => segments[index]).sort((left, right) => stampOf(left) - stampOf(right));

const tailWithin = (ordered, endsAt, divisor) => {
  const floor = endsAt - BOUNDARY_WINDOW_SECONDS * divisor;
  return ordered.filter((segment) => stampOf(segment) >= floor);
};

const headWithin = (ordered, startsAt, divisor) => {
  const ceiling = startsAt + BOUNDARY_WINDOW_SECONDS * divisor;
  return ordered.filter((segment) => stampOf(segment) <= ceiling);
};

const piecesFrom = (sessions, cuts, divisor) => {
  const edges = [0, ...cuts.map((sessionIndex) => sessionIndex + 1), sessions.length];
  /** @type {CallPiece[]} */
  const pieces = [];
  for (let edge = 0; edge < edges.length - 1; edge += 1) {
    const group = sessions.slice(edges[edge], edges[edge + 1]);
    const indices = group.flatMap((session) => session.indices).sort((left, right) => left - right);
    const startsAt = group[0].startsAt;
    const endsAt = group[group.length - 1].endsAt;
    pieces.push({
      sessionIndices: group.map((_, offset) => edges[edge] + offset),
      indices,
      count: indices.length,
      startsAt,
      endsAt,
      durationSeconds: (endsAt - startsAt) / divisor,
    });
  }
  return pieces;
};

/**
 * @param {readonly BoundarySegment[]} segments the note's transcript segments, in whatever
 * order they are stored
 * @param {{ gapSeconds?: number, minSessionSegments?: number, minPieceSeconds?: number, maxPieceSeconds?: number }} [options]
 * @returns {CallBoundaryReport}
 */
export const detectCallBoundaries = (segments, options = {}) => {
  const gapSeconds = options.gapSeconds ?? SESSION_GAP_SECONDS;
  const minSessionSegments = options.minSessionSegments ?? MIN_SESSION_SEGMENTS;
  const minPieceSeconds = options.minPieceSeconds ?? MIN_PIECE_SECONDS;
  const maxPieceSeconds = options.maxPieceSeconds ?? MAX_PIECE_SECONDS;

  const list = Array.isArray(segments) ? segments : [];
  const report = detectSessions(list, { gapSeconds, minSessionSegments });
  const divisor = unitDivisor(report.unit);

  if (!report.usable) {
    return {
      unit: report.unit,
      pieces: [],
      boundaries: [],
      refused: report.reason ?? "insufficient-timestamps",
    };
  }

  if (report.unassigned.length > 0) {
    return { unit: report.unit, pieces: [], boundaries: [], refused: "unassigned-segments" };
  }

  const sessions = report.sessions;
  const ordered = sessions.map((session) => orderedByTime(list, session.indices));

  /** @type {Map<number, { gapSeconds: number, score: number, reasons: string[], gapStartsAt: number, gapEndsAt: number }>} */
  const candidates = new Map();
  for (let index = 0; index < sessions.length - 1; index += 1) {
    const left = sessions[index];
    const right = sessions[index + 1];
    const gap = (right.startsAt - left.endsAt) / divisor;
    const scored = scoreCallBoundary({
      before: tailWithin(ordered[index], left.endsAt, divisor),
      after: headWithin(ordered[index + 1], right.startsAt, divisor),
      gapSeconds: gap,
    });
    const bothSessionsAreSubstantial = !left.isFragment && !right.isFragment;
    if (scored.boundary && bothSessionsAreSubstantial) {
      candidates.set(index, {
        gapSeconds: gap,
        score: scored.score,
        reasons: scored.reasons,
        gapStartsAt: left.endsAt,
        gapEndsAt: right.startsAt,
      });
    }
  }

  let cuts = [...candidates.keys()].sort((left, right) => left - right);

  for (;;) {
    const pieces = piecesFrom(sessions, cuts, divisor);
    const offending = pieces.findIndex((piece) => piece.durationSeconds < minPieceSeconds);
    if (offending === -1 || cuts.length === 0) break;

    const bordering = [];
    if (offending - 1 >= 0) bordering.push(offending - 1);
    if (offending < cuts.length) bordering.push(offending);
    bordering.sort(
      (left, right) => candidates.get(cuts[left]).score - candidates.get(cuts[right]).score
    );
    const dropped = bordering[0];
    cuts = cuts.filter((_, position) => position !== dropped);
  }

  const settled = piecesFrom(sessions, cuts, divisor);
  cuts = cuts.filter(
    (_, position) =>
      settled[position].durationSeconds <= maxPieceSeconds &&
      settled[position + 1].durationSeconds <= maxPieceSeconds
  );

  const pieces = piecesFrom(sessions, cuts, divisor);
  const boundaries = cuts.map((sessionIndex, position) => {
    const candidate = candidates.get(sessionIndex);
    return {
      sessionIndex,
      gapSeconds: candidate.gapSeconds,
      score: candidate.score,
      reasons: candidate.reasons,
      gapStartsAt: candidate.gapStartsAt,
      gapEndsAt: candidate.gapEndsAt,
      beforePieceIndex: position,
      afterPieceIndex: position + 1,
      before: pieces[position],
      after: pieces[position + 1],
    };
  });

  return { unit: report.unit, pieces, boundaries };
};
