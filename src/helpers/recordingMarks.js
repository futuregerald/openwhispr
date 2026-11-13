const EPOCH_MS_FLOOR = 1e9;

const isInstant = (value) => typeof value === "number" && Number.isFinite(value);

const parseSegments = (transcript) => {
  if (typeof transcript !== "string" || transcript.trim() === "") return null;
  try {
    const parsed = JSON.parse(transcript);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
  } catch {
    return null;
  }
};

const orNull = (value) => (isInstant(value) ? value : null);

function normalizeMarkZeros(zeros) {
  const source = zeros && typeof zeros === "object" ? zeros : {};
  return {
    system: orNull(source.system),
    mic: orNull(source.mic),
    firstLine:
      isInstant(source.firstLine) && source.firstLine > EPOCH_MS_FLOOR ? source.firstLine : null,
  };
}

function markZeroForNote(note, zeros) {
  const segments = parseSegments(note?.transcript);
  if (!segments) return null;
  const known = normalizeMarkZeros(zeros);

  if (note.transcript_origin_source === "unanchored") {
    return segments.every((segment) => segment?.source === "mic") ? known.mic : known.system;
  }
  if (isInstant(note.transcript_origin_ms)) return note.transcript_origin_ms;
  return known.firstLine;
}

module.exports = { markZeroForNote, normalizeMarkZeros };
