import React, { useState, useMemo, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Users, Merge, X, Play, Square } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { useToast } from "../ui/useToast";
import { computeSpeakerStats } from "../../helpers/speakerTalkTime";
import { resolveSpeakerAuditionCue } from "../../helpers/speakerAuditionCue";
import {
  toggleSpeakerSelection,
  toggleSelectAllSpeakers,
  getMergePrimaryId,
  getMergeTargetIds,
  canMergeSelection,
} from "../../helpers/speakerMergeSelection";

interface Speaker {
  id: string;
  name: string;
  isPlaceholder: boolean;
  segmentCount: number;
  talkTimeSeconds: number;
  talkTimePercent: number;
}

interface SpeakerPanelProps {
  noteId: number;
  segments: Array<{
    id?: string;
    text: string;
    source?: string;
    speaker?: string;
    speakerName?: string;
    speakerIsPlaceholder?: boolean;
    timestamp?: number;
  }>;
  onFilterSpeaker: (speakerId: string | null) => void;
  activeSpeakerFilter: string | null;
  onMapSpeaker?: (
    speakerId: string,
    displayName: string,
    email?: string | null,
    profileId?: number | null
  ) => void | Promise<void>;
  onMergeSpeakers?: (primaryId: string, targetIds: string[]) => void | Promise<void>;
  isRecording?: boolean;
  transcriptOriginSource?: string | null;
}

const AUDITION_SECONDS = 8;

const isPlayable = (url: string | null | undefined, path: string | null | undefined) =>
  Boolean(url) && !String(path ?? "").toLowerCase().endsWith(".pcm");

const SPEAKER_COLORS = [
  "bg-blue-500", "bg-emerald-500", "bg-amber-500", "bg-purple-500",
  "bg-rose-500", "bg-cyan-500", "bg-orange-500", "bg-teal-500",
  "bg-pink-500", "bg-indigo-500", "bg-lime-500", "bg-red-500",
  "bg-sky-500", "bg-violet-500", "bg-fuchsia-500",
];

