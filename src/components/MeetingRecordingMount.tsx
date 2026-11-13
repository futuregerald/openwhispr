import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "./ui/useToast";
import {
  getMicAnalyser,
  primeMeetingWorklet,
  stopRecording,
  useMeetingRecordingStore,
} from "../stores/meetingRecordingStore";
import { serializeTranscriptSegments } from "../helpers/transcriptSpeakerState";
import { startTranscriptAutosave } from "../helpers/transcriptAutosave";

const EMA_PREV = 0.5;
const EMA_NEXT = 0.5;
const AUTOSAVE_INTERVAL_MS = 30_000;

export default function MeetingRecordingMount(): null {
  const { t } = useTranslation();
  const { toast } = useToast();
  const isRecording = useMeetingRecordingStore((s) => s.isRecording);
  const error = useMeetingRecordingStore((s) => s.error);
  const realtimeTranscript = useMeetingRecordingStore((s) => s.transcript);
  const realtimeSegments = useMeetingRecordingStore((s) => s.segments);
  const recordingNoteId = useMeetingRecordingStore((s) => s.recordingNoteId);
  const prevTranscribingRef = useRef(false);

  useEffect(() => {
    primeMeetingWorklet();
  }, []);

  useEffect(() => {
    const unsubscribe = window.electronAPI.onMeetingAutoStopRequest?.(() => {
      if (useMeetingRecordingStore.getState().isRecording) {
        stopRecording();
      }
    });
    return () => unsubscribe?.();
  }, []);

  useEffect(() => {
    if (
      prevTranscribingRef.current &&
      !isRecording &&
      (realtimeTranscript || realtimeSegments.length > 0)
    ) {
      const transcript =
        realtimeSegments.length > 0
          ? serializeTranscriptSegments(realtimeSegments)
          : realtimeTranscript;

      if (recordingNoteId && transcript) {
        window.electronAPI.updateNote(recordingNoteId, { transcript });
      }
    }
    prevTranscribingRef.current = isRecording;
  }, [isRecording, realtimeTranscript, realtimeSegments, recordingNoteId]);

  useEffect(() => {
    if (!isRecording || !recordingNoteId) return;

    return startTranscriptAutosave({
      intervalMs: AUTOSAVE_INTERVAL_MS,
      read: () => useMeetingRecordingStore.getState().segments,
      write: (segments) => {
        window.electronAPI.updateNote(recordingNoteId, {
          transcript: serializeTranscriptSegments(segments),
        });
      },
    });
  }, [isRecording, recordingNoteId]);

  useEffect(() => {
    if (!error) return;
    toast({
      title: t("notes.meeting.title"),
      description: error,
      variant: "destructive",
    });
  }, [error, toast, t]);

  useEffect(() => {
    if (!isRecording) return;

    let rafId = 0;
    let smoothed = 0;
    let buf = new Float32Array(256);

    const tick = () => {
      const analyser = getMicAnalyser();
      if (analyser) {
        if (buf.length !== analyser.fftSize) {
          buf = new Float32Array(analyser.fftSize);
        }
        analyser.getFloatTimeDomainData(buf);
        let sumSquares = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = buf[i];
          sumSquares += v * v;
        }
        const rms = Math.sqrt(sumSquares / buf.length);
        smoothed = EMA_PREV * smoothed + EMA_NEXT * rms;
        const clamped = smoothed < 0 ? 0 : smoothed > 1 ? 1 : smoothed;
        useMeetingRecordingStore.setState({ currentMicLevel: clamped });
      }
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafId);
      useMeetingRecordingStore.setState({ currentMicLevel: 0 });
    };
  }, [isRecording]);

  return null;
}
