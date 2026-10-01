import { useTranslation } from "react-i18next";
import { AlertCircle } from "lucide-react";
import { Button } from "./button";
import { useQdrantHealth } from "../../hooks/useQdrantHealth";

export default function QdrantNotice() {
  const { t } = useTranslation();
  const { health, repair, repairing, repairFailed } = useQdrantHealth();

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
              {repairFailed
                ? t("settings.semanticSearch.notice.repairFailed")
                : t("settings.semanticSearch.notice.description")}
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
