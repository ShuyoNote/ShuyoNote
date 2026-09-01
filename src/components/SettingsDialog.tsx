import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useEditorStore, type SettingsTab } from "../store/editor";
import { ACCENTS, useTheme, type Theme } from "../store/theme";
import { getPlugins, isPluginEnabled, togglePlugin, usePluginRevision } from "../plugins/registry";
import { AiSettingsForm } from "./AiSettingsForm";
import { api } from "../lib/api";
import { isDesktopPlatform } from "../lib/platform";
import { toast } from "../store/toast";
import { APP_VERSION, APP_LICENSE } from "../lib/links";

const THEMES: { id: Theme; label: string }[] = [
  { id: "system", label: "跟随系统" },
  { id: "light", label: "亮色" },
  { id: "dark", label: "暗色" },
];

const TABS: { id: SettingsTab; label: string; hint: string }[] = [
  { id: "appearance", label: "外观", hint: "主题与强调色" },
  { id: "plugins", label: "插件", hint: "启用/禁用扩展" },
  { id: "security", label: "安全", hint: "端到端加密与锁定" },
  { id: "ai", label: "AI", hint: "服务商与模型" },
  { id: "about", label: "关于与更新", hint: "版本与许可" },
];

function AppearancePane() {
  const { theme, accent, setTheme, setAccent } = useTheme();
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
    </>
  );
}

function PluginsPane() {
  usePluginRevision();
  const plugins = getPlugins();
  return (
    <section className="set-section">
      <div className="set-section-title">已安装插件</div>
      <div className="set-list">
        {plugins.map((p) => (
          <div key={p.id} className="set-row">
            <div className="set-row-text">
              <div className="set-row-name">{p.name}</div>
              <div className="set-row-sub">{p.commands?.length ?? 0} 个命令</div>
            </div>
            <button
              className={`set-toggle${isPluginEnabled(p.id) ? " is-on" : ""}`}
              role="switch"
              aria-checked={isPluginEnabled(p.id)}
              onClick={() => togglePlugin(p.id)}
            >
              {isPluginEnabled(p.id) ? "已启用" : "已禁用"}
            </button>
          </div>
        ))}
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
              <span className="set-rail-label">{t.label}</span>
              <span className="set-rail-hint">{t.hint}</span>
            </button>
          ))}
        </nav>
        <div className="set-body">
          <header className="set-body-head">
            <div className="set-body-title">{TABS.find((t) => t.id === tab)?.label}</div>
            <button className="set-close" onClick={close} aria-label="关闭设置">×</button>
          </header>
          <div className="set-body-scroll">
            {tab === "appearance" && <AppearancePane />}
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
    </div>,
    document.body,
  );
}
