import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Scissors } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { useToast } from "../ui/useToast";
import { formatMmSs } from "../../utils/formatDuration";
import {
  detectedGapSuggestion,
  splitFailureKey,
  splitPreview,
  type SplitPart,
} from "../../helpers/lineSplit";
import type { TranscriptSegment } from "../../stores/meetingRecordingStore";

interface SplitAtLineDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  noteId: number;
  noteTitle: string;
  segments: TranscriptSegment[];
  clockMs: number | null;
  initialLineIndex: number;
}

export default function SplitAtLineDialog({
  open,
  onOpenChange,
  noteId,
  noteTitle,
  segments,
  clockMs,
  initialLineIndex,
}: SplitAtLineDialogProps) {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const [lineIndex, setLineIndex] = useState(initialLineIndex);
  const [firstTitle, setFirstTitle] = useState(noteTitle);
  const [secondTitle, setSecondTitle] = useState("");
  const [isCommitting, setIsCommitting] = useState(false);

  const preview = useMemo(
    () => splitPreview(segments, lineIndex, clockMs),
    [segments, lineIndex, clockMs]
  );
  const suggestion = useMemo(() => detectedGapSuggestion(segments, clockMs), [segments, clockMs]);

  const clock = (ms: number) =>
    new Date(ms).toLocaleTimeString(i18n.language, { hour: "2-digit", minute: "2-digit" });

  const rangeOf = (part: SplitPart) =>
    part.startsAtMs != null && part.endsAtMs != null
      ? `${clock(part.startsAtMs)}–${clock(part.endsAtMs)}`
      : `${formatMmSs(part.startSeconds)}–${formatMmSs(part.endSeconds)}`;

  const suggestionAt = suggestion
    ? suggestion.atMs != null
      ? clock(suggestion.atMs)
      : formatMmSs(suggestion.atSeconds)
    : "";
  const showSuggestion = suggestion != null && suggestion.lineIndex !== lineIndex;
  const suggestionUsable =
    suggestion != null && splitPreview(segments, suggestion.lineIndex, clockMs) != null;

  const handleCommit = async () => {
    setIsCommitting(true);
    try {
      const result = await window.electronAPI?.splitNoteAtLine?.(
        noteId,
        lineIndex,
        { firstTitle, secondTitle },
        segments[lineIndex]?.text
      );
      if (result?.success) {
        toast({ title: t("notes.callSplit.done", { count: 2 }) });
        onOpenChange(false);
        return;
      }
      toast({ title: t(splitFailureKey(result?.reason)), variant: "destructive" });
    } catch (error) {
      toast({
        title: t("notes.callSplit.failedUnknown"),
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
    } finally {
      setIsCommitting(false);
    }
  };

  const parts = preview
    ? [
        { key: "first", part: preview.first },
        { key: "second", part: preview.second },
      ]
    : [];

  return (
    <Dialog open={open} onOpenChange={(next) => !isCommitting && onOpenChange(next)}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Scissors size={16} aria-hidden="true" />
            {t("notes.splitAtLine.title")}
          </DialogTitle>
          <DialogDescription>{t("notes.splitAtLine.description")}</DialogDescription>
        </DialogHeader>

        {showSuggestion && suggestionUsable && (
          <div className="flex items-center gap-2 rounded-md border border-border/40 bg-foreground/3 px-3 py-2 text-xs text-foreground/70">
            <span className="flex-1">
              {t("notes.splitAtLine.suggestion", {
                gap: formatMmSs(suggestion.gapSeconds),
                at: suggestionAt,
              })}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setLineIndex(suggestion.lineIndex)}
            >
              {t("notes.splitAtLine.useThis")}
            </Button>
          </div>
        )}

        {preview ? (
          <div className="grid gap-3" aria-live="polite">
            {parts.map(({ key, part }) => (
              <div key={key} className="grid gap-1.5">
                <div className="flex items-baseline justify-between gap-2">
                  <Label htmlFor={`split-title-${key}`} className="text-xs">
                    {t(`notes.splitAtLine.${key}Part`)}
                  </Label>
                  <span className="text-[11px] text-muted-foreground tabular-nums">
                    {t("notes.splitAtLine.partSummary", {
                      lines: part.count,
                      range: rangeOf(part),
                    })}
                  </span>
                </div>
                <Input
                  id={`split-title-${key}`}
                  value={key === "first" ? firstTitle : secondTitle}
                  onChange={(event) =>
                    key === "first"
                      ? setFirstTitle(event.target.value)
                      : setSecondTitle(event.target.value)
                  }
                  placeholder={
                    key === "first"
                      ? t("notes.splitAtLine.firstPlaceholder")
                      : t("notes.splitAtLine.secondPlaceholder")
                  }
                  disabled={isCommitting}
                />
              </div>
            ))}
            <p className="line-clamp-2 text-xs text-muted-foreground">
              {t("notes.splitAtLine.startsWith", { text: segments[lineIndex]?.text ?? "" })}
            </p>
            {preview.linesOutOfOrder && (
              <p className="text-xs text-muted-foreground">{t("notes.splitAtLine.outOfOrder")}</p>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t("notes.splitAtLine.failedInvalidLine")}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isCommitting}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="destructive"
            onClick={() => void handleCommit()}
            disabled={!preview || isCommitting}
          >
            {isCommitting ? t("notes.callSplit.splitting") : t("notes.splitAtLine.commit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
