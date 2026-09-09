import type { TranscriptSegment } from "../stores/meetingRecordingStore";
import { parseTranscriptSegments as parseShared } from "../helpers/transcriptSpeakerState";
import logger from "./logger";

export function parseTranscriptSegments(raw: string): TranscriptSegment[] {
  return parseShared(raw, (message, error) => logger.warn(message, error));
}
