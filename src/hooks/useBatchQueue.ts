import { useState, useRef, useCallback, useEffect } from "react";
import { transcribeFile } from "../services/fileTranscription";
import type { FileTranscriptionConfig } from "../services/fileTranscription";

export type QueueItemStatus =
  | "queued"
  | "downloading"
  | "transcribing"
  | "done"
  | "error";

export interface QueueItem {
  id: string;
  source: "file" | "url";
  name: string;
  path: string;
  url?: string;
  sizeBytes: number;
  status: QueueItemStatus;
  progress: number;
  error?: string;
  noteId?: number;
  tempPath?: string;
}

export interface TranscribeOptions {
  transcription: FileTranscriptionConfig;
  folderId: number | null;
  // Returns an i18n key under notes.upload.* when the file exceeds the
  // mode-aware size limit, null when acceptable.
  validateSize?: (sizeBytes: number) => string | null;
}

export interface DiarizationOptions {
  enabled: boolean;
  numSpeakers: number | null;
}

export function computeByokDiarize(opts: {
  diarizationEnabled: boolean;
  useLocalWhisper: boolean;
  isOpenWhisprCloud: boolean;
  cloudTranscriptionProvider: string;
}): boolean {
  return (
    opts.diarizationEnabled &&
    !opts.useLocalWhisper &&
    !opts.isOpenWhisprCloud &&
    (opts.cloudTranscriptionProvider === "openai" ||
      opts.cloudTranscriptionProvider === "mistral")
  );
}

