const storedLineCount = (storedTranscript) => {
  if (typeof storedTranscript !== "string" || storedTranscript.trim() === "") return null;
  try {
    const parsed = JSON.parse(storedTranscript);
    return Array.isArray(parsed) ? parsed.length : null;
  } catch {
    return null;
  }
};

export function overlayStillMatches(storedTranscript, overlaySegments) {
  const stored = storedLineCount(storedTranscript);
  if (stored === null) return true;
  return Array.isArray(overlaySegments) && overlaySegments.length === stored;
}
