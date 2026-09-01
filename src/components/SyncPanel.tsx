import { useEffect, useState } from "react";
import { usePopover } from "../hooks/usePopover";
import { api, type SyncProfile } from "../lib/api";
import { isDesktopPlatform } from "../lib/platform";
import { useSpaceStore } from "../store/space";
import { useNotes } from "../store/notes";
import { SyncIcon } from "./icons";

interface ServerSpace {
  id: string;
  name: string;
  role: string;
  owner_id: string;
}

interface ServerMember {
  user_id: string;
  email: string;
  role: string;
}

interface EditRow {
  ws_id: string;
  name: string;
  server_url: string;
  token: string;
  space_id: string;
  // Login-to-get-token (U3): email/password are transient (never persisted); the
  // resulting token fills `token`. `remoteSpaces` caches the spaces the account
  // joined (from GET /spaces) so the 空间 ID 可以下拉绑定.
  loginEmail: string;
  loginPassword: string;
  remoteSpaces: ServerSpace[];
  // M27 成员管理（选中空间且已登录后可用）：members 列表 + 邀请表单。
  members: ServerMember[];
  memberOpen: boolean;
  inviteEmail: string;
  inviteRole: string;
}

// Per-workspace sync targets (S8): each local workspace binds to its own remote
// (server + token + space_id), so one person can sync different spaces to
// different servers/accounts (multi-server × multi-space).
export function SyncPanel() {
  const { loadPages } = useNotes();
  const { open, pos, triggerRef, contentRef, toggle } = usePopover<HTMLButtonElement>();
  const spaces = useSpaceStore((s) => s.spaces);
  const [rows, setRows] = useState<EditRow[]>([]);
  const [status, setStatus] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);

  const refresh = async () => {
    try {
      const profiles = await api.listSyncProfiles();
      const name = new Map(spaces.map((s) => [s.id, s.name]));
      const allIds = new Set<string>([...spaces.map((s) => s.id), ...profiles.map((p) => p.ws_id)]);
      const byWs = new Map<string, SyncProfile>(profiles.map((p) => [p.ws_id, p]));
      setRows(
        Array.from(allIds).map((id) => {
          const p = byWs.get(id);
          return {
            ws_id: id,
            name: name.get(id) ?? id,
            server_url: p?.server_url ?? "",
            token: p?.token ?? "",
            space_id: p?.space_id ?? "",
            loginEmail: "",
            loginPassword: "",
            remoteSpaces: [],
            members: [],
            memberOpen: false,
            inviteEmail: "",
            inviteRole: "editor",
          };
        }),
      );
    } catch (e) {
      setStatus(String(e));
    }
  };

  useEffect(() => {
    if (open) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const save = async (r: EditRow) => {
    try {
      await api.setSyncProfile(r.ws_id, { server_url: r.server_url, token: r.token || undefined, space_id: r.space_id || undefined });
      setStatus(`已保存「${r.name}」`);
    } catch (e) {
      setStatus(String(e));
    }
  };

  const syncOne = async (r: EditRow) => {
    if (!r.server_url) { setStatus("请先填服务器地址"); return; }
    setSyncing(true);
    setStatus("");
    try {
      const res = await api.syncWorkspace(r.ws_id);
      setStatus(`「${r.name}」同步完成：上传 ${res.pushed} / 拉取 ${res.pulled}`);
      await loadPages();
    } catch (e) {
      setStatus(`「${r.name}」同步失败：${e}`);
    } finally {
      setSyncing(false);
    }
  };

  const syncAll = async () => {
    setSyncing(true);
    setStatus("");
    try {
      const results = await api.syncNow();
      const ok = results.filter((r) => !r.error).length;
      const fail = results.filter((r) => r.error).length;
      setStatus(`同步全部：完成 ${ok} 个${fail ? `，失败 ${fail} 个` : ""}`);
      await loadPages();
    } catch (e) {
      setStatus(`同步失败：${e}`);
    } finally {
      setSyncing(false);
    }
  };

  const update = (ws_id: string, field: keyof EditRow, value: string) =>
    setRows((rs) => rs.map((r) => (r.ws_id === ws_id ? { ...r, [field]: value } : r)));

  const login = async (r: EditRow) => {
    const base = r.server_url.trim().replace(/\/+$/, "");
    if (!base) { setStatus("请先填服务器地址"); return; }
    if (!r.loginEmail.trim() || !r.loginPassword) { setStatus("请输入邮箱和密码"); return; }
    setLoggingIn(true);
    setStatus("");
    try {
      // 走 Rust 代理命令（绕 WebView2 CORS）：服务端无 CORS 层，前端 fetch 会被拦。
      const { token } = await api.teamLogin(base, r.loginEmail.trim(), r.loginPassword);
      if (!token) throw new Error("服务器未返回 token");
      // 空间列表拉取失败不阻断登录：token 先填入，列表尽力而为。
      const list = await api.teamListSpaces(base, token).catch(() => [] as ServerSpace[]);
      setRows((rs) =>
        rs.map((x) => (x.ws_id === r.ws_id ? { ...x, token, loginPassword: "", remoteSpaces: list } : x)),
      );
      setStatus(`登录成功「${r.name}」，绑定 ${list.length} 个空间`);
    } catch (e) {
      setStatus(`登录失败：${e}`);
    } finally {
      setLoggingIn(false);
    }
  };

  // ---- M27 成员管理 handlers ----
  const toggleMembers = (r: EditRow) => {
    setRows((rs) => rs.map((x) => (x.ws_id === r.ws_id ? { ...x, memberOpen: !x.memberOpen } : x)));
    if (!r.memberOpen && r.space_id && r.token) void loadMembers(r);
  };

  const loadMembers = async (r: EditRow) => {
    const base = r.server_url.trim().replace(/\/+$/, "");
    if (!base || !r.space_id || !r.token) { setStatus("请先登录并绑定空间"); return; }
    setStatus("");
    try {
      const members = await api.teamListMembers(base, r.token, r.space_id);
      setRows((rs) => rs.map((x) => (x.ws_id === r.ws_id ? { ...x, members } : x)));
    } catch (e) {
      setStatus(`成员拉取失败：${e}`);
    }
  };

  const inviteMember = async (r: EditRow) => {
    const base = r.server_url.trim().replace(/\/+$/, "");
    if (!base || !r.space_id || !r.token) { setStatus("请先登录并绑定空间"); return; }
    if (!r.inviteEmail.trim()) { setStatus("请输入被邀请者邮箱"); return; }
    setStatus("");
    const email = r.inviteEmail.trim();
    const role = r.inviteRole;
    try {
      await api.teamInviteMember(base, r.token, r.space_id, email, role);
      await loadMembers({ ...r, inviteEmail: "" });
      setStatus(`已邀请 ${email}`);
    } catch (e) {
      setStatus(`邀请失败：${e}`);
    }
  };

  const removeMember = async (r: EditRow, userId: string) => {
    const base = r.server_url.trim().replace(/\/+$/, "");
    try {
      await api.teamRemoveMember(base, r.token, r.space_id, userId);
      await loadMembers(r);
      setStatus("已移除成员");
    } catch (e) {
      setStatus(`移除失败：${e}`);
    }
  };

  const setMemberRole = async (r: EditRow, email: string, role: string) => {
    const base = r.server_url.trim().replace(/\/+$/, "");
    try {
      await api.teamSetMemberRole(base, r.token, r.space_id, email, role);
      await loadMembers(r);
      setStatus("已更新角色");
    } catch (e) {
      setStatus(`更新角色失败：${e}`);
    }
  };

  return (
    <div className="sync-panel">
      <button ref={triggerRef} className="btn-sync" onClick={toggle} title="同步设置">
        <SyncIcon />
      </button>
      {open && (
        <div ref={contentRef} className="sync-popover" style={{ top: pos.top, left: pos.left }}>
          <div className="sync-title">每空间同步目标</div>
          {!isDesktopPlatform() && (
            <div className="sync-web-note">Web 版不支持多设备同步，请在桌面版配置。</div>
          )}
          <div className="sync-profiles">
            {rows.map((r) => (
              <div key={r.ws_id} className="sync-profile">
                <div className="sync-profile-name">{r.name}</div>
                <div className="sync-row">
                  <label>服务器</label>
                  <input value={r.server_url} placeholder="http://localhost:8787" onChange={(e) => update(r.ws_id, "server_url", e.target.value)} />
                </div>
                <div className="sync-row sync-login-row">
                  <label>账号（登录拿 token）</label>
                  <div className="sync-login-fields">
                    <input value={r.loginEmail} placeholder="邮箱" onChange={(e) => update(r.ws_id, "loginEmail", e.target.value)} />
                    <input type="password" value={r.loginPassword} placeholder="密码" onChange={(e) => update(r.ws_id, "loginPassword", e.target.value)} />
                  </div>
                  <button className="sync-login-btn" disabled={loggingIn || !r.server_url} onClick={() => login(r)}>
                    {loggingIn ? "登录中…" : "登录"}
                  </button>
                </div>
                <div className="sync-row">
                  <label>令牌（{r.token ? "✓ 已获取" : "尚未获取"}）</label>
                  <input type="password" value={r.token} placeholder="团队 token" onChange={(e) => update(r.ws_id, "token", e.target.value)} />
                </div>
                <div className="sync-row">
                  <label>空间 ID</label>
                  {r.remoteSpaces.length > 0 ? (
                    <select value={r.space_id} onChange={(e) => update(r.ws_id, "space_id", e.target.value)}>
                      <option value="">选择我加入的空间…</option>
                      {r.remoteSpaces.map((sp) => (
                        <option key={sp.id} value={sp.id}>
                          {sp.name}（{sp.role}）
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input value={r.space_id} placeholder="团队空间 id（留空=旧单用户）" onChange={(e) => update(r.ws_id, "space_id", e.target.value)} />
                  )}
                </div>
                {r.space_id && r.token && (
                  <div className="sync-row sync-members-row">
                    <button className="sync-members-toggle" onClick={() => toggleMembers(r)}>
                      {r.memberOpen ? "收起成员" : "成员管理"}
                    </button>
                    {r.memberOpen && (
                      <div className="sync-members">
                        <div className="sync-members-list">
                          {r.members.length === 0 ? (
                            <span className="sync-members-empty">（无成员）</span>
                          ) : (
                            r.members.map((m) => (
                              <div key={m.user_id} className="sync-member">
                                <span className="sync-member-email">{m.email}</span>
                                <select className="sync-member-role" value={m.role} onChange={(e) => void setMemberRole(r, m.email, e.target.value)}>
                                  <option value="viewer">viewer</option>
                                  <option value="editor">editor</option>
                                  <option value="admin">admin</option>
                                </select>
                                <button className="sync-member-remove" title="移除" onClick={() => void removeMember(r, m.user_id)}>✕</button>
                              </div>
                            ))
                          )}
                        </div>
                        <div className="sync-members-invite">
                          <input value={r.inviteEmail} placeholder="被邀请者邮箱" onChange={(e) => update(r.ws_id, "inviteEmail", e.target.value)} />
                          <select value={r.inviteRole} onChange={(e) => update(r.ws_id, "inviteRole", e.target.value)}>
                            <option value="viewer">viewer</option>
                            <option value="editor">editor</option>
                            <option value="admin">admin</option>
                          </select>
                          <button onClick={() => void inviteMember(r)}>邀请</button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
                <div className="sync-profile-actions">
                  <button onClick={() => save(r)}>保存</button>
                  <button disabled={syncing || !r.server_url} onClick={() => syncOne(r)}>
                    {syncing ? "同步中…" : "同步"}
                  </button>
                </div>
              </div>
            ))}
          </div>
          {status && <div className="sync-status">{status}</div>}
          <div className="sync-actions">
            <button onClick={syncAll} disabled={syncing}>同步全部</button>
          </div>
        </div>
      )}
    </div>
  );
}


