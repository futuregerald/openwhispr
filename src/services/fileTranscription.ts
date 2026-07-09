import { withSessionRefresh } from "../lib/auth";

export interface FileTranscriptionResult {
  success: boolean;
  text?: string;
  error?: string;
  code?: string;
  diarized?: boolean;
  warning?: string;
}

export interface FileTranscriptionConfig {
  useLocalWhisper: boolean;
  localTranscriptionProvider: string;
  whisperModel: string;
  parakeetModel: string;
  isOpenWhisprCloud: boolean;
  getApiKey: () => string;
  cloudTranscriptionProvider: string;
  cloudTranscriptionBaseUrl: string;
  cloudTranscriptionModel: string;
  language: string;
  cortiEnvironment?: string;
  cortiTenant?: string;
}

// Single provider dispatch shared by the single-file flow and the batch queue,
// so BYOK providers receive identical options in both.
export async function transcribeFile(
  filePath: string,
  cfg: FileTranscriptionConfig,
  diarize: boolean
): Promise<FileTranscriptionResult> {
  if (cfg.isOpenWhisprCloud) {
    return withSessionRefresh(async () => {
      const r = await window.electronAPI.transcribeAudioFileCloud!(filePath);
      if (!r.success && r.code) {
        throw Object.assign(new Error(r.error || "Cloud transcription failed"), {
          code: r.code,
        });
      }
      return r;
    });
  }

  if (cfg.useLocalWhisper) {
    return window.electronAPI.transcribeAudioFile(filePath, {
      provider: cfg.localTranscriptionProvider as "whisper" | "nvidia",
      model: cfg.localTranscriptionProvider === "nvidia" ? cfg.parakeetModel : cfg.whisperModel,
    });
  }

  return window.electronAPI.transcribeAudioFileByok!({
    filePath,
    apiKey: cfg.getApiKey(),
    baseUrl: cfg.cloudTranscriptionBaseUrl || "",
    model: cfg.cloudTranscriptionModel,
    diarize: diarize || undefined,
    provider: cfg.cloudTranscriptionProvider,
    language: cfg.language,
    environment: cfg.cortiEnvironment,
    tenant: cfg.cortiTenant,
  });
}
