export type RecordingSide = "you" | "them";

export const RECORDING_SIDE_LABEL_KEYS: Record<RecordingSide, string> = {
  you: "notes.speaker.you",
  them: "notes.speaker.them",
};

export const recordingSideOf = (
  segment: { source?: string | null } | null | undefined
): RecordingSide => (segment?.source === "mic" ? "you" : "them");
