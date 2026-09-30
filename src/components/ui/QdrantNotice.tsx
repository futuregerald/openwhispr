import { useTranslation } from "react-i18next";
import { AlertCircle } from "lucide-react";
import { Button } from "./button";
import { useQdrantHealth } from "../../hooks/useQdrantHealth";

/**
 * Semantic search failing is silent: the agent quietly falls back to keyword
 * matching and nothing says why the results got worse. This says so, and offers
 * the one action that helps.
 *
 * Deliberately not dismissable, unlike MeetingDetectionNotice: this state is
 * repairable from the notice itself, so dismissing it would hide the fix rather
 * than acknowledge something the user can do nothing about.
 */
export default function QdrantNotice() {
  const { t } = useTranslation();
  const { health, repair, repairing } = useQdrantHealth();

  if (!health?.available || !health.degraded) return null;

  return (
    <div className="max-w-3xl mx-auto w-full mb-3">
      <div className="rounded-lg border border-warning/20 bg-warning/8 dark:bg-warning/10 p-3">
        <div className="flex items-start gap-3">
          <div className="shrink-0 w-8 h-8 rounded-md bg-warning/15 flex items-center justify-center">
            <AlertCircle size={16} className="text-amber-600 dark:text-warning" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-foreground mb-0.5">
              {t("settings.semanticSearch.notice.title")}
            </p>
            <p className="text-xs text-muted-foreground mb-2">
              {t("settings.semanticSearch.notice.description")}
            </p>
            <Button
              variant="default"
              size="sm"
              className="h-7 text-xs"
              onClick={repair}
              disabled={repairing}
            >
              {repairing
                ? t("settings.semanticSearch.notice.repairing")
                : t("settings.semanticSearch.notice.action")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
