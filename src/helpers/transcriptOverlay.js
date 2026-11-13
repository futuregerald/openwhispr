const storedLines = (storedTranscript) => {
  if (typeof storedTranscript !== "string" || storedTranscript.trim() === "") return null;
  try {
    const parsed = JSON.parse(storedTranscript);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

export function overlayStillMatches(storedTranscript, overlaySegments) {
  const stored = storedLines(storedTranscript);
  if (stored === null) return true;
  return (
    Array.isArray(overlaySegments) &&
    overlaySegments.length === stored.length &&
    stored.every((line, i) => line?.text === overlaySegments[i]?.text)
  );
}
