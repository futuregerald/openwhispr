export type SplitSafetyReason =
  | "plain-text"
  | "too-short"
  | "missing-timestamps"
  | "mixed-units"
  | "negative-offset"
  | "clock-overwritten";

export type SplitSafety = { ok: boolean; reason?: SplitSafetyReason };

export function splitSafetyOf(
  note: {
    transcript?: string | null;
    transcript_origin_ms?: number | null;
    updated_at?: string | null;
  } | null
): SplitSafety;
