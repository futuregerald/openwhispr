const EPOCH_MS_FLOOR = 1e9;
const CLOCK_OVERWRITE_SLACK_MS = 10 * 60 * 1000;

const parseSegments = (transcript) => {
  if (typeof transcript !== "string" || transcript.trim() === "") return null;
  try {
    const parsed = JSON.parse(transcript);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const unsafe = (reason) => ({ ok: false, reason });

const updatedAtMsOf = (updatedAt) => {
  if (typeof updatedAt !== "string") return null;
  const ms = Date.parse(`${updatedAt.replace(" ", "T")}Z`);
  return Number.isFinite(ms) ? ms : null;
};

export function splitSafetyOf(note) {
  const segments = note ? parseSegments(note.transcript) : null;
  if (!segments) return unsafe("plain-text");
  if (segments.length < 2) return unsafe("too-short");

  const stamps = segments.map((segment) => segment && segment.timestamp);
  if (!stamps.every((stamp) => typeof stamp === "number" && Number.isFinite(stamp))) {
    return unsafe("missing-timestamps");
  }

  const epochCount = stamps.filter((stamp) => stamp > EPOCH_MS_FLOOR).length;
  if (epochCount > 0 && epochCount < stamps.length) return unsafe("mixed-units");
  if (epochCount === stamps.length) return { ok: true };

  if (stamps.some((stamp) => stamp < 0)) return unsafe("negative-offset");

  const clockMs = note.transcript_origin_ms;
  const updatedAtMs = updatedAtMsOf(note.updated_at);
  if (Number.isFinite(clockMs) && updatedAtMs != null) {
    const lastLineMs = clockMs + Math.max(...stamps) * 1000;
    if (lastLineMs > updatedAtMs + CLOCK_OVERWRITE_SLACK_MS) return unsafe("clock-overwritten");
  }
  return { ok: true };
}
