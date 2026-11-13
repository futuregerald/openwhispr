export type SplitPart = {
  count: number;
  startsAtMs: number | null;
  endsAtMs: number | null;
  startSeconds: number;
  endSeconds: number;
};

export type SplitPreview = { first: SplitPart; second: SplitPart; linesOutOfOrder: boolean };

export type LineSplitState =
  | { kind: "hidden" }
  | { kind: "unsafe"; reason: string }
  | { kind: "available"; earliestIndex: number };

export type DetectedGapSuggestion = {
  lineIndex: number;
  gapSeconds: number;
  atSeconds: number;
  atMs: number | null;
};

type TimedSegment = { text?: string; timestamp?: number | null };

export function splitFailureKey(reason: string | undefined): string;

export function lineSplitState(
  note: {
    transcript?: string | null;
    transcript_origin_ms?: number | null;
    updated_at?: string | null;
  } | null,
  displayedSegments: readonly TimedSegment[],
  options: { isRecording: boolean; pipelineRunning?: boolean }
): LineSplitState;

export function splitPreview(
  segments: readonly TimedSegment[],
  lineIndex: number,
  clockMs: number | null | undefined
): SplitPreview | null;

export function detectedGapSuggestion(
  segments: readonly TimedSegment[],
  clockMs: number | null | undefined
): DetectedGapSuggestion | null;
