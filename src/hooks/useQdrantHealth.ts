import { useCallback, useEffect, useState } from "react";
import type { QdrantHealth } from "../types/electron";

// Deliberately shorter than useMeetingDetectionHealth's 30s: the manager calls a
// sidecar degraded after 30s without a successful health check, and polling at
// the same period would make the notice appear and clear up to 30s late.
const POLL_MS = 10000;

export function useQdrantHealth(enabled = true) {
  const [health, setHealth] = useState<QdrantHealth | null>(null);
  const [repairing, setRepairing] = useState(false);
  const [repairFailed, setRepairFailed] = useState(false);

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
    setRepairFailed(false);
    try {
      const result = await window.electronAPI?.repairQdrant?.();
      setRepairFailed(!result?.success);
    } catch {
      setRepairFailed(true);
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

  return { health, refresh, repair, repairing, repairFailed };
}