export default function SpeakerPanel({
  noteId,
  segments,
  onFilterSpeaker,
  activeSpeakerFilter,
  onMapSpeaker,
  onMergeSpeakers,
  isRecording = false,
  transcriptOriginSource,
}: SpeakerPanelProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [selectedForMerge, setSelectedForMerge] = useState<string[]>([]);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [tracks, setTracks] = useState<{
    micUrl: string | null;
    systemUrl: string | null;
    micPath: string | null;
    systemPath: string | null;
    micDuration: number | null;
    systemDuration: number | null;
  } | null>(null);
  const audioRef = useRef<Record<"mic" | "system", HTMLAudioElement | null>>({
    mic: null,
    system: null,
  });

  // Two elements, not one with a reassigned src: the mic cue needs BOTH durations before it
  // can decide where to seek, and a shared element would have to load metadata twice.
  useEffect(() => {
    let cancelled = false;
    const api = (window as any).electronAPI;
    if (!api?.getNoteAudioPaths) return undefined;

    const load = async () => {
      const paths = await api.getNoteAudioPaths(noteId).catch(() => null);
      if (cancelled || !paths) return;

      const durationOf = (url: string | null) =>
        new Promise<number | null>((resolve) => {
          if (!url) return resolve(null);
          const probe = new Audio();
          probe.preload = "metadata";
          probe.addEventListener("loadedmetadata", () => resolve(probe.duration), { once: true });
          probe.addEventListener("error", () => resolve(null), { once: true });
          probe.src = url;
        });

      const [micDuration, systemDuration] = await Promise.all([
        isPlayable(paths.micUrl, paths.micPath) ? durationOf(paths.micUrl) : null,
        isPlayable(paths.systemUrl, paths.systemPath) ? durationOf(paths.systemUrl) : null,
      ]);
      if (!cancelled) setTracks({ ...paths, micDuration, systemDuration });
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [noteId]);

  const stopAudition = () => {
    for (const element of Object.values(audioRef.current)) element?.pause();
    setPlayingId(null);
  };

  useEffect(() => stopAudition, []);

  const auditionCueFor = (speakerId: string) =>
    tracks
      ? resolveSpeakerAuditionCue(segments, speakerId, {
          micDuration: tracks.micDuration,
          systemDuration: tracks.systemDuration,
        })
      : null;

  const handleAudition = (speakerId: string) => {
    if (playingId === speakerId) return stopAudition();
    const cue = auditionCueFor(speakerId);
    const url = cue?.track === "mic" ? tracks?.micUrl : tracks?.systemUrl;
    if (!cue || !url) return;

    stopAudition();
    let element = audioRef.current[cue.track];
    if (!element) {
      element = new Audio();
      audioRef.current[cue.track] = element;
    }
    const stopAt = cue.seconds + AUDITION_SECONDS;
    const onTime = () => {
      if (element && element.currentTime >= stopAt) {
        element.pause();
        element.removeEventListener("timeupdate", onTime);
        setPlayingId((current) => (current === speakerId ? null : current));
      }
    };
    element.addEventListener("timeupdate", onTime);
    element.addEventListener("ended", () => setPlayingId(null), { once: true });
    element.addEventListener("error", () => setPlayingId(null), { once: true });
    if (element.src !== url) element.src = url;
    element.currentTime = cue.seconds;
    void element.play().then(
      () => setPlayingId(speakerId),
      () => setPlayingId(null)
    );
  };

  const speakers = useMemo(
    () => computeSpeakerStats(segments) as Speaker[],
    [segments]
  );

  const speakerIds = useMemo(() => speakers.map((s) => s.id), [speakers]);
  const primaryId = getMergePrimaryId(selectedForMerge);
  const primaryName =
    speakers.find((s) => s.id === primaryId)?.name ?? primaryId ?? "";
  const allSelected =
    speakerIds.length > 0 && selectedForMerge.length === speakerIds.length;

  const handleStartEdit = (speaker: Speaker) => {
    setEditingId(speaker.id);
    setEditValue(speaker.name);
  };

  const reportSkippedLocked = (result: { skippedLockedCount?: number } | undefined) => {
    const skipped = result?.skippedLockedCount ?? 0;
    if (skipped > 0) {
      toast({ title: t("speakers.panel.lockedSkipped", { count: skipped }) });
    }
  };

  // Routed through onMapSpeaker, not the rename IPC. The IPC skips locked segments, and every
  // speaker the user has already named is fully locked -- note 13's speaker_0 is locked on all
  // 907 of its segments, so renaming it reported "907 skipped" and changed nothing. A rename
  // started from this panel is the user changing their own mind, which the lock was never
  // meant to prevent. It also writes a profile, so the name is suggested in later meetings.
  const handleCommitEdit = () => {
    if (editingId && editValue.trim() && onMapSpeaker) {
      void Promise.resolve(onMapSpeaker(editingId, editValue.trim(), null, null)).catch(() => {});
    } else if (editingId && editValue.trim()) {
      Promise.resolve(
        (window as any).electronAPI?.renameSpeaker?.(noteId, editingId, editValue.trim())
      )
        .then(reportSkippedLocked)
        .catch(() => {});
    }
    setEditingId(null);
  };

  const handleToggleMergeSelect = (id: string) => {
    setSelectedForMerge((prev) => toggleSpeakerSelection(prev, id));
  };

  const handleToggleSelectAll = () => {
    setSelectedForMerge((prev) => toggleSelectAllSpeakers(prev, speakerIds));
  };

  // Merge goes the same way as rename, deliberately. Splitting them -- rename in the renderer,
  // merge in main -- loses data: the editor prefers its local segment state over the stored
  // transcript until the note id changes, so a merge written by main is invisible here and the
  // next rename writes the pre-merge segments back over it.
  const handleMerge = () => {
    if (!canMergeSelection(selectedForMerge)) return;
    const primaryId = getMergePrimaryId(selectedForMerge);
    const targetIds = getMergeTargetIds(selectedForMerge);

    if (onMergeSpeakers) {
      void Promise.resolve(onMergeSpeakers(primaryId, targetIds)).catch(() => {});
    } else {
      Promise.resolve((window as any).electronAPI?.mergeSpeakers?.(noteId, primaryId, targetIds))
        .then(reportSkippedLocked)
        .catch(() => {});
    }
    setSelectedForMerge([]);
  };

  return (
    <div className="rounded-lg border border-border bg-background shadow-lg p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <Users size={14} />
          <span>
            {t("speakers.panel.title", { count: speakers.length })}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {speakers.length > 1 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleToggleSelectAll}
              className="h-6 text-xs"
            >
              {allSelected
                ? t("speakers.panel.selectNone")
                : t("speakers.panel.selectAll")}
            </Button>
          )}
          {canMergeSelection(selectedForMerge) && (
            <Button variant="outline" size="sm" onClick={handleMerge} className="h-6 text-xs">
              <Merge size={12} className="mr-1" />
              {t("speakers.panel.mergeInto", {
                count: getMergeTargetIds(selectedForMerge).length,
                name: primaryName,
              })}
            </Button>
          )}
          {activeSpeakerFilter && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onFilterSpeaker(null)}
              className="h-6 text-xs"
            >
              <X size={12} className="mr-1" />
              {t("speakers.panel.clearFilter")}
            </Button>
          )}
        </div>
      </div>

      {canMergeSelection(selectedForMerge) && (
        <div className="mb-2 text-[10px] text-muted-foreground">
          {t("speakers.panel.keepingSpeaker", { name: primaryName })}
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 max-h-56 overflow-y-auto">
        {speakers.map((speaker, idx) => {
          const isFiltered = activeSpeakerFilter === speaker.id;
          const isMergeSelected = selectedForMerge.includes(speaker.id);
          const isMergePrimary = canMergeSelection(selectedForMerge) && speaker.id === primaryId;
          const colorClass = SPEAKER_COLORS[idx % SPEAKER_COLORS.length];

          return (
            <div
              key={speaker.id}
              className={`flex items-center gap-2 p-2 rounded-md border cursor-pointer transition-colors
                ${isFiltered ? "border-primary bg-primary/5" : "border-border hover:border-muted-foreground/30"}
                ${isMergeSelected ? "ring-2 ring-primary" : ""}`}
              onClick={() => onFilterSpeaker(isFiltered ? null : speaker.id)}
            >
              <div className={`w-6 h-6 rounded-full ${colorClass} shrink-0 flex items-center justify-center text-white text-xs font-bold`}>
                {speaker.name.charAt(0).toUpperCase()}
              </div>
              {(() => {
                const cue = auditionCueFor(speaker.id);
                const unavailable = isRecording
                  ? t("speakers.panel.auditionWhileRecording")
                  : !tracks?.systemUrl && !tracks?.micUrl
                    ? t("speakers.panel.auditionNoAudio")
                    : !cue
                      ? t("speakers.panel.auditionNoCue")
                      : null;
                const isPlaying = playingId === speaker.id;
                return (
                  <button
                    type="button"
                    disabled={Boolean(unavailable)}
                    title={
                      unavailable ??
                      (transcriptOriginSource === "audio:system"
                        ? t("speakers.panel.auditionPlay")
                        : t("speakers.panel.auditionApproximate"))
                    }
                    className="shrink-0 p-1 rounded hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleAudition(speaker.id);
                    }}
                  >
                    {isPlaying ? <Square size={11} /> : <Play size={11} />}
                  </button>
                );
              })()}
              <div className="flex-1 min-w-0">
                {editingId === speaker.id ? (
                  <Input
                    value={editValue}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditValue(e.target.value)}
                    onBlur={handleCommitEdit}
                    onKeyDown={(e: React.KeyboardEvent) => e.key === "Enter" && handleCommitEdit()}
                    className="h-5 text-xs p-1"
                    autoFocus
                    onClick={(e: React.MouseEvent) => e.stopPropagation()}
                  />
                ) : (
                  <span
                    className="text-xs font-medium truncate block"
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      handleStartEdit(speaker);
                    }}
                  >
                    {speaker.name}
                    {isMergePrimary && (
                      <span className="ml-1 text-[9px] font-normal text-primary">
                        {t("speakers.panel.keptBadge")}
                      </span>
                    )}
                  </span>
                )}
                <span className="text-[10px] text-muted-foreground">
                  {speaker.segmentCount} {t("speakers.panel.segments")} &middot;{" "}
                  {t("speakers.panel.talkTime", { percent: speaker.talkTimePercent })}
                </span>
              </div>
              <input
                type="checkbox"
                className="shrink-0"
                checked={isMergeSelected}
                onChange={(e) => {
                  e.stopPropagation();
                  handleToggleMergeSelect(speaker.id);
                }}
                title={t("speakers.panel.selectForMerge")}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
