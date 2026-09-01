import { useEffect, useRef } from "react";
import { api } from "../lib/api";
import { useNotes } from "../store/notes";

const AUTO_SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Auto-sync on startup and periodically, when a server is configured.
export function useAutoSync() {
  const { loadPages } = useNotes();
  const syncing = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const syncOnce = async () => {
      if (syncing.current) return;
      try {
        // Gate on per-workspace sync profiles (S8) rather than the legacy global
        // config: a user who set up a profile (server + space) but never set the
        // old get_sync_config should still auto-sync.
        const profiles = await api.listSyncProfiles();
        const anyReady = profiles.some((p) => p.server_url && p.space_id);
        if (!anyReady) return;
        syncing.current = true;
        try {
          await api.syncNow();
          if (!cancelled) await loadPages();
        } finally {
          syncing.current = false;
        }
      } catch (e) {
        console.error("auto sync failed", e);
      }
    };

    // Initial sync shortly after startup.
    const initial = setTimeout(syncOnce, 3000);
    // Periodic sync.
    const interval = setInterval(syncOnce, AUTO_SYNC_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearTimeout(initial);
      clearInterval(interval);
    };
  }, [loadPages]);
}
