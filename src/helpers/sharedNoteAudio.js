// @ts-check

const AUDIO_PATH_COLUMNS = ["mic_audio_path", "system_audio_path"];

const audioPathsOf = (note) => [
  ...new Set(
    AUDIO_PATH_COLUMNS.map((column) => note && note[column]).filter(
      (value) => typeof value === "string" && value !== ""
    )
  ),
];

function notesSharingAudioPaths(db, paths) {
  if (!db || paths.length === 0) return [];
  const placeholders = paths.map(() => "?").join(", ");
  return db
    .prepare(
      `SELECT id, mic_audio_path, system_audio_path FROM notes
       WHERE mic_audio_path IN (${placeholders}) OR system_audio_path IN (${placeholders})`
    )
    .all(...paths, ...paths);
}

function planSharedAudioClear(rows, paths) {
  const deleted = new Set(paths);
  const seen = new Set();
  const updates = [];
  for (const row of rows) {
    if (!row || seen.has(row.id)) continue;
    seen.add(row.id);
    const fields = {};
    for (const column of AUDIO_PATH_COLUMNS) {
      if (deleted.has(row[column])) fields[column] = null;
    }
    if (Object.keys(fields).length > 0) updates.push({ noteId: row.id, fields });
  }
  return updates;
}

module.exports = { AUDIO_PATH_COLUMNS, audioPathsOf, notesSharingAudioPaths, planSharedAudioClear };
