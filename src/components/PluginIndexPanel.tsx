import { useState } from "react";
import { api } from "../lib/api";
import { confirmDialog } from "../store/confirm";
import { usePlugins } from "../store/plugins";
import type { PluginIndexView } from "../types";
import {
  entryInstallable,
  entryMetaLine,
  entrySignatureNote,
  indexSignatureLabel,
  indexSourceLabel,
  installConfirmMessage,
  loadIndexDraft,
  saveIndexDraft,
} from "../lib/pluginIndex";

/**
 * 「从索引安装」（M11.11a）：给一个索引 URL，拉到条目列表，逐条看权限再装。
 *
 * 刻意**不是**商店：没有推荐、没有排序、没有评分，也不内置任何"官方索引"地址——
 * 你订阅谁由你决定（自托 = 自担）。这个面板只做三件事：显示来源、显示签名状态、
 * 摊开权限。
 */
export function PluginIndexPanel() {
  const { installFromIndex } = usePlugins();
  // 上次填过的地址 / 公钥只读一次：它不是"信任配置"，只是省得每次重打。
  const [draft] = useState(() => loadIndexDraft(window.localStorage));
  const [url, setUrl] = useState(draft.url);
  const [pubkey, setPubkey] = useState(draft.pubkey);
  const [view, setView] = useState<PluginIndexView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [installing, setInstalling] = useState("");

  const loadIndex = async () => {
    setBusy(true);
    setError("");
    try {
      const v = await api.fetchPluginIndex(url.trim(), pubkey.trim() || null);
      setView(v);
      // 只有真的拉到了才记住这份地址/公钥（打错了不该被记住）。
      saveIndexDraft(window.localStorage, url.trim(), pubkey.trim());
    } catch (e) {
      setView(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const doInstall = async (id: string) => {
    if (!view) return;
    const entry = view.plugins.find((p) => p.id === id);
    if (!entry) return;
    const gate = entryInstallable(entry);
    if (!gate.ok) return;
    const sourceLabel = indexSourceLabel(view, url.trim());
    const okToGo = await confirmDialog({
      title: "从索引安装插件",
      message: installConfirmMessage(entry, sourceLabel, !!pubkey.trim()),
    });
    if (!okToGo) return;
    setInstalling(id);
    try {
      await installFromIndex(url.trim(), id, pubkey.trim() || null);
    } finally {
      setInstalling("");
    }
  };

  const sig = view ? indexSignatureLabel(view) : null;

  return (
    <div className="pm-index">
      <div className="pm-index-form">
        <input
          className="pm-index-url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="索引地址 https://…/plugin-index.json"
          spellCheck={false}
        />
        <input
          className="pm-index-key"
          value={pubkey}
          onChange={(e) => setPubkey(e.target.value)}
          placeholder="索引公钥（可选，minisign）"
          spellCheck={false}
        />
        <button onClick={loadIndex} disabled={busy || !url.trim()}>
          {busy ? "拉取中…" : "拉取索引"}
        </button>
      </div>
      <div className="pm-index-hint">
        地址必须是 https。填了公钥就必须能取到 <code>.minisig</code> 签名并校验通过，否则直接失败。
      </div>
      {error && <div className="pm-index-error">{error}</div>}
      {view && sig && (
        <>
          <div className="pm-index-source">
            来源：{indexSourceLabel(view, url.trim())}
            {view.generatedAt ? ` · 生成于 ${view.generatedAt}` : ""}
          </div>
          <div className={sig.level === "ok" ? "pm-index-sig ok" : "pm-index-sig warn"}>
            {sig.text}
          </div>
          {view.plugins.length === 0 ? (
            <div className="pm-empty">这份索引里没有插件</div>
          ) : (
            view.plugins.map((p) => {
              const gate = entryInstallable(p);
              return (
                <div key={p.id} className="pm-index-item">
                  <div className="pm-index-item-main">
                    <div className="pm-index-item-title">
                      {p.name || p.id}
                      {p.revoked && <span className="pm-index-badge">已撤回</span>}
                    </div>
                    <div className="pm-index-item-meta">{entryMetaLine(p)}</div>
                    {p.description && <div className="pm-index-item-desc">{p.description}</div>}
                    <div className="pm-index-item-perms">
                      {p.permissions.length === 0
                        ? "不申请任何数据权限"
                        : p.permissions.map((perm) => (
                            <div key={perm.id}>
                              {perm.id} —— {perm.reason || "（作者没写理由）"}
                            </div>
                          ))}
                    </div>
                    <div className="pm-index-item-sig">{entrySignatureNote(p)}</div>
                    {!gate.ok && <div className="pm-index-item-blocked">{gate.reason}</div>}
                  </div>
                  <button
                    onClick={() => doInstall(p.id)}
                    disabled={!gate.ok || installing === p.id}
                    title={gate.ok ? "安装这个插件" : gate.reason}
                  >
                    {installing === p.id ? "安装中…" : "安装"}
                  </button>
                </div>
              );
            })
          )}
        </>
      )}
    </div>
  );
}
