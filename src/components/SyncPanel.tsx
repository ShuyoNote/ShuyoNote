import { useEffect, useState } from "react";
import { usePopover } from "../hooks/usePopover";
import { api, type SyncProfile } from "../lib/api";
import { useSpaceStore } from "../store/space";
import { useNotes } from "../store/notes";
import { SyncIcon } from "./icons";

interface EditRow {
  ws_id: string;
  name: string;
  server_url: string;
  token: string;
  space_id: string;
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

  return (
    <div className="sync-panel">
      <button ref={triggerRef} className="btn-sync" onClick={toggle} title="同步设置">
        <SyncIcon />
      </button>
      {open && (
        <div ref={contentRef} className="sync-popover" style={{ top: pos.top, left: pos.left }}>
          <div className="sync-title">每空间同步目标</div>
          <div className="sync-profiles">
            {rows.map((r) => (
              <div key={r.ws_id} className="sync-profile">
                <div className="sync-profile-name">{r.name}</div>
                <div className="sync-row">
                  <label>服务器</label>
                  <input value={r.server_url} placeholder="http://localhost:8787" onChange={(e) => update(r.ws_id, "server_url", e.target.value)} />
                </div>
                <div className="sync-row">
                  <label>令牌</label>
                  <input type="password" value={r.token} placeholder="团队 token" onChange={(e) => update(r.ws_id, "token", e.target.value)} />
                </div>
                <div className="sync-row">
                  <label>空间 ID</label>
                  <input value={r.space_id} placeholder="团队空间 id（留空=旧单用户）" onChange={(e) => update(r.ws_id, "space_id", e.target.value)} />
                </div>
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
