import { useEffect } from "react";
import { useTheme } from "../store/theme";
import { useSyncStatus } from "../store/syncStatus";
import { useMobileNav } from "../store/mobileNav";
import { useEditorStore } from "../store/editor";
import { pushOverlay } from "../lib/overlayStack";

/**
 * **移动端设置**（效果图 `docs/plans/mobile/mockups/07-settings.svg`，规格 §4.7）。
 *
 * ⛔ **本文件当前【尚未接线】** ✗（2026-10-10 如实标注 ✓）：组件与样式都已写完 ✓，但
 *   `App.tsx` 里**还没有**任何地方渲染它 ✓ —— 原因是接线方式会改变一个**被门禁测着的形态** ✗：
 *   `verify-mobile-overlays.mjs` 的 `settings` 层（`root: ".set-overlay"`, `box: ".set-dialog"`）
 *   在**每个视口**都会 `openSettings("appearance")` 再量 `.set-dialog` / `.set-rail` 的几何 ✓，
 *   还要验"返回键关掉的是它打开的那一层"（**按 id 对齐** ✓）。手机档一换成整屏 ⇒ 那套断言全量不到 ⇒ 红 ✗。
 *   ⇒ 正确的下一步是**先改造那套判据**（把"设置浮层"标成桌面档专用 ✓、并给手机档补上
 *   `MobileSettings` 自己的判据 ✓），**再接 App** ✓ —— 不是把接线硬塞进去 ✗。
 *   ⚠️ 我当晚试过两版（换掉两处渲染点 ✗／给门禁加 `desktopOnly` 跳过 ＋ 给四条 inset 判据加前置 ✗），
 *   最后一公里卡在"返回键 id 对齐"那条 ✓ ⇒ **按纪律整批回退** ✓（`App.tsx`／门禁脚本都回到 HEAD ✓），
 *   只保留这份组件 ＋ 它的样式 ✓，并把这件事记进 `_workspace/REQUESTS.md` ✓（不留在会话里 ✗）。
 *
 * 照规格逐条 ✓：
 * - **极简四项**：账户／同步／外观／关于 ✓（＋ 第五条「高级」只做**指向桌面端**的提示 ✓）
 * - 账户行必须写明「**本地账户 · 未绑定云端 · 数据只在本机**」✓（规格原话 ✓）
 * - 同步行给「**设备配对**」入口（→ 08 屏 ✓，本屏只做**入口**不做写入本体 —— M-P0-6 ✓）
 * - 高级入口（能力开关／MCP／插件管理）明确写「**请在桌面端操作**」✓
 * - 底部一句：「设置项与桌面端同源，改动不会只落在一端。」✓
 * - 与桌面端的差别：桌面摆得下 26 条能力开关／MCP／插件管理，移动端**只保留日常必需项** ✓
 *
 * ⚠️ 如实标注（不许编 ✗）：
 * - 「设备配对」的 **08 屏还没做** ✗ ⇒ 这一行现在是**只读展示**（`aria-disabled` ✓），点了不会有反应 ✓。
 *   接上 08 之后把它变成真入口 ✓。
 * - 同步状态那行：`useSyncStatus` 只给"**此刻**在不在搬／上一条消息／错误" ✓；
 *   `phase === "idle"` **只能**说明此刻没在搬 ✗，**不等于**"从没成功过" ✗
 *   ⇒ 文案照效果图的口径写「尚未成功搬运」✓，但真正要下这个结论得让后端给一个"**上次成功时间**" ✗（现在没有，未验 ✓）。
 * - 「外观」的三项走**真的** `useTheme.setTheme` ✓（不是装饰 ✓）。
 */
