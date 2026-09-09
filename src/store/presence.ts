// Near-realtime presence store (P0.2): who's online in the current space and
// which page each is on. The heartbeat/refresh lives in hooks/usePresence.ts;
// this store just holds the snapshot and a tiny pub-sub for components.
import { create } from "zustand";

export interface PresenceMember {
  user_id: string;
  email: string | null;
  page_id: string | null;
  last_seen_at: number;
}

interface PresenceState {
  /** The active space id this presence snapshot is scoped to. */
  spaceId: string | null;
  /** Online members of the current space (within heartbeat window). */
  online: PresenceMember[];
  /** Tracked so components can re-render when the snapshot refreshes. */
  refresh: number;
  setSnapshot: (spaceId: string | null, online: PresenceMember[]) => void;
  clear: () => void;
}

export const usePresenceStore = create<PresenceState>((set) => ({
  spaceId: null,
  online: [],
  refresh: 0,
  setSnapshot: (spaceId, online) =>
    set((s) => ({ spaceId, online, refresh: s.refresh + 1 })),
  clear: () => set({ spaceId: null, online: [], refresh: 0 }),
}));
