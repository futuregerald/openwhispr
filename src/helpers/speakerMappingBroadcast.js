export function speakerMappingsForBroadcast(payload, noteId) {
  if (!payload || payload.noteId !== noteId) return null;
  const map = {};
  for (const mapping of payload.mappings || []) {
    if (!mapping || typeof mapping.speaker_id !== "string") continue;
    if (typeof mapping.display_name !== "string" || !mapping.display_name) continue;
    map[mapping.speaker_id] = mapping.display_name;
  }
  return map;
}
