export const MAX_MARKS = 8;
export const MIN_MARK_GAP_MS = 10_000;

const pad2 = (value) => String(value).padStart(2, "0");

export function formatElapsed(ms) {
  const totalSeconds = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}:${pad2(minutes)}:${pad2(seconds)}`;
}

export function deckTracks(startedAtMs, markTimesMs) {
  if (!Number.isFinite(startedAtMs)) return [];
  const edges = [startedAtMs, ...markTimesMs];
  return edges.map((startsAtMs, index) => ({
    number: pad2(index + 1),
    startsAtMs,
    endsAtMs: index + 1 < edges.length ? edges[index + 1] : null,
  }));
}

export function markerKeyState({ isMarking, markCount, lastMarkAtMs, nowMs }) {
  if (isMarking) return { enabled: false, reason: "marking" };
  if (markCount >= MAX_MARKS) return { enabled: false, reason: "limit-reached" };
  if (Number.isFinite(lastMarkAtMs) && nowMs - lastMarkAtMs < MIN_MARK_GAP_MS) {
    return { enabled: false, reason: "too-soon" };
  }
  return { enabled: true, reason: null };
}

export function recordMarkerResult(book, result, nowMs) {
  if (!result || result.success !== true || !Array.isArray(result.marks)) {
    return { marks: book.marks, times: book.times, refusal: result?.reason ?? "unknown" };
  }
  const marks = result.marks;
  const times = book.times.slice(0, marks.length);
  while (times.length < marks.length) times.push(nowMs);
  return { marks, times, refusal: null };
}

export async function pressMarker({ getState, setState, requestMark, nowMs, onError }) {
  const before = getState();
  if (!before.isRecording || before.isMarking) return;
  setState({ isMarking: true, markerRefusal: null });
  let result;
  try {
    result = await requestMark();
  } catch (error) {
    if (onError) onError(error);
  }
  const current = getState();
  if (!current.isRecording) {
    setState({ isMarking: false });
    return;
  }
  const next = recordMarkerResult(
    { marks: current.markers, times: current.markerTimes },
    result,
    nowMs()
  );
  setState({
    markers: next.marks,
    markerTimes: next.times,
    markerRefusal: next.refusal,
    isMarking: false,
  });
}
