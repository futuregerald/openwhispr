/**
 * Decides which saved audio files may be deleted by the retention sweep.
 *
 * Split out of `audioStorage.js` because that module reads `app.getPath` in its
 * constructor and so cannot load under `node --test` — and this decision is
 * exactly the kind that must be tested. Deleting audio is irreversible.
 *
 * The rule that matters: a meeting whose notes were never generated keeps its
 * audio no matter how old it is. Otherwise deferring a meeting — which the app
 * now asks users to do when memory is tight — quietly becomes data loss thirty
 * days later.
 *
 * Two notes can share one file, because splitting a welded recording copies the
 * paths rather than the audio. So the question is asked of EVERY note that
 * references a file, not of the one the filename happens to name: one
 * unprocessed sibling retains the file, and deleting it clears the columns on
 * all of them.
 */

/** @returns {number|null} the note id for a meeting track, or null for anything else */
function parseMeetingNoteId(filename) {
  const match = /^OpenWhispr-meeting-(\d+)-/.exec(filename);
  return match ? Number(match[1]) : null;
}

function parseTranscriptionId(filename) {
  const basename = filename.replace(/\.webm$/, "");
  const lastDash = basename.lastIndexOf("-");
  return lastDash !== -1 ? basename.slice(lastDash + 1) : basename;
}

/**
 * @param {object} args
 * @param {Array<{name:string, mtimeMs:number}>} args.files
 * @param {number} args.cutoffMs files older than this are candidates for deletion
 * @param {(noteId:number) => boolean} args.isMeetingUnprocessed
 * @param {(filename:string) => number[]} [args.notesSharingFile] every note id whose
 *   `mic_audio_path` or `system_audio_path` points at this file. A split child's id
 *   never appears in a filename, so without this the sweep asks only the recording
 *   note whether the meeting was processed, and clears the columns on only that one.
 */
function planAudioCleanup({ files, cutoffMs, isMeetingUnprocessed, notesSharingFile = null }) {
  const deleteFiles = [];
  const expiredTranscriptionIds = [];
  const expiredNoteIds = new Set();
  const retainedNoteIds = new Set();
  let keptCount = 0;

  for (const { name, mtimeMs } of files || []) {
    if (mtimeMs >= cutoffMs) {
      keptCount++;
      continue;
    }

    const nameNoteId = parseMeetingNoteId(name);
    const sharedNoteIds = new Set();
    if (nameNoteId != null) sharedNoteIds.add(nameNoteId);

    let lookupFailed = false;
    if (notesSharingFile) {
      try {
        for (const id of notesSharingFile(name) || []) {
          if (Number.isInteger(id)) sharedNoteIds.add(id);
        }
      } catch {
        lookupFailed = true;
      }
    }

    if (sharedNoteIds.size > 0 || nameNoteId != null) {
      let unprocessed = lookupFailed;
      if (!unprocessed) {
        for (const id of sharedNoteIds) {
          try {
            if (isMeetingUnprocessed(id)) {
              unprocessed = true;
              break;
            }
          } catch {
            unprocessed = true;
            break;
          }
        }
      }
      if (unprocessed) {
        for (const id of sharedNoteIds) retainedNoteIds.add(id);
        keptCount++;
        continue;
      }
      deleteFiles.push(name);
      for (const id of sharedNoteIds) expiredNoteIds.add(id);
      continue;
    }

    if (name.endsWith(".webm")) {
      deleteFiles.push(name);
      expiredTranscriptionIds.push(parseTranscriptionId(name));
      continue;
    }

    deleteFiles.push(name);
  }

  return {
    deleteFiles,
    expiredTranscriptionIds,
    expiredNoteIds,
    retainedNoteIds,
    keptCount,
  };
}

module.exports = { planAudioCleanup, parseMeetingNoteId };
