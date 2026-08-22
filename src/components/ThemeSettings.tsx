import { usePopover } from "../hooks/usePopover";
import { ACCENTS, useTheme, type Theme } from "../store/theme";
import { getPlugins, isPluginEnabled, togglePlugin, usePluginRevision } from "../plugins/registry";

const THEMES: { id: Theme; label: string }[] = [
  { id: "system", label: "跟随系统" },
  { id: "light", label: "亮色" },
  { id: "dark", label: "暗色" },
];

// Theme settings popover: base theme + accent color (CSS variable override) + plugin toggles.
export function ThemeSettings() {
  const { theme, accent, setTheme, setAccent } = useTheme();
  usePluginRevision();
  const { open, pos, triggerRef, contentRef, toggle, close } = usePopover<HTMLButtonElement>();
  const plugins = getPlugins();

  return (
    <>
      <button ref={triggerRef} className="btn-theme" onClick={toggle} title="主题设置">
        🎨
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
        </div>
      )}
    </>
  );
}
