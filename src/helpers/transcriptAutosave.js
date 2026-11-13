export function startTranscriptAutosave({ intervalMs, read, write }) {
  let lastWritten = null;

  const interval = setInterval(() => {
    const segments = read();
    if (!segments || segments.length === 0 || segments === lastWritten) return;
    lastWritten = segments;
    write(segments);
  }, intervalMs);

  return () => clearInterval(interval);
}
