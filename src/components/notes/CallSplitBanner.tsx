import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Scissors } from "lucide-react";
import { useToast } from "../ui/useToast";
import { ConfirmDialog } from "../ui/dialog.js";
import type { NoteItem } from "../../types/electron";

export default function CallSplitBanner({ note }: { note: NoteItem }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [callCount, setCallCount] = useState(1);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isSplitting, setIsSplitting] = useState(false);
  const [isDismissed, setIsDismissed] = useState(note.call_split_dismissed === 1);

  useEffect(() => {
    setIsDismissed(note.call_split_dismissed === 1);
  }, [note.id, note.call_split_dismissed]);

  useEffect(() => {
    setCallCount(1);
    if (note.note_type !== "meeting" || !note.transcript) return;

    let cancelled = false;
    void (async () => {
      const result = await window.electronAPI?.scanNoteCallBoundaries?.(note.id);
      if (!cancelled && result?.success) setCallCount(result.callCount ?? 1);
    })();
    return () => {
      cancelled = true;
    };
  }, [note.id, note.note_type, note.transcript]);

  const handleDismiss = useCallback(() => {
    setIsDismissed(true);
    void window.electronAPI?.dismissNoteCallSplit?.(note.id);
  }, [note.id]);

  const handleSplit = useCallback(async () => {
    setIsSplitting(true);
    try {
      const result = await window.electronAPI?.splitNoteCalls?.(note.id);
      if (result?.success) {
        toast({
          title: t("notes.callSplit.done", { count: (result.childNoteIds?.length ?? 0) + 1 }),
        });
      } else {
        toast({ title: t("notes.callSplit.failed"), variant: "destructive" });
      }
    } finally {
      setIsSplitting(false);
    }
  }, [note.id, t, toast]);

  if (isDismissed || callCount < 2) return null;

  return (
    <div className="mx-5 mt-3 flex items-center gap-2 rounded-md border border-blue-500/30 bg-blue-500/8 px-3 py-2 text-[11px] leading-relaxed text-foreground/70">
      <Scissors size={12} className="shrink-0 text-blue-500/70" />
      <span className="flex-1">{t("notes.callSplit.message", { count: callCount })}</span>
      <button
        className="shrink-0 h-6 px-2 rounded-md bg-foreground/5 hover:bg-foreground/10 text-foreground/70 disabled:opacity-40 disabled:pointer-events-none"
        onClick={() => setConfirmOpen(true)}
        disabled={isSplitting}
      >
        {isSplitting ? t("notes.callSplit.splitting") : t("notes.callSplit.split")}
      </button>
      <button
        className="shrink-0 h-6 px-2 rounded-md text-foreground/50 hover:text-foreground/70"
        onClick={handleDismiss}
      >
        {t("notes.callSplit.dismiss")}
      </button>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t("notes.callSplit.confirmTitle", { count: callCount })}
        description={t("notes.callSplit.confirmDescription")}
        confirmText={t("notes.callSplit.split")}
        cancelText={t("common.cancel")}
        onConfirm={() => void handleSplit()}
        variant="destructive"
      />
    </div>
  );
}
