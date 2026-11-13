import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { SkipForward, Square } from "lucide-react";
import { cn } from "../lib/utils";
import { useMeetingRecordingStore, addMarker } from "../../stores/meetingRecordingStore";
import { deckTracks, formatElapsed, markerKeyState } from "../../helpers/recorderDeck";

const READOUT = "font-[family-name:var(--font-family-readout)] font-medium tabular-nums";

const KEY_BASE = cn(
  "inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-lg text-[11px] font-semibold",
  "uppercase tracking-wider border select-none cursor-pointer",
  "transition-colors duration-150 outline-none",
  "focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-1 focus-visible:ring-offset-background",
  "disabled:opacity-40 disabled:cursor-not-allowed"
);

export default function RecorderDeck({ onStop }: { onStop: () => void }) {
  const { t, i18n } = useTranslation();
  const startedAt = useMeetingRecordingStore((s) => s.recordingStartedAt);
  const markerTimes = useMeetingRecordingStore((s) => s.markerTimes);
  const isMarking = useMeetingRecordingStore((s) => s.isMarking);
  const markerRefusal = useMeetingRecordingStore((s) => s.markerRefusal);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const tracks = deckTracks(startedAt, markerTimes);
  const nextKey = markerKeyState({
    isMarking,
    markCount: markerTimes.length,
    lastMarkAtMs: markerTimes.length > 0 ? markerTimes[markerTimes.length - 1] : null,
    nowMs,
  });
  const nextDisabled = !nextKey.enabled || startedAt == null;

  const clock = (ms: number) =>
    new Date(ms).toLocaleTimeString(i18n.language, { hour: "2-digit", minute: "2-digit" });

  const hintKey = markerRefusal
    ? `notes.recorderDeck.refused.${markerRefusal}`
    : nextKey.reason === "limit-reached" || nextKey.reason === "too-soon"
      ? `notes.recorderDeck.refused.${nextKey.reason}`
      : null;

  return (
    <div
      role="group"
      aria-label={t("notes.recorderDeck.label")}
      className={cn(
        "mb-2 rounded-xl border border-border/30 dark:border-white/8 bg-surface-2/80",
        "px-3 py-2.5 pointer-events-auto"
      )}
    >
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2 shrink-0">
          <span
            aria-hidden="true"
            className="size-2 rounded-full bg-warning animate-pulse motion-reduce:animate-none"
          />
          <span className="text-[11px] font-semibold uppercase tracking-wider text-foreground/70">
            {t("notes.recorderDeck.rec")}
          </span>
          <span
            className={cn(READOUT, "text-[15px] text-foreground/90")}
            role="timer"
            aria-label={t("notes.recorderDeck.elapsed")}
          >
            {formatElapsed(startedAt == null ? 0 : nowMs - startedAt)}
          </span>
        </div>

        <div className="flex-1" />

        <button
          type="button"
          onClick={() => void addMarker()}
          disabled={nextDisabled}
          aria-describedby={hintKey ? "recorder-deck-hint" : undefined}
          title={t("notes.recorderDeck.nextHint")}
          className={cn(
            KEY_BASE,
            "border-warning/50 bg-foreground/4 text-foreground/80 hover:bg-foreground/8",
            "shadow-[inset_0_-2px_0_0_var(--color-warning)]"
          )}
        >
          <SkipForward size={12} aria-hidden="true" />
          {t("notes.recorderDeck.next")}
        </button>

        <button
          type="button"
          onClick={onStop}
          className={cn(
            KEY_BASE,
            "border-border/40 dark:border-white/10 bg-foreground/4 text-foreground/80 hover:bg-foreground/8"
          )}
        >
          <Square size={10} fill="currentColor" aria-hidden="true" />
          {t("notes.recorderDeck.stop")}
        </button>
      </div>

      <ol
        aria-live="polite"
        aria-label={t("notes.recorderDeck.tracks")}
        className="mt-2 flex max-h-16 flex-wrap gap-x-4 gap-y-0.5 overflow-y-auto"
      >
        {tracks.map((track) => (
          <li key={track.number} className={cn(READOUT, "text-[11px] text-foreground/60")}>
            <span className="text-foreground/40">{track.number}</span> {clock(track.startsAtMs)}
            {"–"}
            {track.endsAtMs != null ? clock(track.endsAtMs) : ""}
          </li>
        ))}
      </ol>

      <p
        id="recorder-deck-hint"
        role="status"
        aria-live="polite"
        className="mt-1 text-[11px] text-muted-foreground empty:hidden"
      >
        {hintKey ? t(hintKey) : null}
      </p>
    </div>
  );
}
