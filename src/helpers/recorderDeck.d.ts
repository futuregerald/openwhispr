export const MAX_MARKS: number;
export const MIN_MARK_GAP_MS: number;

export type DeckTrack = { number: string; startsAtMs: number; endsAtMs: number | null };

export type MarkerBook = { marks: number[] };

export type MarkerKeyState = {
  enabled: boolean;
  reason: "marking" | "limit-reached" | "too-soon" | null;
};

export function formatElapsed(ms: number): string;

export function deckTracks(
  startedAtMs: number | null | undefined,
  markTimesMs: readonly number[]
): DeckTrack[];

export function markerKeyState(args: {
  isMarking: boolean;
  markCount: number;
  lastMarkAtMs: number | null;
  nowMs: number;
}): MarkerKeyState;

export function recordMarkerResult(
  book: MarkerBook,
  result: { success: boolean; marks?: number[]; reason?: string } | null | undefined
): MarkerBook & { refusal: string | null };

export const REFUSAL_VISIBLE_MS: number;

export type MarkerPressState = {
  isRecording: boolean;
  recordingNoteId: number | null;
  isMarking: boolean;
  markers: number[];
  markerRefusal: string | null;
};

export function pressMarker(args: {
  getState: () => MarkerPressState;
  setState: (patch: Partial<MarkerPressState>) => void;
  requestMark: () => Promise<{ success: boolean; marks?: number[]; reason?: string } | undefined>;
  onError?: (error: unknown) => void;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
}): Promise<void>;