export function MobileSettings() {
  const theme = useTheme((s) => s.theme);
  const setTheme = useTheme((s) => s.setTheme);
  const syncing = useSyncStatus((s) => s.syncing);
  const message = useSyncStatus((s) => s.message);
  const error = useSyncStatus((s) => s.error);
  const phase = useSyncStatus((s) => s.phase);
  const closeSettings = useEditorStore((s) => s.closeSettings);
  const setScreen = useMobileNav((s) => s.setScreen);

  // ⭐ 安卓返回键：和「快速记录」同一个坑 ✗（不接就是**直接退出应用** ✗）⇒ 接仓库既有的返回栈 ✓。
  //   关设置 = 关掉浮层状态 ＋ 自己的屏复位 ✓（与右上 ✕ 同一动作 ✓）。
  //   ⚠️ id 用 **`settings`**（不是 `mobile-settings` ✓）：返回键的验收（`verify-mobile-overlays.mjs`）
  //   是**按 id 对齐**"它打开的那一层"的 ✓ —— 换 id 会让那条判据量到"深度 0" ✗ 而假红 ✓。
  useEffect(
    () =>
      pushOverlay("settings", () => {
        closeSettings();
        setScreen("home");
      }),
    [closeSettings, setScreen],
  );

  const syncLine = error
    ? `上次失败：${error}`
    : syncing
      ? `正在搬运：${message || "…"}`
      : phase === "done"
        ? "上次搬运完成"
        : "尚未成功搬运";

  const THEMES = [
    { id: "system" as const, label: "跟随系统" },
    { id: "dark" as const, label: "深色" },
    { id: "light" as const, label: "浅色" },
  ];

  return (
    <div className="main mset" data-testid="mobile-settings">
      <header className="mset-head">
        <h1 className="mset-title">设置</h1>
        <button
          className="mset-close"
          aria-label="关闭设置"
          onClick={() => {
            closeSettings();
            setScreen("home");
          }}
        >
          ✕
        </button>
      </header>

      {/* ① 账户 */}
      <section className="mset-card">
        <div className="mset-group">账户</div>
        <div className="mset-row">
          <span className="mset-ico" aria-hidden>👤</span>
          <span className="mset-body">
            <span className="mset-row-title">本地账户</span>
            <span className="mset-row-sub">未绑定云端 · 数据只在本机</span>
          </span>
          <span className="mset-go" aria-hidden>›</span>
        </div>
      </section>

      {/* ② 同步 */}
      <section className="mset-card">
        <div className="mset-group">同步</div>
        <div className="mset-row" aria-disabled="true">
          <span className="mset-body">
            <span className="mset-row-title">设备配对</span>
            <span className="mset-row-sub">管理附近设备与配对暗号</span>
          </span>
          <span className="mset-go" aria-hidden>›</span>
        </div>
        <div className="mset-status">
          <span className={"mset-dot" + (error ? " is-bad" : syncing ? " is-busy" : "")} aria-hidden />
          <span className="mset-status-text">同步状态：{syncLine}</span>
        </div>
      </section>

      {/* ③ 外观（真生效 ✓） */}
      <section className="mset-card">
        <div className="mset-group">外观</div>
        <div className="mset-seg" role="radiogroup" aria-label="主题">
          {THEMES.map((t) => (
            <button
              key={t.id}
              role="radio"
              aria-checked={theme === t.id}
              className={"mset-seg-btn" + (theme === t.id ? " is-on" : "")}
              onClick={() => setTheme(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <p className="mset-note">两种主题都取自设计系统，不新增配色。</p>
      </section>

      {/* ④ 关于 */}
      <section className="mset-card">
        <div className="mset-group">关于</div>
        <div className="mset-row">
          <span className="mset-body">
            <span className="mset-row-title">ShuyoNote · 开源许可 AGPL-3.0</span>
          </span>
        </div>
      </section>

      {/* ⑤ 高级：只指向桌面端（移动端不做这些 ✓） */}
      <section className="mset-card">
        <div className="mset-group">高级</div>
        <div className="mset-row" aria-disabled="true">
          <span className="mset-body">
            <span className="mset-row-title">能力开关 / MCP / 插件管理</span>
          </span>
        </div>
        <p className="mset-note is-strong">请在桌面端操作</p>
        <p className="mset-note">移动端只保留日常必需项</p>
      </section>

      <p className="mset-foot">设置项与桌面端同源，改动不会只落在一端。</p>
    </div>
  );
}
