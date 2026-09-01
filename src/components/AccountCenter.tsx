import { useEffect, useState } from "react";
import { usePopover } from "../hooks/usePopover";
import { api } from "../lib/api";
import { useSpaceStore } from "../store/space";
import { useNotes } from "../store/notes";
import { useAuth } from "../store/auth";
import { PersonIcon } from "./icons";

// U4 — 账户中心(看板,非「当前账号」全局态):按服务器分组列出所有同步身份
// 及其挂载的本地空间;可同步该组 / 全部。透明度 + 管理,不做切换登录态。
interface AcctWs {
  ws_id: string;
  name: string;
  spaceId: string;
  token: string;
}
interface AcctGroup {
  server_url: string;
  wss: AcctWs[];
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url.replace(/^https?:\/\//, "").split("/")[0] || url || "(未设置服务器)";
  }
}
function colorOf(url: string): string {
  let h = 0;
  for (let i = 0; i < url.length; i++) h = (h * 31 + url.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 65% 45%)`;
}

export function AccountCenter() {
  const { open, pos, triggerRef, contentRef, toggle } = usePopover<HTMLButtonElement>();
  const spaces = useSpaceStore((s) => s.spaces);
  const { loadPages } = useNotes();
  const [groups, setGroups] = useState<AcctGroup[]>([]);
  const [status, setStatus] = useState("");
  const [syncing, setSyncing] = useState(false);
  const { authed, serverUrl, clear } = useAuth();

  const logoutCurrent = async () => {
    if (!serverUrl) return;
    setStatus("");
    try {
      await api.teamLogout(serverUrl);
      clear();
      setStatus("已登出当前账号");
      await refresh();
    } catch (e) {
      setStatus(`登出失败：${e}`);
    }
  };

  const refresh = async () => {
    try {
      const profiles = await api.listSyncProfiles();
      const name = new Map(spaces.map((s) => [s.id, s.name]));
      const byServer = new Map<string, AcctWs[]>();
      for (const p of profiles) {
        const key = p.server_url || "(未设置服务器)";
        if (!byServer.has(key)) byServer.set(key, []);
        byServer.get(key)!.push({
          ws_id: p.ws_id,
          name: name.get(p.ws_id) ?? p.ws_id,
          spaceId: p.space_id,
          token: p.token,
        });
      }
      setGroups(Array.from(byServer.entries()).map(([server_url, wss]) => ({ server_url, wss })));
    } catch (e) {
      setStatus(String(e));
    }
  };

  useEffect(() => {
    if (open) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const syncGroup = async (g: AcctGroup) => {
    setSyncing(true);
    setStatus("");
    try {
      let ok = 0;
      let fail = 0;
      for (const w of g.wss) {
        const r = await api.syncWorkspace(w.ws_id);
        if (r.error) fail++;
        else ok++;
      }
      setStatus(`「${hostOf(g.server_url)}」同步：成功 ${ok}，失败 ${fail}`);
      await loadPages();
    } catch (e) {
      setStatus(String(e));
    } finally {
      setSyncing(false);
    }
  };

  const syncAll = async () => {
    setSyncing(true);
    setStatus("");
    try {
      const rs = await api.syncNow();
      const ok = rs.filter((r) => !r.error).length;
      const fail = rs.filter((r) => r.error).length;
      setStatus(`同步全部：成功 ${ok}，失败 ${fail}`);
      await loadPages();
    } catch (e) {
      setStatus(String(e));
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="sync-panel acct-center">
      <button ref={triggerRef} className="btn-sync" onClick={toggle} title="身份与账户">
        <PersonIcon />
      </button>
      {open && (
        <div ref={contentRef} className="sync-popover" style={{ top: pos.top, left: pos.left }}>
          <div className="sync-title">账户中心</div>
          {authed ? (
            <div className="acct-current">
              <span className="acct-current-label">当前团队账号：{hostOf(serverUrl)}</span>
              <button className="acct-logout" onClick={() => void logoutCurrent()}>登出</button>
            </div>
          ) : (
            <div className="acct-current acct-current-empty">未登录团队账号</div>
          )}
          {groups.length === 0 ? (
            <div className="sync-empty">
              尚无同步身份。在各空间的「同步」里配置服务器与登录后,会**按服务器**在此分组显示。
            </div>
          ) : (
            groups.map((g) => (
              <div key={g.server_url} className="acct-group">
                <div className="acct-group-head">
                  <span className="acct-dot" style={{ background: colorOf(g.server_url) }} />
                  <span className="acct-group-name">{hostOf(g.server_url)}</span>
                  <button className="acct-group-sync" disabled={syncing} onClick={() => syncGroup(g)}>
                    同步该组
                  </button>
                </div>
                {g.wss.map((w) => (
                  <div key={w.ws_id} className="acct-ws">
                    <span className="acct-ws-name">{w.name}</span>
                    <span className="acct-ws-meta">
                      {w.spaceId ? `空间 ${w.spaceId}` : "单用户"}
                      {w.token ? " · ✓已认证" : ""}
                    </span>
                  </div>
                ))}
              </div>
            ))
          )}
          {status && <div className="sync-status">{status}</div>}
          <div className="sync-actions">
            <button onClick={syncAll} disabled={syncing || groups.length === 0}>
              同步全部
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
