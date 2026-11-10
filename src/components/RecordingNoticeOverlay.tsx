import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";

type RecordingNoticeData =
  | { kind: "cap-warning"; endsAt: number }
  | { kind: "call-ended"; noteId: number | null; until: number };

const MONO_FONT = "ui-monospace, SFMono-Regular, Menlo, monospace";

function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export default function RecordingNoticeOverlay() {
  const { t } = useTranslation();
  const [data, setData] = useState<RecordingNoticeData | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [hasResponded, setHasResponded] = useState(false);

  useEffect(() => {
    let shown = false;

    const show = (incoming: RecordingNoticeData) => {
      if (shown) return;
      shown = true;
      setData(incoming);
      setNow(Date.now());
      setTimeout(() => {
        setIsVisible(true);
        window.electronAPI?.recordingNoticeReady?.();
      }, 50);
    };

    const cleanup = window.electronAPI?.onRecordingNoticeData?.(show);

    window.electronAPI?.getRecordingNoticeData?.().then((pulled) => {
      if (pulled) show(pulled);
    });

    return () => cleanup?.();
  }, []);

  useEffect(() => {
    if (!data) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [data]);

  const respond = useCallback(
    (action: "keep" | "stop" | "resume" | "dismiss") => {
      if (hasResponded) return;
      setHasResponded(true);
      window.electronAPI?.recordingNoticeRespond?.(action);
    },
    [hasResponded]
  );

  const primaryButtonClass =
    "bg-warning text-[#17171a] hover:brightness-110 active:brightness-95 disabled:opacity-40 disabled:pointer-events-none text-[14px] font-semibold px-3 py-1.5 rounded-md transition";
  const secondaryButtonClass =
    "border border-white/30 text-white hover:bg-white/10 active:bg-white/20 disabled:opacity-40 disabled:pointer-events-none text-[14px] font-medium px-3 py-1.5 rounded-md transition-colors";

  const resumeExpired = data?.kind === "call-ended" && now >= data.until;

  return (
    <div className="meeting-notification-window w-full h-full bg-transparent p-3">
      <div
        className={[
          "bg-[#17171a] text-white border border-white/15 rounded-xl shadow-lg px-3 py-2.5",
          "transition-all duration-300 ease-out",
          isVisible
            ? "translate-x-0 opacity-100 scale-100"
            : "translate-x-[120%] opacity-0 scale-95",
        ].join(" ")}
      >
        {data?.kind === "cap-warning" && (
          <div className="flex flex-col gap-2">
            <p
              className="text-[14px] font-semibold uppercase tracking-wider text-warning leading-tight"
              style={{ fontFamily: MONO_FONT }}
            >
              {t("recordingNotice.capTitle", { time: formatCountdown(data.endsAt - now) })}
            </p>
            <div className="flex items-center gap-2">
              <button onClick={() => respond("keep")} className={primaryButtonClass}>
                {t("recordingNotice.keep")}
                <span className="ml-1.5 text-[12px] font-medium" style={{ fontFamily: MONO_FONT }}>
                  {t("recordingNotice.keepHint")}
                </span>
              </button>
              <button onClick={() => respond("stop")} className={secondaryButtonClass}>
                {t("recordingNotice.stop")}
              </button>
            </div>
          </div>
        )}

        {data?.kind === "call-ended" && (
          <div className="flex items-center justify-between gap-3">
            <p
              className="text-[14px] font-semibold text-warning leading-tight"
              style={{ fontFamily: MONO_FONT }}
            >
              {t("recordingNotice.callEnded")}
            </p>
            <button
              onClick={() => respond("resume")}
              disabled={resumeExpired}
              className={primaryButtonClass}
            >
              {t("recordingNotice.resume")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
