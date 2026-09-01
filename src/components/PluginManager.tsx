import { useEffect } from "react";
import { platform, isDesktopPlatform } from "../lib/platform";
import { usePlugins } from "../store/plugins";

// Plugin manager: list disk-loaded plugins, enable/disable, install from a folder,
// open the plugin directory, uninstall.
export function PluginManager() {
  const { managerOpen, setManagerOpen, plugins, load, toggle, uninstall, install, openDir } =
    usePlugins();

  useEffect(() => {
    if (managerOpen) load();
  }, [managerOpen, load]);

  if (!managerOpen) return null;

  const pickInstall = async () => {
    const sel = await platform.dialog.open({ multiple: false, directory: true, title: "选择插件目录" });
    if (typeof sel === "string") await install(sel);
  };

  return (
    <div className="plugin-manager-overlay" onClick={() => setManagerOpen(false)}>
      <div className="plugin-manager" onClick={(e) => e.stopPropagation()}>
        <div className="pm-head">
          <div className="pm-title">插件管理</div>
          <div className="pm-actions">
            <button onClick={pickInstall} title="从本地文件夹安装插件">从文件夹安装</button>
            <button onClick={openDir} title="在文件管理器中打开插件目录">打开插件目录</button>
            <button className="pm-close" title="关闭" onClick={() => setManagerOpen(false)}>
              ×
            </button>
          </div>
        </div>
        {!isDesktopPlatform() && (
          <div className="sync-web-note">Web 版不支持磁盘插件（受限 JS 运行时），请使用桌面版。</div>
        )}
        {plugins.length === 0 ? (
          <div className="pm-empty">未发现插件 · 可从文件夹安装，或把插件放入插件目录</div>
        ) : (
          plugins.map((p) => (
            <div key={p.id} className="pm-item">
              <div className="pm-item-info">
                <div className="pm-item-name">
                  {p.name}
                  <span className="pm-item-ver">v{p.version}</span>
                </div>
                <div className="pm-item-desc">{p.description || "—"}</div>
                <div className="pm-item-cmds">{p.commands.length} 个命令</div>
              </div>
              <div className="pm-item-actions">
                <button onClick={() => toggle(p.id)}>{p.enabled ? "禁用" : "启用"}</button>
                <button className="danger" onClick={() => uninstall(p.id)}>
                  卸载
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
