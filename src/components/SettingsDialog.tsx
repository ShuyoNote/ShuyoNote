import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useEditorStore, type SettingsTab } from "../store/editor";
import { ACCENTS, useTheme, type Theme } from "../store/theme";
import { getPlugins, isPluginEnabled, togglePlugin, usePluginRevision, PLUGIN_META } from "../plugins/registry";
import { AiSettingsForm } from "./AiSettingsForm";
import { BackupButton } from "./BackupButton";
import { StoragePanel } from "./StoragePanel";
import { api } from "../lib/api";
import type { SyncProfile } from "../lib/api";
import { isDesktopPlatform } from "../lib/platform";
import { toast } from "../store/toast";
import { confirmDialog } from "../store/confirm";
import { useSpaceStore } from "../store/space";
import { useWindowChrome } from "../store/windowChrome";
import { useNotes } from "../store/notes";
import { useAuth } from "../store/auth";
import { exportCurrentSpace, importSpacePackage, removeSpace } from "../lib/spaceTransfer";
import { APP_VERSION, APP_LICENSE } from "../lib/links";
import {
  PaletteIcon,
  FolderIcon,
  PersonIcon,
  DatabaseIcon,
  TemplateIcon,
  LockIcon,
  SparkleIcon,
  InfoIcon,
} from "./icons";

const THEMES: { id: Theme; label: string }[] = [
  { id: "system", label: "跟随系统" },
  { id: "light", label: "亮色" },
  { id: "dark", label: "暗色" },
];

const TABS: { id: SettingsTab; label: string; hint: string; icon: JSX.Element }[] = [
  { id: "appearance", label: "外观", hint: "主题与强调色", icon: <PaletteIcon width={16} height={16} /> },
  { id: "spaces", label: "空间", hint: "配色 / 删除 / 迁移", icon: <FolderIcon width={16} height={16} /> },
  { id: "account", label: "账户", hint: "登录身份与同步目标", icon: <PersonIcon width={16} height={16} /> },
  { id: "data", label: "数据", hint: "备份 / 存储与清理", icon: <DatabaseIcon width={16} height={16} /> },
  { id: "plugins", label: "插件", hint: "启用/禁用扩展", icon: <TemplateIcon width={16} height={16} /> },
  { id: "security", label: "安全", hint: "端到端加密与锁定", icon: <LockIcon width={16} height={16} /> },
  { id: "ai", label: "AI", hint: "服务商与模型", icon: <SparkleIcon width={16} height={16} /> },
  { id: "about", label: "关于与更新", hint: "版本与许可", icon: <InfoIcon width={16} height={16} /> },
];

// 每页一句话说明，放在内容区页头——比只有一个标题更有分量，也省去用户猜
// 「这一页到底管什么」。
const TAB_DESC: Record<SettingsTab, string> = {
  appearance: "主题、强调色等外观偏好，改动即时生效。",
  spaces: "空间的低频管理：配色、删除、单空间导入导出。切换空间在侧栏顶部。",
  account: "团队账号与各服务器上的同步身份；同步操作本身在侧栏「同步」里。",
  data: "全库备份与存储清理——都是低频且不可逆的操作。",
  plugins: "插件的启用与禁用；其命令会出现在命令面板（Ctrl+K）。",
  security: "本机静置加密与会话锁定。口令即密钥，丢失无法找回。",
  ai: "AI 服务商、模型与密钥；配置后可在助手、PDF 帮读、公式识别中使用。",
  about: "版本、许可与更新检查。",
};

// 「数据」页：全库备份/恢复与存储清理——低频、全局、不可逆，按判据归设置。
// 两个组件都用 `label` 变体渲染成带文字的按钮，实现与侧栏时期完全共用。
function DataPane() {
  return (
    <>
      <section className="set-section">
        <div className="set-section-title">完整备份</div>
        <div className="set-row">
          <div className="set-row-text">
            <div className="set-row-name">备份 / 恢复（全库）</div>
            <div className="set-row-sub">
              导出所有空间与附件为一个包；导入为**合并**，不会覆盖现有空间。
            </div>
          </div>
          <BackupButton label="备份 / 恢复…" />
        </div>
        <p className="set-hint">
          单个空间的导出/导入在「空间」页；这里是整机全库级别的备份。
        </p>
      </section>

      <section className="set-section">
        <div className="set-section-title">存储与清理</div>
        <div className="set-row">
          <div className="set-row-text">
            <div className="set-row-name">存储 / 空间管理</div>
            <div className="set-row-sub">
              查看数据库 / 附件 / 回收站 / 版本历史的占用构成，并回收可释放空间
            </div>
          </div>
          <StoragePanel label="打开…" />
        </div>
      </section>
    </>
  );
}

