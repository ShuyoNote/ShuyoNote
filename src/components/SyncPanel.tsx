import { useEffect, useState } from "react";
import { usePopover } from "../hooks/usePopover";
import { api, type SyncProfile } from "../lib/api";
import { isDesktopPlatform } from "../lib/platform";
import { useSpaceStore } from "../store/space";
import { useAuth } from "../store/auth";
import { useNotes } from "../store/notes";
import { CloudSyncIcon } from "./icons";

const ENTITY_LABELS: Record<string, string> = {
  page: "页面",
  database: "数据库",
  attachment: "附件",
  block: "块",
};
const entityLabel = (e: string) => ENTITY_LABELS[e] || e || "项";

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
  // 面板比默认弹层宽/高，把实际尺寸告诉 usePopover，靠边打开时才不会被切掉。
  const { open, pos, triggerRef, contentRef, toggle } = usePopover<HTMLButtonElement>({
    width: 452,
    minSpace: 420,
  });
  const spaces = useSpaceStore((s) => s.spaces);
  const activeId = useSpaceStore((s) => s.activeId);
  const authed = useAuth((s) => s.authed);
  const authEmail = useAuth((s) => s.email);
  const [rows, setRows] = useState<EditRow[]>([]);
  const [status, setStatus] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const [history, setHistory] = useState<{ ws_id: string; at: number; pushed: number; pulled: number; ok: boolean; message: string; items: { entity: string; entity_id: string; op: string; dir: string }[] }[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [detailOpenIdx, setDetailOpenIdx] = useState<number | null>(null);

  const refresh = async () => {
    try {
      const profiles = await api.listSyncProfiles();
      const name = new Map(spaces.map((s) => [s.id, s.name]));
      // 已删除的工作空间不该在这里露出（否则只剩一行裸 UUID）。后端已按
      // meta.workspaces 过滤，这里再挡一层：空间列表已加载时，只认识得出名字的
      // 空间；列表尚未加载（首帧）时退回并集，避免面板空白。
      // 只显示当前活动空间：打开同步面板聚焦当前正在用的空间，而不是列出所有。
      // 当 activeId 存在时只取它；无活动空间（首帧）退回并集避免空白。
      let ids: string[];
      if (activeId) {
        ids = [activeId];
      } else {
        const known = spaces.length > 0;
        const profileIds = profiles.map((p) => p.ws_id).filter((id) => !known || name.has(id));
        ids = Array.from(new Set([...spaces.map((s) => s.id), ...profileIds]));
      }
      const byWs = new Map<string, SyncProfile>(profiles.map((p) => [p.ws_id, p]));
      // 同步/保存过（有 server_url）的空间，默认填入上次登录的邮箱。
      const serverEmail = new Map<string, string>();
      // 已绑定空间的可选项（remoteSpaces）：有 token 时拉取，保证 space_id 能
      // 匹配到名称显示下拉（否则刷新后变回手填裸 id）。
      const remoteByServer = new Map<string, ServerSpace[]>();
      for (const id of ids) {
        const p = byWs.get(id);
        const sv = p?.server_url;
        if (sv && !serverEmail.has(sv) && !remoteByServer.has(sv)) {
          const em = await api.teamGetServerEmail(sv).catch(() => "");
          if (em) serverEmail.set(sv, em);
          if (p?.token) {
            const list = await api.teamListSpaces(sv, p.token).catch(() => [] as ServerSpace[]);
            remoteByServer.set(sv, list);
          }
        }
      }
      setRows(
        ids.map((id) => {
          const p = byWs.get(id);
          return {
            ws_id: id,
            name: name.get(id) ?? id,
            server_url: p?.server_url ?? "",
            token: p?.token ?? "",
            space_id: p?.space_id ?? "",
            // 有 server_url 时预填上次登录邮箱；否则空。
            loginEmail: p?.server_url ? (serverEmail.get(p.server_url) ?? "") : "",
            loginPassword: "",
            remoteSpaces: p?.server_url ? (remoteByServer.get(p.server_url) ?? []) : [],
            members: [],
            memberOpen: false,
            inviteEmail: "",
            inviteRole: "editor",
          };
        }),
      );
      await loadHistory();
    } catch (e) {
      setStatus(String(e));
    }
  };

  // 同步历史（最新 15 条）。
  const loadHistory = async () => {
    try {
      const h = await api.listSyncHistory(15).catch(() => [] as { ws_id: string; at: number; pushed: number; pulled: number; ok: boolean; message: string; items: { entity: string; entity_id: string; op: string; dir: string }[] }[]);
      if (h.length) setHistory(h);
    } catch (e) {
      setStatus(String(e));
    }
  };

  useEffect(() => {
    if (open) void refresh();
    // 打开面板 / 切换活动空间 / 空间列表变化时，都刷新到当前活动空间。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activeId, spaces]);

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
      await loadHistory();
    } catch (e) {
      setStatus(`「${r.name}」同步失败：${e}`);
    } finally {
      setSyncing(false);
    }
  };

  const update = (ws_id: string, field: keyof EditRow, value: string) =>
    setRows((rs) => rs.map((r) => (r.ws_id === ws_id ? { ...r, [field]: value } : r)));

  // 登录与注册共用的收尾：token 落到该行 + auth store + **落盘**，并尽力拉一次
  // 空间列表（列表失败不回滚会话——token 已有效，用户仍可手填空间 id）。
  //
  // 自动保存是必须的：此前登录只把 token 放进面板的临时 state，用户不点「保存」
  // 就关掉面板等于白登一次——而「刚登录完还要再点保存」本身就不该存在。
  // 同服务器其它空间的绑定指向旧账号 token：登录（换账号）后统一覆盖为当前 token，
  // 避免残留旧账号会话导致 401/数据错乱。保留各自 server_url。
  const cleanOtherServerTokens = async (base: string, token: string) => {
    const profiles = await api.listSyncProfiles();
    const target = profiles.filter((p) => p.server_url === base);
    for (const p of target) {
      await api.setSyncProfile(p.ws_id, { server_url: base, token, space_id: p.space_id }).catch(() => {});
    }
  };

  const applySession = async (r: EditRow, base: string, token: string, what: string) => {
    const list = await api.teamListSpaces(base, token).catch(() => [] as ServerSpace[]);
    setRows((rs) =>
      rs.map((x) => (x.ws_id === r.ws_id ? { ...x, server_url: base, token, loginPassword: "", remoteSpaces: list } : x)),
    );
    useAuth.getState().setSession(base, token, r.loginEmail?.trim());
    let saved = true;
    try {
      await api.setSyncProfile(r.ws_id, {
        server_url: base,
        token,
        space_id: r.space_id || undefined,
      });
    } catch (e) {
      saved = false;
      console.error("auto-save sync profile failed", e);
    }
    // 同服务器其它空间的绑定指向旧账号 token：登录（换账号）后统一覆盖为当前 token，
    // 避免残留旧账号的会话导致 401/数据错乱（这也是之前 401 的同类根源）。
    // 保留各自 server_url，仅更新 token/space。
    await cleanOtherServerTokens(base, token).catch((e) => console.error("clean other sync tokens failed", e));
    setStatus(
      saved
        ? `${what}成功「${r.name}」，已保存${list.length ? `，可选空间 ${list.length} 个` : ""}`
        : `${what}成功，但保存失败——请手动点「保存」`,
    );
  };

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
      await applySession(r, base, token, "登录");
    } catch (e) {
      const msg = String(e);
      setStatus(
        msg.includes("401") ? "登录失败：邮箱或密码不对（没有账号请先「注册」）" : `登录失败：${msg}`,
      );
    } finally {
      setLoggingIn(false);
    }
  };

  // 注册：在该服务器开新账号。服务端 /auth/register 成功后直接下发会话 token，
  // 所以注册即登录，不需要再点一次登录。密码规则与服务端一致（≥8 位）。
  const register = async (r: EditRow) => {
    const base = r.server_url.trim().replace(/\/+$/, "");
    if (!base) { setStatus("请先填服务器地址"); return; }
    if (!r.loginEmail.trim() || !r.loginPassword) { setStatus("请输入邮箱和密码"); return; }
    if (r.loginPassword.length < 8) { setStatus("注册失败：密码至少 8 位"); return; }
    setLoggingIn(true);
    setStatus("");
    try {
      const { token } = await api.teamRegister(base, r.loginEmail.trim(), r.loginPassword, null);
      if (!token) throw new Error("服务器未返回 token");
      await applySession(r, base, token, "注册");
    } catch (e) {
      const msg = String(e);
      setStatus(
        msg.includes("409") ? "注册失败：该邮箱已注册，请直接「登录」" : `注册失败：${msg}`,
      );
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

  const logout = async (r: EditRow) => {
    const base = r.server_url.trim().replace(/\/+$/, "");
    setStatus("");
    try {
      await api.teamLogout(base);
      setRows((rs) =>
        rs.map((x) => (x.ws_id === r.ws_id ? { ...x, token: "", space_id: "", remoteSpaces: [], members: [], memberOpen: false } : x)),
      );
      useAuth.getState().clear();
      // 同样要落盘：否则重开面板时 refresh() 会把旧 token 从库里读回来，
      // 看起来像「登出了又自己登回去」。
      await api.setSyncProfile(r.ws_id, { server_url: base }).catch((e) => {
        console.error("clear sync profile failed", e);
      });
      setStatus("已登出");
    } catch (e) {
      setStatus(`登出失败：${e}`);
    }
  };

  // 选中空间即落盘：与登录同理——「选完还要再点保存」是多余的一步，
  // 忘了点就等于没绑。手填服务器地址/令牌仍走「保存」按钮。
  const pickSpace = async (r: EditRow, spaceId: string) => {
    update(r.ws_id, "space_id", spaceId);
    const base = r.server_url.trim().replace(/\/+$/, "");
    if (!base) return;
    try {
      await api.setSyncProfile(r.ws_id, {
        server_url: base,
        token: r.token || undefined,
        space_id: spaceId || undefined,
      });
      const name = r.remoteSpaces.find((x) => x.id === spaceId)?.name;
      setStatus(spaceId ? `已绑定空间「${name ?? spaceId}」` : "已解除空间绑定");
    } catch (e) {
      setStatus(`保存失败：${e}`);
    }
  };

  // 当前用户在该绑定空间的角色是否可管理成员（admin/owner）。viewer/editor 只读。
  const canManageSpace = (r: EditRow): boolean => {
    const role = r.remoteSpaces.find((x) => x.id === r.space_id)?.role ?? "";
    return role === "admin" || role === "owner";
  };

  // 状态条只有一行文案，按语义上色：失败=红、提示性前置条件=黄、其余=绿。
  const statusKind = (s: string): "ok" | "err" | "warn" =>
    /失败|错误|不支持|不存在|无效/.test(s) ? "err" : /^请/.test(s) ? "warn" : "ok";

  const roleClass = (role: string) =>
    ["owner", "admin", "editor", "viewer"].includes(role) ? `role-${role}` : "role-viewer";

  const initial = (s: string) => (s.trim()[0] ?? "?").toUpperCase();

  return (
    <div className="sync-panel">
      <button ref={triggerRef} className="btn-sync" onClick={toggle} title="同步设置">
        <CloudSyncIcon width={14} height={14} />
        <span>同步</span>
      </button>
      {open && (
        <div
          ref={contentRef}
          className="sync-popover is-sync"
          style={{ top: pos.top, left: pos.left }}
          role="dialog"
          aria-label="同步设置"
        >
          <header className="sync-head">
            <div className="sync-head-text">
              <div className="sync-title">同步</div>
              <div className="sync-subtitle">每个空间各自绑定服务器与团队空间</div>
            </div>
            <span className={`sync-chip${authed ? " is-on" : ""}`}>{authed ? "已登录" : "未登录"}</span>
          </header>

          {!isDesktopPlatform() && (
            <div className="sync-web-note">
              <b>Web 版不支持多设备同步</b>
              <span>笔记存在本浏览器里；要多设备同步请用桌面版。</span>
            </div>
          )}

          <div className="sync-profiles">
            {rows.length === 0 && <div className="sync-empty-state">还没有可配置的空间</div>}
            {rows.map((r) => {
              const myRole = r.remoteSpaces.find((x) => x.id === r.space_id)?.role ?? "";
              const state = r.server_url && r.space_id ? "bound" : r.server_url ? "partial" : "none";
              return (
                <section key={r.ws_id} className="sync-card">
                  <div className="sync-card-head">
                    <span className="sync-card-avatar" aria-hidden>{initial(r.name)}</span>
                    <span className="sync-card-name" title={r.name}>{r.name}</span>
                    <span className={`sync-state is-${state}`}>
                      {state === "bound" ? "已绑定" : state === "partial" ? "待选空间" : "未配置"}
                    </span>
                  </div>

                  <div className="sync-field">
                    <label htmlFor={`sync-srv-${r.ws_id}`}>服务器</label>
                    <input
                      id={`sync-srv-${r.ws_id}`}
                      className="sync-input"
                      value={r.server_url}
                      placeholder="http://localhost:8787"
                      onChange={(e) => update(r.ws_id, "server_url", e.target.value)}
                    />
                  </div>

                  {/* 已拿到令牌就不再堆登录表单——只留一枚「已登录」胶囊 + 登出。 */}
                  {r.token ? (
                    <div className="sync-account">
                      <span className="sync-account-dot" aria-hidden />
                      <div className="sync-account-text">
                        <b>{authEmail || "已登录"}</b>
                        <span title={r.server_url}>{r.server_url || "—"}</span>
                      </div>
                      <button className="sync-btn ghost" onClick={() => void logout(r)}>登出</button>
                    </div>
                  ) : (
                    <div className="sync-field">
                      <label htmlFor={`sync-mail-${r.ws_id}`}>账号</label>
                      <div className="sync-auth-grid">
                        <input
                          id={`sync-mail-${r.ws_id}`}
                          className="sync-input"
                          value={r.loginEmail}
                          placeholder="邮箱"
                          autoComplete="username"
                          onChange={(e) => update(r.ws_id, "loginEmail", e.target.value)}
                        />
                        <input
                          className="sync-input"
                          type="password"
                          value={r.loginPassword}
                          placeholder="密码"
                          autoComplete="current-password"
                          onChange={(e) => update(r.ws_id, "loginPassword", e.target.value)}
                        />
                      </div>
                      <div className="sync-auth-btns">
                        <button className="sync-btn primary" disabled={loggingIn || !r.server_url} onClick={() => login(r)}>
                          {loggingIn ? "处理中…" : "登录"}
                        </button>
                        <button className="sync-btn" disabled={loggingIn || !r.server_url} onClick={() => register(r)}>
                          注册
                        </button>
                      </div>
                      <p className="sync-hint">首次使用点「注册」，密码 ≥8 位，注册成功即自动登录。</p>
                    </div>
                  )}

                  <div className="sync-field">
                    <label htmlFor={`sync-space-${r.ws_id}`}>团队空间</label>
                    {r.remoteSpaces.length > 0 ? (
                      <div className="sync-space-row">
                        <select
                          id={`sync-space-${r.ws_id}`}
                          className="sync-input"
                          value={r.space_id}
                          onChange={(e) => void pickSpace(r, e.target.value)}
                        >
                          <option value="">选择我加入的空间…</option>
                          {r.remoteSpaces.map((sp) => (
                            <option key={sp.id} value={sp.id}>{sp.name}</option>
                          ))}
                        </select>
                        {myRole && <span className={`sync-role ${roleClass(myRole)}`}>{myRole}</span>}
                      </div>
                    ) : (
                      <input
                        id={`sync-space-${r.ws_id}`}
                        className="sync-input"
                        value={r.space_id}
                        placeholder="团队空间 id（多设备同步需绑定一个团队空间；留空无法同步）"
                        onChange={(e) => update(r.ws_id, "space_id", e.target.value)}
                      />
                    )}
                  </div>

                  {r.space_id && r.token && canManageSpace(r) && (
                    <div className="sync-field">
                      <button
                        className="sync-members-toggle"
                        aria-expanded={r.memberOpen}
                        onClick={() => toggleMembers(r)}
                      >
                        <span>成员管理</span>
                        {r.members.length > 0 && <span className="sync-members-count">{r.members.length}</span>}
                        <span className={`sync-caret${r.memberOpen ? " is-open" : ""}`} aria-hidden>▾</span>
                      </button>
                      {r.memberOpen && (
                        <div className="sync-members">
                          {r.members.length === 0 ? (
                            <div className="sync-members-empty">还没有成员</div>
                          ) : (
                            r.members.map((m) => {
                              const canManage = canManageSpace(r);
                              const isOwnerRow = m.role === "owner";
                              return (
                                <div key={m.user_id} className="sync-member">
                                  <span className="sync-member-avatar" aria-hidden>{initial(m.email)}</span>
                                  <span className="sync-member-email" title={m.email}>{m.email}</span>
                                  <select
                                    className={`sync-member-role ${roleClass(m.role)}`}
                                    value={m.role}
                                    aria-label={`${m.email} 的角色`}
                                    disabled={!canManage || isOwnerRow}
                                    onChange={(e) => void setMemberRole(r, m.email, e.target.value)}
                                  >
                                    <option value="viewer">viewer</option>
                                    <option value="editor">editor</option>
                                    <option value="admin">admin</option>
                                  </select>
                                  <button
                                    className="sync-member-remove"
                                    title={isOwnerRow ? "空间所有者不可移除" : "移除成员"}
                                    aria-label={`移除 ${m.email}`}
                                    disabled={!canManage || isOwnerRow}
                                    onClick={() => void removeMember(r, m.user_id)}
                                  >
                                    ✕
                                  </button>
                                </div>
                              );
                            })
                          )}
                          <div className="sync-invite">
                            <input
                              className="sync-input"
                              value={r.inviteEmail}
                              placeholder="被邀请者邮箱"
                              disabled={!canManageSpace(r)}
                              onChange={(e) => update(r.ws_id, "inviteEmail", e.target.value)}
                            />
                            <select
                              className="sync-input sync-invite-role"
                              value={r.inviteRole}
                              aria-label="邀请角色"
                              disabled={!canManageSpace(r)}
                              onChange={(e) => update(r.ws_id, "inviteRole", e.target.value)}
                            >
                              <option value="viewer">viewer</option>
                              <option value="editor">editor</option>
                              <option value="admin">admin</option>
                            </select>
                            <button className="sync-btn" disabled={!canManageSpace(r)} onClick={() => void inviteMember(r)}>
                              邀请
                            </button>
                          </div>
                          {!canManageSpace(r) && (
                            <p className="sync-hint">只有 admin / owner 能邀请成员或改角色。</p>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* 手动令牌是老配置法的后路，默认收起，避免面板一眼全是输入框。 */}
                  <details className="sync-advanced">
                    <summary>高级：手动填令牌{r.token ? "（已获取）" : ""}</summary>
                    <input
                      className="sync-input"
                      type="password"
                      value={r.token}
                      placeholder="团队 token"
                      onChange={(e) => update(r.ws_id, "token", e.target.value)}
                    />
                  </details>

                  <div className="sync-card-actions">
                    {/* 登录/注册与选空间都会自动落盘，这里的「保存」只用于手填
                        服务器地址或手动粘贴令牌的情况。 */}
                    <button className="sync-btn" onClick={() => save(r)} title="保存手填的服务器地址 / 令牌">
                      保存
                    </button>
                    <button className="sync-btn primary" disabled={syncing || !r.server_url} onClick={() => syncOne(r)}>
                      {syncing ? "同步中…" : "同步"}
                    </button>
                  </div>
                </section>
              );
            })}
          </div>

          <footer className="sync-foot">
            {status && <div className={`sync-status is-${statusKind(status)}`}>{status}</div>}
            {history.length > 0 && (
              <div className="sync-history">
                <button className="sync-members-toggle" onClick={() => setHistoryOpen((v) => !v)}>
                  <span>同步历史</span>
                  <span className="sync-members-count">{history.length}</span>
                  <span className={`sync-caret${historyOpen ? " is-open" : ""}`} aria-hidden>▾</span>
                </button>
                {historyOpen && (
                  <div className="sync-history-list">
                    {history.slice(0, 8).map((h, i) => {
                      const d = new Date(h.at).toLocaleString("zh-CN");
                      const open = detailOpenIdx === i;
                      return (
                        <div key={i} className="sync-history-item">
                          <span className="sync-history-status">{h.ok ? "✓" : "✗"}</span>
                          <span className="sync-history-at">{d}</span>
                          <span className="sync-history-detail">
                            上传 {h.pushed} / 拉取 {h.pulled}
                          </span>
                          {h.items.length > 0 && (
                            <button
                              className="sync-history-detail-toggle"
                              onClick={() => setDetailOpenIdx(open ? null : i)}
                            >
                              {h.items.length} 项明细 ▾
                            </button>
                          )}
                          {h.message && <span className="sync-history-msg">{h.message}</span>}
                          {open && (
                            <div className="sync-history-items">
                              {h.items.slice(0, 30).map((it, j) => (
                                <div key={j} className="sync-history-item-row">
                                  <span className={`sync-dir-${it.dir}`}>{it.dir === "push" ? "↑" : "↓"}</span>
                                  <span className="sync-entity">{entityLabel(it.entity)}</span>
                                  <span className="sync-op">{it.op === "delete" ? "删除" : "变更"}</span>
                                  <span className="sync-id" title={it.entity_id}>{it.entity_id.slice(0, 10)}…</span>
                                </div>
                              ))}
                              {h.items.length > 30 && <div className="sync-history-more">…等 {h.items.length - 30} 项</div>}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </footer>
        </div>
      )}
    </div>
  );
}