export function useBatchQueue() {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentItemId, setCurrentItemId] = useState<string | null>(null);
  const processingRef = useRef(false);
  const cancelledRef = useRef(false);
  const queueRef = useRef<QueueItem[]>([]);

  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  const addFiles = useCallback(
    (files: Array<{ name: string; path: string; sizeBytes: number }>) => {
      const items: QueueItem[] = files.map((f) => ({
        id: crypto.randomUUID(),
        source: "file" as const,
        name: f.name,
        path: f.path,
        sizeBytes: f.sizeBytes,
        status: "queued" as const,
        progress: 0,
      }));
      setQueue((prev) => [...prev, ...items]);
      return items;
    },
    []
  );

  const addUrls = useCallback((urls: string[]) => {
    const items: QueueItem[] = urls.map((url) => ({
      id: crypto.randomUUID(),
      source: "url" as const,
      name: url,
      path: "",
      url,
      sizeBytes: 0,
      status: "queued" as const,
      progress: 0,
    }));
    setQueue((prev) => [...prev, ...items]);
    return items;
  }, []);

  const removeItem = useCallback((id: string) => {
    setQueue((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const updateItem = useCallback((id: string, updates: Partial<QueueItem>) => {
    setQueue((prev) =>
      prev.map((item) => (item.id === id ? { ...item, ...updates } : item))
    );
  }, []);

  const cancelAll = useCallback(() => {
    cancelledRef.current = true;
    window.electronAPI.cancelUrlDownload();
    setQueue((prev) =>
      prev.map((item) =>
        item.status === "queued"
          ? { ...item, status: "error" as const, error: "batchCancelled" }
          : item
      )
    );
  }, []);

  const clearQueue = useCallback(() => {
    cancelledRef.current = true;
    setQueue([]);
    setCurrentItemId(null);
  }, []);

  const processQueue = useCallback(
    async (
      transcribeOpts: TranscribeOptions,
      diarizationOpts: DiarizationOptions
    ) => {
      if (processingRef.current) return;
      processingRef.current = true;
      cancelledRef.current = false;
      setIsProcessing(true);

      const snapshotApiKey = transcribeOpts.transcription.getApiKey();
      const transcription: FileTranscriptionConfig = {
        ...transcribeOpts.transcription,
        getApiKey: () => snapshotApiKey,
      };

      const processItem = async (item: QueueItem) => {
        setCurrentItemId(item.id);
        let filePath = item.path;
        let tempPath: string | undefined;
        let noteName = item.name;
        let sizeBytes = item.sizeBytes;

        try {
          if (item.source === "url" && item.url) {
            updateItem(item.id, { status: "downloading", progress: 0 });

            const cleanupProgress =
              window.electronAPI.onUrlDownloadProgress?.((data) => {
                updateItem(item.id, {
                  progress: data.percent,
                  name: data.title || item.name,
                });
              });

            try {
              const res = await window.electronAPI.downloadUrlAudio(item.url);
              if (!res.success) {
                const fail = res as { success: false; error: string };
                updateItem(item.id, { status: "error", error: fail.error });
                return;
              }
              filePath = res.tempPath;
              tempPath = res.tempPath;
              noteName = res.title || item.name;
              sizeBytes = res.sizeBytes;
              updateItem(item.id, {
                path: res.tempPath,
                tempPath: res.tempPath,
                name: noteName,
                sizeBytes: res.sizeBytes,
              });
            } finally {
              cleanupProgress?.();
            }
          }

          if (cancelledRef.current) return;

          const sizeError = transcribeOpts.validateSize?.(sizeBytes) ?? null;
          if (sizeError) {
            updateItem(item.id, { status: "error", error: sizeError });
            return;
          }

          updateItem(item.id, { status: "transcribing", progress: 0 });

          const byokUseDiarize = computeByokDiarize({
            diarizationEnabled: diarizationOpts.enabled,
            useLocalWhisper: transcription.useLocalWhisper,
            isOpenWhisprCloud: transcription.isOpenWhisprCloud,
            cloudTranscriptionProvider: transcription.cloudTranscriptionProvider,
          });

          const transcribePromise = transcribeFile(filePath, transcription, byokUseDiarize);

          const diarizePromise = diarizationOpts.enabled && filePath && !byokUseDiarize
            ? window.electronAPI.diarizeAudioFile?.(filePath, {
                numSpeakers: diarizationOpts.numSpeakers ?? undefined,
              }).catch(() => null)
            : Promise.resolve(null);

          const [transcriptionResult, diarResult] = await Promise.all([
            transcribePromise,
            diarizePromise,
          ]);

          if (!transcriptionResult.success || !transcriptionResult.text) {
            updateItem(item.id, {
              status: "error",
              error: transcriptionResult.error || "batchTranscriptionFailed",
            });
            return;
          }

          let finalText = transcriptionResult.text;

          if ("diarized" in transcriptionResult && transcriptionResult.diarized) {
            // Cloud diarization already applied
          } else if (diarResult?.success && diarResult.segments && diarResult.segments.length > 0) {
            try {
              const duration = diarResult.segments[diarResult.segments.length - 1]?.end || 0;
              const mergeResult = await window.electronAPI.mergeSpeakerText?.(
                diarResult.segments, finalText, duration
              );
              if (mergeResult?.success && mergeResult.text) {
                finalText = mergeResult.text;
              }
            } catch {
              // Merge failed, save without speaker labels
            }
          }

          const noteRes = await window.electronAPI.saveNote(
            noteName,
            finalText,
            "upload",
            noteName,
            null,
            transcribeOpts.folderId
          );

          if (noteRes.success && noteRes.note) {
            updateItem(item.id, {
              status: "done",
              progress: 100,
              noteId: noteRes.note.id,
            });
          } else {
            updateItem(item.id, { status: "error", error: "batchSaveFailed" });
          }
        } catch (err) {
          updateItem(item.id, {
            status: "error",
            error: err instanceof Error ? err.message : "batchUnknownError",
          });
        } finally {
          if (tempPath) {
            window.electronAPI.deleteTempFile(tempPath);
          }
        }
      };

      const processed = new Set<string>();
      let next: QueueItem | undefined;
      while (
        !cancelledRef.current &&
        (next = queueRef.current.find((i) => i.status === "queued" && !processed.has(i.id)))
      ) {
        processed.add(next.id);
        await processItem(next);
      }

      setCurrentItemId(null);
      setIsProcessing(false);
      processingRef.current = false;
      cancelledRef.current = false;
    },
    [updateItem]
  );

  useEffect(() => {
    return () => {
      if (processingRef.current) {
        cancelledRef.current = true;
        window.electronAPI.cancelUrlDownload();
      }
    };
  }, []);

  const completedCount = queue.filter((i) => i.status === "done").length;
  const totalCount = queue.length;
  const hasQueue = queue.length > 0;

  return {
    queue,
    isProcessing,
    currentItemId,
    hasQueue,
    completedCount,
    totalCount,
    addFiles,
    addUrls,
    removeItem,
    cancelAll,
    clearQueue,
    processQueue,
  };
}
