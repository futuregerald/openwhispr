export interface SpeakerMappingBroadcast {
  noteId: number;
  mappings?: {
    speaker_id: string;
    display_name: string;
    profile_id?: number | null;
  }[];
}

export function speakerMappingsForBroadcast(
  payload: SpeakerMappingBroadcast | null | undefined,
  noteId: number | undefined
): Record<string, string> | null;
