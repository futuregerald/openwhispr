const EPOCH_MS_FLOOR = 1e9;

const stampOf = (segment) => {
  const stamp = segment && segment.timestamp;
  return Number.isFinite(stamp) ? stamp : Number.POSITIVE_INFINITY;
};

const timeOrder = (segments) =>
  segments
    .map((segment, index) => ({ index, stamp: stampOf(segment) }))
    .sort((left, right) => left.stamp - right.stamp || left.index - right.index);

const unitOf = (ordered) =>
  ordered.filter((entry) => entry.stamp > EPOCH_MS_FLOOR && Number.isFinite(entry.stamp)).length >=
  2
    ? "epoch-ms"
    : "relative-seconds";

const validCuts = (cutPositions, total) =>
  [
    ...new Set(
      cutPositions.filter(
        (position) => Number.isInteger(position) && position > 0 && position < total
      )
    ),
  ].sort((left, right) => left - right);

const pieceOf = (group, pieceIndex, divisor) => {
  const startsAt = group[0].stamp;
  const endsAt = group[group.length - 1].stamp;
  return {
    sessionIndices: [pieceIndex],
    indices: group.map((entry) => entry.index).sort((left, right) => left - right),
    count: group.length,
    startsAt,
    endsAt,
    durationSeconds: (endsAt - startsAt) / divisor,
  };
};

export function cutReportAt(segments, cutPositions) {
  const list = Array.isArray(segments) ? segments : [];
  const ordered = timeOrder(list);
  const unit = unitOf(ordered);
  const divisor = unit === "epoch-ms" ? 1000 : 1;
  if (ordered.length === 0) return { unit, pieces: [], boundaries: [] };

  const cuts = validCuts(Array.isArray(cutPositions) ? cutPositions : [], ordered.length);
  const edges = [0, ...cuts, ordered.length];
  const pieces = [];
  for (let edge = 0; edge < edges.length - 1; edge += 1) {
    pieces.push(pieceOf(ordered.slice(edges[edge], edges[edge + 1]), edge, divisor));
  }

  const boundaries = cuts.map((_, position) => {
    const before = pieces[position];
    const after = pieces[position + 1];
    return {
      sessionIndex: position,
      gapSeconds: (after.startsAt - before.endsAt) / divisor,
      score: 0,
      reasons: ["chosen-line"],
      gapStartsAt: before.endsAt,
      gapEndsAt: after.startsAt,
      beforePieceIndex: position,
      afterPieceIndex: position + 1,
      before,
      after,
    };
  });

  return { unit, pieces, boundaries };
}

export function cutPositionsForOffsets(segments, offsetsSeconds, clockMs = null) {
  const list = Array.isArray(segments) ? segments : [];
  const ordered = timeOrder(list);
  const offsetOf = (stamp) => {
    if (!Number.isFinite(stamp)) return null;
    if (stamp <= EPOCH_MS_FLOOR) return stamp;
    return Number.isFinite(clockMs) ? (stamp - clockMs) / 1000 : null;
  };
  const lineOffsets = ordered.map((entry) => offsetOf(entry.stamp));

  const positions = [];
  for (const mark of Array.isArray(offsetsSeconds) ? offsetsSeconds : []) {
    if (typeof mark !== "number" || !Number.isFinite(mark)) continue;
    const position = lineOffsets.findIndex((offset) => offset != null && offset >= mark);
    positions.push(position);
  }
  return validCuts(positions, ordered.length);
}

export function timePositionOfIndex(segments, index) {
  const list = Array.isArray(segments) ? segments : [];
  return timeOrder(list).findIndex((entry) => entry.index === index);
}
