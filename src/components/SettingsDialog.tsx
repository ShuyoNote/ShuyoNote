import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import { useEditorStore, type SettingsTab } from "../store/editor";
import { McpAccessPane } from "./McpAccessPane";
import { useOverlayScrollLock } from "../hooks/useOverlayScrollLock";
import { useOverlayLayer } from "../hooks/useOverlayLayer";
import { ACCENTS, useTheme, type Theme } from "../store/theme";
import { AiSettingsForm } from "./AiSettingsForm";
import { BackupButton } from "./BackupButton";
import { SearchIcon } from "./icons";
import { BackupSettingsPanel } from "./BackupSettingsPanel";
import { SpacePackageTransferRows } from "./SpacePackageTransferRows";
import { StoragePanel } from "./StoragePanel";
import { usePlugins } from "../store/plugins";
import { api } from "../lib/api";
import { lockVault, refreshVault, unlockVault } from "../lib/vault";
import { useVault } from "../hooks/useVault";
import type { SyncProfile, EmailAccount, SpaceSecurityView } from "../lib/api";
import { emailSupported, isDesktopPlatform } from "../lib/platform";
// ⭐ 2026-10-08 第 5 招（裁定 A ✓）：个人偏好「隐藏高级项」——纯规则在 lib 里（可单测 ✓）。
import { readHideAdvanced, visibleGroups, writeHideAdvanced } from "../lib/settingsNavPref";
// 账号唯一键统一从 lib/emailAccount 引入：原先本文件与 EmailPanel 各有一份完全相同的实现，
// 而 store 还需要第三份——三份同逻辑的键函数只会静默分叉。
import { accountKey } from "../lib/emailAccount";
import { toast } from "../store/toast";
import { confirmDialog } from "../store/confirm";
import { useSpaceStore } from "../store/space";
// ⭐ 2026-10-10：空间**筛选**（20+ 个空间）—— 与侧栏那个空间切换器**共用这一份**匹配 ✓
import { filterSpaces } from "../lib/spaceFilter";
import { spaceCryptoBadge } from "../lib/spaceSecurity";
// ⭐ 2026-10-10（owner：「加密空间要做个特殊标识」）：与侧栏**同一处**映射（文字标识，⛔ 不只靠颜色）✓
import { exportCurrentSpace, importSpacePackage, removeSpace } from "../lib/spaceTransfer";
import { APP_VERSION, APP_LICENSE } from "../lib/links";
import { useEmailPanel } from "../store/emailPanel";
import {
  PaletteIcon,
  ChevronRightIcon,
  TrashIcon,
  FolderIcon,
  LockIcon,
  DatabaseIcon,
  TemplateIcon,
  SendIcon,
  SparkleIcon,
  InfoIcon,
  InboxIcon,
  DownloadIcon,
} from "./icons";
import { AbilitiesPane } from "./AbilitiesPane";

const THEMES: { id: Theme; label: string }[] = [
  { id: "system", label: "跟随系统" },
  { id: "light", label: "亮色" },
  { id: "dark", label: "暗色" },
];

/** 左侧导航的分组（⭐ 2026-10-08 第 2 招，owner 看过效果图后拍板 ✓）：
 *  「11 项平铺 → 4 组」✓ —— 组标题只用**小号灰字 ＋ 细分隔线**（⛔ 不加 emoji ✗，owner 明确说过"花哨"✗）。 */
export type SettingsGroup = "basic" | "collab" | "ai" | "system";

/** 第 5 招（裁定 A ✓）：打开「隐藏高级项」时**被收起**的组 —— 只留 `basic` ✓。 */
const ADVANCED_GROUPS: SettingsGroup[] = ["collab", "ai", "system"];

export const SETTINGS_GROUPS: { id: SettingsGroup; labelKey: string }[] = [
  { id: "basic", labelKey: "settings.groups.basic" },
  { id: "collab", labelKey: "settings.groups.collab" },
  { id: "ai", labelKey: "settings.groups.ai" },
  { id: "system", labelKey: "settings.groups.system" },
];

export const TABS: { id: SettingsTab; labelKey: string; hintKey: string; icon: JSX.Element; group: SettingsGroup }[] = [
  { id: "appearance", labelKey: "settings.appearance", hintKey: "settings.appearanceHint", icon: <PaletteIcon width={16} height={16} />, group: "basic" },
  { id: "spaces", labelKey: "settings.spaces", hintKey: "settings.spacesHint", icon: <FolderIcon width={16} height={16} />, group: "collab" },
  // ⭐ **2026-10-29（owner 选 B）**：「账户」页**整页撤掉** ✗ —— 团队 UI 删除后它只剩「设备名」一格，
  //   而设备名已搬进**同步面板 → 局域网同步**（它影响的是"附近设备里怎么显示你"）✓。
  { id: "email", labelKey: "settings.email", hintKey: "settings.emailHint", icon: <InboxIcon width={16} height={16} />, group: "collab" },
  { id: "data", labelKey: "settings.data", hintKey: "settings.dataHint", icon: <DatabaseIcon width={16} height={16} />, group: "basic" },
  { id: "plugins", labelKey: "settings.plugins", hintKey: "settings.pluginsHint", icon: <TemplateIcon width={16} height={16} />, group: "system" },
  // ⭐ 2026-10-02：官方引擎与按需下载 —— 排在「插件」之后（插件＝第三方扩展 ／ 能力＝官方引擎 ✓）。
  { id: "abilities", labelKey: "settings.abilities", hintKey: "settings.abilitiesHint", icon: <DownloadIcon width={16} height={16} />, group: "ai" },
  // ⭐ 2026-10-06（owner 拍板 R89）：外部 AI 接入的开关面 —— 与「安全」同一族（都是"谁能碰我的库"✓）。
  { id: "mcp", labelKey: "settings.mcp", hintKey: "settings.mcpHint", icon: <SendIcon width={16} height={16} />, group: "collab" },
  // ⭐ **2026-10-14**：⭐ 那三格（监听地址／配对暗号／自动开启）**已回到同步面板** ✓ —— 设置面**不再提供** ✓
  //   （⭐ 旧注释那句"三个手填项从同步面板搬到这里"是**旧口径** ✗，已改 ✓；⭐ 本片只改这一句注释 ✓）。
  { id: "ai", labelKey: "settings.ai", hintKey: "settings.aiHint", icon: <SparkleIcon width={16} height={16} />, group: "ai" },
  { id: "about", labelKey: "settings.about", hintKey: "settings.aboutHint", icon: <InfoIcon width={16} height={16} />, group: "system" },
];

