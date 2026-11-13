import type { CallBoundaryReport } from "./callBoundaries";

export function cutReportAt(
  segments: readonly { timestamp?: number | null }[],
  cutPositions: readonly number[]
): CallBoundaryReport;

export function cutPositionsForOffsets(
  segments: readonly { timestamp?: number | null }[],
  offsetsSeconds: readonly unknown[],
  clockMs?: number | null
): number[];

export function timePositionOfIndex(
  segments: readonly { timestamp?: number | null }[],
  index: number
): number;
