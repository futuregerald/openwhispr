export interface LabelledSegment {
  label: string;
  text: string;
}

export interface NoteActionInputSource {
  notes: string;
  rawTranscript: string;
  labelledSegments: LabelledSegment[];
}

export interface NoteActionInput {
  promptText: string;
  localRunnerNoteContent: string;
}

export const buildNoteActionInput = ({
  notes,
  rawTranscript,
  labelledSegments,
}: NoteActionInputSource): NoteActionInput => {
  const transcriptText =
    labelledSegments.length > 0
      ? labelledSegments.map((s) => `${s.label}: ${s.text}`).join("\n")
      : rawTranscript;

  const promptText = [
    notes.trim() ? notes : "",
    transcriptText ? `## Meeting Transcript\n${transcriptText}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    promptText,
    localRunnerNoteContent: labelledSegments.length > 0 ? notes : promptText,
  };
};
