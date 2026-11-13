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

export function recordMarkerResult(book, result) {
  if (!result || result.success !== true || !Array.isArray(result.marks)) {
    return { marks: book.marks, refusal: result?.reason ?? "unknown" };
  }
  return { marks: result.marks, refusal: null };
}

export const REFUSAL_VISIBLE_MS = 5000;

let pendingRefusalClear = null;

export async function pressMarker({
  getState,
  setState,
  requestMark,
  onError,
  schedule = setTimeout,
  cancel = clearTimeout,
}) {
  const before = getState();
  if (!before.isRecording || before.isMarking) return;
  const noteIdAtPress = before.recordingNoteId;
  if (pendingRefusalClear !== null) cancel(pendingRefusalClear);
  pendingRefusalClear = null;
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
  if (current.recordingNoteId !== noteIdAtPress) return;
  const next = recordMarkerResult({ marks: current.markers }, result);
  setState({ markers: next.marks, markerRefusal: next.refusal, isMarking: false });
  if (next.refusal !== null) {
    pendingRefusalClear = schedule(() => {
      pendingRefusalClear = null;
      if (getState().markerRefusal === next.refusal) setState({ markerRefusal: null });
    }, REFUSAL_VISIBLE_MS);
  }
}
