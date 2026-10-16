export function hasGeneratedNotes(enhancedContent: unknown): boolean;
export function defaultNoteViewMode(
  noteType: unknown,
  enhancedContent: unknown
): "enhanced" | "raw";
export function shouldOpenArrivedNotes(state: {
  noteType: unknown;
  hadGeneratedNotes: boolean;
  hasGeneratedNotes: boolean;
  viewMode: "raw" | "transcript" | "enhanced";
  userChoseView: boolean;
  isRecording: boolean;
}): boolean;
