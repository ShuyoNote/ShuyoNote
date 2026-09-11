import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { confirmDialog } from "../store/confirm";
import { usePlugins } from "../store/plugins";
import type { PluginIndexEntry, PluginIndexView } from "../types";
import {
  addedPermissions,
  entryAction,
  entryMetaLine,
  entrySignatureNote,
  publisherKeyChanged,
  indexSignatureLabel,
  indexSourceLabel,
  revokedKeysSummary,
  installConfirmMessage,
  loadIndexDraft,
  saveIndexDraft,
  subscriptionStatus,
  subscriptionTitle,
} from "../lib/pluginIndex";

/**
 * 「从索引安装」（M11.11a）：给一个索引 URL，拉到条目列表，逐条看权限再装。
 *
 * 刻意**不是**商店：没有推荐、没有排序、没有评分，也不内置任何"官方索引"地址——
 * 你订阅谁由你决定（自托 = 自担）。这个面板只做三件事：显示来源、显示签名状态、
 * 摊开权限。
 */
export function PluginIndexPanel() {
  const {
    installFromIndex, plugins,
    subscriptions, loadSubscriptions, subscribeIndex, unsubscribeIndex, checkSubscriptions,
  } = usePlugins();
  // 已装的版本：升级 / 重装 / 拒绝降级全靠它（与后端同一套版本比较口径）。
  const installedOf = (id: string) => plugins.find((p) => p.id === id) ?? null;
  // 上次填过的地址 / 公钥只读一次：它不是"信任配置"，只是省得每次重打。
  const [draft] = useState(() => loadIndexDraft(window.localStorage));
  const [url, setUrl] = useState(draft.url);
  const [pubkey, setPubkey] = useState(draft.pubkey);
  const [view, setView] = useState<PluginIndexView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [installing, setInstalling] = useState("");

  const [checking, setChecking] = useState(false);
  const [label, setLabel] = useState("");

  useEffect(() => {
    void loadSubscriptions();
  }, [loadSubscriptions]);

  const loadIndex = async (over?: { url?: string; pubkey?: string }) => {
    const u = (over?.url ?? url).trim();
    const k = (over?.pubkey ?? pubkey).trim();
    setBusy(true);
    setError("");
    try {
      const v = await api.fetchPluginIndex(u, k || null);
      setView(v);
      // 只有真的拉到了才记住这份地址/公钥（打错了不该被记住）。
      saveIndexDraft(window.localStorage, u, k);
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
    const installed = installedOf(id);
    const changed = keyChanged(entry);
    const act = entryAction(entry, installed?.version, changed);
    if (act.action === "blocked" || act.action === "newer-installed") return;
    const sourceLabel = indexSourceLabel(view, url.trim());
    const okToGo = await confirmDialog({
      title:
        act.action === "upgrade"
          ? "升级插件"
          : act.action === "reinstall"
            ? "重装插件"
            : act.action === "key-changed"
              ? "发布者公钥变了"
              : "从索引安装插件",
      message: installConfirmMessage(
        entry,
        sourceLabel,
        !!pubkey.trim(),
        installed?.version,
        addedPermissions(entry, installed),
        {
          pinned: pinnedOf(id)?.fingerprint ?? null,
          incoming: entry.publisherKeyFingerprint || null,
        },
      ),
      danger: act.action === "key-changed",
    });
    if (!okToGo) return;
    setInstalling(id);
    try {
      await installFromIndex(url.trim(), id, pubkey.trim() || null, act.action === "key-changed");
    } finally {
      setInstalling("");
    }
  };

  const sig = view ? indexSignatureLabel(view) : null;

  /** 每个插件已固定的发布者公钥指纹（来自已装插件列表）。 */
  const pinnedOf = (id: string) => installedOf(id)?.publisher_key ?? null;
  /**
   * 索引里那条声明的发布者公钥指纹。
   *
   * 这里**不自己算指纹**：指纹的算法只该有一处（后端 `publisher_key_fingerprint`），
   * 前端算一份迟早会与后端不一致，而"不一致的指纹"恰好会让用户做出错误判断。
   * 所以界面只显示后端给的固定指纹，索引里那把 key 的指纹由后端在安装时比较并报错。
   */
  const keyChanged = (p: PluginIndexEntry) =>
    publisherKeyChanged(p, pinnedOf(p.id), p.publisherKeyFingerprint);

  return (
    <div className="pm-index">
      {/* 多源订阅：一组索引 URL，可增删、可逐个检查。**不是商店**——没有推荐、没有排序，
          也不内置任何官方索引；索引内容永远现场拉。 */}
      <div className="pm-subs">
        <div className="pm-subs-head">
          <span>订阅的索引（{subscriptions.length}）</span>
          <button
            className="pm-subs-check"
            disabled={checking || subscriptions.length === 0}
            onClick={async () => {
              setChecking(true);
              try {
                await checkSubscriptions();
              } finally {
                setChecking(false);
              }
            }}
            title="逐个拉一遍，记下每条的结果（哪条挂了、有几条可更新）"
          >
            {checking ? "检查中…" : "检查更新"}
          </button>
        </div>
        {subscriptions.length === 0 ? (
          <div className="pm-subs-empty">
            还没有订阅。下面填一个索引地址点「拉取索引」，就能把它存成订阅——自托一个、社区一个、
            公司内网一个，各自独立。
          </div>
        ) : (
          subscriptions.map((sub) => {
            const st = subscriptionStatus(sub);
            return (
              <div key={sub.url} className="pm-sub">
                <div className="pm-sub-main">
                  <button
                    className="pm-sub-open"
                    onClick={() => {
                      setUrl(sub.url);
                      setPubkey(sub.pubkey);
                      void loadIndex({ url: sub.url, pubkey: sub.pubkey });
                    }}
                    title={`拉取这一条：${sub.url}`}
                  >
                    {subscriptionTitle(sub)}
                  </button>
                  <span className={st.level === "warn" ? "pm-sub-status warn" : "pm-sub-status"}>
                    {st.text}
                  </span>
                  <span className="pm-sub-sig">
                    {sub.pubkey ? "验签公钥已设置" : "不验签（没填公钥）"}
                  </span>
                </div>
                <button
                  className="pm-sub-del"
                  title="取消订阅（不会卸载任何插件）"
                  onClick={async () => {
                    if (
                      await confirmDialog({
                        title: "取消订阅",
                        message: `不再订阅这份索引？\n${sub.url}\n已装的插件不受影响（订阅只是"从哪里找插件"）。`,
                      })
                    )
                      await unsubscribeIndex(sub.url);
                  }}
                >
                  ×
                </button>
              </div>
            );
          })
        )}
      </div>
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
        <input
          className="pm-index-label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="备注（可选，如「公司内网」）"
          spellCheck={false}
        />
        <button onClick={() => void loadIndex()} disabled={busy || !url.trim()}>
          {busy ? "拉取中…" : "拉取索引"}
        </button>
        <button
          className="pm-index-save"
          disabled={!url.trim()}
          onClick={async () => {
            const r = await subscribeIndex(url.trim(), pubkey.trim(), label.trim());
            if (r.ok) setLabel("");
          }}
          title="存成订阅，之后一键切换、也能一次检查全部"
        >
          存为订阅
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
          {view.revokedKeys.length > 0 && (
            <div className="pm-index-sig warn">
              {revokedKeysSummary(view.revokedKeys)
                .split("\n")
                .map((line) => (
                  <div key={line}>{line}</div>
                ))}
            </div>
          )}
          {view.plugins.length === 0 ? (
            <div className="pm-empty">这份索引里没有插件</div>
          ) : (
            view.plugins.map((p) => {
              const installed = installedOf(p.id);
              const changed = keyChanged(p);
              const act = entryAction(p, installed?.version, changed);
              const blocked = act.action === "blocked" || act.action === "newer-installed";
              const why = act.reason || "安装这个插件";
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
                    {(() => {
                      const note = entrySignatureNote(
                        p,
                        pinnedOf(p.id),
                        p.publisherKeyFingerprint,
                      );
                      return (
                        <div
                          className={
                            note.level === "warn"
                              ? "pm-index-item-sig warn"
                              : "pm-index-item-sig"
                          }
                        >
                          {note.text}
                        </div>
                      );
                    })()}
                    {installed && act.action === "upgrade" && (
                      <div className="pm-index-item-installed">
                        已装 v{installed.version}
                        {addedPermissions(p, installed).length > 0
                          ? ` · 这次会新增 ${addedPermissions(p, installed).length} 项权限`
                          : " · 权限没有新增"}
                      </div>
                    )}
                    {blocked && <div className="pm-index-item-blocked">{why}</div>}
                  </div>
                  <button
                    onClick={() => doInstall(p.id)}
                    disabled={blocked || installing === p.id}
                    title={why}
                  >
                    {installing === p.id ? "处理中…" : act.label}
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
