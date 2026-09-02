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
      if (!s.token || !s.server_url) {
        set({ serverUrl: "", token: "", authed: false });
        return;
      }
      // 校验 token 是否仍被服务端认可：用 token 调 /spaces。若 401，说明本地
      // 存的 token 已失效（服务端清理/过期/换账号），不能误显示「已登录」——
      // 否则组织管理等会 401。失效则清空，引导重新登录。
      try {
        await api.teamListSpaces(s.server_url, s.token);
        set({ serverUrl: s.server_url, token: s.token, authed: true });
      } catch {
        // 401 / 网络错：token 不可用，清空。
        set({ serverUrl: "", token: "", authed: false });
      }
    } catch {
      set({ serverUrl: "", token: "", authed: false });
    }
  },
  setSession: (serverUrl, token) => set({ serverUrl, token, authed: !!token }),
  clear: () => set({ serverUrl: "", token: "", authed: false }),
}));
