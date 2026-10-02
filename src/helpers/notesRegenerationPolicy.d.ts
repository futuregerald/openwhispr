export type NotesRegenerationReason =
  "disabled" | "no-notes" | "unknown-provenance" | "user-edited" | "regenerate";

export type NotesRegenerationDecision = {
  regenerate: boolean;
  reason: NotesRegenerationReason;
};

export declare function shouldRegenerateNotes(options: {
  enabled?: boolean;
  enhancedContent?: string | null;
  generatedHash?: string | null;
  hashOf: (content: string) => string;
}): NotesRegenerationDecision;
