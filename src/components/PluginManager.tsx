import { useEffect } from "react";
import { platform, isDesktopPlatform } from "../lib/platform";
import { confirmDialog } from "../store/confirm";
import { usePlugins } from "../store/plugins";

// Plugin manager: list disk-loaded plugins, enable/disable, install from a folder,
// open the plugin directory, uninstall.
export function PluginManager() {
  const {
    managerOpen, setManagerOpen, plugins, load, toggle, uninstall, install, openDir,
    logsFor, logs, openLogs, closeLogs, clearLogs,
  } = usePlugins();

  useEffect(() => {
    if (managerOpen) load();
  }, [managerOpen, load]);

  if (!managerOpen) return null;

  const pickInstall = async () => {
    const sel = await platform.dialog.open({ multiple: false, directory: true, title: "选择插件目录" });
    if (typeof sel === "string") await install(sel);
  };

  // 卸载在磁盘上是 `remove_dir_all`，删掉就找不回来，所以和仓库里其它破坏性操作
  // 一样先确认；失败文案由 store 统一弹 toast（含后端原始错误文本）。
  const uninstallWithConfirm = async (id: string, name: string) => {
    if (
      !(await confirmDialog({
        title: "卸载插件",
        message: `卸载插件「${name}」？插件目录将被删除，此操作不可恢复。`,
        danger: true,
      }))
    )
      return;
    await uninstall(id);
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
                {/* 插件运行时连 console 都没有，__log/__toast 是作者唯一的排错手段，
                    所以日志必须有个能看的地方。 */}
                <button
                  onClick={() => (logsFor === p.id ? closeLogs() : openLogs(p.id))}
                  title="查看这个插件的日志（__log / __toast）"
                >
                  {logsFor === p.id ? "收起日志" : "日志"}
                </button>
                <button className="danger" onClick={() => uninstallWithConfirm(p.id, p.name)}>
                  卸载
                </button>
              </div>
              {logsFor === p.id && (
                <div className="pm-logs">
                  {logs.length === 0 ? (
                    <div className="pm-log-empty">
                      暂无日志 · 插件可用 <code>__log("info", "…")</code> 或 <code>__toast("…")</code> 写日志
                    </div>
                  ) : (
                    logs.map((l, i) => (
                      <div key={`${l.at_ms}-${i}`} className={`pm-log pm-log-${l.level}`}>
                        <span className="pm-log-time">
                          {new Date(l.at_ms).toLocaleTimeString()}
                        </span>
                        <span className="pm-log-level">{l.level}</span>
                        <span className="pm-log-msg">{l.message}</span>
                      </div>
                    ))
                  )}
                  <div className="pm-log-actions">
                    <button onClick={() => clearLogs()}>清空日志</button>
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
