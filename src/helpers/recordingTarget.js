const hasTranscriptContent = (transcript) => {
  if (typeof transcript !== "string" || transcript.trim() === "") return false;
  if (!transcript.startsWith("[")) return true;
  try {
    const parsed = JSON.parse(transcript);
    return Array.isArray(parsed) ? parsed.length > 0 : true;
  } catch {
    return true;
  }
};

export function noteHasRecording(note) {
  if (!note) return false;
  return (
    hasTranscriptContent(note.transcript) || Boolean(note.mic_audio_path || note.system_audio_path)
  );
}

const CARRIED_FIELDS = [
  "calendar_event_id",
  "participants",
  "meeting_type_id",
  "diarization_enabled",
  "expected_speaker_count",
];

export function continuedNoteFields(source, suffix, fallbackTitle = "New note") {
  const carried = {};
  for (const field of CARRIED_FIELDS) {
    if (source[field] != null) carried[field] = source[field];
  }
  return {
    title: `${source.title || fallbackTitle} ${suffix}`,
    noteType: source.note_type,
    folderId: source.folder_id,
    carried,
  };
}