// 每页一句话说明，放在内容区页头——比只有一个标题更有分量，也省去用户猜
// 「这一页到底管什么」。
// 「数据」页：全库备份/恢复与存储清理——低频、全局、不可逆，按判据归设置。
// 两个组件都用 `label` 变体渲染成带文字的按钮，实现与侧栏时期完全共用。
function DataPane() {
  // ⭐ 2026-10-11（owner 截图「去掉这部分」）：原先这里有一份「备份提醒」偏好状态 ＋ 存/取
  //    `localStorage["shuyonote:backupReminder"]` ✓ —— ⭐ 已随那一节一起删掉 ✓。
  //    ⚠️ **如实记**：那条提醒的**触发端**在 `App.tsx`（同一次里也删了 ✓）——
  //       ⛔ 只删界面不删触发的话，用户会**继续被提醒却没法关** ✗。
  //    ⚠️ 老键 `shuyonote:backupReminder` 可能还留在别人的 localStorage 里 ⇒ **已经没人读它** ✓
  //       （不清理也无害 ✓）；`shuyonote:lastBackupAt` 仍由 `BackupButton` 写入 ⇒ 现在**只写不读** ✓。
  return (
    <>
      <section className="set-section">
        <div className="set-section-title">完整备份</div>
        <div className="set-row">
          <div className="set-row-text">
            <div className="set-row-name">备份 / 恢复（全库）</div>
            <div className="set-row-sub">
              导出所有空间与附件为一个包；导入为合并，不会覆盖现有空间。
            </div>
          </div>
          <BackupButton label="备份 / 恢复…" />
        </div>
        {/* ⚠️⭐ **2026-10-11 搬出来**：「自动备份」那一格原来挂在 `<BackupButton>` 里面 ⇒ 被塞进了
            `.backup-menu` ⇒ CDP 实测那个 wrapper 的 max-content 变成 **590px** ⇒ 把上面那一行的
            `.set-row-text` 挤成 **宽 0** ⇒ 「备份 / 恢复（全库）」与说明**一个字一列** ✗（owner 截图 ✓）。
            ⭐ 这里它是**独立一块**（⛔ 不是那一行的右控件 ✗）⇒ 行＝"左文字＋右按钮"，面板在行下面 ✓。 */}
        <BackupSettingsPanel />
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


// 「空间」页：空间管理（**切换** / 配色 / 删除 / 导出 / 导入）。
// ⚠️ **2026-10-10（owner 亲口要求）**：「设置-空间面板要可以切换空间，效果等同于在侧边栏的空间切换。」
//   ⇒ 本页**也**能切了 ✓；⛔ 但**不是**在这里再写一遍"改 active ＋ 刷新" ✗ ——
//   切空间**只有一条路**：`useSpaceStore.switchTo`（侧栏顶部那次走的就是它 ✓，
//   它内部已经含 `setActiveWorkspaceId` ＋ `loadPages` ＋ `refreshVault` ✓）。
// ⭐ 2026-10-25（合并「空间」与「安全」两页）：把会话锁 / 钥匙袋收成「空间」页顶部的一条，
//   ⛔ 不再让安全页单独列一遍空间 ✗（那一遍与本页的列表是同一份数据的两份显示）。
//   ⚠️ 判据：导航里不再有「安全」；空间页顶部必须能找到解锁入口（活动空间是明文时也要有）。
function SpaceSecurityBanner() {
  const { activeSpaceEncrypted, locked } = useVault();
  const spaces = useSpaceStore((s) => s.spaces);
  const activeId = useSpaceStore((s) => s.activeId);
  const activeName = spaces.find((s) => s.id === activeId)?.name ?? "当前空间";
  const [busy, setBusy] = useState(false);
  const [bag, setBag] = useState<{ has_material: boolean; spaces: number; unlocked: boolean } | null>(null);
  const [bagPass, setBagPass] = useState("");
  useEffect(() => {
    let live = true;
    const fn = api.keyringStatus;
    if (!fn) return;
    void fn()
      .then((s) => { if (live) setBag(s); })
      .catch(() => { if (live) setBag(null); });
    return () => { live = false; };
  }, [locked, activeSpaceEncrypted]);

  const unlockBag = async () => {
    setBusy(true);
    try {
      await unlockVault(bagPass);
      setBagPass("");
      toast("已解锁钥匙袋：加密空间现在可以同步", "success");
      try { setBag((await api.keyringStatus()) ?? null); } catch { /* 刷新失败不影响已解锁 */ }
      try { await useSpaceStore.getState().load(); } catch { /* 空间列表刷新失败不影响已解锁 */ }
    } catch (e) {
      toast(String(e), "error");
    } finally { setBusy(false); }
  };
  const lock = async () => {
    setBusy(true);
    try {
      await lockVault();
      toast("已锁定：界面会切回锁定屏，解锁后才继续同步", "success");
    } catch (e) { toast(String(e), "error"); } finally { setBusy(false); }
  };

  if (!activeSpaceEncrypted && !bag?.has_material) return null;
  const count = bag?.spaces ?? (activeSpaceEncrypted ? 1 : 0);
  const unlocked = bag?.unlocked ?? (activeSpaceEncrypted && !locked);
  return (
    <section className="set-security-card">
      <div className="set-security-left">
        <div className="set-security-overline">加密空间 · 会话锁定</div>
        <div className="set-security-title">
          {count} 个加密空间
          <span className={`set-security-pill ${unlocked ? "is-ok" : "is-warn"}`}>
            {unlocked ? "已解锁" : "未解锁"}
          </span>
        </div>
        <div className="set-security-sub">
          {activeSpaceEncrypted && locked
            ? "已加密 · 已锁定 · 解锁前读不到内容，同步也会被拒绝。"
            : unlocked
              ? `${activeSpaceEncrypted ? activeName : "保险柜"} · 本会话已拿到主密钥，可以同步`
              : "解锁后本机才能读取加密空间，并开始拉取对端密文"}
        </div>
        <div className="set-security-chips">
          <span>SQLCipher 密文落盘</span>
          <span>仅附近设备直连 · 对端 Windows</span>
        </div>
        <div className="set-security-hint">
          {unlocked
            ? (activeSpaceEncrypted ? "锁定后本机不再持有钥匙；对外只搬运 sealed 密文。" : "钥匙只在内存里；不写盘、不上传。")
            : "主口令只在本机内存里使用，不落盘。"}
        </div>
      </div>
      <div className="set-security-right">
        <div className="set-security-right-label">{unlocked ? "会话状态" : "主口令"}</div>
        {!unlocked ? (
          <div className="set-security-row">
            <input
              className="set-input"
              type="password"
              placeholder="输入主口令"
              value={bagPass}
              disabled={busy}
              onChange={(e) => setBagPass(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && bagPass.length > 0) void unlockBag(); }}
            />
            <button className="set-btn is-primary" disabled={busy || bagPass.length === 0} onClick={unlockBag}>
              {busy ? "解锁中…" : "解锁"}
            </button>
          </div>
        ) : activeSpaceEncrypted && !locked ? (
          <button className="set-btn" disabled={busy} onClick={lock}>立即锁定</button>
        ) : (
          <div className="set-security-ok">已解锁 · 钥匙只在内存</div>
        )}
      </div>
    </section>
  );
}

function SpacesPane() {
  const spaces = useSpaceStore((s) => s.spaces);
  const activeId = useSpaceStore((s) => s.activeId);
  const [colorFor, setColorFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // ⭐ 2026-10-10：筛选词（owner：「20+ 个空间怎么办」✓）⇒ 只影响**列表显示**：
  //    ⛔ 不动 `spaces`、⛔ 不动"当前空间" ✗（见 `filterSpaces`：签名里根本没有 active ✓）
  const [spaceQuery, setSpaceQuery] = useState("");
  const [secFilter, setSecFilter] = useState<"all" | "enc" | "plain">("all");
  const shownSpaces = filterSpaces(spaces, spaceQuery);
  // 每个空间的同步目标：让「这个空间到底同不同步、同步到哪」在管理页就能看到，
  // 不用再切回同步面板逐个点开。
  const [syncProfiles, setSyncProfiles] = useState<Record<string, SyncProfile>>({});
  const activeName = spaces.find((s) => s.id === activeId)?.name ?? "当前空间";
  // ⭐ 2026-10-25：按空间加密读数（每行显示开/关入口；与 SpacePrivacySection 同一命令面）
  const [secViews, setSecViews] = useState<Record<string, SpaceSecurityView>>({});
  const listRef = useRef<HTMLDivElement | null>(null);
  const [cryptoDlg, setCryptoDlg] = useState<{ id: string; name: string; mode: "enable" | "disable" } | null>(null);
  const [cryptoPass, setCryptoPass] = useState("");
  const [cryptoAck, setCryptoAck] = useState(false);
  const [cryptoBusy, setCryptoBusy] = useState(false);
  const [cryptoErr, setCryptoErr] = useState("");

  const loadSec = useCallback(async () => {
    if (!isDesktopPlatform()) return;
    try {
      const rows = await api.spaceSecurityOverview();
      const by: Record<string, SpaceSecurityView> = {};
      for (const r of rows) by[r.space_id] = r;
      setSecViews(by);
    } catch { /* 读不到就不显示入口，不影响其它空间管理 */ }
  }, []);
  useEffect(() => { void loadSec(); }, [loadSec, spaces.length]);

  const openCrypto = (id: string, name: string, mode: "enable" | "disable") => {
    setCryptoErr(""); setCryptoPass(""); setCryptoAck(false);
    setCryptoDlg({ id, name, mode });
  };
  const closeCrypto = () => { if (!cryptoBusy) setCryptoDlg(null); };
  const runCrypto = async () => {
    if (!cryptoDlg) return;
    if (!cryptoAck) { setCryptoErr("请先勾选下面那句确认"); return; }
    setCryptoBusy(true); setCryptoErr("");
    try {
      if (cryptoDlg.mode === "enable") {
        await api.enableSpaceEncryption(cryptoDlg.id, cryptoPass.trim() || undefined);
        toast(`已开启「${cryptoDlg.name}」的加密`, "success");
      } else {
        await api.disableSpaceEncryption(cryptoDlg.id);
        toast(`已关闭「${cryptoDlg.name}」的加密（库已换回明文）`, "success");
      }
      await refreshVault();
      await useSpaceStore.getState().load();
      await loadSec();
      setCryptoDlg(null);
    } catch (e) {
      setCryptoErr(String(e));
    } finally {
      setCryptoBusy(false);
    }
  };

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

  // ⭐ 切空间：**只走 store 那一条路**（与侧栏顶部那次完全一致 ✓）。
  // ⛔ 不在这里 `api.setActiveWorkspaceId` ＋ 自己刷新 ✗ —— 那会多出第二条路 ✓。
  // ⭐ 2026-10-25：⋯ 菜单点背景（或按 Esc）关闭 —— 原生 <details> 不提供这个行为。
  useEffect(() => {
    const closeMenus = (e: Event) => {
      const t = e.target as Element | null;
      for (const el of document.querySelectorAll<HTMLDetailsElement>(".set-space-more[open]")) {
        if (!t || !el.contains(t)) el.open = false;
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMenus(e);
    };
    document.addEventListener("mousedown", closeMenus);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", closeMenus);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  const pick = async (id: string) => {
    // 点"当前"那一行＝无事发生：切空间会连带 `loadPages` ＋ `refreshVault`，白跑一趟没必要
    if (id === activeId) return;
    await useSpaceStore.getState().switchTo(id);
  };

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

  const isEnc = (sp: (typeof spaces)[number]) => secViews[sp.id]?.encrypted_on_disk ?? sp.encrypted_on_disk;
  const visibleSpaces = shownSpaces.filter((sp) =>
    secFilter === "all" ? true : secFilter === "enc" ? isEnc(sp) : !isEnc(sp),
  );
  const encCount = spaces.filter(isEnc).length;

  return (
    <>
      <SpaceSecurityBanner />
      <section className="set-section set-space-section">
        <div className="set-space-head">
          <div className="set-space-head-title">全部空间 <span>{spaces.length} 个</span></div>
          <div className="set-space-head-tools">
            <div className="set-space-filter-wrap">
              <SearchIcon width={16} height={16} />
              <input
                className="set-space-filter sync-input"
                value={spaceQuery}
                onChange={(e) => setSpaceQuery(e.target.value)}
                placeholder="筛选空间…"
                aria-label="筛选空间"
              />
              {spaceQuery !== "" && (
                <button className="set-space-filter-clear" onClick={() => setSpaceQuery("")} aria-label="清空筛选" title="清空筛选">×</button>
              )}
            </div>
            <div className="set-space-seg" role="tablist" aria-label="按加密状态筛选">
              <button role="tab" aria-selected={secFilter === "all"} className={secFilter === "all" ? "is-on" : ""} onClick={() => setSecFilter("all")}>全部 {spaces.length}</button>
              <button role="tab" aria-selected={secFilter === "enc"} className={secFilter === "enc" ? "is-on" : ""} onClick={() => setSecFilter("enc")}>已加密 {encCount}</button>
              <button role="tab" aria-selected={secFilter === "plain"} className={secFilter === "plain" ? "is-on" : ""} onClick={() => setSecFilter("plain")}>未加密 {spaces.length - encCount}</button>
            </div>
          </div>
        </div>
        <div className="set-space-list set-space-list-scroll" ref={listRef}>
          {spaces.length === 0 ? (
            <div className="set-space-empty">还没有空间</div>
          ) : visibleSpaces.length === 0 ? (
            /* ⛔ 零命中**不许**只给空列表 ✗（用户会以为空间没了 ✓）⇒ 说人话 ＋ 给出路 ✓ */
            <div className="set-space-empty">
              没有匹配的空间
              <button className="set-btn" onClick={() => setSpaceQuery("")}>清空筛选</button>
            </div>
          ) : (
            visibleSpaces.map((s) => {
            const active = s.id === activeId;
            const prof = syncProfiles[s.id];
            // ⭐ 2026-10-10：「这个空间加密了吗」那一格 ⇒ 文字标识（与侧栏**同一处**映射 ✓）
            return (
              <div key={s.id} className={`set-space-card${active ? " is-active" : ""}`}>
                {/* ⭐ 这一行**可点**：点了就切过去（owner 2026-10-10）✓
                    ⚠️ 处理器挂在**这一层**：下面那两个按钮在它内部 ⇒ 各自 `stopPropagation` ✓；
                    配色面板是它的**兄弟**节点 ⇒ 点色块本来就不会走到这里 ✓。 */}
                <div
                  className="set-space-row"
                  onClick={() => void pick(s.id)}
                >
                  <span className="set-space-mark" style={s.theme ? { background: s.theme, color: "#fff" } : undefined}>
                    {(secViews[s.id]?.encrypted_on_disk ?? s.encrypted_on_disk)
                      ? <LockIcon width={18} height={18} />
                      : <FolderIcon width={18} height={18} />}
                  </span>
                  <div className="set-row-text">
                    <div className="set-row-name">
                      {s.name}
                      {active && <span className="set-tag">当前</span>}

                    </div>
                    <div className="set-space-meta">
                      <span className="set-space-scope">个人空间 · 仅附近设备直连</span>
                      {/* ⭐ 2026-10-10（owner：「加密空间要做个特殊标识」）——与**侧栏切换器**同一格读数、
                          同一个映射（`spaceCryptoBadge` ✓）⇒ "两处一致"是**结构性**的 ✓。
                          ⚠️ 只显示**文字**（⛔ 不只靠颜色 ✗）；读数拿不到 ⇒ 不显示 ✓。 */}
                      {/* ⭐ 2026-10-10（owner 截图）：这里原来直接显示 `↔ 121.199.8.24` ✗ ——
                          一个公网 IP 摆在设置里，普通用户既看不懂也不需要 ✓。
                          ⇒ 人话「已同步」✓ ＋ ⭐ **完整地址留在 `title` 里** ✓（排障要用 ✓，⛔ 别删它 ✗）。 */}
                      {prof?.server_url ? (
                        <span className="set-space-sync" title={prof.server_url}>
                          已同步
                        </span>
                      ) : (
                        <span className="set-space-local">仅本机</span>
                      )}
                      {/* ⭐ 2026-10-10（owner 截图）：那串空间编号（`91f96e7f` 那类）删掉了 ✓
                          —— 普通用户不需要 ✓；⛔ 也**不要**改成塞进 `title` 里 ✗（那还是露给用户了 ✓）。 */}
                    </div>
                  </div>
                  {/* ⭐ 2026-10-10（owner 截图）：切换原来**只有鼠标悬停**才提示 ✗（整行那个 `title`）
                      ⇒ 给一个**看得见**的入口 ✓。
                      ⚠️ ⭐ **必须 `stopPropagation`** ✗ —— 整行本来就 `onClick={pick}` ✓
                      ⇒ 不拦就会**切两次**（自己那次 ＋ 冒泡那次 ✓）；与「配色」「删除」同一处理 ✓。
                      ⚠️ **当前那一行不显示** ✓（它已经在那儿了，再给个"切过去"很怪 ✓）。 */}
                  <div className="set-space-status">
                        {(() => {
                          const onDisk = secViews[s.id]?.encrypted_on_disk ?? s.encrypted_on_disk;
                          const crypto = spaceCryptoBadge(onDisk);
                          if (crypto.show) {
                            return (
                              <span className="set-space-crypto is-enc" title={crypto.title} aria-label={crypto.title}>
                                {crypto.label}
                              </span>
                            );
                          }
                          // 读数拿不到（undefined）⇒ 不标；明确明文才给「明文」
                          return onDisk === false ? <span className="set-space-state is-plain">明文</span> : null;
                        })()}
                  </div>
                  <details className="set-space-more" onClick={(e) => e.stopPropagation()}>
                    <summary aria-label={`${s.name} 的更多操作`} title="更多操作">⋯</summary>
                    <div className="set-space-menu">
                      {!active && (
                        <button
                          className="set-space-switch set-btn"
                          title={`切换到「${s.name}」`}
                          onClick={(e) => { e.stopPropagation(); void pick(s.id); }}
                        >
                          <ChevronRightIcon width={14} height={14} />
                          <span>切换</span>
                        </button>
                      )}
                      <button
                        className={`set-btn${secViews[s.id]?.encrypted_on_disk || s.encrypted_on_disk ? " is-danger-ghost" : ""}`}
                        disabled={busy}
                        title={secViews[s.id]?.key_available === false ? "先解锁钥匙袋才能关闭加密" : undefined}
                        onClick={(e) => {
                          e.stopPropagation();
                          const enc = secViews[s.id]?.encrypted_on_disk ?? s.encrypted_on_disk;
                          openCrypto(s.id, s.name, enc ? "disable" : "enable");
                        }}
                      >
                        <LockIcon width={14} height={14} />
                        <span>{secViews[s.id]?.encrypted_on_disk || s.encrypted_on_disk ? "关闭加密…" : "开启加密…"}</span>
                      </button>
                      <button
                        className={`set-btn${colorFor === s.id ? " is-on" : ""}`}
                        onClick={(e) => { e.stopPropagation(); setColorFor((c) => (c === s.id ? null : s.id)); }}
                      >
                        <PaletteIcon width={14} height={14} />
                        <span>配色</span>
                      </button>
                      <button
                        className="set-btn is-danger-ghost"
                        disabled={busy || spaces.length <= 1 || active}
                        title={active ? "当前空间不可删除，请先切换到别的空间" : spaces.length <= 1 ? "至少保留一个空间" : "删除该空间"}
                        onClick={(e) => { e.stopPropagation(); void doRemove(s.id, s.name); }}
                      >
                        <TrashIcon width={14} height={14} />
                        <span>删除</span>
                      </button>
                    </div>
                  </details>
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
            })
          )}
        </div>
        <p className="set-hint">
          点一行就能切过去（与侧栏顶部那次切换同一条路）。删除为软删除，数据仍在磁盘上，可在「存储 / 空间管理」里彻底清理。
        </p>
      </section>

      <section className="set-section">
        <div className="set-section-title">单空间迁移</div>
        {/* ⭐ 2026-10-31（owner 选 A）：空间包（.shuyospace）的导出/导入从**文件管理工具栏**搬到
            这里 —— 导出的是整个空间、导入会**新建一个空间**，都不是"文件"动作。
            下面的「快速搬家（.zip）」是旧通道（workspaceTransfer），格式不同、保留不动。 */}
        <SpacePackageTransferRows />
        <p className="set-hint" data-testid="set-space-quickmigrate-hint">
          快速搬家（<code>.zip</code>，旧通道）：只适合本机快速搬运，不带校验；企业版/跨版本交付请用上面的空间包。
        </p>
        {/* ⭐ 2026-10-10（owner **第二次**提：「去掉这两个图标」）：两张卡片顶上原本各有一个方块图标
            （`.set-migrate-icon`，写的是 ↑ ／ ↓）✗ ⇒ **只删图标** ✓：
            标题（导出当前空间／导入空间包）＋ 说明那句 ＋ 两个按钮**一个不少** ✓。
            ⚠️ 卡片是**内容撑高**的（`.set-migrate-card` 没写死高度 ✓）⇒ 少一个 28px 图标只是矮一截、
            **不会塌** ✓ —— 真高度由 `_tmp/scratch/migrate-card-height.mjs`（真 Chromium／Edge）量过 ✓。
            ⚠️ 那条 CSS（原来卡片顶上那个方块图标的规则）**已随节点一起删掉** ✓
              （2026-10-10；App.css 里留了一行墓碑注释说明为什么不能再加回来 ✓）
              —— 防线在测试里：卡片**只能**有 标题／说明／按钮 三样节点 ✓，谁加回来当场红 ✓。 */}
        <div className="set-migrate">
          <div className="set-migrate-card">
            <div className="set-migrate-name">导出当前空间</div>
            <div className="set-migrate-sub">「{activeName}」及其引用到的附件，打包成一个 zip</div>
            <button className="set-btn" onClick={() => void exportCurrentSpace(activeName)}>
              导出…
            </button>
          </div>
          <div className="set-migrate-card">
            <div className="set-migrate-name">导入空间包</div>
            <div className="set-migrate-sub">始终新建一个空间，绝不覆盖现有空间</div>
            <button className="set-btn" onClick={() => void importSpacePackage()}>
              导入…
            </button>
          </div>
        </div>
      </section>

      {cryptoDlg && (
        <div className="set-crypto-scrim" onClick={closeCrypto}>
          <div className="set-crypto-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="set-crypto-head">
              <div className="set-crypto-title">
                {cryptoDlg.mode === "enable" ? `为「${cryptoDlg.name}」开启加密` : `关闭「${cryptoDlg.name}」的加密？`}
              </div>
              <button className="set-close" aria-label="关闭" onClick={closeCrypto} disabled={cryptoBusy}>×</button>
            </div>
            {cryptoDlg.mode === "enable" ? (
              <>
                <div className="set-crypto-steps">
                  <div><b>1 改写空间库</b><span>这个空间的库会以 SQLCipher 密文重新落盘</span></div>
                  <div><b>2 包住空间钥匙</b><span>用主口令派生的密钥把空间钥匙装进钥匙袋</span></div>
                  <div><b>3 同步照常</b><span>锁着时对外只搬 sealed 封包，明文只留在已解锁侧</span></div>
                </div>
                <label className="set-crypto-label">主口令（本机已有钥匙袋且已解锁时可留空）</label>
                <input className="set-input" type="password" value={cryptoPass} disabled={cryptoBusy}
                  placeholder="至少 8 位；不会上传、不会落盘"
                  onChange={(e) => setCryptoPass(e.target.value)} />
                <label className="set-crypto-check">
                  <input type="checkbox" checked={cryptoAck} disabled={cryptoBusy} onChange={(e) => setCryptoAck(e.target.checked)} />
                  我记住了主口令 —— 丢失后这个空间无法恢复
                </label>
              </>
            ) : (
              <>
                <div className="set-crypto-warn">
                  <div>库会解密为明文 —— 任何能访问这台电脑的人都可以直接读</div>
                  <div>同步关系保留；对端仍按它自己的加密设置处理</div>
                  <div>重新开启加密需要再做一次完整加密（不可撤销）</div>
                </div>
                <label className="set-crypto-check">
                  <input type="checkbox" checked={cryptoAck} disabled={cryptoBusy} onChange={(e) => setCryptoAck(e.target.checked)} />
                  我理解关闭后数据会以明文形式保存在这台电脑上
                </label>
              </>
            )}
            {cryptoErr && <div className="set-crypto-err">{cryptoErr}</div>}
            <div className="set-crypto-foot">
              <button className="set-btn" onClick={closeCrypto} disabled={cryptoBusy}>取消</button>
              <button className={`set-btn ${cryptoDlg.mode === "disable" ? "is-danger" : "is-primary"}`}
                onClick={() => void runCrypto()} disabled={cryptoBusy}>
                {cryptoBusy ? "处理中…" : cryptoDlg.mode === "enable" ? "开启加密" : "关闭加密"}
              </button>
            </div>
          </div>
        </div>
      )}

    </>
  );
}

// 「邮箱」页：聚合收件箱的 IMAP 账号配置。低频、全局，归设置；收件箱阅读/转换
// 在「打开收件箱」的整页里做（此处只做"我是谁、连哪个邮箱"）。

function EmailPane() {
  const [host, setHost] = useState("");
  const [port, setPort] = useState("993");
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [useTls, setUseTls] = useState(true);
  const [autoFetch, setAutoFetch] = useState(false);
  const [intervalMin, setIntervalMin] = useState(15);
  // SMTP 发信（回复/转发）：默认留空即复用 IMAP 账号 + 465 隐式 TLS。
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("465");
  const [smtpSecurity, setSmtpSecurity] = useState("ssl");
  const [smtpUser, setSmtpUser] = useState("");
  const [smtpPass, setSmtpPass] = useState("");
  const [trustedDomains, setTrustedDomains] = useState<string[]>([]);
  const [trustInput, setTrustInput] = useState("");
  const [autoTrust, setAutoTrust] = useState(true);
  const [err, setErr] = useState("");
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState("");
  // 邮箱区用**能力**判断而不是 `isDesktopPlatform()`：后者在 Tauri 的移动端也为真，
  // 而邮箱在移动端不存在（Rust 侧那 23 个命令带 #[cfg(desktop)]）。
  const desktop = emailSupported();
  // 多账号管理：账号列表**读自 store**（与邮箱面板同一份，见 store/emailPanel.ts）；
  // 本组件不再自持副本——否则在这里加完账号，已经打开的邮箱面板不会知道。
  const accounts = useEmailPanel((s) => s.accounts);
  const reloadAccountsFromStore = useEmailPanel((s) => s.reloadAccounts);
  // 增删账号**走 store 的动作**（写后端 + 重读列表合在一起），
  // 这样设置里改完，已经挂载的邮箱面板立刻跟着变。
  const saveAccountToStore = useEmailPanel((s) => s.saveAccount);
  const removeAccountFromStore = useEmailPanel((s) => s.removeAccount);
  const [editingKey, setEditingKey] = useState<string | null>(null);

  const fillForm = (a: EmailAccount) => {
    setHost(a.host);
    setPort(String(a.port));
    setUser(a.username);
    setPass(a.password);
    setUseTls(a.use_tls);
    setAutoFetch(a.auto_fetch);
    setIntervalMin(a.interval_minutes || 15);
    setSmtpHost(a.smtp_host);
    setSmtpPort(String(a.smtp_port || 465));
    setSmtpSecurity(a.smtp_security || "ssl");
    setSmtpUser(a.smtp_user);
    setSmtpPass(a.smtp_pass);
    setTrustedDomains(a.trusted_domains ?? []);
    setAutoTrust(a.auto_trust_senders ?? true);
  };
  const resetForm = () => {
    setHost(""); setPort("993"); setUser(""); setPass(""); setUseTls(true);
    setAutoFetch(false); setIntervalMin(15); setSmtpHost(""); setSmtpPort("465");
    setSmtpSecurity("ssl"); setSmtpUser(""); setSmtpPass(""); setTrustedDomains([]); setAutoTrust(true);
  };

  useEffect(() => {
    reloadAccountsFromStore()
      .then((list) => {
        if (list.length > 0) {
          fillForm(list[0]); // 首位 = 当前活动账号
          setEditingKey(accountKey(list[0]));
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 点某条账号回填表单并进入编辑态。
  const editAccount = (a: EmailAccount) => { fillForm(a); setEditingKey(accountKey(a)); setErr(""); };
  // 新建账号：清空表单。
  const startNew = () => { resetForm(); setEditingKey(null); setErr(""); };
  const removeAccount = async (a: EmailAccount) => {
    if (!window.confirm(`删除账号 ${a.username}（${a.host}）？`)) return;
    setErr("");
    try {
      // 删除**走 store**：它会把新列表一起带回来（顺带带回来给邮箱面板）。
      // 旧写法是"只改自己那份 state，再单独读一次后端"，面板那份就留在旧状态。
      const list = await removeAccountFromStore(a);
      if (list.length > 0) { fillForm(list[0]); setEditingKey(accountKey(list[0])); }
      else { resetForm(); setEditingKey(null); }
      setErr("账号已删除 ✓");
    } catch (e) { setErr(String(e)); }
  };
  // 设为活动账号：upsert 后插到列表首位即成为活动账号。
  const setActiveAccount = async (a: EmailAccount) => {
    setErr("");
    try {
      await saveAccountToStore(a);
      setEditingKey(accountKey(a));
      setErr("已设为活动账号 ✓");
    } catch (e) { setErr(String(e)); }
  };

  const testConnection = async () => {
    if (!host) { setErr("请先填写服务器"); return; }
    const payload: EmailAccount = {
      host,
      port: Number(port) || 993,
      username: user,
      password: pass,
      use_tls: useTls,
      auto_fetch: autoFetch,
      interval_minutes: intervalMin,
      smtp_host: smtpHost.trim(),
      smtp_port: Number(smtpPort) || 465,
      smtp_security: smtpSecurity,
      smtp_user: smtpUser.trim(),
      smtp_pass: smtpPass,
      trusted_domains: trustedDomains,
      auto_trust_senders: autoTrust,
    };
    setTesting(true);
    setErr("");
    setTestMsg("");
    try {
      const msg = await api.emailTestConnection(payload);
      setTestMsg(msg);
    } catch (e) {
      setErr(String(e));
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    if (!host) return;
    setErr("");
    try {
      const payload: EmailAccount = {
        host,
        port: Number(port) || 993,
        username: user,
        password: pass,
        use_tls: useTls,
        auto_fetch: autoFetch,
        interval_minutes: intervalMin,
        smtp_host: smtpHost.trim(),
        smtp_port: Number(smtpPort) || 465,
        smtp_security: smtpSecurity,
        smtp_user: smtpUser.trim(),
        smtp_pass: smtpPass,
        trusted_domains: trustedDomains,
        auto_trust_senders: autoTrust,
      };
      await saveAccountToStore(payload);
      setEditingKey(accountKey(payload));
      setErr("配置已保存 ✓");
    } catch (e) {
      setErr(String(e));
    }
  };

  return (
    <>
      <section className="set-section">
        <div className="set-section-title">聚合收件箱</div>
        {!desktop ? (
          <p className="set-hint">邮箱功能为桌面专属（Web 无法连接 IMAP），请使用桌面版。</p>
        ) : (
          <>
            {/* 顶卡：说明 + 状态 */}
            <div className="email-set-card">
              <div className="email-set-icon" aria-hidden>
                <InboxIcon width={22} height={22} />
              </div>
              <div className="email-set-card-text">
                <div className="email-set-card-title">IMAP 账号（应用密码 / 企业 IMAP）</div>
                <div className="email-set-card-sub">
                  用于拉取收件箱。Gmail 需先开两步验证然后用「应用专用密码」；网易 / 腾讯用授权码。
                </div>
              </div>
            </div>

            {accounts.length > 0 && (
              <div className="email-set-accounts">
                <div className="email-set-accounts-head">
                  <span className="email-set-accounts-title">已保存账号（{accounts.length}）</span>
                  <button className="set-btn" onClick={startNew} title="新增一个 IMAP 账号">＋ 新增账号</button>
                </div>
                <div className="email-set-accounts-list">
                  {accounts.map((a, i) => {
                    const key = accountKey(a);
                    const isActive = i === 0;
                    const isEditing = editingKey === key;
                    return (
                      <div key={key} className={`email-set-account-row${isActive ? " is-active" : ""}${isEditing ? " is-editing" : ""}`}>
                        <span className="email-set-account-avatar" aria-hidden>{(a.username[0] || "?").toUpperCase()}</span>
                        <span className="email-set-account-main">
                          <span className="email-set-account-name" title={a.username}>
                            <span className="email-set-account-user">{a.username}</span>
                            {isActive && <span className="email-set-active-badge">当前活动</span>}
                          </span>
                          <span className="email-set-account-sub">{a.host} · {a.port}</span>
                        </span>
                        <span className="email-set-account-actions">
                          <button className="set-btn" onClick={() => editAccount(a)}>编辑</button>
                          {!isActive && <button className="set-btn" onClick={() => void setActiveAccount(a)}>设为活动</button>}
                          <button className="set-btn is-danger" onClick={() => void removeAccount(a)}>删除</button>
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="email-set-form-head">
              <span className="email-set-form-title">{editingKey ? "编辑账号" : "新增账号"}</span>
              <span className="email-set-form-hint">
                {editingKey ? "修改后点「保存配置」，同 服务器+账号 将覆盖保存。" : "填写下方信息后点「保存配置」，将新增一个账号并设为当前活动。"}
              </span>
            </div>

            <div className="email-set-grid">
              <div className="set-field email-set-host">
                <label htmlFor="email-host">服务器</label>
                <input id="email-host" className="set-input" placeholder="imap.qq.com" value={host} onChange={(e) => setHost(e.target.value)} />
              </div>
              <div className="set-field email-set-port">
                <label htmlFor="email-port">端口</label>
                <input id="email-port" className="set-input" placeholder="993" value={port} onChange={(e) => setPort(e.target.value)} />
              </div>
              <div className="set-field email-set-wide">
                <label htmlFor="email-user">账号</label>
                <input id="email-user" className="set-input" placeholder="you@example.com" value={user} onChange={(e) => setUser(e.target.value)} />
              </div>
              <div className="set-field email-set-wide">
                <label htmlFor="email-pass">密码 / 应用密码</label>
                <input id="email-pass" className="set-input" type="password" placeholder="应用密码 / 授权码" value={pass} onChange={(e) => setPass(e.target.value)} />
              </div>
            </div>

            <div className="email-set-row email-set-tls">
              <span className="email-set-row-text">
                <span className="email-set-row-name">使用 TLS/SSL</span>
                <span className="email-set-row-sub">993 端口默认开启；关掉后可连 143 明文。</span>
              </span>
              <button
                className={`ui-toggle ${useTls ? "on" : ""}`}
                role="switch"
                aria-checked={useTls}
                onClick={() => setUseTls(!useTls)}
              >
                <span className="ui-toggle-knob" />
              </button>
            </div>

            <div className="email-set-card email-set-smtp-card">
              <div className="email-set-card-text">
                <div className="email-set-card-title">SMTP 发信（回复 / 转发）</div>
                <div className="email-set-card-sub">
                  从应用内直接发信需 SMTP。留空则复用 IMAP 账号（QQ/163 等常需单独的 SMTP 授权码）。
                </div>
              </div>
            </div>
            <div className="email-set-grid email-set-grid-smtp">
              <div className="set-field email-set-host">
                <label htmlFor="email-smtp-host">SMTP 服务器</label>
                <input id="email-smtp-host" className="set-input" placeholder="smtp.qq.com（留空=复用IMAP）" value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} />
              </div>
              <div className="set-field email-set-port">
                <label htmlFor="email-smtp-port">端口</label>
                <input id="email-smtp-port" className="set-input" placeholder="465" value={smtpPort} onChange={(e) => setSmtpPort(e.target.value)} />
              </div>
              <div className="set-field email-set-port">
                <label htmlFor="email-smtp-sec">加密</label>
                <select id="email-smtp-sec" className="set-input" value={smtpSecurity} onChange={(e) => setSmtpSecurity(e.target.value)}>
                  <option value="ssl">SSL（465）</option>
                  <option value="starttls">STARTTLS（587）</option>
                  <option value="none">明文（不推荐）</option>
                </select>
              </div>
              <div className="set-field email-set-wide">
                <label htmlFor="email-smtp-user">SMTP 账号（留空=复用 IMAP）</label>
                <input id="email-smtp-user" className="set-input" placeholder="smtp 专用账号" value={smtpUser} onChange={(e) => setSmtpUser(e.target.value)} />
              </div>
              <div className="set-field email-set-wide">
                <label htmlFor="email-smtp-pass">SMTP 授权码（留空=复用 IMAP）</label>
                <input id="email-smtp-pass" className="set-input" type="password" placeholder="SMTP 授权码 / 应用密码" value={smtpPass} onChange={(e) => setSmtpPass(e.target.value)} />
              </div>
            </div>

            <div className="email-set-row email-set-tls">
              <span className="email-set-row-text">
                <span className="email-set-row-name">定时收取</span>
                <span className="email-set-row-sub">后台按间隔自动拉取未读，侧栏邮箱图标显示未读角标。</span>
              </span>
              <button
                className={`ui-toggle ${autoFetch ? "on" : ""}`}
                role="switch"
                aria-checked={autoFetch}
                onClick={() => setAutoFetch(!autoFetch)}
              >
                <span className="ui-toggle-knob" />
              </button>
            </div>

            {autoFetch && (
              <div className="email-set-row email-set-tls">
                <span className="email-set-row-text">
                  <span className="email-set-row-name">收取间隔</span>
                  <span className="email-set-row-sub">太密会频繁连服务器，建议 15 分钟以上。</span>
                </span>
                <select
                  className="set-input email-set-select"
                  value={intervalMin}
                  onChange={(e) => setIntervalMin(Number(e.target.value))}
                >
                  <option value={5}>5 分钟</option>
                  <option value={15}>15 分钟</option>
                  <option value={30}>30 分钟</option>
                  <option value={60}>60 分钟</option>
                </select>
              </div>
            )}

            <div className="email-set-card email-set-trust-card">
              <div className="email-set-card-text">
                <div className="email-set-card-title">可信发件人域名</div>
                <div className="email-set-card-sub">
                  这些域名的远程图片自动加载（不用点「显示图片」）。可手动添加，或开启下方「自动信任」。
                </div>
              </div>
            </div>
            <div className="email-set-row email-set-tls">
              <span className="email-set-row-text">
                <span className="email-set-row-name">打开邮件自动信任发件人</span>
                <span className="email-set-row-sub">开启后每次打开一封邮件，会把其发件人域名加入可信（关闭则仅在点击「信任此发件人」时加入）。</span>
              </span>
              <button
                className={`ui-toggle ${autoTrust ? "on" : ""}`}
                role="switch"
                aria-checked={autoTrust}
                onClick={() => setAutoTrust(!autoTrust)}
              >
                <span className="ui-toggle-knob" />
              </button>
            </div>
            <div className="email-set-trust">
              <div className="email-set-trust-list">
                {trustedDomains.length === 0 && <span className="email-set-trust-empty">暂无（打开邮件时自动加入域名）</span>}
                {trustedDomains.map((d) => (
                  <span key={d} className="email-set-trust-chip">
                    {d}
                    <button
                      className="email-set-trust-remove"
                      title="移除可信"
                      onClick={() => setTrustedDomains((prev) => prev.filter((x) => x !== d))}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
              <div className="email-set-trust-add">
                <input
                  className="set-input"
                  placeholder="输入域名，如 qq.com"
                  value={trustInput}
                  onChange={(e) => setTrustInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      const d = trustInput.trim().toLowerCase().replace(/^@/, "");
                      if (d) setTrustedDomains((prev) => [...new Set([...prev, d])]);
                      setTrustInput("");
                    }
                  }}
                />
                <button
                  className="set-btn"
                  onClick={() => {
                    const d = trustInput.trim().toLowerCase().replace(/^@/, "");
                    if (d) setTrustedDomains((prev) => [...new Set([...prev, d])]);
                    setTrustInput("");
                  }}
                >
                  添加
                </button>
              </div>
            </div>

            <div className="set-actions email-set-actions">
              <button className="set-btn is-primary" disabled={!host} onClick={() => void save()}>保存配置</button>
              <button className="set-btn" onClick={() => { useEmailPanel.getState().openPanel(); useEditorStore.getState().closeSettings(); }}>
                <InboxIcon width={14} height={14} /> 打开收件箱
              </button>
              <button className="set-btn" disabled={testing || !host} onClick={() => void testConnection()}>
                {testing ? "测试中…" : "测试连接"}
              </button>
            </div>
            {err && <div className="set-status-line">{err}</div>}
            {testMsg && <div className="set-status-line is-ok">✓ {testMsg}</div>}
          </>
        )}
      </section>
    </>
  );
}

function AppearancePane() {
  // 逐字段订阅（`setTheme`/`setAccent` 是动作，引用恒定）。
  const theme = useTheme((s) => s.theme);
  const accent = useTheme((s) => s.accent);
  const setTheme = useTheme((s) => s.setTheme);
  const setAccent = useTheme((s) => s.setAccent);
  const { i18n } = useTranslation();
  const setLang = (lng: string) => {
    try { localStorage.setItem("shuyonote:lang", lng === "system" ? "" : lng); } catch { /* ignore */ }
    void i18n.changeLanguage(lng === "system" ? (navigator.language?.toLowerCase().startsWith("en") ? "en" : "zh-CN") : lng);
  };
  return (
    <>
      <section className="set-section">
        <div className="set-section-title">语言 / Language</div>
        <div className="set-chip-row">
          <button
            className={`set-chip${i18n.language?.startsWith("zh") ? " is-on" : ""}`}
            onClick={() => setLang("zh-CN")}
          >
            中文
          </button>
          <button
            className={`set-chip${i18n.language?.toLowerCase().startsWith("en") ? " is-on" : ""}`}
            onClick={() => setLang("en")}
          >
            English
          </button>
        </div>
        <p className="set-hint">未翻译的界面暂以中文显示。</p>
      </section>
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

// 插件卡片图标。内联 SVG，不引其它图标组件。
// （曾经有一张「内置插件的图标/配色表」，随内置插件启停机制一起被删掉了——那是死代码。）
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
    pdf: (
      <>
        <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
        <path d="M14 3v6h6" />
        {/* 「PDF」角标：让它一眼可辨是 PDF 而不是普通文档。chip 底是红色
            （--cat-red），文字用固定白色保证可读。 */}
        <rect x="8" y="13" width="8" height="5" rx="1" fill="currentColor" stroke="none" />
        <text x="12" y="16.6" textAnchor="middle" fontSize="3.4" fontStyle="italic" fontWeight="700" fill="#fff" stroke="none">PDF</text>
      </>
    ),
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
  const managerPlugins = usePlugins((s) => s.plugins);
  const setManagerOpen = usePlugins((s) => s.setManagerOpen);
  const toggle = usePlugins((s) => s.toggle);
  const load = usePlugins((s) => s.load);
  const enabled = managerPlugins.filter((p) => p.enabled).length;
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <section className="set-section">
      <div className="set-section-title">
        插件管理
        <span className="plugin-count">{enabled}/{managerPlugins.length} 已启用</span>
        {/* 「管理插件」：权限、日志、活动、校验、卸载这些细节在管理弹窗里，
            设置页只负责浏览与开关。store 里本来就有 setManagerOpen，不必新增 prop。 */}
        <button
          type="button"
          className="pm-open-btn"
          onClick={() => setManagerOpen(true)}
        >
          管理插件
        </button>
      </div>
      {managerPlugins.length === 0 ? (
        <div className="plugin-empty">
          <p>未发现磁盘插件。</p>
          <p className="set-hint">从本地文件夹安装，或把插件放入插件目录。</p>
          <button className="set-btn" onClick={() => setManagerOpen(true)}>打开插件管理</button>
        </div>
      ) : (
        <div className="plugin-grid">
          {managerPlugins.map((p) => (
            <div key={p.id} className={`plugin-card${p.enabled ? "" : " is-off"}`}>
              <div className="plugin-card-head">
                <span className="plugin-icon"><PluginGlyph icon="plugin" /></span>
                {/* 右上角 = 状态兼控制：一个开关，既显示启用/禁用，点击即切换。
                    不再单独保留状态点或底部大开关——一处表达就够了。 */}
                <button
                  className={`ui-toggle${p.enabled ? " on" : ""}`}
                  role="switch"
                  aria-checked={p.enabled}
                  title={p.enabled ? "点击禁用" : "点击启用"}
                  onClick={() => void toggle(p.id)}
                >
                  <span className="ui-toggle-knob" />
                </button>
              </div>
              <div className="plugin-name">{p.name}</div>
              <div className="plugin-sub">
                <span className="plugin-desc">{p.description || "—"}</span>
                <span className="plugin-meta">{p.commands.length} 个命令 · v{p.version}</span>
              </div>
            </div>
          ))}
        </div>
      )}
      <p className="set-hint">
        磁盘插件通过受限 JS 运行时（boa）执行；其命令出现在命令面板（Ctrl+K）。
      </p>
    </section>
  );
}

// 空间隐私 ＋ **会话锁定**。
//
// ★ owner 第三轮拍板（2026-09-24）：这一节原先是「端到端加密」（**应用级**：全局一把钥匙，
// 一开全加密／一关全明文）。那整套（含解锁哨兵、读老库的兜底、① 的迁移/轮换）**整条删掉了**
// ⇒ 这里换成**按空间**那一节（`SpacePrivacySection`：每个空间各加各的密，团队空间保持明文）。
//
// 留下的「会话锁定」**不是加密作用域的一部分**：它是会话级的（丢掉内存里的主密钥 ⇒ 界面切回
// 锁定屏、同步被拒），而加密作用域已经是按空间的了。
function SecurityPane() {
  // ⭐ 2026-10-25：会话锁 / 钥匙袋已经抽成 `SpaceSecurityBanner`（空间页顶部复用同一份）。
  //   本页保留给测试与深链，不再复制第二套逻辑。
  //
  // ⭐⭐ **2026-10-25（owner 拍 A：「整块从『安全』页删掉」）**：这里原来还挂着
  //   「空间隐私」那一节（按空间分类 ＋ 开/关加密 ＋ 团队空间绑服务器）。
  //   删掉的依据：**同一批动作已经在「设置 · 空间」页**（每行有 明文/已加密 徽标、⋯ 菜单、
  //   开/关加密的确认框），而本页那一份还留着**已退役**的文案（"填一个配对暗号就行"）。
  //   ⇒ 两套重复口径迟早打架（今天「去开加密」接错页就是同类事故）。
  return (
    <>
      <SpaceSecurityBanner />
    </>
  );
}

function AboutPane() {
  const { t } = useTranslation();
  const openAbout = useEditorStore((s) => s.openAbout);
  const closeSettings = useEditorStore((s) => s.closeSettings);
  const updateAvailable = useEditorStore((s) => s.updateAvailable);
  const latestVersion = useEditorStore((s) => s.latestVersion);
  return (
    <section className="set-section">
      <div className="set-section-title">{t("about.version")}</div>
      <div className="set-row">
        <div className="set-row-text">
          <div className="set-row-name">ShuyoNote v{APP_VERSION}</div>
          <div className="set-row-sub">
            {updateAvailable && latestVersion ? t("about.newVersion", { v: latestVersion }) : t("about.license") + " " + APP_LICENSE}
          </div>
        </div>
        <button
          className={`set-btn${updateAvailable ? " is-primary" : ""}`}
          onClick={() => {
            closeSettings();
            openAbout();
          }}
        >
          {updateAvailable ? t("about.checkUpdate") : t("about.aboutUpdate")}
        </button>
      </div>
      <p className="set-hint">
        {t("about.intro")}
      </p>
    </section>
  );
}

// 独立设置中心：左侧标签栏 + 右侧内容。把原先散落在主题弹层里的
// 外观 / 插件 / 空间隐私与会话锁定，以及 AI 配置统一收口，避免「危险开关藏在
// 调色板里」这种语义错位。
export function SettingsDialog() {
  const { t } = useTranslation();
  const open = useEditorStore((s) => s.settingsOpen);
  // 设置面板打开时锁住内容区滚动（锁 `.note-scroll`，不是 body）。
  useOverlayScrollLock(open);
  // Android 返回键：优先关掉最上层浮层（见 lib/overlayStack.ts）。
  useOverlayLayer("settings", open, () => useEditorStore.getState().closeSettings());
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

  // ⭐ 2026-10-08 第 5 招（裁定 A ✓）：**默认全显** ✓ —— 读不到偏好 ⇒ `false` ⇒ 一个组都不藏 ✓
  //   （⛔ 绝不"默认藏" ✗：默认藏 ＝ 默认找不到 ✗）。打开后只留基础组 ✓，并**记进 localStorage** ✓。
  // ⛔⛔ **这个 `useState` 必须在下面那句 `if (!open) return null;` 之前** —— 它原先被放在**之后**，
  //   于是 `open: false → true` 时 hook 个数变了 ⇒ 打开设置面板就抛 `Minified React error #310`，
  //   设置面板整块打不开（2026-10-08 由 CI 的 `check-web-build` 抓到：它同时报「插件入口没走到」；
  //   真因与修法见 `scripts/check-hook-order.mjs` 头部第 3 条真事故 ✓）。
  const [hideAdvanced, setHideAdvanced] = useState<boolean>(() => readHideAdvanced());

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
  {/* ⚠️ Web 版没有本机通道 ⇒ 「外部 AI 接入」那一项**整个不出现** ✓（与命令面登记成桌面专属同一口径 ✓；
            不留一个点进去是空白的 tab ✗）。 */}
        {visibleGroups<SettingsGroup>(SETTINGS_GROUPS.map((g) => g.id), hideAdvanced, ADVANCED_GROUPS).map((gid) => {
          const g = SETTINGS_GROUPS.find((x) => x.id === gid)!;
          const items = TABS.filter((it) => it.group === g.id && (it.id !== "mcp" || isDesktopPlatform()));
          // ⚠️ 组里一项都没有（如 Web 版没有 MCP）⇒ **连标题都不画** ✗（不留空分组 ✓）
          if (!items.length) return null;
          return (
            <div className="set-rail-group" key={g.id}>
              <div className="set-rail-group-title">
                {/* ⭐ 2026-10-10 R185（真机：分类栏被挤成**单字竖排** ✗）：标签原来是**裸文本节点** ✗
                    ⇒ 它是 flex 容器里的匿名 flex 子项 ⇒ 自动最小尺寸 ＝ min-content ＝ **一个汉字**
                    （CJK 可在任何字之间断行 ✓）⇒ 一被压窄就竖成一列 ✓。
                    ⇒ 包一层带**明确宽度策略**的 `span.set-rail-label` ✓（规则在 App.css ✓）。
                    ⚠️ 形状借自 win 的 `3f66ff44`（同为"flex 子项缺宽度策略"✓），但**对象不同** ⇒
                    修法方向也不同 ✗：他那格是"被长文本顶开"⇒ 补 `min-width: 0` ✓；
                    我们这格是"被挤窄"⇒ 补 `flex: 0 0 auto` ＋ `white-space: nowrap` ✓（⛔ 不是照抄 ✗）。 */}
                <span className="set-rail-label">{t(g.labelKey)}</span>
              </div>
              {items.map((it) => (
                <button
                  key={it.id}
                  className={`set-rail-item${tab === it.id ? " is-on" : ""}`}
                  aria-current={tab === it.id}
                  onClick={() => setTab(it.id)}
                >
                  <span className="set-rail-icon">{it.icon}</span>
                  <span className="set-rail-text">
                    <span className="set-rail-label">{t(it.labelKey)}</span>
                    <span className="set-rail-hint">{t(it.hintKey)}</span>
                  </span>
                </button>
              ))}
            </div>
          );
        })}
        {/* ⭐ 2026-10-08 第 5 招（裁定 A ✓）：**个人偏好**「隐藏高级项」。
            默认**关** ⇒ 高级项照常全都看得见 ✓（谁都不会找不到功能 ✓）；想清爽的人自己打开 ✓。
            ⛔ 它不是"基础/高级模式" ✗（那要用户先自我认定属于哪一档 ⇒ 想用 MCP 的人得先知道"有个高级模式" ✗）。 */}
        <button
          type="button"
          role="switch"
          aria-checked={hideAdvanced}
          className={`set-rail-pref${hideAdvanced ? " is-on" : ""}`}
          title={hideAdvanced ? "显示全部设置项" : "只留基础项（外观 / 账户 / 数据）"}
          onClick={() => {
            const next = !hideAdvanced;
            setHideAdvanced(next);
            writeHideAdvanced(next);
            // ⚠️ 别把当前页留在**刚被藏起来**的组里 ✗（否则导航里没有它、内容却还开着 ✓ 会让人找不到北 ✓）
            if (next && ADVANCED_GROUPS.includes(tab as SettingsGroup)) setTab("appearance");
          }}
        >
          {hideAdvanced ? "显示高级项" : "隐藏高级项"}
        </button>
        </nav>
        <div className="set-body">
          <header className="set-body-head">
            <div className="set-body-head-text">
              <div className="set-body-title">{TABS.find((x) => x.id === tab) ? t(TABS.find((x) => x.id === tab)!.labelKey) : ""}</div>
              <div className="set-body-desc">{TABS.find((x) => x.id === tab) ? t(TABS.find((x) => x.id === tab)!.hintKey) : ""}</div>
            </div>
            <button className="set-close" onClick={close} aria-label="关闭设置">×</button>
          </header>
          <div className="set-body-scroll">
            <div className="set-body-inner">
            {tab === "appearance" && <AppearancePane />}
            {tab === "spaces" && <SpacesPane />}
            {tab === "email" && <EmailPane />}
            {tab === "data" && <DataPane />}
            {tab === "plugins" && <PluginsPane />}
            {tab === "abilities" && <AbilitiesPane />}
            {tab === "security" && <SecurityPane />}
            {tab === "ai" && (
              <section className="set-section set-ai">
                {/* ⛔ 2026-10-08 删掉一行 `<div class="set-section-title">AI 服务</div>` ✗ ——
                    面板头已经写着「AI」＋「服务商与模型」（`set-body-title` / `set-body-desc`），
                    正文再来一个「AI 服务」是同义重复；而且它是这一页**唯一没走 i18n** 的小节标题
                    （英文界面里也是中文）✗。owner 2026-10-08 在真窗口里圈出它问「是不是多余」✓。
                    ⚠️ 判据在 `check-web-build`：真 Chromium 打开 AI 页 ⇒ 正文 `.set-ai .set-section-title`
                    必须是 **0 个** ✓（那一页的所有小节标题都该在页签里，不该在正文顶部再报一次面板名）。 */}
                <AiSettingsForm onDone={() => {}} showCancel={false} />
              </section>
            )}
            {tab === "mcp" && isDesktopPlatform() && <McpAccessPane />}
        {tab === "about" && <AboutPane />}
            {/* ⭐ 2026-10-11：设备直连的设置面（桌面专属 ⇒ 与 mcp 同一道平台门 ✓）。 */}
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
