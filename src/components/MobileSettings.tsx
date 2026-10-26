import { useEffect, useState } from "react";
import { useTheme } from "../store/theme";
import { useSyncStatus } from "../store/syncStatus";
import { useMobileNav } from "../store/mobileNav";
import { useEditorStore } from "../store/editor";
import { useSpaceStore } from "../store/space";
import { useNotes } from "../store/notes";
import { isDesktopPlatform } from "../lib/platform";
import { exportCurrentSpace, importSpacePackage } from "../lib/spaceTransfer";
import { pushOverlay } from "../lib/overlayStack";
import { SyncPanel } from "./SyncPanel";
import { MobileSpaceSheet } from "./MobileSpaceSheet";
import { AlertTriangleIcon, CheckIcon, ChevronRightIcon, DeviceIcon, DownloadIcon, InfoIcon, LayersIcon, SwapIcon, UploadIcon, UserIcon, XIcon } from "./icons";
import { api } from "../lib/api";

/**
 * **移动端设置**（效果图 `docs/plans/mobile/mockups/07-settings.svg`，规格 §4.7）。
 *
 * ✅ **已接线**（2026-10-14 阶段 2 第一刀 ✓）：手机形态点 ⚙️ 即进本屏 ✓（分岔在 `ActivityBar` ✓，
 *   桌面的 ⚙️ 仍开那个 `SettingsDialog` ✓）。⛔ 下面这段"尚未接线"的旧记录**保留**（它是当时实况 ✓）：
 * ~~⛔ **本文件当前【尚未接线】** ✗（2026-10-10 如实标注 ✓）：组件与样式都已写完 ✓，但~~
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
 * - ⭐ 「设备配对」**已是真入口** ✓（2026-10-14 更新 ✓）：08 屏 owner 拍「走 A」并已落地 ⇒ 点它 `setScreen("pair")` ✓（⛔ 旧记录"08 屏还没做 ⇒ 只读展示"已过期 ✗）。
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
  // ⭐ 2026-10-22：空间卡要"导出**当前**空间" ⇒ 得知道当前是哪个；
  //   ⛔ 不整店订阅（`check-store-subscriptions`），两个字段级选择器就够 ✓。
  const spaces = useSpaceStore((s) => s.spaces);
  const activeId = useSpaceStore((s) => s.activeId);
  const activeName = spaces.find((s) => s.id === activeId)?.name ?? "当前空间";
  // 2026-10-26：设备名称（局域网里别人看到的名字）—— 与桌面「设置 → 账户」同一条命令。
  const [deviceName, setDeviceName] = useState("");
  const [deviceNameLoaded, setDeviceNameLoaded] = useState(false);
  const [deviceNameSaving, setDeviceNameSaving] = useState(false);
  const [deviceNameStatus, setDeviceNameStatus] = useState("");
  const [spaceOpen, setSpaceOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    api
      .getDeviceName()
      .then((n) => {
        if (alive) {
          setDeviceName(n ?? "");
          setDeviceNameLoaded(true);
        }
      })
      .catch(() => {
        if (alive) setDeviceNameLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, []);
  const saveDeviceName = async () => {
    setDeviceNameSaving(true);
    setDeviceNameStatus("");
    try {
      const effective = await api.setDeviceName(deviceName);
      setDeviceName(effective);
      setDeviceNameStatus(`已保存；当前生效名：${effective}`);
    } catch (e) {
      setDeviceNameStatus(`保存失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDeviceNameSaving(false);
    }
  };

  /**
   * ⭐ **导入完必须自己切过去** —— 移动端**没有空间切换器**（`MobilePair`/`MobilePairCode`
   * 都只按 `activeId` 查），只"导入成功"的话新空间在这屏里**永远看不到** ＝ 死路
   * （与"浮＋建空页落只读屏"同族，owner 2026-10-22 报过那一族）。
   *
   * ⚠️ 切失败也要说清楚：`switchTo` 自己会弹一条拒绝原因（两档），这里**不重复弹** ✓。
   */
  const importAndSwitch = async () => {
    const meta = await importSpacePackage();
    if (!meta) return; // 取消 / 失败：toast 已经如实报过，不在这里再编一句
    const ok = await useSpaceStore.getState().switchTo(meta.id);
    if (ok) {
      // 切成了 ⇒ 关掉可能被 loadPages 还原的旧页，再回首页看这个空间的列表。
      useNotes.getState().closePage();
      setScreen("home");
    }
  };

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
    <div className="mshell mset" data-testid="mobile-settings">
      <header className="mset-head">
        <h1 className="mset-title">我的</h1>
        <button
          className="mset-close"
          aria-label="关闭设置"
          onClick={() => {
            closeSettings();
            setScreen("home");
          }}
        >
          <XIcon width={16} height={16} />
        </button>
      </header>

      {/* ① 账户 */}
      <section className="mset-card">
        <div className="mset-group">账户</div>
        <div className="mset-row">
          <span className="mset-ico" aria-hidden><UserIcon width={17} height={17} /></span>
          <span className="mset-body">
            <span className="mset-row-title">本地账户</span>
            <span className="mset-row-sub">未绑定云端 · 数据只在本机</span>
          </span>
          <span className="mset-go" aria-hidden><ChevronRightIcon width={15} height={15} /></span>
        </div>
        {/* ⭐ 2026-10-26（owner：「设备名称在哪里输入」）：局域网里别人看到的名字就在这里改 ✓
            与桌面「设置 → 账户」同一条 `get/set_device_name` 命令 ✓（⛔ 不新造后端 ✗）。 */}
        <div className="mset-row mset-name-row">
          <span className="mset-ico" aria-hidden><DeviceIcon width={17} height={17} /></span>
          <span className="mset-body">
            <span className="mset-row-title">设备名称</span>
            <span className="mset-name-edit">
              <input
                className="mset-name-input"
                value={deviceName}
                disabled={!deviceNameLoaded || deviceNameSaving}
                placeholder="留空＝用系统名"
                maxLength={40}
                aria-label="设备名称"
                onChange={(e) => setDeviceName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void saveDeviceName();
                }}
              />
              <button
                className="mset-name-save"
                disabled={!deviceNameLoaded || deviceNameSaving}
                aria-label="保存设备名称"
                onClick={() => void saveDeviceName()}
              >
                <CheckIcon width={14} height={14} />
              </button>
            </span>
            <span className="mset-row-sub">别人在「附近设备」里看到的名字 · 改完点 ✓ 保存</span>
            {deviceNameStatus && <span className="mset-name-status">{deviceNameStatus}</span>}
          </span>
        </div>
      </section>

      {/* ② 同步 —— ⚠️ **只在原生档（Tauri）渲染**（owner 2026-10-22 明确指出：
          「web 版移动端不显示配对同步卡片」）。配对 / 局域网 / mesh 状态全是原生命令
          （`isDesktopPlatform() === isTauri()`）⇒ Web 上这张卡里每一项都只会说"不支持"，
          留着就是**假入口**。Web 上那句"不提供多设备同步"的如实说明**移到「空间」卡的脚注**了
          （⛔ 不是删掉不说 ✗）。 */}
      {isDesktopPlatform() && (
      <section className="mset-card">
        <div className="mset-group">同步</div>
        {/* ⭐ 阶段 2（R205）：**真入口** ✓ —— 08「设备配对 · 同步」屏 owner 拍了「走 A」并已落地 ✓
            ⇒ ⛔ 原来的 `aria-disabled="true"` ＋ 「08 屏还没做」那句注释**已过期** ✗（2026-10-14 更新 ✓）。
            ⚠️ 于是本屏顺手成了 08 的**第二个门** ✓（另一个是常驻「同步」胶囊 ✓）。 */}
        <button className="mset-row" onClick={() => setScreen("pair")}>
          <span className="mset-body">
            <span className="mset-row-title">设备配对与同步</span>
            <span className="mset-row-sub">管理附近设备与配对</span>
          </span>
          <span className="mset-go" aria-hidden><ChevronRightIcon width={15} height={15} /></span>
        </button>
        {/* ⭐ 2026-10-19 第二刀：主界面那颗同步浮钮已删 ⇒ **搬到设置屏**这里 ✓
            （`SyncPanel` 自带触发器 ✓，本刀**一个字符都没改它** ✓；手机上点它会进 08 屏 ✓）。 */}
        <SyncPanel />
        {/* ⭐ 2026-10-20 重设计：设计图要求显示「上次成功时间」。⚠️ 后端目前**没有**这个读数
            （`useSyncStatus` 只给"此刻"），所以这里只能如实写「暂无读数」——⛔ 不编一个时间 ✗。 */}
        <p className="mset-last">上次成功时间：暂无读数（尚无该读数）</p>
        <div className="mset-status">
          <span className={"mset-dot" + (error ? " is-bad" : syncing ? " is-busy" : "")} aria-hidden />
          <span className="mset-status-text">同步状态：{syncLine}</span>
        </div>
      </section>
      )}

      {/* ③ 空间：导出 / 导入（2026-10-22 owner 拍板「加」，效果图
          `docs/plans/mobile/mockups/2026-10-20-redesign/07b-settings-space-native.svg`
          ＋ `07c-settings-space-web.svg`）

          ⭐ 为什么这一屏必须有它：Web 版**没有「配对同步」**（配对/局域网那套是原生命令，
          `isDesktopPlatform() === isTauri()`）⇒ 在 Web 上"换设备"只剩**空间包**这一条路 ✓。
          ⭐ 顺序刻意在「同步」之后、距「外观」之前：DOM 顺序决定它紧跟哪张卡 ——
          同步卡若某天按平台隐藏，它自然上移，不用改这里 ✓。 */}
      <section className="mset-card">
        {/* ⚠️ 2026-10-22 owner 选了「A：与邻卡一致」——所以这里用**本屏既有词汇**
            （`mset-group` 小灰标 ＋ `mset-row`），⛔ 不用效果图那套"粗体标题＋图标"的新卡头：
            那套要整屏一起换（其余四张卡还都是旧词汇），不是这一笔的事。
            ⇒ 效果图 07b/07c 是**目标形态**；本屏的全量重设计由 macOS 侧那批统一做。 */}
        <div className="mset-group">空间</div>
        <div className="mset-row mset-current-space">
          <span className="mset-ico" aria-hidden><LayersIcon width={17} height={17} /></span>
          <span className="mset-body">
            <span className="mset-row-title">{activeName}</span>
            <span className="mset-row-sub">当前空间 · 本机共 {spaces.length} 个</span>
          </span>
          <span className="mset-go" aria-hidden><CheckIcon width={15} height={15} /></span>
        </div>
        <button className="mset-row" onClick={() => setSpaceOpen(true)}>
          <span className="mset-ico" aria-hidden><SwapIcon width={17} height={17} /></span>
          <span className="mset-body">
            <span className="mset-row-title">切换空间</span>
            <span className="mset-row-sub">切完回首页，显示该空间的全部笔记</span>
          </span>
          <span className="mset-go" aria-hidden><ChevronRightIcon width={15} height={15} /></span>
        </button>
        <button className="mset-row" onClick={() => void exportCurrentSpace(activeName)}>
          <span className="mset-ico" aria-hidden><DownloadIcon width={17} height={17} /></span>
          <span className="mset-body">
            <span className="mset-row-title">导出当前空间</span>
            <span className="mset-row-sub">zip · 含该空间的附件</span>
          </span>
          <span className="mset-go" aria-hidden><ChevronRightIcon width={15} height={15} /></span>
        </button>
        <button className="mset-row" onClick={() => void importAndSwitch()}>
          <span className="mset-ico" aria-hidden><UploadIcon width={17} height={17} /></span>
          <span className="mset-body">
            <span className="mset-row-title">导入空间包</span>
            <span className="mset-row-sub">新建 · 不覆盖现有空间</span>
          </span>
          <span className="mset-go" aria-hidden><ChevronRightIcon width={15} height={15} /></span>
        </button>
        {/* ⚠️ 这句是**行为说明**，不是装饰：导入后会自动切到新空间 ✓ */}
        <p className="mset-note">导入成功会自动切到新空间（否则导完看不到）。</p>
        {/* ⚠️ 门槛来自实测：web 导出是"全库快照 ＋ 临时副本 ＋ 整份 zip 在内存"，峰值约 3～4 倍；
            真包里已有 36 / 40 MB 的例子 ⇒ 手机上先劝一句，⛔ 不假装支持 ✗ */}
        <p className="mset-note">大空间（&gt; 50 MB）建议在桌面端导出/导入。</p>
        {!isDesktopPlatform() && (
          <p className="mset-note">
            Web 版不提供多设备同步（浏览器存储可能被回收）—— 换设备请用上面的空间包。
          </p>
        )}
      </section>

      {/* ④ 外观（真生效 ✓） */}
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
      </section>

      {/* ④ 关于 */}
      <section className="mset-card">
        <div className="mset-group">关于</div>
        {/* ⭐ 阶段 2（R205）：**手机上「关于」的入口** ✓ —— 沿用既有的 `aboutOpen` ✓
            （`App.tsx` 那一支 `isMobile && aboutOpen` 自然接管 ✓，所以 `MobileAbout` 的消费者**不用改** ✓，
             ⛔ 也**不新造状态** ✗）。 */}
        <button
          className="mset-row"
          onClick={() => {
            // ⚠️ 必须先**离开设置屏**（`setScreen("home")` ✓）：`App.tsx` 里 `settings` 支排在 `aboutOpen` **之前**
            //    （那是为了让 ⚙️ 在任何时候都整屏进设置 ✓）⇒ 若停在 `settings`，`aboutOpen` 那支**永远轮不到** ✗
            //    ⇒ 实测：只置 `aboutOpen` 时移动关于屏**不渲染** ✗（读到 `has=false`＋`labels:[]`＋返回键 `0×0` ✓）。
            setScreen("home");
            useEditorStore.getState().openAbout();
          }}
        >
          <span className="mset-ico" aria-hidden><InfoIcon width={17} height={17} /></span>
          <span className="mset-body">
            <span className="mset-row-title">关于与更新</span>
            <span className="mset-row-sub">版本 · 开源许可 · 链接</span>
          </span>
          <span className="mset-go" aria-hidden><ChevronRightIcon width={15} height={15} /></span>
        </button>
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
          <span className="mset-ico" aria-hidden><AlertTriangleIcon width={17} height={17} /></span>
          <span className="mset-body">
            <span className="mset-row-title">能力开关 / MCP / 插件管理</span>
          </span>
        </div>
        <p className="mset-note is-strong">请在桌面端操作</p>
        <p className="mset-note">移动端只保留日常必需项</p>
      </section>

      <p className="mset-foot">设置项与桌面端同源，改动不会只落在一端。</p>
      <MobileSpaceSheet open={spaceOpen} onClose={() => setSpaceOpen(false)} />
    </div>
  );
}