// 空间配色候选（与侧栏空间弹层同一组色值）。
const SPACE_ACCENTS = [
  "#3370FF", "#00B578", "#FF8A1E", "#7B61FF", "#00A9C7", "#D9A300", "#F54A45", "#646A73",
];

function hostLabel(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url.replace(/^https?:\/\//, "").split("/")[0] || url || "(未设置服务器)";
  }
}

// 「空间」页：低频且有破坏性的空间管理（配色 / 删除 / 导出 / 导入）。
// 高频的「切换空间」仍留在侧栏——它是工作流入口，不是设置。
function SpacesPane() {
  const spaces = useSpaceStore((s) => s.spaces);
  const activeId = useSpaceStore((s) => s.activeId);
  const [colorFor, setColorFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 每个空间的同步目标：让「这个空间到底同不同步、同步到哪」在管理页就能看到，
  // 不用再切回同步面板逐个点开。
  const [syncProfiles, setSyncProfiles] = useState<Record<string, SyncProfile>>({});
  const activeName = spaces.find((s) => s.id === activeId)?.name ?? "当前空间";

  useEffect(() => {
    api
      .listSyncProfiles()
      .then((list) => {
        const byWs: Record<string, SyncProfile> = {};
        for (const p of list) byWs[p.ws_id] = p;
        setSyncProfiles(byWs);
      })
      .catch(() => {});
  }, [spaces.length]);

  const setColor = async (id: string, color: string) => {
    setColorFor(null);
    const ok = await useSpaceStore.getState().setSettings(id, color);
    if (!ok) toast("设置颜色失败", "error");
  };

  const doRemove = async (id: string, name: string) => {
    const ok = await confirmDialog({
      title: "删除工作空间",
      message: `删除「${name}」及其所有内容？建议先导出/备份（软删除，可在数据目录恢复）。`,
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await removeSpace(id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="set-section">
        <div className="set-section-title">全部空间（{spaces.length}）</div>
        <div className="set-space-list">
          {spaces.map((s) => {
            const active = s.id === activeId;
            const prof = syncProfiles[s.id];
            return (
              <div key={s.id} className={`set-space-card${active ? " is-active" : ""}`}>
                <div className="set-space-row">
                  <span
                    className="set-space-mark"
                    style={s.theme ? { background: s.theme, color: "#fff" } : undefined}
                  >
                    {s.name.charAt(0)}
                  </span>
                  <div className="set-row-text">
                    <div className="set-row-name">
                      {s.name}
                      {active && <span className="set-tag">当前</span>}
                    </div>
                    <div className="set-space-meta">
                      {prof?.server_url ? (
                        <span className="set-space-sync">↔ {hostLabel(prof.server_url)}</span>
                      ) : (
                        <span className="set-space-local">仅本机</span>
                      )}
                      <span className="set-space-id" title={s.id}>{s.id.slice(0, 8)}</span>
                    </div>
                  </div>
                  <button
                    className={`set-btn${colorFor === s.id ? " is-on" : ""}`}
                    onClick={() => setColorFor((c) => (c === s.id ? null : s.id))}
                  >
                    配色
                  </button>
                  <button
                    className="set-btn is-danger-ghost"
                    disabled={busy || spaces.length <= 1 || active}
                    title={active ? "当前空间不可删除，请先切换到别的空间" : spaces.length <= 1 ? "至少保留一个空间" : "删除该空间"}
                    onClick={() => doRemove(s.id, s.name)}
                  >
                    删除
                  </button>
                </div>
                {colorFor === s.id && (
                  <div className="set-space-colors">
                    <span className="set-space-colors-label">空间颜色</span>
                    <div className="set-swatch-row">
                      {SPACE_ACCENTS.map((c) => (
                        <button
                          key={c}
                          className={`set-swatch${s.theme === c ? " is-on" : ""}`}
                          style={{ background: c }}
                          aria-label={`使用颜色 ${c}`}
                          onClick={() => setColor(s.id, c)}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <p className="set-hint">
          切换空间在侧栏顶部——这里只做低频管理。删除为软删除，数据仍在磁盘上，可在「存储 / 空间管理」里彻底清理。
        </p>
      </section>

      <section className="set-section">
        <div className="set-section-title">单空间迁移</div>
        <div className="set-migrate">
          <div className="set-migrate-card">
            <div className="set-migrate-icon">↑</div>
            <div className="set-migrate-name">导出当前空间</div>
            <div className="set-migrate-sub">「{activeName}」及其引用到的附件，打包成一个 zip</div>
            <button className="set-btn" onClick={() => void exportCurrentSpace(activeName)}>
              导出…
            </button>
          </div>
          <div className="set-migrate-card">
            <div className="set-migrate-icon">↓</div>
            <div className="set-migrate-name">导入空间包</div>
            <div className="set-migrate-sub">始终新建一个空间，绝不覆盖现有空间</div>
            <button className="set-btn" onClick={() => void importSpacePackage()}>
              导入…
            </button>
          </div>
        </div>
      </section>
    </>
  );
}

// 「账户」页：登录身份（低频、全局）。同步操作仍在同步面板——那是高频、
// 需要状态常驻可见的动作。这里只做「我是谁、连了哪些服务器」。
function AccountPane() {
  const spaces = useSpaceStore((s) => s.spaces);
  const { authed, serverUrl, clear } = useAuth();
  const [groups, setGroups] = useState<{ server_url: string; wss: { ws_id: string; name: string; spaceId: string; token: string }[] }[]>([]);
  const [status, setStatus] = useState("");
  const [syncing, setSyncing] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const profiles = await api.listSyncProfiles();
      const name = new Map(spaces.map((s) => [s.id, s.name]));
      const byServer = new Map<string, { ws_id: string; name: string; spaceId: string; token: string }[]>();
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
  }, [spaces]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const logout = async () => {
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

  const syncGroup = async (g: { server_url: string; wss: { ws_id: string }[] }) => {
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
      setStatus(`「${hostLabel(g.server_url)}」同步：成功 ${ok}，失败 ${fail}`);
      await useNotes.getState().loadPages();
    } catch (e) {
      setStatus(String(e));
    } finally {
      setSyncing(false);
    }
  };

  return (
    <>
      <section className="set-section">
        <div className="set-section-title">当前团队账号</div>
        {authed ? (
          <div className="set-row">
            <span className="set-status-dot set-dot-on" />
            <div className="set-row-text">
              <div className="set-row-name">{hostLabel(serverUrl)}</div>
              <div className="set-row-sub">已登录 · 会话保存在本机 meta 库</div>
            </div>
            <button className="set-btn" onClick={() => void logout()}>登出</button>
          </div>
        ) : (
          <div className="set-row">
            <span className="set-status-dot" />
            <div className="set-row-text">
              <div className="set-row-name">未登录团队账号</div>
              <div className="set-row-sub">在侧栏「同步」里登录或注册后，这里会显示当前身份</div>
            </div>
          </div>
        )}
      </section>

      <section className="set-section">
        <div className="set-section-title">同步身份（按服务器分组）</div>
        {groups.length === 0 ? (
          <p className="set-hint">
            尚无同步身份。在侧栏「同步」里为某个空间配置服务器并登录后，会按服务器在此分组显示。
          </p>
        ) : (
          <div className="set-list">
            {groups.map((g) => (
              <div key={g.server_url} className="set-group">
                <div className="set-group-head">
                  <span className="set-row-name">{hostLabel(g.server_url)}</span>
                  <button className="set-btn" disabled={syncing} onClick={() => void syncGroup(g)}>
                    {syncing ? "同步中…" : "同步该组"}
                  </button>
                </div>
                {g.wss.map((w) => (
                  <div key={w.ws_id} className="set-group-item">
                    <span>{w.name}</span>
                    <span className="set-row-sub">
                      {w.spaceId ? `空间 ${w.spaceId}` : "单用户"}
                      {w.token ? " · ✓已认证" : ""}
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
        {status && <div className="set-status-line">{status}</div>}
      </section>
    </>
  );
}


function AppearancePane() {
  const { theme, accent, setTheme, setAccent } = useTheme();
  const customTitleBar = useWindowChrome((s) => s.custom);
  const setCustomTitleBar = useWindowChrome((s) => s.setCustom);
  const material = useWindowChrome((s) => s.material);
  const setMaterial = useWindowChrome((s) => s.setMaterial);
  return (
    <>
      <section className="set-section">
        <div className="set-section-title">基础主题</div>
        <div className="set-chip-row">
          {THEMES.map((t) => (
            <button
              key={t.id}
              className={`set-chip${theme === t.id ? " is-on" : ""}`}
              onClick={() => setTheme(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </section>
      <section className="set-section">
        <div className="set-section-title">强调色</div>
        <div className="set-swatch-row">
          {ACCENTS.map((a) => (
            <button
              key={a.id}
              className={`set-swatch${accent === a.id ? " is-on" : ""}`}
              style={{ background: a.light }}
              title={a.name}
              aria-label={a.name}
              onClick={() => setAccent(a.id)}
            />
          ))}
        </div>
        <p className="set-hint">强调色作用于按钮、选中态与链接，随明暗主题自动取对应色值。</p>
      </section>

      {isDesktopPlatform() && (
        <section className="set-section">
          <div className="set-section-title">窗口</div>
          <div className="set-row">
            <div className="set-row-text">
              <div className="set-row-name">自定义标题栏</div>
              <div className="set-row-sub">
                顶栏显示「当前页面 · 空间」并与应用同色。关掉则用系统标题栏——
                若贴边分屏（Aero Snap）或边缘缩放手感不对，退回系统栏即可。
              </div>
            </div>
            <button
              className={`set-toggle${customTitleBar ? " is-on" : ""}`}
              role="switch"
              aria-checked={customTitleBar}
              onClick={() => setCustomTitleBar(!customTitleBar)}
            >
              {customTitleBar ? "已开启" : "已关闭"}
            </button>
          </div>
          <div className="set-row">
            <div className="set-row-text">
              <div className="set-row-name">材质（Mica）</div>
              <div className="set-row-sub">
                顶栏透出桌面壁纸，Win11 22H2+ 生效，旧系统自动忽略。壁纸较花时
                可能影响观感，需要时可关——与标题栏染色互斥。
              </div>
            </div>
            <button
              className={`set-toggle${material ? " is-on" : ""}`}
              role="switch"
              aria-checked={material}
              onClick={() => setMaterial(!material)}
            >
              {material ? "已开启" : "已关闭"}
            </button>
          </div>
          <p className="set-hint">两项切换均即时生效，无需重启。</p>
        </section>
      )}
    </>
  );
}

// 插件卡片图标：按 PLUGIN_META 的 icon 键绘制。内联 SVG，不引其它图标组件。
function PluginGlyph({ icon }: { icon: string }) {
  const paths: Record<string, React.ReactNode> = {
    stats: <><path d="M4 20h16" /><path d="M7 20v-6M12 20V9M17 20V13" /></>,
    export: <><path d="M12 15V3" /><path d="M8 7l4-4 4 4" /><path d="M4 17v3h16v-3" /></>,
    database: <><ellipse cx="12" cy="6" rx="8" ry="3" /><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6" /></>,
    template: <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M9 21V9" /></>,
    plugin: <><rect x="3" y="3" width="8" height="8" rx="2" /><rect x="13" y="13" width="8" height="8" rx="2" /><path d="M7 11v6M11 7h6" /></>,
    ai: <path d="M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z" />,
    help: <><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 1 1 4.5 1.5c-.8 1-2 1.3-2 2.5M12 17h.01" /></>,
    view: <><circle cx="12" cy="12" r="3" /><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z" /></>,
    pdf: <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6" /></>,
    sync: <><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v6h-6" /></>,
    report: <><path d="M3 3v18h18" /><rect x="7" y="12" width="3" height="6" /><rect x="12" y="8" width="3" height="10" /></>,
  };
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {paths[icon] ?? paths.view}
    </svg>
  );
}

function PluginsPane() {
  usePluginRevision();
  const plugins = getPlugins();
  const enabled = plugins.filter((p) => isPluginEnabled(p.id)).length;
  return (
    <section className="set-section">
      <div className="set-section-title">
        已安装插件
        <span className="plugin-count">{enabled}/{plugins.length} 已启用</span>
      </div>
      <div className="plugin-grid">
        {plugins.map((p) => {
          const meta = PLUGIN_META[p.id] ?? {};
          const on = isPluginEnabled(p.id);
          return (
            <div key={p.id} className={`plugin-card${on ? "" : " is-off"}`}>
              <div className="plugin-card-head">
                <span
                  className="plugin-icon"
                  style={meta.color ? { background: `color-mix(in srgb, ${meta.color} 16%, transparent)`, color: meta.color } : undefined}
                >
                  <PluginGlyph icon={meta.icon ?? "view"} />
                </span>
                <span className={`plugin-status${on ? " is-on" : ""}`}>
                  <span className="plugin-status-dot" />
                  {on ? "已启用" : "已禁用"}
                </span>
              </div>
              <div className="plugin-name">{p.name}</div>
              <div className="plugin-sub">{p.commands?.length ?? 0} 个命令 · 出现在命令面板</div>
              <button
                className={`set-toggle${on ? " is-on" : ""}`}
                role="switch"
                aria-checked={on}
                onClick={() => togglePlugin(p.id)}
              >
                {on ? "已启用" : "已禁用"}
              </button>
            </div>
          );
        })}
      </div>
      <p className="set-hint">插件命令出现在命令面板（Ctrl+K）中；禁用后其命令一并隐藏。</p>
    </section>
  );
}

// 端到端加密：口令即密钥，关闭/开启都会触发全库重写，所以这里的破坏性操作
// 一律要二次确认，且把「丢失不可找回」写在入口而不是等出事再说。
function SecurityPane() {
  const [enabled, setEnabled] = useState(false);
  const [locked, setLocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [confirmOff, setConfirmOff] = useState(false);
  const desktop = isDesktopPlatform();

  const refresh = useCallback(() => {
    api
      .encryptionStatus()
      .then((s) => {
        setEnabled(s.enabled);
        setLocked(s.locked);
      })
      .catch(() => {});
  }, []);
  useEffect(() => refresh(), [refresh]);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast(ok, "success");
      setPass("");
      setPass2("");
      setConfirmOff(false);
      refresh();
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const state = !enabled ? "off" : locked ? "locked" : "on";
  const canEnable = pass.trim().length >= 8 && pass === pass2;

  return (
    <section className="set-section">
      <div className="set-section-title">端到端加密</div>
      {!desktop && (
        <div className="set-note">Web 版不支持本地静置加密，请使用桌面版。</div>
      )}

      <div className={`set-status set-status-${state}`}>
        <span className="set-status-dot" />
        <div className="set-status-text">
          <b>
            {state === "off" ? "未开启" : state === "locked" ? "已加密 · 会话已锁定" : "已加密 · 已解锁"}
          </b>
          <span>
            {state === "off"
              ? "笔记以明文存放在本机数据库中。"
              : state === "locked"
                ? "内容不可读，解锁后才会加载；同步在解锁前会被拒绝。"
                : "本机数据库与同步内容均为密文，服务端看不到明文。"}
          </span>
        </div>
      </div>

      {state === "off" && (
        <>
          <div className="set-field">
            <label htmlFor="set-enc-pass">设置口令（至少 8 位）</label>
            <input
              id="set-enc-pass"
              className="set-input"
              type="password"
              autoComplete="new-password"
              placeholder="口令"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              disabled={!desktop}
            />
          </div>
          <div className="set-field">
            <label htmlFor="set-enc-pass2">再输一次</label>
            <input
              id="set-enc-pass2"
              className="set-input"
              type="password"
              autoComplete="new-password"
              placeholder="确认口令"
              value={pass2}
              onChange={(e) => setPass2(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && canEnable && run(() => api.setEncryption(pass), "已开启端到端加密")}
              disabled={!desktop}
            />
            {pass2 && pass !== pass2 && <p className="set-error">两次输入不一致</p>}
          </div>
          <div className="set-danger-note">
            <b>口令即密钥，丢失无法找回。</b>没有任何后门或找回流程——忘记口令等于永久失去这些笔记，请先妥善保存（并建议先做一次备份导出）。
          </div>
          <div className="set-actions">
            <button
              className="set-btn is-primary"
              disabled={!desktop || busy || !canEnable}
              onClick={() => run(() => api.setEncryption(pass), "已开启端到端加密")}
            >
              开启加密
            </button>
          </div>
        </>
      )}

      {state === "locked" && (
        <>
          <div className="set-field">
            <label htmlFor="set-enc-unlock">输入口令解锁</label>
            <input
              id="set-enc-unlock"
              className="set-input"
              type="password"
              placeholder="口令"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && pass && run(() => api.unlockEncryption(pass), "已解锁")}
            />
          </div>
          <div className="set-actions">
            <button className="set-btn is-primary" disabled={busy || !pass} onClick={() => run(() => api.unlockEncryption(pass), "已解锁")}>
              解锁
            </button>
          </div>
        </>
      )}

      {state === "on" && (
        <div className="set-actions">
          <button className="set-btn" disabled={busy} onClick={() => run(() => api.lockEncryption(), "已锁定（下次同步前需解锁）")}>
            立即锁定
          </button>
        </div>
      )}

      {enabled && (
        <div className="set-danger">
          <div className="set-danger-title">危险操作</div>
          {!confirmOff ? (
            <div className="set-danger-row">
              <div className="set-danger-text">
                关闭加密会把全库解密回明文写盘，过程不可中断。
              </div>
              <button className="set-btn is-danger" disabled={busy} onClick={() => setConfirmOff(true)}>
                关闭加密
              </button>
            </div>
          ) : (
            <div className="set-danger-row">
              <div className="set-danger-text">
                确认关闭？之后本机笔记将以<b>明文</b>存放，同步也不再加密。
              </div>
              <div className="set-danger-btns">
                <button className="set-btn" disabled={busy} onClick={() => setConfirmOff(false)}>
                  取消
                </button>
                <button
                  className="set-btn is-danger"
                  disabled={busy}
                  onClick={() => run(() => api.disableEncryption(), "已关闭端到端加密")}
                >
                  确认关闭
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function AboutPane() {
  const openAbout = useEditorStore((s) => s.openAbout);
  const closeSettings = useEditorStore((s) => s.closeSettings);
  const updateAvailable = useEditorStore((s) => s.updateAvailable);
  const latestVersion = useEditorStore((s) => s.latestVersion);
  return (
    <section className="set-section">
      <div className="set-section-title">版本</div>
      <div className="set-row">
        <div className="set-row-text">
          <div className="set-row-name">ShuyoNote v{APP_VERSION}</div>
          <div className="set-row-sub">
            {updateAvailable && latestVersion ? `发现新版本 v${latestVersion}` : "许可证 " + APP_LICENSE}
          </div>
        </div>
        <button
          className={`set-btn${updateAvailable ? " is-primary" : ""}`}
          onClick={() => {
            closeSettings();
            openAbout();
          }}
        >
          {updateAvailable ? "查看更新" : "关于与更新"}
        </button>
      </div>
      <p className="set-hint">
        「关于」里可检查更新、查看开源与反馈链接，并控制是否允许跳转到外部网站（隐私开关）。
      </p>
    </section>
  );
}

// 独立设置中心：左侧标签栏 + 右侧内容。把原先散落在主题弹层里的
// 外观 / 插件 / 端到端加密，以及 AI 配置统一收口，避免「危险开关藏在
// 调色板里」这种语义错位。
export function SettingsDialog() {
  const open = useEditorStore((s) => s.settingsOpen);
  const tab = useEditorStore((s) => s.settingsTab);
  const setTab = useEditorStore((s) => s.setSettingsTab);
  const close = useEditorStore((s) => s.closeSettings);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  if (!open) return null;

  return createPortal(
    <div
      className="set-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="set-dialog" role="dialog" aria-label="设置" aria-modal="true">
        <nav className="set-rail" aria-label="设置分类">
          <div className="set-rail-title">设置</div>
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`set-rail-item${tab === t.id ? " is-on" : ""}`}
              aria-current={tab === t.id}
              onClick={() => setTab(t.id)}
            >
              <span className="set-rail-icon">{t.icon}</span>
              <span className="set-rail-text">
                <span className="set-rail-label">{t.label}</span>
                <span className="set-rail-hint">{t.hint}</span>
              </span>
            </button>
          ))}
        </nav>
        <div className="set-body">
          <header className="set-body-head">
            <div className="set-body-head-text">
              <div className="set-body-title">{TABS.find((t) => t.id === tab)?.label}</div>
              <div className="set-body-desc">{TAB_DESC[tab]}</div>
            </div>
            <button className="set-close" onClick={close} aria-label="关闭设置">×</button>
          </header>
          <div className="set-body-scroll">
            <div className="set-body-inner">
            {tab === "appearance" && <AppearancePane />}
            {tab === "spaces" && <SpacesPane />}
            {tab === "account" && <AccountPane />}
            {tab === "data" && <DataPane />}
            {tab === "plugins" && <PluginsPane />}
            {tab === "security" && <SecurityPane />}
            {tab === "ai" && (
              <section className="set-section set-ai">
                <div className="set-section-title">AI 服务</div>
                <AiSettingsForm onDone={() => {}} showCancel={false} />
              </section>
            )}
            {tab === "about" && <AboutPane />}
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
