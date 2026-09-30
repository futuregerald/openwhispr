import { useCallback, useEffect, useState } from "react";
import type { QdrantHealth } from "../types/electron";

// Deliberately shorter than useMeetingDetectionHealth's 30s: the manager calls a
// sidecar degraded after 30s without a successful health check, and polling at
// the same period would make the notice appear and clear up to 30s late.
const POLL_MS = 10000;

/**
 * Reads the main process's view of whether the semantic-search sidecar is
 * working. Polled rather than pushed, for the same reason as detection health:
 * the interesting state persists, and a sidecar going quiet is exactly what a
 * push would miss.
 */
export function useQdrantHealth(enabled = true) {
  const [health, setHealth] = useState<QdrantHealth | null>(null);
  const [repairing, setRepairing] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await window.electronAPI?.getQdrantHealth?.();
      setHealth(next ?? null);
    } catch {
      setHealth(null);
    }
  }, []);

  const repair = useCallback(async () => {
    setRepairing(true);
    try {
      await window.electronAPI?.repairQdrant?.();
    } finally {
      setRepairing(false);
      await refresh();
    }
  }, [refresh]);

  useEffect(() => {
    if (!enabled) return;
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [enabled, refresh]);

  return { health, refresh, repair, repairing };
}
