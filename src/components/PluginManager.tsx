import { useEffect, useState } from "react";
import { platform, isDesktopPlatform } from "../lib/platform";
import { confirmDialog } from "../store/confirm";
import { usePlugins } from "../store/plugins";
import { viewPlacement } from "../lib/pluginViews";
import { pluginMenuHosted, pluginMenuTitle } from "../lib/capabilities/menus.meta";
import { auditDetail, auditStatus, auditTitle } from "../lib/pluginAudit";
import { PluginFieldInput } from "./PluginFieldInput";
import { PluginIndexPanel } from "./PluginIndexPanel";
import { approvalDetail, approvalLabel } from "../lib/pluginApproval";
import { revocationNotice, revokedKeyNotice, runtimeLabel, sourceLabel } from "../lib/pluginIndex";
import { formatBytes } from "../lib/pluginAudit";

// Plugin manager: list disk-loaded plugins, enable/disable, install from a folder,
// open the plugin directory, uninstall.
export function PluginManager() {
  const {
    managerOpen, setManagerOpen, plugins, load, toggle, uninstall, install, openDir,
    logsFor, logs, openLogs, closeLogs, clearLogs,
    auditFor, audit, openAudit, closeAudit, clearAudit,
    ignoreRevocation, ignoreRevokedKey,
    factsFor, facts, openFacts, closeFacts,
    validations, verify, closeVerify, autoReloadedAt, watchPluginDir,
    settingsFor, settings, openSettings, closeSettings, saveSetting,
    approve,
  } = usePlugins();

  useEffect(() => {
    if (managerOpen) load();
  }, [managerOpen, load]);

  // 热重载：面板打开期间低频轮询插件目录指纹，作者改完文件（或放了新插件目录）就
  // 自动重扫，不必手动开关面板或重启应用。1.5s 一次只做一次 read_dir + 元数据，
  // 代价可以忽略；关掉面板即停止轮询。
  // 设置表单的草稿值：**必须受控**（否则输入框不显示你敲的字，而"保存"读到的是旧值——
  // 这种"看着在改、其实没改"的错法比直接报错更难发现）。
  const [draft, setDraft] = useState<Record<string, string | boolean>>({});
  useEffect(() => {
    if (!settingsFor) return;
    const init: Record<string, string | boolean> = {};
    for (const st of settings) {
      if (st.type === "boolean") init[st.key] = st.value === "true" || (st.value === null && st.default === true);
      else init[st.key] = st.value ?? (st.default === undefined || st.default === null ? "" : String(st.default));
    }
    setDraft(init);
  }, [settingsFor, settings]);

  useEffect(() => {
    if (!managerOpen) return;
    watchPluginDir();
    const t = window.setInterval(() => watchPluginDir(), 1500);
    return () => window.clearInterval(t);
  }, [managerOpen, watchPluginDir]);

  if (!managerOpen) return null;

  const pickInstall = async () => {
    const sel = await platform.dialog.open({ multiple: false, directory: true, title: "选择插件目录" });
    if (typeof sel === "string") await install(sel);
  };

  // .zip 插件包走的是同一条安装路径（先校验后落盘），只是多了一步解包。
  const pickInstallZip = async () => {
    const sel = await platform.dialog.open({
      multiple: false,
      title: "选择插件包（.zip）",
      filters: [{ name: "插件包", extensions: ["zip"] }],
    });
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
          <div className="pm-title">
            <svg className="pm-mark" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
              <rect x="3" y="3" width="18" height="18" rx="5" fill="none" stroke="currentColor" strokeWidth="2" />
              <rect x="8.5" y="8.5" width="7" height="7" rx="2" fill="currentColor" />
            </svg>
            {/* 标题文字单独包一层并禁止折行：窄窗口下它曾被挤成「插件 / 管理」两行
                （`.pm-title` 是 flex 容器，文字是匿名 flex 项，会跟着换行）。
                徽章可以折到下一行，标题本身不行。 */}
            <span className="pm-title-text">插件管理</span>
            {plugins.length > 0 && <span className="pm-count">{plugins.length} 个已装</span>}
            {/* 作者循环的可见反馈：文件改动被自动识别时给出时间，而不是"悄悄变了" */}
            {autoReloadedAt && (
              <span className="pm-autoreload">
                已自动重新扫描 {new Date(autoReloadedAt).toLocaleTimeString()}
              </span>
            )}
          </div>
          <div className="pm-actions">
            <button onClick={pickInstall} title="从本地文件夹安装插件">从文件夹安装</button>
            <button onClick={pickInstallZip} title="安装一个 .zip 插件包">装 zip 包</button>
            <button onClick={openDir} title="在文件管理器中打开插件目录">打开插件目录</button>
            <button className="pm-close" title="关闭" onClick={() => setManagerOpen(false)}>
              ×
            </button>
          </div>
        </div>
        {/* 头部固定、只有这一块滚动：插件多起来时标题与"装 zip 包"这些入口不该跟着滚走。 */}
        <div className="pm-body">
        {!isDesktopPlatform() ? (
          <div className="sync-web-note">Web 版不支持磁盘插件（受限 JS 运行时），请使用桌面版。</div>
        ) : (
          <details className="pm-index-fold">
            <summary title="用一个索引地址安装插件（自托 / 社区索引）">从索引安装（给 URL）</summary>
            <PluginIndexPanel />
          </details>
        )}
        {plugins.length === 0 ? (
          <div className="pm-empty">未发现插件 · 可从文件夹安装，或把插件放入插件目录</div>
        ) : (
          <div className="pm-list">
          {plugins.map((p) => (
            <div key={p.id} className={`pm-item ${p.enabled ? "pm-on" : "pm-off"}`}>
              <div className="pm-item-info">
                {/* 卡片抬头：名字与"启没启用"在同一行，状态不靠读按钮文字 */}
                <div className="pm-item-head">
                  <div className="pm-item-name">
                    {p.name}
                    <span className="pm-item-ver">v{p.version}</span>
                    <span className={`pm-item-runtime pm-rt-${p.runtime === "declarative" ? "decl" : "code"}`}>
                      {runtimeLabel(p.runtime)}
                    </span>
                  </div>
                  <span className={`pm-state ${p.enabled ? "pm-state-on" : "pm-state-off"}`}>
                    {p.enabled ? "已启用" : "已禁用"}
                  </span>
                </div>
                {/* 机器可核对的那几项放一行小字：id 用等宽（要和目录名对上），命令数用词 */}
                <div className="pm-item-meta">
                  <code className="pm-item-id" title="插件 id（等于插件目录名）">{p.id}</code>
                  <span className="pm-item-cmds">{p.commands.length} 个命令</span>
                </div>
                <div className="pm-item-desc">{p.description || "—"}</div>
                {/* 撤回记忆（M11.11b 第一块）：索引说过这个版本不该再用，宿主已经拦下运行。
                    给两个出口：仍然使用（明确表态）或卸载。索引拥有者不是用户的上司，
                    所以"仍然使用"这条路必须存在，但要说清它意味着什么。 */}
                {p.revoked &&
                  (() => {
                    const notice = revocationNotice(p.revoked);
                    return (
                      <div className={notice.blocked ? "pm-revoked" : "pm-revoked pm-revoked-ignored"}>
                        <div className="pm-revoked-text">{notice.text}</div>
                        {!p.revoked!.ignored && (
                          <button
                            className="pm-revoked-btn"
                            onClick={() => void ignoreRevocation(p.id)}
                            title="索引拥有者认为它不该再跑；这个按钮表示你选择相信自己的判断"
                          >
                            仍然使用
                          </button>
                        )}
                      </div>
                    );
                  })()}
                {/* 发布者密钥被撤回：比"某个版本被撤回"更重（这把 key 签的都不作数了）。 */}
                {p.publisher_key_revoked &&
                  (() => {
                    const notice = revokedKeyNotice(p.publisher_key_revoked);
                    return (
                      <div className={notice.blocked ? "pm-revoked" : "pm-revoked pm-revoked-ignored"}>
                        <div className="pm-revoked-text">{notice.text}</div>
                        {!p.publisher_key_revoked!.ignored && (
                          <button
                            className="pm-revoked-btn"
                            onClick={() =>
                              void ignoreRevokedKey(p.publisher_key_revoked!.fingerprint, p.name)
                            }
                            title="索引认为这把密钥签的东西都不该再用；这个按钮表示你选择相信自己的判断"
                          >
                            仍然使用
                          </button>
                        )}
                      </div>
                    );
                  })()}
                {/* 声明扩张过：宿主已经暂停它了，这里说清新增了什么 + 给唯一的放行按钮。
                    刻意不叫"启用"——用户要做的是"看了新增项再确认"，不是一个无关开关。 */}
                {p.approval?.required && (
                  <div className="pm-approval">
                    <div className="pm-approval-text">{approvalDetail(p)}</div>
                    <button className="pm-approval-btn" onClick={() => void approve(p.id)}>
                      {approvalLabel()}并继续运行
                    </button>
                  </div>
                )}
                {/* 四组授权块（权限 / 会自动运行 / 命令出现在哪 / 会接住哪些文件）原来各自摊开，
                    叠起来就是"一堵墙"，把操作按钮一路往下推。
                    收进一个折叠区；但**默认收起不等于藏起来**：未启用的插件在标题上直说
                    "启用前请看这里"——原设计（新装默认禁用、用户看完再启用）不能因为美化而破掉。
                    不用 React 控制 open，避免把用户手动展开的状态顶回去。 */}
                <details className="pm-perms-fold">
                  <summary>
                    它要什么权限、会在什么时候跑
                    {!p.enabled && <span className="pm-fold-warn">启用前请看这里</span>}
                  </summary>
                {/* 权限 + 理由必须摊在用户面前：新装的插件默认禁用，用户看完再启用。 */}
                {p.permissions.length === 0 ? (
                  <div className="pm-item-perms">不需要任何权限</div>
                ) : (
                  <div className="pm-item-perms">
                    需要权限：
                    {p.permissions.map((perm) => (
                      <span key={perm.id} className={`pm-perm${perm.risk === "high" ? " pm-perm-high" : ""}`} title={perm.reason || perm.id}>
                        {perm.title}
                      </span>
                    ))}
                    {p.permissions_baseline && (
                      <span className="pm-perm-baseline">旧插件：未声明权限，按基线授权</span>
                    )}
                  </div>
                )}
                {/* 事件和权限是同一类授权：用户没点命令时它也会跑代码，必须在启用前看到。 */}
                {p.events.length > 0 && (
                  <div className="pm-item-perms">
                    会在这些时候自动运行：
                    {p.events.map((ev) => (
                      <span key={ev.id} className="pm-perm" title={ev.reason || ev.id}>
                        {ev.title}
                      </span>
                    ))}
                  </div>
                )}
                {/* 命令挂在哪个入口也是"这个插件会干什么"的一部分：`page.context` 会让
                    页面列表的行菜单里多出东西，不说的话用户只会觉得"菜单里怎么多了个选项"。
                    标题从注册表生成物取（lib/capabilities/menus.meta），不手抄。 */}
                {(() => {
                  const hosted = Array.from(
                    new Set(
                      (p.commands ?? []).flatMap((c) => (c.menus ?? []).filter((m) => pluginMenuHosted(m))),
                    ),
                  );
                  if (hosted.length === 0) return null;
                  return (
                    <div className="pm-item-perms">
                      命令会出现在：
                      {hosted.map((m) => (
                        <span key={m} className="pm-perm" title={m}>
                          {pluginMenuTitle(m)}
                        </span>
                      ))}
                    </div>
                  );
                })()}
                {/* 声明式视图也是"这个插件会干什么"的一部分：用户该在启用前就知道
                    它会往哪儿加东西——尤其是 `placement: "rail"`，那是**界面右侧多一个按钮**，
                    不说的话用户只会看到一个不明来历的图标。 */}
                {(p.views ?? []).length > 0 && (
                  <div className="pm-item-perms">
                    会加上这些视图：
                    {(p.views ?? []).map((v) => (
                      <span
                        key={v.id}
                        className="pm-perm"
                        title={
                          viewPlacement(v) === "rail"
                            ? "常驻面板：出现在右侧竖条上，与正文并排（点行不关面板）"
                            : "浮层：从命令面板打开，看完关掉"
                        }
                      >
                        {v.title || v.id}（{viewPlacement(v) === "rail" ? "右侧常驻面板" : "浮层"}）
                      </span>
                    ))}
                  </div>
                )}
                {/* 导入触发同样是"这个插件会干什么"的一部分：用户该在启用前就知道
                    命令面板里会多出哪些入口、它们接住哪些文件。 */}
                {(p.triggers ?? []).length > 0 && (
                  <div className="pm-item-perms">
                    会接住这些文件：
                    {(p.triggers ?? []).map((tg) => (
                      <span key={`${tg.kind}:${tg.command}:${tg.extensions.join(",")}`} className="pm-perm" title={`导入触发：选中文件后由宿主读取内容，交给命令 ${tg.command}`}>
                        {tg.extensions.join(" / ")}
                      </span>
                    ))}
                  </div>
                )}
                </details>
              </div>
              <div className="pm-item-actions">
                <button onClick={() => toggle(p.id)}>{p.enabled ? "禁用" : "启用"}</button>
                {/* 插件运行时连 console 都没有，__log/__toast 是作者唯一的排错手段，
                    所以日志必须有个能看的地方。 */}
                <button
                  onClick={() => (logsFor === p.id ? closeLogs() : openLogs(p.id))}
                  title="查看这个插件的日志（api.log / api.notify）"
                >
                  {logsFor === p.id ? "收起日志" : "日志"}
                </button>
                {/* 事实清单：来源、体积、声明、静态扫描看得出来的事——只摆事实，不评分。 */}
                <button
                  onClick={() => (factsFor === p.id ? closeFacts() : void openFacts(p.id))}
                  title="这个插件可查证的事实（来源、体积、声明、静态扫描结果）——只摆事实，不给结论"
                >
                  {factsFor === p.id ? "收起事实" : "事实"}
                </button>
                {/* 能力调用审计：它碰过哪些权限、有没有被拒（权限被拒的记录最该看）。 */}
                <button
                  onClick={() => (auditFor === p.id ? closeAudit() : openAudit(p.id))}
                  title="查看这个插件调用过哪些能力、有没有被权限拦下"
                >
                  {auditFor === p.id ? "收起活动" : "活动"}
                </button>
                {/* 设置：用户在宿主界面填、插件只读（api.settings.get）——写只发生在这一处。 */}
                <button
                  onClick={() => (settingsFor === p.id ? closeSettings() : openSettings(p.id))}
                  title="这个插件声明的可配置项（值存在插件自己的数据里）"
                >
                  {settingsFor === p.id ? "收起设置" : "设置"}
                </button>
                {/* 作者工具链：一次列出全部问题（manifest / 权限 / Boa 语法 / 命令注册），
                    走的是与加载器同一条路径，所以"校验通过"= 应用能装能跑。 */}
                <button
                  onClick={() => (validations[p.id] ? closeVerify(p.id) : verify(p.id))}
                  title="校验这个插件：manifest、权限与理由、JS 语法、命令注册"
                >
                  {validations[p.id] ? "收起校验" : "校验"}
                </button>
                <button className="danger" onClick={() => uninstallWithConfirm(p.id, p.name)}>
                  卸载
                </button>
              </div>
              {auditFor === p.id && (
                <div className="pm-logs">
                  {audit.length === 0 ? (
                    <div className="pm-log-empty">暂无活动记录</div>
                  ) : (
                    audit.map((a, i) => (
                      <div key={`${a.at_ms}-${i}`} className={`pm-log ${a.ok ? "" : "pm-log-error"}`}>
                        <span className="pm-log-time">{new Date(a.at_ms).toLocaleTimeString()}</span>
                        <span className="pm-log-level">{auditStatus(a)}</span>
                        <span className="pm-log-msg">
                          {auditTitle(a)}
                          {auditDetail(a) && <span className="pm-log-scope">（{auditDetail(a)}）</span>}
                        </span>
                      </div>
                    ))
                  )}
                  <div className="pm-log-actions">
                    <button onClick={() => clearAudit()}>清空活动</button>
                  </div>
                </div>
              )}
              {settingsFor === p.id && (
                <div className="pm-settings">
                  {settings.length === 0 ? (
                    <div className="pm-log-empty">这个插件没有声明任何可配置项</div>
                  ) : (
                    settings.map((st) => (
                      <div key={st.key} className="pm-setting-row">
                        <span className="pm-setting-label" title={st.description || st.key}>
                          {st.label}
                          <span className="pm-setting-scope">{st.scope === "app" ? "应用级（明文）" : "本空间（加密）"}</span>
                        </span>
                        <PluginFieldInput
                          field={{
                            name: st.key,
                            label: st.label,
                            type: st.type,
                            required: false,
                            placeholder: st.description,
                            options: st.options,
                            default: st.default,
                          }}
                          value={draft[st.key] ?? ""}
                          onChange={(v) => {
                            setDraft((d) => ({ ...d, [st.key]: v }));
                            // 复选框没有"保存"按钮可点：勾了就是决定了，立刻落库。
                            if (st.type === "boolean") void saveSetting(p.id, st.key, v === true ? "true" : "false");
                          }}
                          onSubmit={() => void saveSetting(p.id, st.key, String(draft[st.key] ?? ""))}
                        />
                        {st.type !== "boolean" && (
                          <button
                            className="pm-setting-save"
                            onClick={() => void saveSetting(p.id, st.key, String(draft[st.key] ?? ""))}
                            title="保存这一项"
                          >
                            保存
                          </button>
                        )}
                      </div>
                    ))
                  )}
                  {settings.some((x) => x.scope === "app") && (
                    <div className="pm-setting-warn">
                      标记「应用级（明文）」的项存在 meta.db，不随空间加密——别往里放 token 这类东西。
                    </div>
                  )}
                </div>
              )}
              {validations[p.id] &&
                (() => {
                  const v = validations[p.id];
                  const errors = v.problems.filter((x) => x.severity === "error").length;
                  return (
                    <div className="pm-verify">
                      <div className="pm-verify-head">
                        {v.ok ? (
                          <span className="pm-verify-ok">✓ 校验通过</span>
                        ) : (
                          <span className="pm-verify-bad">✗ {errors} 个错误</span>
                        )}
                        <span className="pm-verify-meta">
                          API {v.api_version} · 入口 {v.main}（{(v.entry_bytes / 1024).toFixed(1)} KiB）·{" "}
                          {v.commands.length} 个命令
                        </span>
                      </div>
                      {v.commands.length > 0 && (
                        <div className="pm-verify-line">
                          命令：{v.commands.map((c) => (c.title ? `${c.title}（${c.id}）` : c.id)).join("、")}
                        </div>
                      )}
                      <div className="pm-verify-line">
                        实际授予 {v.granted.length} 项：{v.granted.join("、") || "（无）"}
                        {v.permissions_baseline && "（未声明 permissions → 按 v1 基线授权）"}
                      </div>
                      {v.permissions.some((x) => !x.known) && (
                        <div className="pm-verify-warn">
                          有权限本版本不认识，会被忽略：
                          {v.permissions
                            .filter((x) => !x.known)
                            .map((x) => x.id)
                            .join("、")}
                        </div>
                      )}
                      {v.problems.length === 0 ? (
                        <div className="pm-problem pm-problem-ok">没有发现问题</div>
                      ) : (
                        v.problems.map((pr, i) => (
                          <div key={`${pr.code}-${i}`} className={`pm-problem pm-problem-${pr.severity}`}>
                            <span className="pm-problem-code">[{pr.code}]</span>
                            <span className="pm-problem-msg">{pr.message}</span>
                            {pr.file && <span className="pm-problem-file">{pr.file}</span>}
                          </div>
                        ))
                      )}
                    </div>
                  );
                })()}
              {factsFor === p.id && (
                <div className="pm-facts">
                  {/* 一句必要的说明：这不是安全分析，也抓不住聪明的恶意代码——
                      一个假的安全感比没有更糟，所以边界要先讲清楚。 */}
                  <div className="pm-facts-note">
                    这是「事实清单」，不是安全评分：只列出可查证的东西，判断留给你。
                    它抓不住真正聪明的恶意代码。
                  </div>
                  {!facts ? (
                    <div className="pm-facts-empty">读取中…</div>
                  ) : (
                    <>
                      <div className="pm-facts-row">
                        <span className="pm-facts-key">来源</span>
                        <span className="pm-facts-val">
                          {sourceLabel(facts.source)}
                          {facts.version ? ` · v${facts.version}` : ""}
                          {` · ${facts.runtime === "declarative" ? "零代码" : "有代码"}`}
                        </span>
                      </div>
                      <div className="pm-facts-row">
                        <span className="pm-facts-key">体积</span>
                        <span className="pm-facts-val">
                          {formatBytes(facts.totalBytes)} · {facts.fileCount} 个文件 · 入口{" "}
                          {formatBytes(facts.mainBytes)}
                        </span>
                      </div>
                      <div className="pm-facts-row">
                        <span className="pm-facts-key">声明</span>
                        <span className="pm-facts-val">
                          {facts.declaredPermissions.length === 0
                            ? "不申请任何数据权限"
                            : `${facts.declaredPermissions.length} 项权限：${facts.declaredPermissions.join(" / ")}`}
                          {facts.baselinePermissions && "（按基线全给）"}
                          {facts.events.length > 0 &&
                            ` · 订阅 ${facts.events.length} 个事件（没点命令时也会跑代码）：${facts.events.join(" / ")}`}
                        </span>
                      </div>
                      {facts.facts.map((f) => (
                        <div key={f.code + f.text} className="pm-facts-item">
                          {f.text}
                        </div>
                      ))}
                    </>
                  )}
                </div>
              )}
              {logsFor === p.id && (
                <div className="pm-logs">
                  {logs.length === 0 ? (
                    <div className="pm-log-empty">
                      暂无日志 · 插件可用 <code>api.log("…")</code> 或 <code>api.notify("…")</code> 写日志
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
          ))}
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
