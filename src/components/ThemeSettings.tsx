import { useCallback, useEffect, useState } from "react";
import { usePopover } from "../hooks/usePopover";
import { PaletteIcon } from "./icons";
import { ACCENTS, useTheme, type Theme } from "../store/theme";
import { getPlugins, isPluginEnabled, togglePlugin, usePluginRevision } from "../plugins/registry";
import { api } from "../lib/api";
import { toast } from "../store/toast";

const THEMES: { id: Theme; label: string }[] = [
  { id: "system", label: "跟随系统" },
  { id: "light", label: "亮色" },
  { id: "dark", label: "暗色" },
];

// End-to-end encryption settings: enable/disable + session lock/unlock.
function EncryptionSection() {
  const [enabled, setEnabled] = useState(false);
  const [locked, setLocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pass, setPass] = useState("");

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
      refresh();
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="enc-settings">
      <div className="theme-settings-title">端到端加密</div>
      <div className="enc-status-row">
        <span className="enc-status-dot" style={{ background: enabled ? (locked ? "#e6a23c" : "#67c23a") : "#c0c4cc" }} />
        <span className="enc-status-text">
          {enabled ? (locked ? "已加密（会话已锁定）" : "已加密（同步加密）") : "未开启"}
        </span>
      </div>
      {!enabled ? (
        <div className="enc-form">
          <input
            className="db-input"
            type="password"
            placeholder="设置口令（至少 8 位）"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && pass.trim().length >= 8 && run(() => api.setEncryption(pass), "已开启端到端加密")}
          />
          <button
            className="plugin-toggle on"
            disabled={busy || pass.trim().length < 8}
            onClick={() => run(() => api.setEncryption(pass), "已开启端到端加密")}
          >
            开启加密
          </button>
        </div>
      ) : locked ? (
        <div className="enc-form">
          <input
            className="db-input"
            type="password"
            placeholder="输入口令解锁"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && pass && run(() => api.unlockEncryption(pass), "已解锁")}
          />
          <button
            className="plugin-toggle on"
            disabled={busy || !pass}
            onClick={() => run(() => api.unlockEncryption(pass), "已解锁")}
          >
            解锁
          </button>
          <button
            className="plugin-toggle"
            disabled={busy}
            onClick={() => run(() => api.disableEncryption(), "已关闭端到端加密")}
          >
            关闭加密
          </button>
        </div>
      ) : (
        <div className="enc-form">
          <button
            className="plugin-toggle"
            disabled={busy}
            onClick={() => run(() => api.lockEncryption(), "已锁定（下次同步前需解锁）")}
          >
            锁定
          </button>
          <button
            className="plugin-toggle"
            disabled={busy}
            onClick={() => run(() => api.disableEncryption(), "已关闭端到端加密")}
          >
            关闭加密
          </button>
        </div>
      )}
    </div>
  );
}

// Theme settings popover: base theme + accent color (CSS variable override) + plugin toggles.
export function ThemeSettings() {
  const { theme, accent, setTheme, setAccent } = useTheme();
  usePluginRevision();
  const { open, pos, triggerRef, contentRef, toggle, close } = usePopover<HTMLButtonElement>();
  const plugins = getPlugins();

  return (
    <>
      <button ref={triggerRef} className="btn-theme" onClick={toggle} title="主题设置">
        <PaletteIcon />
      </button>
      {open && (
        <div
          ref={contentRef}
          className="theme-settings"
          style={{ position: "fixed", top: pos.top, left: pos.left }}
        >
          <div className="theme-settings-title">基础主题</div>
          <div className="theme-settings-row">
            {THEMES.map((t) => (
              <button
                key={t.id}
                className={`theme-settings-chip ${theme === t.id ? "active" : ""}`}
                onClick={() => setTheme(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="theme-settings-title">强调色</div>
          <div className="theme-settings-row">
            {ACCENTS.map((a) => (
              <button
                key={a.id}
                className={`theme-accent-swatch ${accent === a.id ? "active" : ""}`}
                style={{ background: a.light }}
                title={a.name}
                onClick={() => {
                  setAccent(a.id);
                  close();
                }}
              />
            ))}
          </div>
          <div className="theme-settings-sep" />
          <div className="theme-settings-title">插件</div>
          {plugins.map((p) => (
            <div key={p.id} className="plugin-row">
              <span className="plugin-name">{p.name}</span>
              <button
                className={`plugin-toggle ${isPluginEnabled(p.id) ? "on" : ""}`}
                onClick={() => togglePlugin(p.id)}
              >
                {isPluginEnabled(p.id) ? "启用" : "禁用"}
              </button>
            </div>
          ))}
          <div className="theme-settings-sep" />
          <EncryptionSection />
        </div>
      )}
    </>
  );
}
