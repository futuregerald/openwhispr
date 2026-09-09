import type { TranscriptSegment } from "../stores/meetingRecordingStore";

export type TranscriptSpeakerStatus = "provisional" | "confirmed" | "suggested" | "locked";
export type TranscriptSpeakerLockSource = "user" | "diarization" | "suggestion";

type SpeakerStateField =
  | "speaker"
  | "speakerName"
  | "speakerIsPlaceholder"
  | "suggestedName"
  | "suggestedProfileId"
  | "speakerStatus"
  | "speakerLocked"
  | "speakerLockSource";

export declare const isTranscriptSpeakerLocked: (segment: TranscriptSegment) => boolean;

export declare const normalizeTranscriptSegment: (segment: TranscriptSegment) => TranscriptSegment;

export declare const normalizeTranscriptSegments: (
  segments: TranscriptSegment[]
) => TranscriptSegment[];

export declare const applyTranscriptSpeakerPatch: (
  segment: TranscriptSegment,
  patch: Partial<Pick<TranscriptSegment, SpeakerStateField>>
) => TranscriptSegment;

export declare const lockTranscriptSpeaker: (
  segment: TranscriptSegment,
  patch?: Partial<Pick<TranscriptSegment, SpeakerStateField>>
) => TranscriptSegment;

export declare const mergeTranscriptSegments: (
  existingSegments: TranscriptSegment[],
  incomingSegments: TranscriptSegment[]
) => TranscriptSegment[];

export declare const serializeTranscriptSegments: (segments: TranscriptSegment[]) => string;

export declare const parseTranscriptSegments: (
  raw: string,
  onError?: (message: string, error: unknown) => void
) => TranscriptSegment[];
