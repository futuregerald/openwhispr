export const MAX_MARKS: number;
export const MIN_MARK_GAP_MS: number;

export type DeckTrack = { number: string; startsAtMs: number; endsAtMs: number | null };

export type MarkerBook = { marks: number[]; times: number[] };

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
  result: { success: boolean; marks?: number[]; reason?: string } | null | undefined,
  nowMs: number
): MarkerBook & { refusal: string | null };

export type MarkerPressState = {
  isRecording: boolean;
  isMarking: boolean;
  markers: number[];
  markerTimes: number[];
  markerRefusal: string | null;
};

export function pressMarker(args: {
  getState: () => MarkerPressState;
  setState: (patch: Partial<MarkerPressState>) => void;
  requestMark: () => Promise<{ success: boolean; marks?: number[]; reason?: string } | undefined>;
  nowMs: () => number;
  onError?: (error: unknown) => void;
}): Promise<void>;
