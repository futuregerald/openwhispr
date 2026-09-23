import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ChevronDown, ChevronRight, Loader2, Plug } from "lucide-react";
import { CopyableCommand } from "./ui/CopyableCommand";
import { LogoTile } from "./ui/LogoTile";
import logo from "../assets/logo.svg";

type McpCommands = {
  read: string;
  readWrite: string;
  fallbackRead: string;
  fallbackReadWrite: string;
  remove: string;
};

const INDEX_POLL_MS = 5000;

export default function McpIntegrationCard() {
  const { t } = useTranslation();
  const [commands, setCommands] = useState<McpCommands | null>(null);
  const [loading, setLoading] = useState(true);
  const [showWrite, setShowWrite] = useState(false);
  const [showFallback, setShowFallback] = useState(false);
  const [pendingNotes, setPendingNotes] = useState(0);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI
      ?.getMcpConfig?.()
      .then((config) => {
        if (cancelled) return;
        setCommands(config?.commands ?? null);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshIndexStatus = useCallback(async () => {
    try {
      const status = await window.electronAPI?.getSearchIndexStatus?.();
      const pending = status?.transcript_segments?.pending_notes ?? 0;
      setPendingNotes(pending);
      return pending;
    } catch {
      setPendingNotes(0);
      return 0;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      const pending = await refreshIndexStatus();
      if (cancelled || pending === 0) return;
      timer = setTimeout(poll, INDEX_POLL_MS);
    };
    poll();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [refreshIndexStatus]);

  return (
    <div className="rounded-lg border border-border/50 dark:border-border-subtle/70 bg-card/50 dark:bg-surface-2/50 backdrop-blur-sm p-4">
      <div className="flex items-center gap-2 mb-4">
        <LogoTile src={logo} alt="OpenWhispr" />
        <div className="w-9 h-9 rounded-lg bg-white dark:bg-surface-raised shadow-[0_0_0_1px_rgba(0,0,0,0.04)] dark:shadow-none dark:border dark:border-white/5 flex items-center justify-center shrink-0">
          <Plug className="w-4 h-4 text-foreground/70" strokeWidth={2} />
        </div>
      </div>

      <h3 className="text-sm font-semibold text-foreground mb-1">{t("integrations.mcp.title")}</h3>
      <p className="text-xs text-muted-foreground/70 mb-4 leading-relaxed">
        {t("integrations.mcp.description")}
      </p>

      {loading && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground/60 mb-3">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t("integrations.mcp.loading")}
        </div>
      )}

      {!loading && !commands && (
        <p className="text-xs text-muted-foreground/70 mb-3">{t("integrations.mcp.unavailable")}</p>
      )}

      {commands && (
        <>
          <div className="mb-3">
            <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50 mb-1.5">
              {t("integrations.mcp.addLabel")}
            </div>
            <CopyableCommand command={commands.read} />
            <p className="text-[11px] text-muted-foreground/60 mt-1.5 leading-relaxed">
              {t("integrations.mcp.requiresNode")}
            </p>
            <p className="text-[11px] text-muted-foreground/60 mt-1 leading-relaxed">
              {t("integrations.mcp.tierNote")}
            </p>
          </div>

          <button
            type="button"
            onClick={() => setShowFallback((open) => !open)}
            className="flex items-center gap-1 text-xs text-muted-foreground/70 hover:text-foreground transition-colors mb-2"
          >
            {showFallback ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            {t("integrations.mcp.noNodeToggle")}
          </button>

          {showFallback && (
            <div className="mb-3">
              <p className="text-[11px] text-muted-foreground/60 mb-1.5 leading-relaxed">
                {t("integrations.mcp.noNodeDescription")}
              </p>
              <CopyableCommand command={commands.fallbackRead} />
            </div>
          )}

          <button
            type="button"
            onClick={() => setShowWrite((open) => !open)}
            className="flex items-center gap-1 text-xs text-muted-foreground/70 hover:text-foreground transition-colors mb-2"
          >
            {showWrite ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            {t("integrations.mcp.writeToggle")}
          </button>

          {showWrite && (
            <div className="mb-3">
              <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 p-2.5 mb-2">
                <AlertTriangle className="h-3.5 w-3.5 text-warning shrink-0 mt-0.5" />
                <p className="text-[11px] text-muted-foreground/80 leading-relaxed">
                  {t("integrations.mcp.writeWarning")}
                </p>
              </div>
              <CopyableCommand command={showFallback ? commands.fallbackReadWrite : commands.readWrite} />
            </div>
          )}

          <div className="mt-4">
            <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50 mb-1.5">
              {t("integrations.mcp.removeLabel")}
            </div>
            <CopyableCommand command={commands.remove} />
          </div>
        </>
      )}

      {pendingNotes > 0 && (
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground/70 mt-4">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t("integrations.mcp.indexBuilding", { count: pendingNotes })}
        </div>
      )}
    </div>
  );
}
