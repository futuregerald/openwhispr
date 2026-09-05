const { STEP_ORDER, localizedTitlePlaceholders } = require("./postCallPipelineManager");

// Reuses the pipeline's own list rather than hard-coding the English strings.
// It resolves every placeholder in every supported language, because a note may
// have been created while the app was in a different language than the one
// running now -- and because for every non-English user the English list matches
// nothing at all, which would report a note as complete when its title was never
// generated.
function isPlaceholderTitle(title) {
  const trimmed = String(title || "").trim();
  if (!trimmed) return true;
  return localizedTitlePlaceholders().includes(trimmed);
}

/**
 * Which pipeline step a meeting note is stuck on, decided from the note itself.
 *
 * The renderer already tracks pipeline progress, but only in memory and only
 * from a live broadcast — so it knows nothing about a run that failed while the
 * control panel was closed, which is exactly the state of every meeting that
 * has a transcript and no notes. Those are the notes a retry menu exists for,
 * so the answer has to come from something durable, and the note's own columns
 * are the only durable record there is.
 *
 * The order matters and follows STEP_ORDER: the earliest thing still missing is
 * what to retry, because every later step depends on it.
 *
 * @returns {{step: string|null, reason: string}} `step` is null when there is
 *   nothing to retry — either the note is complete, or it has no audio and no
 *   transcript, in which case re-running would produce the same nothing.
 */
function resolveRetryStep(note) {
  if (!note) return { step: null, reason: "missing" };

  const hasAudio = !!(note.system_audio_path || note.mic_audio_path);
  const hasTranscript = !!(note.transcript && String(note.transcript).trim());
  const hasNotes = !!(note.enhanced_content && String(note.enhanced_content).trim());
  const hasTitle = !isPlaceholderTitle(note.title);

  if (!hasTranscript) {
    // Nothing to work from. Retrying the transcription is only meaningful if
    // the audio is still on disk; the 30-day cleanup may have taken it.
    return hasAudio
      ? { step: "retranscribe", reason: "no-transcript" }
      : { step: null, reason: "no-transcript-no-audio" };
  }

  if (!hasNotes) {
    // The overwhelmingly common case: the title step succeeded and the notes
    // step failed. Retrying from "notes" reuses the transcript that already
    // exists rather than re-transcribing and re-diarizing an hour of audio.
    return { step: "notes", reason: "no-notes" };
  }

  if (!hasTitle) {
    return { step: "title", reason: "no-title" };
  }

  return { step: null, reason: "complete" };
}

/** Every step a user may retry, earliest first. */
function retryableSteps(note) {
  const hasAudio = !!(note?.system_audio_path || note?.mic_audio_path);
  return STEP_ORDER.filter((step) => step !== "retranscribe" || hasAudio);
}

module.exports = { resolveRetryStep, retryableSteps, isPlaceholderTitle };
