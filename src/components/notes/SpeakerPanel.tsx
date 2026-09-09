import React, { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Users, Merge, X } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { useToast } from "../ui/useToast";
import { computeSpeakerStats } from "../../helpers/speakerTalkTime";
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
}

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
}: SpeakerPanelProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [selectedForMerge, setSelectedForMerge] = useState<string[]>([]);

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

  const handleCommitEdit = () => {
    if (editingId && editValue.trim()) {
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

  const handleMerge = () => {
    if (!canMergeSelection(selectedForMerge)) return;
    Promise.resolve(
      (window as any).electronAPI?.mergeSpeakers?.(
        noteId,
        getMergePrimaryId(selectedForMerge),
        getMergeTargetIds(selectedForMerge)
      )
    )
      .then(reportSkippedLocked)
      .catch(() => {});
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
