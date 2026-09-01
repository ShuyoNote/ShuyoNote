import { create } from "zustand";
import { api } from "../lib/api";

// M27 team-edition login state. The session itself lives in meta.db
// (team_login / team_get_session / team_logout); this store mirrors the current
// session so the UI can render logged-in state (About / AccountCenter / SyncPanel)
// and restore it on startup. Token is never put in browser storage.
interface AuthState {
  serverUrl: string;
  token: string;
  authed: boolean;
  /** Restore the session from meta.db (team_get_session) on app start. */
  init: () => Promise<void>;
  /** Record a successful login (teamLogin already persisted the token). */
  setSession: (serverUrl: string, token: string) => void;
  /** Clear after logout (teamLogout already revoked + cleared the session). */
  clear: () => void;
}

export const useAuth = create<AuthState>((set) => ({
  serverUrl: "",
  token: "",
  authed: false,
  init: async () => {
    try {
      const s = await api.teamGetSession();
      set({ serverUrl: s.server_url, token: s.token, authed: !!s.token });
    } catch {
      set({ serverUrl: "", token: "", authed: false });
    }
  },
  setSession: (serverUrl, token) => set({ serverUrl, token, authed: !!token }),
  clear: () => set({ serverUrl: "", token: "", authed: false }),
}));
