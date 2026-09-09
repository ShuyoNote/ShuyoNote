// Near-realtime presence hook (P0.2): heartbeat + fetch who's online.
// Runs only when the active workspace has a bound sync profile (server+space_id)
// AND a server token. Heartbeats every 15s with the current page, and refreshes
// the online snapshot into usePresenceStore so UI can show "who's editing".
import { useEffect } from "react";
import { api } from "../lib/api";
import { useSpaceStore } from "../store/space";
import { useNotes } from "../store/notes";
import { usePresenceStore, type PresenceMember } from "../store/presence";

const HEARTBEAT_MS = 15_000;

export function usePresence() {
  const activeId = useSpaceStore((s) => s.activeId);
  const currentPageId = useNotes((s) => s.currentId);
  const setSnapshot = usePresenceStore((s) => s.setSnapshot);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    const beat = async () => {
      if (!activeId) return;
      try {
        const profiles = await api.listSyncProfiles();
        const profile = profiles.find((p) => p.ws_id === activeId);
        if (!profile || !profile.server_url || !profile.space_id || !profile.token) {
          usePresenceStore.getState().clear();
          return;
        }
        const page = currentPageId ?? null;
        // Heartbeat (best-effort) + fetch online in parallel.
        const [online] = await Promise.all([
          api.teamOnline(profile.server_url, profile.token, profile.space_id).catch(() => [] as PresenceMember[]),
          api.teamPresenceBeat(profile.server_url, profile.token, profile.space_id, page, null).catch(() => null),
        ]);
        if (!cancelled) {
          setSnapshot(profile.space_id, (Array.isArray(online) ? online : []) as PresenceMember[]);
        }
      } catch {
        /* presence is best-effort; ignore */
      }
    };

    beat();
    timer = setInterval(beat, HEARTBEAT_MS);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [activeId, currentPageId, setSnapshot]);
}
