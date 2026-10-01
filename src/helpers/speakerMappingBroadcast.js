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

/**
 * NoteEditor's displaySegments prefers its local diarizedSegments over
 * note.transcript, and persistDisplaySegments sets that state on every
 * non-recording write. So after any in-editor speaker edit, the local array
 * outranks the stored transcript for the rest of the session -- and an external
 * rename that rewrote the transcript would be invisible to it, then overwritten
 * wholesale by the next in-editor edit. Dropping the local array is what lets
 * the just-rewritten transcript win again.
 */
export function externalRenameUpdate(payload, noteId, autoMappings = {}) {
  const mappings = speakerMappingsForBroadcast(payload, noteId);
  if (!mappings) return null;
  // Diarization-derived names are a base layer that is never persisted, so the
  // stored rows win where they exist and these fill the gaps -- the same
  // precedence the initial load applies.
  return { mappings: { ...autoMappings, ...mappings }, clearLocalSegments: true };
}
