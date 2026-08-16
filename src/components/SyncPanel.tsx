import { useEffect, useState } from "react";
import { usePopover } from "../hooks/usePopover";
import { api, type SyncConfig } from "../lib/api";
import { useNotes } from "../store/notes";
import { SyncIcon } from "./icons";

export function SyncPanel() {
  const { loadPages } = useNotes();
  const { open, pos, triggerRef, contentRef, toggle } = usePopover<HTMLButtonElement>();
  const [config, setConfig] = useState<SyncConfig | null>(null);
  const [serverUrl, setServerUrl] = useState("");
  const [token, setToken] = useState("");
  const [status, setStatus] = useState("");
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    if (open) {
      api
        .getSyncConfig()
        .then((c) => {
          setConfig(c);
          setServerUrl(c.server_url);
          setToken(c.token);
        })
        .catch((e) => setStatus(String(e)));
    }
  }, [open]);

  const save = async () => {
    try {
      await api.setSyncConfig({ server_url: serverUrl, token: token || undefined });
      setStatus("已保存");
    } catch (e) {
      setStatus(String(e));
    }
  };

  const sync = async () => {
    setSyncing(true);
    setStatus("");
    try {
      const report = await api.syncNow();
      setStatus(`同步完成：上传 ${report.pushed} 条，拉取 ${report.pulled} 条`);
      await loadPages();
    } catch (e) {
      setStatus(`同步失败：${e}`);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="sync-panel">
      <button ref={triggerRef} className="btn-sync" onClick={toggle} title="同步设置">
        <SyncIcon />
      </button>
      {open && (
        <div ref={contentRef} className="sync-popover" style={{ top: pos.top, left: pos.left }}>
          <div className="sync-row">
            <label>服务器地址</label>
            <input
              value={serverUrl}
              placeholder="http://localhost:8787"
              onChange={(e) => setServerUrl(e.target.value)}
            />
          </div>
          <div className="sync-row">
            <label>令牌（可选）</label>
            <input
              type="password"
              value={token}
              placeholder="同步服务 token"
              onChange={(e) => setToken(e.target.value)}
            />
          </div>
          {config && (
            <div className="sync-meta">
              设备 ID：<code>{config.device_id.slice(0, 8)}…</code>
              <br />
              已推 {config.last_pushed_seq} / 已拉 {config.last_pulled_seq}
            </div>
          )}
          {status && <div className="sync-status">{status}</div>}
          <div className="sync-actions">
            <button onClick={save}>保存</button>
            <button onClick={sync} disabled={syncing || !serverUrl}>
              {syncing ? "同步中…" : "立即同步"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
