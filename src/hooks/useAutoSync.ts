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
        // C2 网络闸门（2026-09-15）：开了「只在 Wi-Fi 下自动同步」时，**非 Wi-Fi 就不自动拉**。
        //
        // ⚠️ 这里只管**自动**同步：手动点「同步」不走这条检查（用户明确要求，就该照做）。
        //
        // ⚠️ 两种"没有 Wi-Fi"必须区别对待（`src-tauri/src/net.rs` 的契约）：
        //   · `"n/a"`（非 Android，闸门**不适用**）⇒ **不拦**；
        //   · 其余非 wifi（cellular/none/other/**unknown**）⇒ **不自动同步**。
        //   把 `unknown`（Android 上真查不到）也算作"不拉"，是因为猜错的代价不对等：
        //   猜成"有 Wi-Fi"而其实是蜂窝 ⇒ 偷偷跑用户流量。**这个方向是刻意选的 fail-safe。**
        const budget = await api.getSyncBudget().catch(() => null);
        if (budget?.wifi_only) {
          const kind = await api.networkType().catch(() => "unknown");
          if (kind !== "n/a" && kind !== "wifi" && kind !== "ethernet") return;
        }
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
