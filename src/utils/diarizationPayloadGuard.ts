export type DiarizationRefusalReason = "no-session" | "session-mismatch" | "note-mismatch";

export interface DiarizationPayloadVerdict {
  accepted: boolean;
  reason: DiarizationRefusalReason | null;
}

export interface DiarizationPayloadIdentity {
  sessionId?: string | null;
  noteId?: number | null;
}

export interface OpenNoteIdentity {
  sessionId?: string | null;
  noteId: number;
}

export const classifyDiarizationPayload = (
  payload: DiarizationPayloadIdentity | null | undefined,
  expected: OpenNoteIdentity
): DiarizationPayloadVerdict => {
  if (!expected.sessionId) {
    return { accepted: false, reason: "no-session" };
  }
  if (payload?.sessionId !== expected.sessionId) {
    return { accepted: false, reason: "session-mismatch" };
  }
  if (payload?.noteId != null && payload.noteId !== expected.noteId) {
    return { accepted: false, reason: "note-mismatch" };
  }
  return { accepted: true, reason: null };
};
