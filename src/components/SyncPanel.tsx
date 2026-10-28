import { useEffect, useState } from "react";
import { isMobileViewport } from "../hooks/useMobile";
import { useMobileNav } from "../store/mobileNav";
import { usePopover } from "../hooks/usePopover";
import { useOverlayScrollLock } from "../hooks/useOverlayScrollLock";
import { useOverlayLayer } from "../hooks/useOverlayLayer";
import { api, type SyncProfile, type SyncBudget, type LanStatus, type NearbyPeer, type SpaceSyncState } from "../lib/api";
import { startEncryptedAdopt } from "../lib/encryptedAdopt";
import { MeshMissingSpaces } from "./MeshMissingSpaces";
import { autoPickPeer } from "../lib/pairTarget"; // ⭐ 常驻判据在 src/lib/pairTarget.test.ts ✓
import { peerIdentityLine } from "../lib/peerIdentity"; // ⭐ 规格 J21 的**唯一实现**（信任前展示身份 ✓）
import { toast } from "../store/toast";
// ⭐ **2026-10-14**：⭐ `MeshAdvancedForm` **又回到面板了** ✓（⭐ 设备级那三格在 `:2120` 一带 ✓）——
//   ⚠️ 旧注释那句"已搬到「设置 · 同步」⇒ 面板不再引它"是**旧口径** ✗，已改 ✓；⭐ 设置那边已去掉 ✓。
// ⚠️ **2026-10-14**：`Reading` 现在从**读数那个 lib** 引 ✓（它原来住 `TrustDevicePanel.tsx` ✓，而那个组件**已删** ✓）。
import {
  MESH_TRUST_BEGIN_COMMAND,
  MESH_TRUST_PREPARE_COMMAND,
  type Reading,
} from "../lib/trustDevicePanelReadings";
import { useSpaceStore } from "../store/space";
import { useAuth } from "../store/auth";
import { useEditorStore } from "../store/editor";
import { useNotes } from "../store/notes";
import { useSyncStatus } from "../store/syncStatus";
import { inputDialog } from "../store/input";
// ⭐ **P-3c**：⭐ 二次确认走**仓内既有**那个件 ✓（⛔ 原生 `confirm` ✗ —— 本仓 `confirm` 只出现在配对
//   那条路的 `need_confirm` 上 ✓，它不是弹窗 ✓）；⛔ 不自造一个 ✗（样式/文案归 owner ✓）。
import { confirmDialog } from "../store/confirm";
import { CloudSyncIcon } from "./icons";
import { isDesktopPlatform, platform } from "../lib/platform";
// ⚠️ 2026-09-29（D3）：**行内 Markdown 的契约**。后端（Rust）给人看的话是按行内 Markdown 写的
// （`**能被别人拉到**` 那种）⇒ 它必须在【渲染边界】过这一道，否则用户看见两个星号。
// 契约的唯一实现是 `src/lib/inlineMd.tsx`（toast 与 SpacePrivacySection 已在用）⇒ 这里接上它。
import { inlineMd } from "../lib/inlineMd";
import { subscribeLanChanged } from "../lib/lanEvents";
import { isNearRealtimeEnabled, applyNearRealtime } from "../lib/nearRealtime";
// ★ 2026-09-29（丙档「设备直连」）：**「拉取间隔」这一档** —— 用户可见、可持久化，
//   读写口径都在 `lib/syncMode.ts` 那一处（面板只调它，不自己碰 localStorage）。
//   ⚠️ 它替换掉了原来"按 `mesh.enabled` 在代码里悄悄换成 5 秒"那条路（见 `effectiveAutoSyncMs`）。
import {
  broadcastAutoSyncChanged,
  readAutoSyncMs,
  settingsForMode,
  syncModeHint,
  syncModeOf,
  setLanMeshActive,
  writeAutoSyncMs,
  type SyncMode,
} from "../lib/syncMode";
import { SyncStatusStrip } from "./SyncStatusStrip";
import { SyncNearbyGroups } from "./SyncNearbyGroups";
import { SyncAdvancedFold } from "./SyncAdvancedFold";
// ⭐ **R176-A（owner 2026-10-28 拍 A）**：④「能读的状态」那一屏 ＋ ②③⑤ 的文案与校验。
//   ⚠️ 全部是**纯函数／常量**（唯一实现 `src/lib/personalSyncReadout.ts` ✓）——
//   面板只负责把读数传进去、把结果摆出来（⛔ 不在这里拼句子 ✗：那正是旧 `heroRoute` 被删的原因之一 ✓）。
import { SyncReadout } from "./SyncReadout";
import {
  PASSWORD_AUTO_HINT,
  PASSWORD_AUTO_VALUE,
  PORT_ADVANCED_HINT,
  PORT_INVALID_TEXT,
  UNTRUST_LABEL,
  UNTRUST_SCOPE_NOTE,
  personalSyncReadout,
  portTextToBind,
} from "../lib/personalSyncReadout";
// ⭐⭐ **2026-10-14（owner 拍「整张卡连输入框一起去掉」）** ✗：⭐ `MeshAdvancedForm` 的挂载点
//    **已从本面板删掉** ✓ ⇒ ⛔ 这里不再 import 它 ✗（那个组件仍在仓里 ✓、它自己的 7 条判据照旧 ✓，
//    但**没有挂载点** ⇒ 孤儿组件 ✓ —— 与 `TrustDevicePanel` 同一形状 ✓，去留等 owner 一句话 ✓）。
//    ⚠️ 由此两点如实记在**它原来那一块**的注释里（见下面那条 ★★ ✓）：① 界面再也不能改监听地址；
//    ② 界面再也没有「关掉网格」⇒ 网格开着时用户从界面上关不掉 ✓。
// ⭐ 跨网中继那两格（图⑤「中继」／图⑧「中继许可证」，2026-10-10）——
//    读数（连上没连上 ＋ 剩余 N 天）**全部来自后端**，这一块只摆上去 ✓。
import { RelayStatusSection } from "./RelayStatusSection";
// ⭐ 2026-10-18：个人版「跨网同步订阅」面板（桌面专属；Web 侧没有本机私钥 ⇒ 不挂）。
import { LicenseSection } from "./LicenseSection";
import {
  publishPendingRemoteTotal,
  subscribePendingRemoteTotal,
} from "../lib/pendingRemoteBadge";

const ENTITY_LABELS: Record<string, string> = {
  page: "页面",
  database: "数据库",
  attachment: "附件",
  block: "块",
};
const entityLabel = (e: string) => ENTITY_LABELS[e] || e || "项";
// 相对时间：最近用「刚刚/几秒前/几分钟前」，超过 1 天显示日期。
const relTime = (ts: number) => {
  const diff = Date.now() - ts;
  const s = Math.floor(diff / 1000);
  if (s < 5) return "刚刚";
  if (s < 60) return `${s} 秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const fmtDuration = (ms: number) => (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + " 秒";
/** C1：本次下载量说成人话（只用来展示，精度不重要）。 */
const fmtMb = (bytes: number) => {
  const mib = bytes / (1024 * 1024);
  return mib >= 1 ? `${mib.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
};
/** ★ 2026-09-29（IA）：「同步方式」那一行的右侧摘要值。
 *  三档的文案与下面 <select> 里的 <option> **逐字一致** —— 不新造词，也不拍扁成
 *  「自动（推荐）」那种说法（拍扁了就说不清用户现在到底在哪一档）。 */
const SYNC_MODE_TEXT: Record<SyncMode, string> = {
  off: "关闭",
  interval: "按间隔（每 30 秒）",
  realtime: "近实时（连着服务端时立刻拉）",
};
/** ★ 2026-09-29（IA）：「同步预算」那一行的右侧摘要值。
 *  取值区间与 `.sync-budget-row` 里那些 <option> 一一对应（256/512/1024/2048/5120 MB）
 *  ⇒ 摘要值念出来与展开后那个下拉里选中的一项**是同一个说法**。 */
const optMb = (n: number) => (n >= 1024 && n % 1024 === 0 ? `${n / 1024} GB` : `${n} MB`);

interface ServerSpace {
  id: string;
  name: string;
  role: string;
  owner_id: string;
}

interface ServerMember {
  user_id: string;
  email: string;
  role: string;
}

interface EditRow {
  ws_id: string;
  name: string;
  /** ⚠️ **2026-10-04 加**：⭐ 空间分类 ✓ —— 服务器那一段只列**团队空间**要用它。
   *  ⭐ 来源＝`api.spaceSecurityOverview()`（那边现成有 `kind` ✓，不用改 Rust ✓）。
   *  ⚠️ 取不到时**兜底当团队** ✓ —— 宁可多给一个入口（后端真拦在 `set_sync_profile` ✓），
   *  也不要让团队空间看不到「创建组织空间」而卡住 ✓。 */
  kind: "personal" | "team";
  server_url: string;
  token: string;
  space_id: string;
  // Login-to-get-token (U3): email/password are transient (never persisted); the
  // resulting token fills `token`. `remoteSpaces` caches the spaces the account
  // joined (from GET /spaces) so the 空间 ID 可以下拉绑定.
  loginEmail: string;
  loginPassword: string;
  // 注册邀请码（仅注册 tab 用，注册时传给服务端 /auth/register）。
  loginRegisterCode: string;
  // 登录/注册 tab（login | register）。
  authMode: "login" | "register";
  remoteSpaces: ServerSpace[];
  // M27 成员管理（选中空间且已登录后可用）：members 列表 + 邀请表单。
  members: ServerMember[];
  memberOpen: boolean;
  inviteEmail: string;
  inviteRole: string;
  // P6.1 每空间「附件同步」开关（默认 true）。**只控制附件字节**，笔记正文 / 标题 /
  // 结构等元数据照常同步 ⇒ 关掉后另一端「看得见但打不开」。
  syncAttachments: boolean;
}

// Per-workspace sync targets (S8): each local workspace binds to its own remote
// (server + token + space_id), so one person can sync different spaces to
// different servers/accounts (multi-server × multi-space).

/** ⭐ **P-4 片②a（2026-10-13）**：那一屏要显示的**比对码** ✗ —— ⭐ 默认**如实「读不到」** ✓
 *  （手法照上面 `TRUST_DEVICE_READINGS` 那条 ✓：⭐ 模块级常量 ⇒ 不必每帧新建对象 ✓）。
 *  ⚠️ ⛔ **不许编一个码** ✗ —— ⭐ 码由 `pairing_trust::pairing_code_for`（片① 已入库 ✓）算 ✓，
 *  ⭐ 而**接线**归**下一片**（片②b ✓）⇒ ⭐ 今天这一屏只会如实说"读不到" ✓。 */
const PAIR_CODE_UNAVAILABLE: Reading<string | null> = {
  kind: "unavailable",
  reason: "还没接上读数（码 ＝ 本机公钥 ＋ 对方公钥 ＋ 这一轮的 trust_ask 算出来的）",
};

/** ⭐ **2026-10-27（owner 拍 M2）**：本机**只自动备一次**局域网前置 ——
 *  一旦自动跑过（或用户手动关过），本机不再自动开第二次 ✓。
 *  ⚠️ 用 localStorage（不是库）✓：它是"这台机器上这个界面的选择"，⛔ 不跟同步、不进备份 ✓。 */
const LAN_AUTO_CONFIG_KEY = "shuyo.lan-sync-autoconfig.v1";

/** ⭐ **P-3d（2026-10-13）**：设备列表那**三段**的名字与 testid ✓ ——
 *  ⭐ 数组下标 ＝ 段序（`nearbyBucket` 的返回值 ✓）：需要重新配对 ⇒ 已信任 ⇒ 待配对 ✓。 */
const NEARBY_GROUPS = [
  { testid: "nearby-group-keychanged", label: "需要重新配对" },
  { testid: "nearby-group-trusted", label: "已信任" },
  { testid: "nearby-group-pending", label: "待配对" },
] as const;
/**
 * ⭐⭐ **2026-10-14（owner）**：「需要重新配对」要夹在**已信任与待配对之间** ✓
 * ⇒ 显示顺序 ＝ **已信任 → 需要重新配对 → 待配对** ✓（＝桶号 `[1, 0, 2]` ✓）。
 *
 * ⚠️ ⛔ **不许靠调换 `NEARBY_GROUPS` 的条目**来实现 ✗ —— 那一份是**按桶号索引**的
 * （下标就是桶号 ✓；非空支靠 `NEARBY_GROUPS[nearbyBucket(p)].testid` 把设备归段 ✓）
 * ⇒ 换掉它会把"桶号"和"显示顺序"搅成一份 ✓。⭐ 所以顺序**单独一份** ✓。
 * ⚠️ ⭐ **两支渲染都必须用它** ✓（0 台那支 ／ 有设备那支 ✓）—— ⛔ 否则两种画面顺序会不同 ✗。
 */
const NEARBY_ORDER = [1, 0, 2] as const;
/** ⭐ **刀十五（2026-10-14，按设计图）**：把 `mesh.bind`（形如 `0.0.0.0:8788` ✓）拆成 ⭐ 地址／端口 ✓
 *  —— ⭐ **一处实现** ✓（⭐ 状态条用 ✓）；⭐ 按**最后一个 `:`** 拆 ✓（IPv6 也安全 ✓），
 *  ⭐ 拆不出来 ⇒ ⭐ 地址给**原文** ✓、⭐ 端口给空串 ✓（⭐ 界面那边如实写「未读到」✓，⛔ 不编 ✗）。 */
const splitMeshBind = (bind: string): { addr: string; port: string } => {
  const i = bind.lastIndexOf(":");
  return i > 0 ? { addr: bind.slice(0, i), port: bind.slice(i + 1) } : { addr: bind, port: "" };
};

/** ⭐ **P-2a-1（2026-10-13）**：`contentOnly` ⇒ ⭐ **只渲染内容体**（⛔ 不带抽屉触发器 ✗、
 *  ⛔ 不带浮层定位 ✗）⇒ 让**同一份 JSX** 也能放进内容区（`App.tsx` 的 `view === "sync"` 那一支 ✓）。
 *  ⚠️ 默认 `false` ⇒ ⭐ **抽屉那支逐字不变** ✓（一行 JSX 都没搬 ✓）。 */
export function SyncPanel({
  contentOnly = false,
  pairCode = PAIR_CODE_UNAVAILABLE,
}: { contentOnly?: boolean; pairCode?: Reading<string | null> } = {}) {
  // 面板比默认弹层宽/高，把实际尺寸告诉 usePopover，靠边打开时才不会被切掉。
  const { open, pos, isSheet, triggerRef, contentRef, toggle, close } = usePopover<HTMLButtonElement>({
    width: 452,
    minSpace: 420,
  });
  useOverlayScrollLock(open);
  // Android 返回键：优先关掉最上层浮层（见 lib/overlayStack.ts）。
  useOverlayLayer("sync", open, () => close());
  const spaces = useSpaceStore((s) => s.spaces);
  const activeId = useSpaceStore((s) => s.activeId);
  const authEmail = useAuth((s) => s.email);
  const [rows, setRows] = useState<EditRow[]>([]);
  // 自动同步间隔（毫秒；0=关闭），存 localStorage 供 App 级定时器使用。
  // ⚠️ 写入口只有 `writeAutoSyncMs`（它会顺便**广播**，让 App 那条定时器重挂 —— 否则面板改了档
  //    而 App 不重渲染，定时器就还按老间隔跑）。
  const [autoMs, setAutoMs] = useState<number>(() => readAutoSyncMs());
  const setAuto = (ms: number) => {
    writeAutoSyncMs(ms);
    setAutoMs(ms);
  };
  // 「近实时推送」（桌面流通道，第 48 轮）：默认开。开关本身与读写口径都在 `lib/nearRealtime.ts`
  //（挂载时起流那条路也读它）—— 这里只做界面：拨一下 ⇒ **立刻**起/停（不等重开页面）。
  const [nearRealtime, setNearRealtime] = useState<boolean>(() => isNearRealtimeEnabled());
  const toggleNearRealtime = async (on: boolean) => {
    setNearRealtime(on); // 先动界面（乐观），失败再回滚并如实说
    try {
      await applyNearRealtime(on);
      setStatus(on ? "已开启近实时推送" : "已关闭近实时推送（改为按间隔轮询）");
    } catch (e) {
      setNearRealtime(!on);
      setStatus(`近实时切换失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };
  // 「同步方式」（2026-09-26 口径收敛）：原来这里是**两个**控件 —— 自动同步间隔四档 ＋ 近实时开关；
  // 它们管的是同一件事的两个旋钮，用户还得在脑子里把两件事叠起来算。现在合成**一个**三选一，
  // 映射与那句人话都在 `lib/syncMode.ts`（**唯一一处**），这里只负责调它。
  const syncMode = syncModeOf(autoMs, nearRealtime);
  const applySyncMode = (mode: SyncMode) => {
    const next = settingsForMode(mode);
    setAuto(next.autoMs);
    // ⚠️ 近实时那半边不只是改 state：`applyNearRealtime` 会**立刻**起/停那条流（不等重开页面），
    //    并且把开关落盘（`lib/nearRealtime.ts` 一处实现）。
    void toggleNearRealtime(next.nearRealtime).then(() => {
      // ★★ 2026-09-26（口径对齐）：**两半都落定之后再广播一次** —— 有效间隔是
      //    `f(间隔档位, 近实时开关)` 的函数，而上面 `setAuto` 那次广播发生在近实时**还是旧值**的时候。
      //    不补这一下的现场：「近实时 → 关闭」会被算成"近实时还开着 ⇒ 挂 5 分钟兜底"
      //    ⇒ 用户选了「关闭」，机器却每 5 分钟自动同步一次（正好是这一轮在修的那类不一致）。
      broadcastAutoSyncChanged();
    });
  };
  const [status, setStatus] = useState("");
  // 甲-1 接线第 3 件：**局域网发现的读数**（`lan_status`）。只在**桌面且面板开着**时轮询 ——
  // 发现层是进程常驻的（`setup` 里就起了），面板关着就没人看这一行（少一次 IPC/秒）。
  // ⚠️ `line` 是 Rust 侧 `lan::status_line` 的**原文**，这里**只显示、不解释**（档位由 Route 决定）。
  const [lanStatus, setLanStatus] = useState<LanStatus | null>(null);
  /** ⭐ **2026-10-28（owner：「一步到位」·P1）**：**加密空间的逐条同步状态** ——
   *  "为什么没数据"要能分辨：本机锁着／对端锁着／对端不在线／可以拉（见 `space_sync_state` ✓）。
   *  ⚠️ 与 `lanStatus` 同一拍（5 秒）读；读不到 ⇒ `null`（⛔ 不拿空数组冒充"没有加密空间" ✗）。 */
  const [spaceSync, setSpaceSync] = useState<SpaceSyncState | null>(null);
  /** ⭐ 2026-10-19（owner：「配对成功后，页面不能自动刷新」）—— 强制再读一次局域网读数。
   *
   *  真因：配对成功那条路只弹了一句 toast，**没有重新读 `lan_status`** ⇒ 那一行还停在「待配对」，
   *  要等下一轮 5 秒轮询（甚至更久）才变 ⇒ 用户看到的是「配好了，没反应」。
   *  ⇒ 做法：一个自增 nonce 塞进轮询 effect 的依赖里 —— 它一变就**立刻**重跑一次 `tick()`
   *  （并重挂定时器）。⚠️ 只"再读一次"，⛔ 不在这里自己改列表（列表唯一来源仍是后端 `lanStatus.nearby`）。
   *  判据：`syncPanelDevicePair.wiring.test.ts` 的「配对成功后要重读」那一条。 */
  const [lanNonce, setLanNonce] = useState(0);
  /**
   * ⭐ **R176-A（owner 2026-10-28 拍 A）③**：**「高级」里那一格端口**的草稿。
   *
   * ⚠️ `null` ＝ **跟着读数走** ✓（显示的是 `lanStatus.mesh.bind` 拆出来的真端口 ✓）——
   *    用户没动过就⛔ 不自己造一个值 ✗（界面写死默认值＝跟系统报出来的真实端口打架，
   *    与 `SyncStatusStrip.tsx` 头部那条纪律同源 ✓）。
   * ⚠️ 端口**只在「高级」里出现** ✓（J12：默认流程零手输端口）；主界面那三格只显示读数 ✓。
   */
  const [meshPortDraft, setMeshPortDraft] = useState<string | null>(null);
  // 切空间 ⇒ 端口跟着那一份读数走（⛔ 不把上一个空间的草稿带过去 ✗）。
  useEffect(() => {
    setMeshPortDraft(null);
  }, [activeId]);
  useEffect(() => {
    // ⚠️⭐ **2026-10-14（owner 连问三次「同步面板还是旧的」的第二个、也是真正的机械原因）** ✗ ——
    // ⭐ 这一行原来是 `if (!open || !isDesktopPlatform()) return;` ✓ ⇒ ⭐ ⭐ **只有浮层打开时才读** ✗。
    // ⭐ 而左栏那颗「同步」走的是 ⭐ `contentOnly`（⭐ `view === "sync"` ⇒ `<SyncPanel contentOnly />` ✓，
    //    它渲染出来是 `.sync-popover.is-sync.is-inline` ✓、⭐ `open` **始终是 false** ✗）
    //    ⇒ ⭐ ⭐ **本 effect 直接 return ⇒ `lanStatus` 永远是 null** ✗
    //    ⇒ ⭐ 依赖它的那两块（⭐ 「设备直连」折叠里的 `MeshAdvancedForm` ✓、⭐ 「附近发现/地址」那一行 ✓）
    //       ⭐ **永远不渲染** ✓ ⇒ ⭐ 界面上一个字都不变 ✓。
    // ⇒ ⭐ 修法：⭐ `contentOnly` 也算"看得见" ✓（⭐ 它本来就是"内容区那一份"✓）。
    // ⚠️ ⭐ 判据面：⭐ 夹具走的不是这一档 ⇒ **DOM 级测不到** ✗ ⇒ 本笔靠**真窗口 CDP 读数**收口 ✓
    //    （⭐ 逐字：⭐ 改前 `details` 只有「同步方式／空间隐私」⇒ 改后应多出「设备直连」＋ 三个控件 ✓）。
    if ((!open && !contentOnly) || !isDesktopPlatform()) return;
    let alive = true;
    const tick = async () => {
      try {
        const st = await api.lanStatus(activeId);
        // ⭐ 2026-10-28（P1）：**加密空间逐条状态**同一拍读 —— 它与 `lan_status` 是两件事：
        //   一个说"附近有谁"，一个说"加密空间为什么没数据"（本机锁着／对端锁着／可以拉）。
        try {
          const enc = await api.spaceSyncState();
          if (alive) setSpaceSync(enc);
        } catch {
          if (alive) setSpaceSync(null);
        }
        if (alive) {
          setLanStatus(st);
          // ★ 2026-09-29：把"局域网这一档开着吗"喂给 `syncMode`（它就是 `App` 那个自动同步
          //   定时器的间隔来源）。owner 判定：**局域网这一档的节拍 = 用户在「拉取间隔」里选的那一档**
          //   （默认 5 秒，见 `syncMode.ts` 的 `PULL_INTERVALS`）。
          //   ⚠️ 用的是 Rust 判好的两个**结论**（`mesh.enabled` ＝ `cfg.bind.is_some()`、
          //      `syncMode` ＝ 总闸那一档），**不按地址形状自己再判一次档**（判据 ⑭ 钉的是后者）。
          setLanMeshActive(!!st.mesh.enabled);
        // ⭐ **2026-10-27（owner「go」）**：**已配对名单也跟这次读数走**（同一份 `lan_status.mesh.paired`）
        //   —— 原来那张名单只在挂载/切空间时读一次 ⇒ 另一台刚配对完，「已配对」那句要等切空间才变 ✗。
        //   ⚠️ 只有它**真是数组**才覆盖（读不到/老构建给不出 ⇒ 保留上一次的，⛔ 不用 [] 冒充"没有" ✗）。
        const pairedNow = st.mesh?.paired;
        if (Array.isArray(pairedNow)) setDuList(pairedNow);
        }
      } catch {
        // 读不到（命令没注册 / 老构建）⇒ 这一行**不显示**，别把它装成"没有发现到对端"。
        if (alive) setLanStatus(null);
      }
    };    void tick();
    const timer = window.setInterval(() => void tick(), 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [open, contentOnly, activeId, lanNonce]);
  // ⚠️ 只有**当前空间这条档案绑全了**才显示那一行：`lan_status` 没绑定时会回落"第一条绑定"
  //（那是给无参调用兜底的），在面板上显示**别的空间**的地址是错的。
  const activeRow = rows.find((r) => r.ws_id === activeId);
  // ⭐⭐ **2026-10-25（owner：「立即同步这个按钮不能点」）**：那颗按钮原来复用 `syncOne(activeRow)`，
  //   而 `syncOne` 是**服务端同步**那条（要求 server_url/token/space_id）；个人空间**永远没有这条档案**
  //   ⇒ `activeRow` 恒 null ⇒ `disabled={syncing || !activeRow}` 恒真 ⇒ 按钮永远是灰的 ✗。
  //   ⇒ 局域网这一档的正确动作是 **`mesh_sync_now`**（跑一轮对等拉取，不需要任何服务端配置）。
  //   ⚠️ 这个 handler **必须留在 `syncOne` 与 `update` 之间**（`syncPanelMesh.wiring` ⑦⑧ 在那一段里
  //      找 `${rep.note}` 与 `loadPages()`；放到别处会被判成"面板自己拼句子"）。
  const [meshBusy, setMeshBusy] = useState(false);

  // 丙-③-b-2b-2：**网格（对等交换）**那一档的设置面。
  // ⚠️ 三个输入各自独立，保存时按命令面的口径给值（`""` ＝ 清除那一项、`null` ＝ 不动）——
  //   这里**不再自己解释一遍**（两处各解释一次，迟早会有一处说错）。
  // ⚠️ 它的门槛**不是** `lanRowBound`：网格**不需要**服务端地址，只要求这个空间有 `space_id`
  //   （"只开网格、不绑服务端"正是这一档要支持的配置）。
  // ⚠️ 监听地址（＋ 已删掉的口令／配对暗号）那几个 state 与 handler **已抽到 `MeshAdvancedForm`** ✓
  //    （task 派单 Round 1：纯抽取，界面与行为一个字没改 ✓ —— 下一轮换挂载点到设置面 ✓）。
  //    这里只留"门槛"那几句解释（它属于面板这一层的判断 ✓）。
  // ⭐ **U11/T5（2026-10-02）**：**逐台解除** —— 这个空间认了哪些设备、把哪一台踢出去。
  //
  // ⚠️ **三件不许**（都有既有口径盯着）：
  //   ① ⛔ **可见处不出现裸 `device_id`** ✗（`INV-UI-copy-no-internal-ids`；
  //      判据 `syncPanelMesh.wiring.test.ts` ③ 扫这一屏 ✓）⇒ 屏幕上只给**短码**（人读用 ✓）
  //   ② ⛔ 不出现「已确认／已验证」这类判定语 ✗（同一族口径 ✓）
  //   ③ ⛔ 短码**从设备号派生，不从哈希派生** ✗ —— 读数里**根本没有**哈希（见 Rust `MeshPairedDevice` ✓），
  //      而"从哈希取几位显示"会把"绝不出哈希"那条自己破掉 ✓
  const [duList, setDuList] = useState<{ deviceId: string; addedAtMs: number }[]>([]);
  const [duBusy, setDuBusy] = useState("");
  useEffect(() => {
    if (!activeId) return;
    let alive = true;
    void (async () => {
      try {
        // ⚠️ 两个参数都给 `null` ⇒ **不写任何东西** ✓（只取读数 ✓ —— 与那两条保存路径同一支命令 ✓）
        const st = await api.meshSetConfig(activeId, null, null);
        if (alive) setDuList(st.paired ?? []);
      } catch {
        // 读不到就**空着** ✓ —— ⛔ 不假装有设备 ✗
        if (alive) setDuList([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [activeId]);
  const duUnpair = async (deviceId: string) => {
    if (!activeId) return;
    // ⭐ **P-3c（2026-10-13，R8）**：⭐ **二次确认** ✗ —— ⛔ 未确认 ⇒ **一个字节都不发** ✗（⛔ 不许"先调再撤" ✗）。
    //   ⚠️ 用仓内**既有**那个确认件 ✓（`store/confirm` 的 `confirmDialog({title,message})` ✓ ——
    //      `BackupButton.tsx:101` 就是这么用的 ✓）；⛔ **不用原生 `confirm`** ✗。
    //   ⚠️ 文案是 owner 的承诺口径 ✓：⭐ 说得含「**重新配对**」✗（解除 ≠ 永久失联 ✓）。
    //   ⚠️⭐ 乐观摘行（`:312` 那条 `setDuList`）**留在成功分支里** ✓ —— ⛔ 别挪到确认之前 ✗。
    const ok = await confirmDialog({
      title: "解除这一台？",
      // ⚠️ 这里是**纯文本**（不是 JSX ✓）⇒ ⛔ **不能**用 `<b>` ✗、也⛔ **不能**用 Markdown 的 `**…**`
      //   （那句话会把星号原样显示出来 ✓ —— `syncPanelMesh.wiring.test.ts` ⑨c 那条规矩管的正是它 ✓）。
      // ⭐ **R176-A（owner 2026-10-28 拍 A）⑤**：两个承诺都写进这句 ✓ ——
      //   ① **不删数据**：笔记和附件**一个字节都不会删** ✓（owner 最怕"取消信任把笔记删了"）；
      //   ② 想再连要**重新配对** ✓（解除 ≠ 永久失联 ✓；旧判据 `syncPanelDeviceUnpair` ② 钉的就是这个词 ✓）。
      message: "不再信任后，这一台拉不动你的内容了；笔记和附件一个字节都不会删。想再连要重新配对一次。",
    });
    if (!ok) return;
    setDuBusy(deviceId);
    try {
      const r = await api.deviceUnpair(activeId, deviceId);
      // ⚠️ 别和后端那句重复：`r.note` 自己已经以「已解除这一台：…」开头（实测 ✓）⇒ 这里只说结果与台数 ✓
      // ⭐ **2026-10-14**：⭐ 结果原来写进 `duNote` ✗ —— 而它只显示在被删掉的「逐台解除」那一列里 ✓
      //    ⇒ ⭐ 改成**就地报一句** ✓（主视图那张卡上的「撤销配对」就是唯一的调用点 ✓）。
      //    ⚠️ 判据点名的那三样（`wasPaired`／`pairedCount`／`r.note` ✓）**一个都没少** ✓。
      toast((r.wasPaired ? "" : "这一台本来就不在名单里。") + `还认 ${r.pairedCount} 台。` + r.note);
      setDuList((prev) => prev.filter((d) => d.deviceId !== deviceId));
    } catch (e) {
      toast(`没解除成：${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setDuBusy("");
    }
  };

  // ⚠️ `saveMeshRoom` / `disableMesh` **已抽到 `MeshAdvancedForm`** ✓
  //    （Round 1 纯抽取：行为逐字照搬 ✓，包括 `saveMeshRoom` 顺手更新 `lanStatus.mesh` 那一下 ✓）。
  //    ⭐ 其中 `saveMeshToken` **已于 2026-10-13 删掉** ✓ —— 用户手打的那条 `mesh_token` 已退役 ✗
  //      （`mesh.rs:787`／`:1727` ✓）；⛔ 后端那格数据**保留可读、不静默删** ✗（本片只动界面 ✓）。

  // ⭐ **T4（2026-10-01）：把这台设备接进来** —— owner 拍「乙」：**两个入口、两个名字** ✓
  //   · 老的那块（`SpacePrivacySection` 的「换设备」）搬**钥匙袋** ⇒ 本组件**不碰**它 ✓（写域收窄 ✓）
  //   · 这一块搬**接线**（地址 ＋ 窗口口令）⇒ 名字叫「**把这台设备接进来**」✓
  // ⚠️ **三步两态，且有一步是"停"**（`U2`／`U3`）：
  // 未加密空间那条提醒的读数（N ＝ 没开加密的空间数 ✓；⛔ 读不到 ⇒ `null`，⛔ 不拿 0 冒充 ✓）。
  const [plaintextCount, setPlaintextCount] = useState<number | null>(null);
  /** ⭐ **P-4 片②a**：那一屏（对码）开着没 ✓ —— ⭐ 由「接入」那一下**顺手打开** ✓
   *  （⚠️ 本片⛔ **不动** `trustDevice` 的调用时点 ✗ —— 那是片②b ✓）。 */
  const [pairScreen, setPairScreen] = useState(false);
  /** ⭐ **P-4 片②b（2026-10-13）**：⭐ 这一轮要对的是**哪一台** ✗ —— ⭐ 「接入」那一下记下来 ✓，
   *  ⭐ 「码对得上，确认」那一下才拿它去调 `trustDevice` ✓（⭐ 取消 ⇒ 清掉、一个字节都不发 ✓）。 */
  const [pairPeer, setPairPeer] = useState<NearbyPeer | null>(null);
  /** ⭐ **P-4 片③（2026-10-14）**：⭐ 屏上**真正**显示的那一格 ✗ —— ⭐ 起点＝prop ✓（⭐ 调用方给了就用它的 ✓）。
   *  ⚠️ ⭐ 只有那份是**占位**时，屏才**自己**去取真读数 ✓（⛔ 否则会抢调用方给的那份 ✗ ⇒
   *  片②a／②b 那几条**当锁**的判据就不可控了 ✓）。 */
  const [pairReading, setPairReading] = useState<Reading<string | null>>(pairCode);
  /** ⭐ **(乙)：取值就在「点『接入』」这一下里发起** ✗ —— ⛔ **不用 `useEffect`** ✗
   *  （⭐ 真因：⭐ 在 `createRoot` 无 `act` 的夹具里，effect 里那次 `setState` **走不到渲染** ✗；
   *   ⭐ 而点击处理里的 promise 续体落在夹具等的那几拍之内 ✓）。
   *  ⚠️ 还没回来 ⇒ ⭐ **先置成「读取中」那种如实态** ✓（⛔ 不许显示一个假码 ✗）。
   *  ⚠️ 调用方已经给了读数（`pairCode !== 占位`）⇒ ⭐ **一个字节都不取** ✓。
   */
  const fetchPairCode = async (peer: NearbyPeer) => {
    if (pairCode !== PAIR_CODE_UNAVAILABLE) return; // ⭐ 调用方给了读数 ⇒ 不抢它的 ✓
    setPairReading({ kind: "unavailable", reason: "正在取这一轮的比对码…" });
    try {
      // ⭐ 两个实参就是**那一台** ✓（⭐ 对方公钥＝`NearbyPeer.pubkey` ✓ 与命令侧同一个源 ✓；
      //    ⛔ 不传 `space_id` ✗ —— ⭐ 空间不参与派生 ✓）。
      // ⚠️ 形状＝**一个对象** ✓（⭐ 与 api.ts 那个包装一致 ✓ —— 上一片就是这么写的 ✓）
      const got = await api.pairingCodeReading({
        peerDeviceId: peer.device_id,
        peerPubkey: peer.pubkey,
      });
      setPairReading(
        got.code
          ? { kind: "ok", value: got.code }
          : // ⭐ `code: null` ＝ **读不到** ⇒ ⭐ 用**命令给的那句人话原因** ✓（⛔ 自己编一个 ✗）
            { kind: "unavailable", reason: got.reason },
      );
    } catch (e) {
      setPairReading({ kind: "unavailable", reason: `取比对码失败：${String(e)}` });
    }
  };
  /** ⭐ **2026-10-28（owner：「配对码老是对不上？」）**：对码屏开着的时候**重取**码
   *  （⛔ 不抢调用方给的读数 —— 这个函数只给下面那条轮询/事件用 ✓）。 */
  const refreshPairCode = async (peer: NearbyPeer) => {
    try {
      const got = await api.pairingCodeReading({ peerDeviceId: peer.device_id, peerPubkey: peer.pubkey });
      setPairReading(
        got.code ? { kind: "ok", value: got.code } : { kind: "unavailable", reason: got.reason },
      );
    } catch (e) {
      setPairReading({ kind: "unavailable", reason: `取比对码失败：${String(e)}` });
    }
  };
  /**
   * ⭐⭐ **2026-10-28（owner：「配对码老是对不上？」）**：**对码屏开着时，码会自己收敛**。
   *
   * ## 真机根因（"老是对不上"的正面）
   * 比对码 ＝ `f(本机公钥, 对方公钥, **这一轮的 trust_ask**)` ✓；"这一轮那串"是**两端各发一次**的，
   * 对面那串要等它的**公告**（`ANNOUNCE_INTERVAL_MS` = 30 秒一轮）才到本机。
   * 码原来 ⛔ **只在点「接入」那一下取一次** ✗ ⇒ 先点的那台用"只有自己那串"算、
   * 后点的那台用"两串都有、按 device_id 挑一遍"算 ⇒ **两个码永远不同**；
   * 屏上也不刷新 ⇒ 重试也一样（每次看到的都是那一刻算的码）✗。
   * ⇒ 现在：屏开着 ⇒ 每 2 秒／每收到一次 `lan:changed` 重取；两端的输入一旦齐了，
   *  **两端会收敛到同一个码** ✓。屏一关 ⇒ 立刻停（不多发请求）✓。
   */
  useEffect(() => {
    if (!pairScreen || !pairPeer) return;
    let alive = true;
    let off: (() => void) | undefined;
    const tick = () => {
      if (alive) void refreshPairCode(pairPeer);
    };
    const t = window.setInterval(tick, 2_000);
    void (async () => {
      const un = await subscribeLanChanged(tick);
      if (alive) off = un;
      else un();
    })();
    return () => {
      alive = false;
      window.clearInterval(t);
      off?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairScreen, pairPeer]);
  /** ⭐⭐ **2026-10-17**：⭐ 点「接入」＝ ⭐ 先**开一轮比对** ✗，再取码 ✓。
   *
   *  ⚠️ 为什么必须多这一步（owner 真机："点接入了，也没有（码）"✗）：⭐ 比对码 ＝
   *  `f(本机公钥, 对面公钥, 这一轮 trust_ask)` ✓，而 `trust_ask` 原来**只在 `mesh_trust_begin`
   *  （登记 ＋ 广播）里生成** ✗ ⇒ ⭐ 不先开一轮就取码 ⇒ 后端如实回"这一轮没有进行中的握手" ✓。
   *  ⭐ 所以「接入」只**开一轮**（不登记 ✓）、「码对得上，确认」才登记 ✓（⛔ 人没确认之前不登记 ✗）。
   *  ⚠️ 只有桌面有发现层（Web 没有 UDP 那一层 ✓）⇒ 非桌面走到这里会如实失败 ⇒ 走 catch ✓。 */
  const preparePairCode = async (peer: NearbyPeer) => {
    if (pairCode !== PAIR_CODE_UNAVAILABLE) return; // ⭐ 调用方给了读数 ⇒ 不抢它的 ✓
    setPairReading({ kind: "unavailable", reason: "正在发起这一轮比对…" });
    try {
      await platform.executor.invoke(MESH_TRUST_PREPARE_COMMAND, {
        peerDeviceId: peer.device_id,
      });
      await fetchPairCode(peer);
    } catch (e) {
      setPairReading({ kind: "unavailable", reason: `发起比对失败：${String(e)}` });
    }
  };
  /**
   * ⭐ **R110（owner 2026-10-02 拍 A）**：**这段码给哪一台**（空 ＝ 不指定 ✓）。
   * ⚠️ 存的是**对方的 `device_id`**（进载荷、也用于本机先登记 ✓）—— 但**屏幕上只显示短码** ✓：
   *    ⛔ 可见文案不出现裸设备号 ✗（`INV-UI-copy-no-internal-ids`，同解除块那套 `duCode` ✓）。
   */
  const [dpPeer, setDpPeer] = useState("");
  // ⚠️ ⭐ **2026-10-14**：`disableMesh`（「关掉网格」＝ `api.meshSetConfig(activeId, "", null)` ✓，`""` ＝
  //    清除监听地址 ✓）**随 `MeshAdvancedForm.tsx` 一起删了** ✓（owner 同一天先拍删那张卡、再拍「去掉孤儿组件」✓）
  //    ⇒ ⭐ 本面板**不再**调它 ✗（`api.meshSetConfig` 在本文件只剩下面 duList 那一处 `null` 读数 ✓）。
  //    ⚠️ 那条「清除 ＝ 空串、⛔ 不是 `null`」的口径**在后端仍有承重** ✓ —— `syncPanelMesh.wiring` ③ 换了对象钉它 ✓。
  // ⚠️ 这里原来还有一个 `meshRoundNow()`（配一个「立刻交换一轮」按钮）。2026-09-26 **口径收敛**：
  //    交换并进「同步」（见 `syncOne` 里那一段）⇒ 函数与按钮**一起删掉**，不留在那儿当"看起来
  //    还该有个按钮"的线索（本仓对死代码的纪律在 TS 这半边同样适用）。
  const [syncing, setSyncing] = useState(false);
  // C1 预算刹车：设备级设置（null = 还没读到，此时不渲染这一块）。
  const [budget, setBudget] = useState<SyncBudget | null>(null);
  const [budgetBusy, setBudgetBusy] = useState(false);
  // C2 网络闸门：当前网络类型。**用真实查询结果当"这台机器支不支持这条闸门"的判据**，
  // 而不是拿 UA / 平台名去近似（`network_type` 在非 Android 上回 `"n/a"` = 不适用）。
  const [netKind, setNetKind] = useState<string>("n/a");
  // 实时同步状态（正在推送/拉取/附件进度），由同步引擎在 web.ts 上报。
  // ⚠️ 与上面那个**本面板自己的** `syncing`（手动同步在跑）不是一个东西，故叫 liveSyncing。
  // 收窄到具体字段：整店订阅会让"任何一次 setProgress"都重渲染整个面板（1171 行，
  // 含冲突列表与历史），而同步期间每传一件附件就写一次进度。字段级订阅与
  // `PageTree` 里 label/x/y/kind 的写法一致（本仓既有风格，不引入 useShallow）。
  const liveSyncing = useSyncStatus((s) => s.syncing);
  const syncPhase = useSyncStatus((s) => s.phase);
  const syncMessage = useSyncStatus((s) => s.message);
  const attCurrent = useSyncStatus((s) => s.attCurrent);
  const attTotal = useSyncStatus((s) => s.attTotal);
  const attName = useSyncStatus((s) => s.attName);
  const syncDurationMs = useSyncStatus((s) => s.durationMs);
  const [loggingIn, setLoggingIn] = useState(false);
  const [history, setHistory] = useState<{ ws_id: string; at: number; pushed: number; pulled: number; ok: boolean; message: string; items: { entity: string; entity_id: string; op: string; dir: string; title: string }[] }[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [detailOpenIdx, setDetailOpenIdx] = useState<number | null>(null);
  // P0.1 同页冲突提示：sync_workspace 返回的 dirty 冲突页，用户选择保留/采用。
  const [conflicts, setConflicts] = useState<{ ws_id: string; entity_id: string; title: string }[]>([]);
  // ★ B 方案（2026-09-22）：**待取回的远端版本**（页级保留本地时存下来的那一版）。
  // 修好之前这一支是**完全静默**的：游标过去了、对端那笔编辑再也取不回、层里一条痕都没有。
  const [pending, setPending] = useState<{ page_id: string; title: string; seq: number }[]>([]);
  const [pendingError, setPendingError] = useState<string | null>(null);
  const [pendingTotal, setPendingTotal] = useState(0);

  /** 读待取回清单（面板打开 / 每次同步 / 每次裁决之后）。失败不打扰用户：它只是提示面。 */
  const loadPendingRemote = async () => {
    try {
      const q = await api.listPendingRemotePages(20);
      setPending((q?.pages ?? []) as { page_id: string; title: string; seq: number }[]);
      setPendingError(null);
      // ★ 角标那个数字**公布给单例**（`lib/pendingRemoteBadge.ts`）：它与这里的清单读的是
      //   **同一张表**，公布进去就省掉一次读，而且两处永远是同一个数（不会"角标说有、清单没有"）。
      publishPendingRemoteTotal(Number(q?.total ?? 0));
    } catch (e) {
      setPending([]);
      // ⭐ 2026-10-20（owner「没看到三个选项的界面」）：读失败**不再静默** ✓
      setPendingError(e instanceof Error ? e.message : String(e));
      // ⚠️ 读失败**不公布 0**：那是"清空角标"，比"暂时不更新"更容易骗人（单例自己也守着这条）。
    }
  };

  /**
   * 裁决**一处**待取回的远端版本。三个选项都**真的动数据** ——
   * 旧横幅那两条按钮只改一行文案（取证文件 §4 的 F3），这一版不是。
   */
  const resolveOne = async (pageId: string, choice: "merge" | "take_remote" | "keep_local") => {
    try {
      const rep = await api.resolvePendingRemote(pageId, choice);
      const what =
        choice === "merge"
          ? `已合并（${rep.merged ? "逐块合并" : "用远端原样"}${rep.unresolved ? `，还有 ${rep.unresolved} 处要逐块裁决` : ""}）`
          : choice === "take_remote"
            ? `已采用远端版本（放弃本地未推送改动 ${rep.discarded_local_changes} 笔）`
            : "已保留本地（下次同步会推送你这份）";
      setStatus(what);
    } catch (e) {
      setStatus(`裁决失败：${e}`);
    }
    await loadPendingRemote();
    await useNotes.getState().loadPages();
  };

  /**
   * 横幅上那两颗按钮：对**这一批冲突页**批量按同一口径收场。
   *
   * ★ 丙-⑤（2026-09-26）：现在**只对"确实存下了远端那一版"的页**生效（`ids` 由调用方给）。
   * 另一类页（戳判"用远端"、本机那一版已被盖掉）**没有**待取回的版本可裁决 —— 对它们调
   * `resolvePendingRemote` 只会报错，而那正是"按钮看着能点、其实什么都没发生"的老毛病。
   */
  const resolveAll = async (ids: string[], choice: "take_remote" | "keep_local") => {
    let done = 0;
    for (const id of ids) {
      try {
        await api.resolvePendingRemote(id, choice);
        done++;
      } catch {
        /* 单页失败不挡其它页；下一次同步还会把它带出来 */
      }
    }
    setConflicts([]);
    setStatus(
      choice === "keep_local"
        ? `已保留本地改动（${done} 页；下次同步会推送你这份）`
        : `已采用服务端版本（${done} 页；本地未推送的改动已真的放弃）`,
    );
    await loadPendingRemote();
    await useNotes.getState().loadPages();
  };

  /** 这批冲突页里，哪些**有**待取回的远端版本（＝ `resolveAll` 真能收场的那一类）。 */
  const conflictsWithStash = conflicts.filter((c) => pending.some((p) => p.page_id === c.entity_id));
  /** 另一类：戳判"用远端"已生效 ⇒ 本机那一版**进了版本历史**（不是"待取回"），没有可裁决的对象。 */
  const conflictsTakenRemote = conflicts.filter((c) => !pending.some((p) => p.page_id === c.entity_id));

  const refresh = async () => {
    try {
      const profiles = await api.listSyncProfiles();
      // ⚠️ **2026-10-04 加**（owner：「个人空间不显示服务器同步内容」）：
      //   ⭐ 服务器那一段只列**团队空间** ✓ ⇒ 需要每个空间的分类 ✓。
      //   ⭐ `SyncProfile` / `WorkspaceMeta` **都没有 `kind`** ✗（前者是服务器绑定关系、后者只有名字），
      //   而 ⭐ `api.spaceSecurityOverview()` 那边**现成有** ✓ ⇒ ⭐ 用它，不改 Rust ✓。
      //   ⚠️ 那是**桌面专属**命令（Web 没有钥匙柜）⇒ 失败就空 map ⇒ 下面兜底当团队 ✓。
      const kindByWs = new Map<string, "personal" | "team">();
      if (isDesktopPlatform()) {
        try {
          // ⭐ **P-3e-1**：⭐ 同一份读数顺手算"没开加密的个数" ✓（⛔ **不再调一次** ✗ —— 不给自己加一轮网络 ✓）。
          //   ⚠️⭐ **先置 `null`** ✓ ⇒ 这一趟若抛（或返回空）就**保持 null** ✓ ⇒ 界面**不渲染** ✓
          //      （⛔ 读不到 ≠ 0 ✗；⛔ 也不能让上一趟的旧数留下来 ✗）。
          setPlaintextCount(null);
          const secRows = await api.spaceSecurityOverview();
          if (Array.isArray(secRows)) {
            setPlaintextCount(secRows.filter((r) => !r.encrypted_on_disk).length);
          }
          for (const v of secRows) {
            // ⚠️ 那个字段名叫 `space_id` ✗，但 `set_space_kind` 收的就是它 ⇒ ⭐ 实为 **workspace id** ✓。
            kindByWs.set(v.space_id, v.kind);
          }
        } catch {
          /* 读不到就不塞 —— 下面的兜底会当团队 ✓ */
        }
      }
      const name = new Map(spaces.map((s) => [s.id, s.name]));
      // 已删除的工作空间不该在这里露出（否则只剩一行裸 UUID）。后端已按
      // meta.workspaces 过滤，这里再挡一层：空间列表已加载时，只认识得出名字的
      // 空间；列表尚未加载（首帧）时退回并集，避免面板空白。
      // 只显示当前活动空间：打开同步面板聚焦当前正在用的空间，而不是列出所有。
      // 当 activeId 存在时只取它；无活动空间（首帧）退回并集避免空白。
      let ids: string[];
      if (activeId) {
        ids = [activeId];
      } else {
        const known = spaces.length > 0;
        const profileIds = profiles.map((p) => p.ws_id).filter((id) => !known || name.has(id));
        ids = Array.from(new Set([...spaces.map((s) => s.id), ...profileIds]));
      }
      const byWs = new Map<string, SyncProfile>(profiles.map((p) => [p.ws_id, p]));
      // 同步/保存过（有 server_url）的空间，默认填入上次登录的邮箱。
      const serverEmail = new Map<string, string>();
      // 已绑定空间的可选项（remoteSpaces）：有 token 时拉取，保证 space_id 能
      // 匹配到名称显示下拉（否则刷新后变回手填裸 id）。
      const remoteByServer = new Map<string, ServerSpace[]>();
      for (const id of ids) {
        const p = byWs.get(id);
        const sv = p?.server_url;
        if (sv && !serverEmail.has(sv) && !remoteByServer.has(sv)) {
          const em = await api.teamGetServerEmail(sv).catch(() => "");
          if (em) serverEmail.set(sv, em);
          if (p?.token) {
            const list = await api.teamListSpaces(sv, p.token).catch(() => [] as ServerSpace[]);
            remoteByServer.set(sv, list);
          }
        }
      }
      setRows(
        ids.map((id) => {
          const p = byWs.get(id);
          return {
            ws_id: id,
            name: name.get(id) ?? id,
            kind: kindByWs.get(id) ?? "team",
            server_url: p?.server_url ?? "",
            token: p?.token ?? "",
            space_id: p?.space_id ?? "",
            // 有 server_url 时预填上次登录邮箱；否则空。
            loginEmail: p?.server_url ? (serverEmail.get(p.server_url) ?? "") : "",
            loginPassword: "",
            loginRegisterCode: "",
            authMode: "login",
            remoteSpaces: p?.server_url ? (remoteByServer.get(p.server_url) ?? []) : [],
            members: [],
            memberOpen: false,
            inviteEmail: "",
            inviteRole: "editor",
            // 缺省 1（开）：老库升级上来没有这一列时的存量行为必须保持不变。
            syncAttachments: (p?.sync_attachments ?? 1) === 1,
          };
        }),
      );
      await loadHistory();
      await loadPendingRemote();
    } catch (e) {
      setStatus(String(e));
    }
  };

  // C1/C2：读设备级预算与当前网络类型。**失败不弹错**——这两个是"锦上添花"的设置，
  // 读不到时面板少一块，但同步本身照样能用。
  const refreshBudget = async () => {
    const [b, kind] = await Promise.all([
      api.getSyncBudget().catch(() => null),
      api.networkType().catch(() => "n/a"),
    ]);
    if (b) setBudget(b);
    setNetKind(kind || "n/a");
  };

  // C1：写预算。⚠️ 用**返回值**刷新自己——磁盘余量下限**不可关**，Rust 侧会把不合法的值夹回去
  // （比如传 0 会回 256）。不采纳返回值的话，界面会显示一个数据库里并不存在的数。
  const saveBudget = async (next: SyncBudget) => {
    setBudgetBusy(true);
    try {
      setBudget(await api.setSyncBudget(next));
    } catch (e) {
      setStatus(`同步预算保存失败：${e}`);
    } finally {
      setBudgetBusy(false);
    }
  };

  // 同步历史（最新 15 条）。
  const loadHistory = async () => {
    try {
      const h = await api.listSyncHistory(15).catch(() => [] as { ws_id: string; at: number; pushed: number; pulled: number; ok: boolean; message: string; items: { entity: string; entity_id: string; op: string; dir: string; title: string }[] }[]);
      if (h.length) setHistory(h);
    } catch (e) {
      setStatus(String(e));
    }
  };

  // 清空同步历史（本地 meta.only）。
  const clearHistory = async () => {
    try {
      await api.clearSyncHistory();
      setHistory([]);
      setStatus("同步历史已清空");
    } catch (e) {
      setStatus(`清空失败：${e}`);
    }
  };

  useEffect(() => {
    // ⭐ **2026-10-25（owner：「页面貌似不能自动刷新」）**：这里原来只认 `open`（浮层），
    //   而左栏那颗「同步」走的是 `contentOnly`（`view === "sync"` ⇒ `<SyncPanel contentOnly />`）
    //   ⇒ `open` 恒 false ⇒ 这一屏从不 refresh／不读历史 ⇒ 看起来"死的"。
    //   ⇒ `contentOnly` 也算"看得见"（与上面 lanStatus 那条修法同一口径）。
    if (open || contentOnly) {
      void refresh();
      // C1/C2 的设备级设置与网络类型（与 profile 列表分开读：它们失败也不该让面板空白）。
      void refreshBudget();
    }
    // 打开面板 / 切换活动空间 / 空间列表变化时，都刷新到当前活动空间。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, contentOnly, activeId, spaces]);

  // ⭐ **2026-10-25（owner：「页面貌似不能自动刷新」）**：看得见时**定时**刷新两处读数 ——
  //   同步历史（后台每轮都会写一条 ⇒ 定时读才看得见"它真的在跑"）＋ 局域网状态（附近/已配对）。
  //   ⚠️ 15 秒：比后台轮（2 分钟）密得多（用户要"看得见在动"），又不至于每秒打库。
  useEffect(() => {
    if ((!open && !contentOnly) || !isDesktopPlatform()) return;
    const t = window.setInterval(() => {
      void loadHistory();
      setLanNonce((n) => n + 1);
    }, 15_000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, contentOnly, activeId]);

  // ⭐ **2026-10-27（owner「go」）**：后端在局域网读数**真变了**（对端进/出、窗口宣告基址变）时
  //   推一次 `lan:changed` ⇒ 立刻重读（不必等 5 秒那一拍）。
  //   ⚠️ 5 秒轮询**保留**兜底：老构建没有这条事件、Web 也没有 ⇒ 取不到就是退订 no-op ✓。
  useEffect(() => {
    let alive = true;
    let off: (() => void) | undefined;
    void (async () => {
      const un = await subscribeLanChanged(() => {
        setLanNonce((n) => n + 1);
        void loadHistory();
      });
      if (alive) off = un;
      else un();
    })();
    return () => {
      alive = false;
      off?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async (r: EditRow) => {
    try {
      await api.setSyncProfile(r.ws_id, { server_url: r.server_url, token: r.token || undefined, space_id: r.space_id || undefined, email: r.loginEmail.trim() || undefined });
      setStatus(`已保存「${r.name}」`);
    } catch (e) {
      setStatus(String(e));
    }
  };

  const syncOne = async (r: EditRow) => {
    // 点「同步」先做前置校验，规范数据才发后端，避免无效请求 / 误导性报错。
    if (!r.server_url.trim()) { setStatus("请先填服务器地址"); return; }
    if (!r.token) { setStatus("请先登录（没有账号请先「注册」）"); return; }
    if (!r.space_id) { setStatus(`请先绑定组织空间${r.remoteSpaces.length ? "（在上方下拉选择一个）" : "（还没有空间就点「创建空间」，或让管理员邀请你加入）"}`); return; }
    setSyncing(true);
    setStatus("");
    useSyncStatus.getState().begin("正在同步…");
    // B2（2026-09-15）：**必须配对 end()**。此前只有 `web.ts` 调 `end()`，桌面 / Android 走
    // Rust 命令、不会自己调 ⇒ store 的 `syncing` **永远是 true**，于是面板一直显示"正在同步…"，
    // 而下面那些 `setStatus("…同步完成…")` 的结果文案被 `syncStatus.syncing` 的分支挡住、永远看不到。
    // 把错误一并带出去，让 `end()` 能落到 `phase: "error"`。
    //
    // 这一步同时是 **P6.1（每空间开关）的前置**：P6.1 要求"中途关掉开关 ⇒ 面板报告
    // *因开关关闭而停止*"，而没有结束态就没有地方显示停止原因。
    let syncErr: string | null = null;
    try {
      const res = await api.syncWorkspace(r.ws_id);
      if (res.error) {
        syncErr = String(res.error);
        setStatus(`「${r.name}」同步失败：${res.error}`);
      } else {
        // P6.1：开关关闭（或同步途中被关掉）时，引擎会跳过附件并在返回值里带 paused
        // 标记。不显示这一句的话，"附件没同步"看起来就像同步失败 / 丢文件。
        // ⚠️ 停止时文案**不能出现"同步完成"**（§六 验收 #8 明确要求"因开关关闭而停止"
        // 而不是"同步完成"）——否则用户以为附件也都对齐了。
        // "未上传 N 个 / 未下载 M 个"来自引擎的两份清单差集（§六 验收 #4）。
        const bits = [
          res.attachments_skipped_upload > 0 ? `未上传 ${res.attachments_skipped_upload} 个` : "",
          res.attachments_skipped_download > 0 ? `未下载 ${res.attachments_skipped_download} 个` : "",
          // C1：被单文件阈值挡下的（不是"停止"，是"轮不到"）。
          res.attachments_skipped_too_large > 0 ? `${res.attachments_skipped_too_large} 个超过单文件上限` : "",
          // C1：**本该传但没传成**的——必须单独说，否则就是静默丢件。
          res.attachments_failed > 0 ? `${res.attachments_failed} 个传输失败` : "",
          res.attachments_bytes_downloaded > 0 ? `本次下载 ${fmtMb(res.attachments_bytes_downloaded)}` : "",
        ].filter(Boolean).join(" / ");
        const att = bits ? `（${bits}）` : "";
        // C1：停止原因要说清是**哪一种**——"附件同步已关闭"和"磁盘要满了"对用户是两件事。
        const stopReason =
          res.attachments_paused_reason === "disk_floor"
            ? "同步已停止：磁盘余量低于下限（可在下方调低「磁盘余量下限」）"
            : res.attachments_paused_reason === "run_cap"
              ? "同步已停止：已达「本次下载总量上限」"
              : "同步已停止：途中关闭了附件同步";
        setStatus(
          res.attachments_paused
            ? `「${r.name}」${stopReason}，已下载的附件保留${att}；上传 ${res.pushed} / 拉取 ${res.pulled}`
            : bits
              ? `「${r.name}」同步完成${att}：上传 ${res.pushed} / 拉取 ${res.pulled}`
              : `「${r.name}」同步完成：上传 ${res.pushed} / 拉取 ${res.pulled}`,
        );
        // P0.1：有同页冲突（本地未推送 + 服务端新 seq）→ 提示用户选择。
        const c = (res.conflicts ?? []) as { entity_id: string; title: string }[];
        if (c.length > 0) {
          setConflicts(c.map((x) => ({ ws_id: r.ws_id, entity_id: x.entity_id, title: x.title })));
        }
      }
      await useNotes.getState().loadPages();
      await loadHistory();
      await loadPendingRemote();
    } catch (e) {
      syncErr = String(e);
      setStatus(`「${r.name}」同步失败：${e}`);
    } finally {
      // ★ 丙-③-b（2026-09-26 口径收敛）：**网格那一档并进「同步」**——同一个按钮，服务端那条走完
      //   再对这个空间跑一轮对等交换（原来它有一个单独的「立刻交换一轮」按钮：一个意图两个动作）。
      //
      // ⚠️ ⚠️ **必须放在 `finally` 里，不许放在 `try` 里** —— 真机上实测踩过：服务端那条**抛错**时
      //   （现场是"会话已失效，请重新登录"），`try` 里剩下的语句**一行都不会跑** ⇒ 网格这一档被
      //   连坐跳过，而它**根本不依赖服务端**（网格是客户端之间直连）。与 `round` 里那条
      //   "一只对端拉不动不连坐"是同一条纪律。
      // ⚠️ 只在**这一行就是面板上显示的那行**、且网格真开着时才跑：`lanStatus.mesh` 是**当前那条档案**
      //   的读数（面板只为它显示网格那一块），拿别行的 ws_id 去跑会与读数对不上。
      // ⚠️ "没配网格 ⇒ 一个字节都不动"由 Rust 侧（`mesh_sync_now` 早退）保证，这里**不重判一遍**。
      if (lanStatus?.mesh.enabled && r.ws_id === activeId) {
        try {
          const rep = await api.meshSyncNow(r.ws_id);
          // ⚠️ `rep.note` **自带**「网格：」前缀（Rust 拼好的人话）—— 这里别再写一遍，
          //    否则真机上会看到 `网格：网格：拉了 1 台对端`（第一版就是这么出去的）。
          // ★ 丙-⑤（2026-09-26）：`rep.note` 里现在还会带上"**你本机那一版让给了远端**
          //    （已存进版本历史）"与"**有几页等你裁决**"—— 同样由 Rust 拼，这里**不重判**。
          setStatus((prev) => `${prev}${prev ? "；" : ""}${rep.note}`);
          // ★★ 丙-⑤：**网格这一轮也换了数据**，所以那两份清单必须跟着刷新。
          //   它们是在上面 `try` 里读的 —— 也就是**网格开跑之前**。不补这一下的话，用户刚被
          //   告知"有 2 页等你裁决"，而下面「待取回的远端版本」那一段**还是空的**（页面列表
          //   同样停在交换前）：通知与现场对不上，用户只会以为那两页丢了。
          await useNotes.getState().loadPages();
          await loadPendingRemote();
        } catch (e) {
          setStatus((prev) => `${prev}${prev ? "；" : ""}网格交换失败：${e instanceof Error ? e.message : String(e)}`);
        }
      }
      setSyncing(false);
      useSyncStatus.getState().end(syncErr);
    }
  };

  // ⭐ **2026-10-25（owner：「立即同步这个按钮不能点」）**：局域网那颗按钮的动作 ——
  //   走 `mesh_sync_now`（不需要服务端配置；个人空间也能点）。
  //   ⚠️ 位置故意放在 `syncOne` 与 `update` 之间：`syncPanelMesh.wiring` ⑦⑧ 在这一段里
  //      找 `${rep.note}` 与 `loadPages()`（⛔ 别把它挪走，否则那条源码级判据会红）。
  const syncMeshNow = async () => {
    if (meshBusy) return;
    setMeshBusy(true);
    setStatus("");
    useSyncStatus.getState().begin("正在同步（局域网）…");
    try {
      const rep = await api.meshSyncNow(activeId ?? null);
      // 人话**原样来自 Rust**（`rep.note`）—— 面板不许自己遍历读数拼句子。
      setStatus(`${rep.note}`);
      useSyncStatus.getState().end();
      setLanNonce((n) => n + 1);
      // 网格那轮之后重拉页面列表（换过来的内容不该等切空间才看见）＋ 同步历史跟着刷新。
      useNotes.getState().loadPages();
      void loadHistory();
    } catch (e) {
      setStatus(`局域网同步失败：${e}`);
      useSyncStatus.getState().end(String(e));
    } finally {
      setMeshBusy(false);
    }
  };

  const update = (ws_id: string, field: keyof EditRow, value: string) =>
    setRows((rs) => rs.map((r) => (r.ws_id === ws_id ? { ...r, [field]: value } : r)));

  // P6.1 每空间「附件同步」开关。两条容易踩的坑，都在这里挡掉：
  //
  // ① **必须走窄命令 `setSyncAttachments`，不能顺手用 `setSyncProfile`**：后者的语义是
  //    "没传的字段 = 清空"（Rust `sync.rs` 的 `token.as_deref().unwrap_or("")`，web.ts 同
  //    语义），为了存一个开关而调用它会把该行的 token / space_id 一起抹掉。
  // ② **必须立即落盘，不能等用户点「保存」**：这个开关的用途之一就是"同步跑到一半关掉
  //    刹车"，同步引擎读的是数据库里的值；只存在面板 state 里的话，跑到一半关 = 关了个
  //    寂寞，得等下一次点「同步」才生效。落盘失败要把 UI 回滚，否则显示成"已关"其实没关。
  const setAttachments = async (r: EditRow, enabled: boolean) => {
    setRows((rs) => rs.map((x) => (x.ws_id === r.ws_id ? { ...x, syncAttachments: enabled } : x)));
    try {
      await api.setSyncAttachments(r.ws_id, enabled);
      setStatus(
        enabled
          ? `「${r.name}」已开启附件同步`
          : `「${r.name}」已关闭附件同步：同步时只走笔记内容，不传附件文件`,
      );
    } catch (e) {
      setRows((rs) => rs.map((x) => (x.ws_id === r.ws_id ? { ...x, syncAttachments: !enabled } : x)));
      setStatus(`附件同步开关保存失败：${e}`);
    }
  };

  // 登录与注册共用的收尾：token 落到该行 + auth store + **落盘**，并尽力拉一次
  // 空间列表（列表失败不回滚会话——token 已有效，用户仍可手填空间 id）。
  //
  // 自动保存是必须的：此前登录只把 token 放进面板的临时 state，用户不点「保存」
  // 就关掉面板等于白登一次——而「刚登录完还要再点保存」本身就不该存在。
  // 同服务器其它空间的绑定指向旧账号 token：登录（换账号）后统一覆盖为当前 token，
  // 避免残留旧账号会话导致 401/数据错乱。保留各自 server_url。
  const cleanOtherServerTokens = async (base: string, token: string) => {
    const profiles = await api.listSyncProfiles();
    const target = profiles.filter((p) => p.server_url === base);
    for (const p of target) {
      await api.setSyncProfile(p.ws_id, { server_url: base, token, space_id: p.space_id }).catch(() => {});
    }
  };

  const applySession = async (r: EditRow, base: string, token: string, what: string) => {
    const list = await api.teamListSpaces(base, token).catch(() => [] as ServerSpace[]);
    setRows((rs) =>
      rs.map((x) => (x.ws_id === r.ws_id ? { ...x, server_url: base, token, loginPassword: "", remoteSpaces: list } : x)),
    );
    useAuth.getState().setSession(base, token, r.loginEmail?.trim());
    let saved = true;
    try {
      await api.setSyncProfile(r.ws_id, {
        server_url: base,
        token,
        space_id: r.space_id || undefined,
      });
    } catch (e) {
      saved = false;
      console.error("auto-save sync profile failed", e);
    }
    // 同服务器其它空间的绑定指向旧账号 token：登录（换账号）后统一覆盖为当前 token，
    // 避免残留旧账号的会话导致 401/数据错乱（这也是之前 401 的同类根源）。
    // 保留各自 server_url，仅更新 token/space。
    await cleanOtherServerTokens(base, token).catch((e) => console.error("clean other sync tokens failed", e));
    setStatus(
      saved
        ? `${what}成功「${r.name}」，已保存${list.length ? `，可选空间 ${list.length} 个` : ""}`
        : `${what}成功，但保存失败——请手动点「保存」`,
    );
  };

  const login = async (r: EditRow) => {
    const base = r.server_url.trim().replace(/\/+$/, "");
    if (!base) { setStatus("请先填服务器地址"); return; }
    if (!r.loginEmail.trim() || !r.loginPassword) { setStatus("请输入邮箱和密码"); return; }
    setLoggingIn(true);
    setStatus("");
    try {
      // 走 Rust 代理命令（绕 WebView2 CORS）：服务端无 CORS 层，前端 fetch 会被拦。
      const { token } = await api.teamLogin(base, r.loginEmail.trim(), r.loginPassword);
      if (!token) throw new Error("服务器未返回 token");
      await applySession(r, base, token, "登录");
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      const noAuth = e?.status === 401 || /401/.test(msg);
      setStatus(
        noAuth ? "登录失败：邮箱或密码不对（没有账号请先「注册」）" : `登录失败：${msg}`,
      );
    } finally {
      setLoggingIn(false);
    }
  };

  // 注册：在该服务器开新账号。服务端 /auth/register 成功后直接下发会话 token，
  // 所以注册即登录，不需要再点一次登录。密码规则与服务端一致（≥8 位）。
  const register = async (r: EditRow) => {
    const base = r.server_url.trim().replace(/\/+$/, "");
    if (!base) { setStatus("请先填服务器地址"); return; }
    if (!r.loginEmail.trim() || !r.loginPassword) { setStatus("请输入邮箱和密码"); return; }
    if (r.loginPassword.length < 8) { setStatus("注册失败：密码至少 8 位"); return; }
    // 邀请码必填：客户端直接拦下，不打扰服务端（也避免控制台 400）。
    if (!r.loginRegisterCode.trim()) { setStatus("注册失败：请输入「注册邀请码」（向管理员索取，如 SHUYOABC）"); return; }
    setLoggingIn(true);
    setStatus("");
    try {
      const { token } = await api.teamRegister(base, r.loginEmail.trim(), r.loginPassword, null, r.loginRegisterCode.trim() || null);
      if (!token) throw new Error("服务器未返回 token");
      await applySession(r, base, token, "注册");
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      const st = e?.status;
      let hint = st === 409 || /409/.test(msg) ? "该邮箱已注册，请直接「登录」"
        : st === 400 || /400/.test(msg) ? "请输入「注册邀请码」（向管理员索取，如 SHUYOABC）且密码 ≥ 8 位"
        : st === 401 || /401/.test(msg) ? "登录失败：邮箱或密码不对（没有账号请先「注册」）"
        : `注册失败：${msg}`;
      setStatus(hint);
    } finally {
      setLoggingIn(false);
    }
  };

  // ---- M27 成员管理 handlers ----
  const toggleMembers = (r: EditRow) => {
    setRows((rs) => rs.map((x) => (x.ws_id === r.ws_id ? { ...x, memberOpen: !x.memberOpen } : x)));
    if (!r.memberOpen && r.space_id && r.token) void loadMembers(r);
  };

  const loadMembers = async (r: EditRow) => {
    const base = r.server_url.trim().replace(/\/+$/, "");
    if (!base || !r.space_id || !r.token) { setStatus("请先登录并绑定空间"); return; }
    setStatus("");
    try {
      const members = await api.teamListMembers(base, r.token, r.space_id);
      setRows((rs) => rs.map((x) => (x.ws_id === r.ws_id ? { ...x, members } : x)));
    } catch (e) {
      setStatus(`成员拉取失败：${e}`);
    }
  };

  const inviteMember = async (r: EditRow) => {
    const base = r.server_url.trim().replace(/\/+$/, "");
    if (!base || !r.space_id || !r.token) { setStatus("请先登录并绑定空间"); return; }
    if (!r.inviteEmail.trim()) { setStatus("请输入被邀请者邮箱"); return; }
    setStatus("");
    const email = r.inviteEmail.trim();
    const role = r.inviteRole;
    try {
      await api.teamInviteMember(base, r.token, r.space_id, email, role);
      await loadMembers({ ...r, inviteEmail: "" });
      setStatus(`已邀请 ${email}`);
    } catch (e) {
      const msg = String(e);
      // 服务端空间邀请要求用户已注册；未注册返回 404。给友好提示。
      setStatus(
        /404|Not Found|not found/i.test(msg)
          ? `「${email}」尚未注册：请让对方先注册账号，或由组长发送邀请码邀请`
          : `邀请失败：${msg}`,
      );
    }
  };

  const removeMember = async (r: EditRow, userId: string) => {
    const base = r.server_url.trim().replace(/\/+$/, "");
    try {
      await api.teamRemoveMember(base, r.token, r.space_id, userId);
      await loadMembers(r);
      setStatus("已移除成员");
    } catch (e) {
      setStatus(`移除失败：${e}`);
    }
  };

  const setMemberRole = async (r: EditRow, email: string, role: string) => {
    const base = r.server_url.trim().replace(/\/+$/, "");
    try {
      await api.teamSetMemberRole(base, r.token, r.space_id, email, role);
      await loadMembers(r);
      setStatus("已更新角色");
    } catch (e) {
      setStatus(`更新角色失败：${e}`);
    }
  };

  const logout = async (r: EditRow) => {
    const base = r.server_url.trim().replace(/\/+$/, "");
    setStatus("");
    try {
      await api.teamLogout(base);
      setRows((rs) =>
        rs.map((x) => (x.ws_id === r.ws_id ? { ...x, token: "", space_id: "", remoteSpaces: [], members: [], memberOpen: false } : x)),
      );
      useAuth.getState().clear();
      // 同样要落盘：否则重开面板时 refresh() 会把旧 token 从库里读回来，
      // 看起来像「登出了又自己登回去」。
      await api.setSyncProfile(r.ws_id, { server_url: base }).catch((e) => {
        console.error("clear sync profile failed", e);
      });
      // 登出成功不显示「已登出」——回到登录表单本身已说明状态，提示是多余噪音。
      setStatus("");
    } catch (e) {
      setStatus(`登出失败：${e}`);
    }
  };

  // 选中空间即落盘：与登录同理——「选完还要再点保存」是多余的一步，
  // 忘了点就等于没绑。手填服务器地址/令牌仍走「保存」按钮。
  const pickSpace = async (r: EditRow, spaceId: string) => {
    update(r.ws_id, "space_id", spaceId);
    const base = r.server_url.trim().replace(/\/+$/, "");
    if (!base) return;
    try {
      await api.setSyncProfile(r.ws_id, {
        server_url: base,
        token: r.token || undefined,
        space_id: spaceId || undefined,
      });
      const name = r.remoteSpaces.find((x) => x.id === spaceId)?.name;
      setStatus(spaceId ? `已绑定空间「${name ?? spaceId}」` : "已解除空间绑定");
    } catch (e) {
      setStatus(`保存失败：${e}`);
    }
  };

  // 创建组织空间：当前登录账号在服务器上新建一个空间，创建后自动绑定。
  // 新注册账号往往没有任何空间，必须直接给入口，否则「登录了却不知道选什么/填什么」。
  const createSpace = async (r: EditRow) => {
    const base = r.server_url.trim().replace(/\/+$/, "");
    if (!base || !r.token) { setStatus("请先登录再创建组织空间"); return; }
    inputDialog({
      title: "创建组织空间",
      placeholder: "空间名称",
      defaultValue: "",
      onSubmit: async (name) => {
        const n = name.trim();
        if (!n) return;
        try {
          const sp = await api.teamCreateSpace(base, r.token, n);
          const ids = Array.isArray(r.remoteSpaces) ? r.remoteSpaces : [];
          setRows((rs) => rs.map((x) => (x.ws_id === r.ws_id ? { ...x, remoteSpaces: [...ids, sp], space_id: sp.id } : x)));
          await api.setSyncProfile(r.ws_id, { server_url: base, token: r.token, space_id: sp.id }).catch(() => {});
          setStatus(`已创建组织空间「${sp.name}」并绑定`);
        } catch (e) {
          setStatus(`创建组织空间失败：${e}`);
        }
      },
    });
  };

  // 当前用户在该绑定空间的角色是否可管理成员（admin/owner）。viewer/editor 只读。
  const canManageSpace = (r: EditRow): boolean => {
    const role = r.remoteSpaces.find((x) => x.id === r.space_id)?.role ?? "";
    return role === "admin" || role === "owner";
  };

  // 状态条只有一行文案，按语义上色：失败=红、提示性前置条件=黄、其余=绿。
  const statusKind = (s: string): "ok" | "err" | "warn" =>
    /失败|错误|不支持|不存在|无效/.test(s) ? "err" : /^请/.test(s) ? "warn" : "ok";

  const roleClass = (role: string) =>
    ["owner", "admin", "editor", "viewer"].includes(role) ? `role-${role}` : "role-viewer";

  const initial = (s: string) => (s.trim()[0] ?? "?").toUpperCase();

  /**
   * ★★ 丙-⑤（2026-09-26）：**侧栏那颗「同步」上的数字角标** —— "有几页等你裁决"。
   *
   * 为什么值得单开一条读法：后台的自动同步（近实时/按间隔那两档）**不弹任何话**（那条路是
   * 静默设计，每轮都弹就是噪声），而"有页等你裁决"恰好是**要用户动手**的事 ⇒ 它得有一个
   * **持久**的去处告诉他一共有几件、点哪儿去处理。
   * ⚠️ 读的是**库里那张队列表**（`listPendingRemotePages` 的 `total`），**不是**某一轮同步的临时
   *    读数 —— 后者转瞬即逝，而真机现场刚抓到过"读数说有、清单里没有"那类不一致。
   * ⚠️ **轮询本身在 `lib/pendingRemoteBadge.ts` 里做成单例**：手机上这个组件同时挂了**两个**实例
   *    （侧栏那颗 ＋ 底部槽位那颗），第一版是每个实例各起一个 30 秒定时器 ⇒ 同一张表每 30 秒
   *    被问两次。两处显示同一个数字 ⇒ **只有一份真相、一个轮询**（那边有判据钉着）。
   * ⚠️ 它常驻挂载（就是侧栏那颗按钮），所以弹层开没开都在对账。
   */
  useEffect(() => subscribePendingRemoteTotal(setPendingTotal), []);

  // ⭐⭐ **2026-10-20（owner「没看到三个选项的界面」）**：面板**一打开就去读**待取回清单** ✓
  //   旧行为：清单**只在一轮同步之后**才被读（doSync 里）⇒ 刚打开面板、还没点同步时，
  //   队列里明明有 5 页，界面上却**一个字都没有** ✗（真机就是这么被耍的 ✓）。
  useEffect(() => {
    void loadPendingRemote();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── D5：**状态置顶**要的三个读数（2026-09-29）────────────────────────────────
  // 全部是【现成的】，本笔零 Rust 改动：
  //   · 状态与时间 ← `history`（`api.listSyncHistory` 的 `at`/`pushed`/`pulled`/`ok`）
  //   · 走哪条路   ← `lanStatus.kind` + `.peers`
  // ⚠️ `kind` **只许拿来换标题**，不许按 `server_url` 的形状自己再判一次档
  //    （`src/lib/platform/commands.ts:186` 注释 ＋ 那条判据钉着）。
  // ⚠️ Web 档 `kind === ""` ⇒ 显示「还没绑同步」，**不是**「同步失败」。
  const myHistory = history.filter((h) => !activeId || h.ws_id === activeId);
  const lastSync = myHistory[0];
  const todayStr = new Date().toDateString();
  const todayItems = myHistory
    .filter((h) => new Date(h.at).toDateString() === todayStr)
    .reduce((a, h) => a + (h.pushed || 0) + (h.pulled || 0), 0);
  // ⚠️ **2026-10-04 加**（owner：「个人空间不显示服务器同步内容」）：
  //   ③ 服务器那一段装的是**服务器 / 账号 / 组织空间 / 成员管理** ✓ ⇒ ⭐ 只列**团队空间** ✓。
  //   ⭐ 个人空间不经过服务器（owner 裁定「个人空间不绑服务器」✓），它的远程路径是**设备直连** ✓。
  //   ⚠️ 必须定义在这里 —— 下面 `isPersonalActive` 要用它（放后面会「used before declaration」）。
  const serverRows = rows.filter((r) => r.kind === "team");
  // ⭐ 当前空间是个人空间吗？⚠️ `rows` 只有**当前活动空间**那一行（见 refresh 里的 ids）
  //   ⇒ ⭐「服务器那一段一行都没有」就等于「当前不是团队空间」✓（取不到 kind 时兜底当团队 ✓）。
  //   ⚠️ 必须定义在这里（放后面会「used before declaration」）。
  //   ⚠️ **刀二十（2026-10-14）**：⭐ `heroState` **不再**用这一格了 ✗ —— 它现在由
  //     「已配对／在线／同步中」三件真事拼成（与当前是个人还是团队无关 ✓）。
  const isPersonalActive = serverRows.length === 0;

  // ⭐⭐ **2026-10-27（owner 拍 M2）**：**第一次进入本页**才把局域网前置备好（设备身份／自动组名／
  //   监听地址／档案行）—— ⛔ 不在启动时自动开（桌面保持"用户不配就不广播"那条隐私口径 ✓）。
  //   ⚠️ 只在本机第一次（localStorage 标记）＋ 当前是个人空间 ＋ `mesh.bind` 还没配 时才跑；
  //   ⚠️ 已经配过 ⇒ 一个字节都不写（`mesh_ensure_defaults` 本身也只补不覆盖 ✓）。
  useEffect(() => {
    if (!isDesktopPlatform()) return;
    if (!isPersonalActive || !activeId || !lanStatus) return;
    if (lanStatus.mesh?.bind) return;
    if (localStorage.getItem(LAN_AUTO_CONFIG_KEY) === "1") return;
    localStorage.setItem(LAN_AUTO_CONFIG_KEY, "1");
    let alive = true;
    void (async () => {
      try {
        await api.meshEnsureDefaults(activeId);
        if (!alive) return;
        // ⭐ 2026-10-27（owner：「按钮布局太丑，优化一下」）：那句话**不再占一行** ⇒
        //   改成一次 toast；状态条**右上角**只留一枚小胶囊按钮 ✓（见下面 `action` ✓）。
        toast("已为本机自动开启局域网发现（同一 Wi-Fi 内可见；可在状态条右上角关闭）");
        setLanNonce((n) => n + 1);
      } catch (e) {
        if (alive) toast(`局域网自动开启失败：${e instanceof Error ? e.message : String(e)}`, "error");
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPersonalActive, activeId, lanStatus]);

  /** ⭐ 2026-10-27（M2）：开启 / 关闭局域网发现（用户可逆）—— 关闭只清监听地址（配对关系保留 ✓）。 */
  const lanToggle = async () => {
    if (!activeId) return;
    try {
      if (lanStatus?.mesh?.enabled) {
        await api.meshSetConfig(activeId, "", null);
        toast("已关闭局域网同步：本机不再被同网络设备发现（配对关系保留）");
      } else {
        await api.meshEnsureDefaults(activeId);
        toast("已开启局域网同步：同一 Wi-Fi 内的设备能发现本机");
      }
      setLanNonce((n) => n + 1);
    } catch (e) {
      setStatus(`局域网同步开/关没成功：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /**
   * ⭐ **R176-A（owner 2026-10-28 拍 A）③**：**「高级」里改端口**（主界面不出现输入框 ✓）。
   *
   * ⚠️ 只改**端口**那一半 ✗：地址还是**当前绑定里那个**（用户不动它 ✓ —— 界面在 2026-10-14
   *   已经按 owner 的决定撤掉了填地址的入口，本笔⛔ 不把它加回来 ✗）。
   * ⚠️ 校验在 `portTextToBind()`（纯函数、有单测 ✓）：⛔ 不合格就**不发**命令 ✗，并给一句可操作的人话 ✓。
   * ⚠️ 走的是**既有**那条 `api.meshSetConfig(ws, bind, null)` ✓（⛔ 不新增后端命令 ✗）。
   */
  const saveMeshPort = async () => {
    if (!activeId) return;
    const { addr, port } = splitMeshBind(lanStatus?.mesh?.bind ?? "");
    const shown = meshPortDraft ?? port;
    const bind = portTextToBind(addr, shown);
    if (!bind) {
      setStatus(PORT_INVALID_TEXT);
      return;
    }
    try {
      await api.meshSetConfig(activeId, bind, null);
      // ⚠️ 说**结果**、不说"已生效"那种判语 ✓：真正的判据是下一拍读数（`lanNonce` 立刻重读一次 ✓）。
      toast(`端口已改成 ${shown.trim()}：同一网络里的设备下一次广播就能看到`);
      setMeshPortDraft(null);
      setLanNonce((n) => n + 1);
    } catch (e) {
      setStatus(`端口没改成：${e instanceof Error ? e.message : String(e)}`);
    }
  };
  // ⚠️ **2026-10-04 改**（owner：「个人空间不显示登录状态文案信息」）：
  //   ⭐ 个人空间**不经过服务器** ⇒ ⭐ 不该说「还没绑同步」✗（那是服务器口径的提醒 ✓）；
  //   ⭐ 它该说的是自己那条路：**附近设备直连** ✓。
  // ⭐ **刀二十（2026-10-14，owner 设计图）** ✗：⭐ 状态条那句是**三件真事拼的** ✓ ——
  //   ⭐「已配对」← `duList`（**本机认过的名单** ✓，与三段里那一支、与「解除」那块**同一份读数** ✓）；
  //   ⭐「在线」← `lanStatus.enabled`（发现层开着 ✓）；⭐「同步中／自动同步中」← `syncing` ✓。
  //   ⚠️ ⛔ 一个都不写死 ✗：读不到 ⇒ 如实说「还没配对／不在线」✓（⛔ 不拿「看起来正常」冒充 ✗）。
  const meshPaired = duList.length > 0;
  const meshOnline = !!lanStatus?.enabled;
  const heroSub = [
    activeRow?.name ?? "",
    lastSync ? relTime(lastSync.at) : "",
    todayItems > 0 ? `今天同步了 ${todayItems} 项` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  // ⛔⭐ **2026-10-14（owner：「去掉这部分」）** ✗ —— ⭐ 「这一轮走的是：…」那句（含它的四个变体：
  //   附近直连／设备直连·N 台可用／服务器／还没绑同步）**整条删掉了** ✓。
  //   ⭐ 那件事现在由**更准的地方**说：⭐ 附近有几台 → 三段设备的计数（`NEARBY_GROUPS` ✓）；
  //   ⭐ 走的是服务器还是直连 → 「同步方式」那一行的值 ✓；⭐ 个人空间不经过服务器 → 副标题 ✓。
  //   ⚠️ 判据按 R192 **换对象**（⛔ 不是删断言 ✗）：从「必须渲染」翻成「不许再渲染」✓
  //   （见 `SyncPanel.trustDevicePanel.wiring.test.tsx` ② ✓）。
  // ── ★ 2026-09-29（IA）：分组 ＋ 每行一个可展开项 —— 每行右边那个【摘要值】────────
  // 口径：**每一行的值都由真实读数算出来**（写死就是在骗人），且尽量复用既有 <option> /
  //       既有小标题的词 —— 本笔不动任何一句既有文案。
  //
  // 只在 Wi-Fi 下同步：默认值与下面那颗复选框**同一处口径**（`?? true`），
  // 否则会出现"行上写关、点开复选框却是开的"。
  const wifiText = (budget?.wifi_only ?? true) ? "开" : "关";
  // 服务器：owner 明确「未绑定时显示『未绑定』」（不是空白，也不是占位 URL）。
  const serverText = activeRow?.server_url.trim() || "未绑定";
  const totalOff = syncMode === "off";
  // 附近设备那一块要的读数（**列表只有一处来源**：`lanStatus.nearby`，与 `peers` 同一次读数）。
  // ⚠️ `Array.isArray` 那一层是给**老 Rust 构建**留的：读数里没有这一项时，界面说"看不到这一层"，
  //    **不许**把"读不到列表"渲染成"网段里没人"（空数组与"不可用"长得一样、含义相反）。
  const nearbyReadable = Array.isArray(lanStatus?.nearby);
  const nearby = lanStatus?.nearby ?? [];

  /**
   * ⭐⭐ **R176-A（owner 2026-10-28 拍 A）④「能读的状态」** ✗ —— 那个面板里的三格读数：
   * 「这一轮走的是：**设备直连**」／「服务 **N** 个空间」／「本机：已信任 **N** 台」✓
   * （判据：`src/lib/personalSyncReadout.test.ts` 钉纯函数、`syncPanelPersonalTrust.wiring.test.ts`
   * 钉这里的挂载点与「值全部来自读数」✓）。
   *
   * ⚠️ 读数来源（**每一格都点得出处**，⛔ 不新造读数／⛔ 不遍历列表自己拼句子 ✗）：
   *   · 走哪条路 ← `lanStatus.kind`（Rust `LinkKind`）／`lanStatus.mesh.enabled`；
   *   · 服务几个空间 ← `lanStatus.mesh.served`（Rust 排过序的那份名单 ✓ 只取长度）；
   *   · 已信任几台 ← `lanStatus.mesh.paired`（⭐ 与 `duList` **同一格**：`tick` 里就是用这一格写
   *     `duList` 的 ✓，两处不会各说各话 ✓）；`duList` 仍管三段设备的分段 ✓（那是另一件事）。
   * ⚠️ **读不到 ≠ 0**：`lanStatus` 还没来 ⇒ 三格都显示「未读到」，⛔ 不拿 0 冒充 ✗
   *   （口径在 `personalSyncReadout.ts` 的 `countFrom()` **只有一处** ✓）。
   * ⚠️ 诊断句（J9：两端参数不一致必须解释原因）**只在**「已信任 N 台、这一轮附近一台都没有」
   *   那个形状下出现 ✓（owner 2026-10-14 删的是**常显**的那条长句 ⇒ 本条按那个决定收敛 ✓）。
   */
  const personalReadout = personalSyncReadout({
    route: {
      syncMode,
      kind: lanStatus?.kind ?? null,
      meshEnabled: lanStatus?.mesh?.enabled ?? null,
      bind: lanStatus?.mesh?.bind ?? null,
    },
    served: lanStatus ? lanStatus.mesh?.served : null,
    trusted: lanStatus ? lanStatus.mesh?.paired : null,
    discoveryOn: !!lanStatus?.enabled,
    nearbyCount: Array.isArray(lanStatus?.nearby) ? lanStatus.nearby.length : null,
  });
  /** ⭐ **R176-A ③**：「高级」里端口那一格用的两个值 —— ⛔ **不写死默认端口** ✗：
   *  端口值只来自 `lanStatus.mesh.bind`（Rust 预置的那一份 ✓），读不到就空着并由界面如实说「未读到」✓。 */
  const bindPort = splitMeshBind(lanStatus?.mesh?.bind ?? "").port;
  const shownPort = meshPortDraft ?? bindPort;

  // ⭐ **2026-10-08（owner：「附近设备同步流程太繁琐了，能简化吗？」）**：
  //   **附近恰好一台时自动选中它** ✓ —— 选中它走的是正路（本机生成时就登记 ⇒
  //   **对面采纳一次、两个方向都通** ✓）；而默认的"不指定"走的是兜底（码离线传 ⇒ **要配两次** ✗）。
  //   ⚠️ 只在**恰好一台**时自动选 ✓：多台时**不替用户挑** ✗（挑错＝连错设备 ✓）。
  //   ⚠️ 用户自己改过之后不再覆盖 ✓ —— 只在他还没选过时补 ✓。
  useEffect(() => {
    // ⚠️ 口径**只留一处**：`src/lib/pairTarget.ts::autoPickPeer` ✓（并有常驻单测 ✓）。
    const next = autoPickPeer(nearby.filter((p) => p.serves_current), dpPeer);
    if (next !== dpPeer) setDpPeer(next);
  }, [nearby, dpPeer]);
  // 我这边的空间名（设备行那一列「服务 …」要写出来：**不许只写 id**——用户不知道那是哪个空间）。
  const mySpaceName = activeRow?.name?.trim() || "这个空间";
  /**
   * 一台设备那一行的第二列（照效果图：`（同网段 · 服务 项目A）`）。
   *
   * ⚠️ **判"它服务不服务我这个空间"的是 Rust**（`serves_current`）—— 这里只把
   *    `space_id` 换成人能读的名字（对不上名字的说个数），**不算交集**（规格 §2 那条不变式）。
   * ⚠️ **绝不出现裸 `space_id`**（`INV-UI-copy-no-internal-ids`）。
   */
  /**
   * ⭐ **P-3d（2026-10-13）**：一台设备该进**哪一段** ✗ ——
   * `0` ＝ **需要重新配对** ／ `1` ＝ 已信任 ／ `2` ＝ 待配对 ✓。
   *
   * ⚠️ ⭐ 只有 `key_changed === true` 才算"钥匙变了" ✗ —— ⭐ **读不到（`null`）与 `false` 一律不算** ✓
   *   （「读不到」是**没有结论** ✓，⛔ 不许被当「变了」✗ —— 与那几格读数同一把尺 ✓）。
   * ⚠️ 段序就是 `0/1/2` 这个序：排序键与分段键**同一个** ✓ ⇒ 两处不可能各说各话 ✓。
   */
  const nearbyBucket = (p: NearbyPeer): 0 | 1 | 2 =>
    p.key_changed === true ? 0 : duList.some((d) => d.deviceId === p.device_id) ? 1 : 2;

  // ⚠️ ⭐ **2026-10-14（实测两次）** ✗：这两段**必须待在 `nearby` 与 `nearbyBucket` 之后** ✓ ——
  //   往上搬一次会 `TS2448 / Cannot access 'nearby' before initialization`（整屏白掉 ✓），
  //   只挪到 `nearby` 之后还会再撞一次 `nearbyBucket` ✓。⛔ 逻辑一个字没改 ✗（只搬位置 ✓）。
  // ⚠️ ⭐ **2026-10-14**：这两段原来在 `meshOnline` 下面 ✓ —— 但它们要读 `nearby`（**下面**才声明 ✓）
  //   ⇒ TDZ ⇒ **整个面板白掉** ✗（tsc `TS2448` ＋ 真机探测 no panel ✓；2 条判据当场红 ✓）
  //   ⇒ ⭐ 挪到 `nearby` 之后 ✓。⚠️ ⛔ 逻辑一个字没改 ✗（只搬位置 ✓）。
  /**
   * ⭐⭐ **2026-10-14（owner 选 C：「按状态变句式」）** ✗：这一行原来是**电报腔的短语**
   * （`已配对 · 在线 · 自动同步中` ✓）—— ⚠️ 它把三件事平铺出来，而且**关掉同步之后仍然写着
   * "自动同步中"** ✗（那是**假话** ✓）。⇒ ⭐ 改成**一句话**，句子由**真实读数**选：
   *
   * · 关掉了（`syncMode === "off"` ✓）⇒ 「同步已关」✓
   * · 发现层没开（`lanStatus.enabled === false` ✓）⇒ 如实说"没在找附近的设备" ✓
   * · 正在同步（`syncing` ✓）⇒ 「正在同步…（已配对 N 台）」✓
   * · 有配对（`duList.length` ✓）⇒ 「已和 N 台设备配对，正在自动同步」✓
   * · 一台都没有 ⇒ 「还没配对，正在找附近的设备」✓
   *
   * ⚠️ ⛔ 一个词都不许写死 ✗：N 来自 `duList`（⭐ 不是 `lanStatus.peers` —— 那是**附近**的台数 ✗），
   * 开关来自读数 ✓；⭐ 读不到 ⇒ 走"没在找"那一句 ✓（⛔ 不拿"看起来正常"冒充 ✗）。
   */
  const heroState = (() => {
    const n = duList.length;
    if (syncMode === "off") return "同步已关";
    if (!meshOnline) {
      return n > 0 ? `已配对 ${n} 台，但没在找附近的设备` : "还没配对，也没在找附近的设备";
    }
    // ⚠️ ⭐ **2026-10-14（owner 追问「属实吗」）** ✗：这一支原来读**本机 state** `syncing` ——
    //   它只在点「立即同步」时置真（657／744 行 ✓）⇒ ⭐ **后台自动同步在跑时它不变** ✗
    //   （而同文件 1256 行的脉冲点用的是**真信号** `liveSyncing` ＝ `useSyncStatus` ✓）
    //   ⇒ ⭐ 两处都用同一把尺：**引擎说在跑，或本机这一下在跑** ✓。
    if (liveSyncing || syncing) return `正在同步…（已配对 ${n} 台）`;
    // ⚠️ ⭐ 这里原来写的是「**正在**自动同步」✗ —— 而走到这一支时**并没有**同步在跑 ✓
    //   ⇒ 那是把"开关是开的"说成了"正在发生" ✓。
    // ⭐⭐ **2026-10-14（owner：「怎么修改？」）** ✗：只改动词还不够 ✓ —— 那句话仍然**没说
    //   "对方在不在"** ✗（开关开着 ≠ 对方可达 ✓）。⇒ ⭐ 用**已有读数**把两种情况分开说：
    //   ⭐ 附近能不能看到**已信任**的那台 ← `nearbyBucket(q) === 1` ✓ —— **与三段里
    //   「已信任 · N 台」逐字同一个来源** ✓（⛔ 零后端改动、⛔ 不造新参数 ✗）。
    if (n === 0) return "还没配对，正在找附近的设备";
    const trustedNearby = nearby.filter((q) => nearbyBucket(q) === 1).length;
    return trustedNearby > 0
      ? `已和 ${n} 台设备配对，对方就在附近，自动同步开着`
      : `已和 ${n} 台设备配对；对方现在不在附近，出现就自动同步`;
  })();
  // ⚠️ 圆点：同步中 ⇒ 蓝；**已配对＋在线** ⇒ 绿；其余 ⇒ 无色（⛔ 不给一个「看起来很健康」的绿 ✗）。
  // ⭐ 同上：**同步关掉了就该无色** ✗ —— 否则会出现"绿点 ＋ 同步已关"这种自相矛盾的画面 ✓。
  // ⭐ 跟上面对齐："在跑"一律用 `liveSyncing || syncing` ✓（⛔ 别让圆点和那句话用两把尺 ✗）。
  const heroDot =
    syncMode === "off" ? "" : liveSyncing || syncing ? " is-busy" : meshPaired && meshOnline ? " is-ok" : "";
  const nearbySecondColumn = (p: NearbyPeer) => {
    if (p.serves_current) return `附近 · 服务 ${mySpaceName}`;
    // ⭐ **P-B（2026-10-13）**：⭐ 先把**原因**说出来 ✗ —— ⛔ 不许把"本机没设暗号"／"那个空间已删"
    //   说得像"**对端没服务我**" ✗（owner 现场那一行就是这个形状 ✓：起因在自己这边，人却去查对端 ✓）。
    //   ⚠️ 这两句**不引用任何值** ✓（尤其**不引用暗号** ✗ —— 它只说"哪一类原因"✓）。
    if (p.serves_reason === "no_secret") return "附近 · 认不出它在服务谁";
    if (p.serves_reason === "space_deleted") return "附近 · 它服务的空间在本机已删";
    if (!p.spaces.length) return "附近 · 没报服务哪个空间";
    const known = p.spaces
      .map((s) => rows.find((r) => r.space_id === s)?.name?.trim() || "")
      .filter(Boolean);
    const unknown = p.spaces.length - known.length;
    const parts = [...known];
    if (unknown > 0) parts.push(`另外 ${unknown} 个空间`);
    return `附近 · 服务 ${parts.join("、")}`;
  };
  // ⚠️ **2026-10-14**：⭐ 这里原来挂着一个 effect —— 打开面板时读一次「信任走到哪一步」✓。
  //    ⭐ 而显示那一格读数的**那一屏**（`TrustDevicePanel` ✓）**已随「附近设备」那一行删掉** ✗
  //    ⇒ ⭐ 读数没人看 ⇒ 这个 effect 一并去掉 ✓（⛔ 不开一个看不见的读数 ✗）。
  // ⭐ 2026-10-11（owner 拍的**甲**：一端点就通）：图④「信任这台设备」——
  //    点一次就把**勾选的那些空间**在这台设备上登记信任 ⇒ 逐个空间调 `mesh_trust_begin` ✓
  //    （⛔ 不再要求另一端也点 ✗）。⚠️ 对端**取这一轮看得见、且服务当前空间**的那一台 ✓；
  //    一台都没有 ⇒ **如实说**"还没有可以信任的设备"，⛔ 不挑一台凑数 ✗。
  // ⭐ **修 B（2026-10-13，Lead 拍板）**：⭐ 第二个参数＝**那一行自己点名的那一台** ✗ ——
  //   「附近的设备」里那颗按钮**必须**能把这一台直接交进来 ✓（⛔ 不再要求"恰好只有它一台服务当前空间"✗）。
  const trustDevice = async (spaceIds: string[], peerInRow?: NearbyPeer) => {
    if (!isDesktopPlatform()) {
      toast("信任设备要在桌面端操作", "info");
      return;
    }
    // ⚠️ 两条解析**并存** ✗（不是替换 ✓）：
    //   · 勾选那条路（`TrustDevicePanel` 的 `onAttach` ✓）**不给** `peerInRow` ⇒ 照旧"找那一台服务当前空间、且可直连的" ✓；
    //   · 主路径（`data-testid="nearby-allow"` ✓）**点名**那一台 ⇒ ⭐ 不再被 `serves_current && invitable` 挡住 ✗
    //     （owner 现场那一台恰好 `serves_current === false` ⇒ 旧守卫会让它**静默早退** ✓ —— 那是"点不动"的一半原因 ✓）。
    const peer = peerInRow ?? nearby.find((p) => p.serves_current && p.invitable) ?? null;
    if (!peer) {
      toast("现在还看不到可以信任的设备（先在「附近的设备」里发现一台）", "info");
      return;
    }
    // ⭐ 2026-10-12（设备身份第 3 步 ✓）：⭐ 信任的产物是"把**它的公钥**记进自己那份名单" ✗
    //   ⇒ ⭐ 对面**没报公钥** ⇒ **如实说**、⛔ 不硬凑一个身份 ✗（老版本的对端就是这一档 ✓）。
    if (!peer.pubkey) {
      toast(
        "这一台还没报出它的身份（它需要这一版的程序，并且开过一次设备直连）—— 现在信任它，说不出「它凭什么证明自己是它」",
        "info",
      );
      return;
    }
    try {
      for (const spaceId of spaceIds) {
        // ⚠️ 走 `platform.executor.invoke`：这条命令的声明归 Lead（⛔ 本任务不碰 `commands.ts` ✗）
        await platform.executor.invoke(MESH_TRUST_BEGIN_COMMAND, {
          spaceId,
          peerDeviceId: peer.device_id,
          peerPubkey: peer.pubkey,
        });
      }
      // ⭐ 文案说的是**结果** ✗（⛔ 不声称"已经双向同步完成" ✗ —— 那要等第一轮真的跑起来 ✓）。
      // ⭐⭐ **2026-10-26（owner 拍 A：两边各点一次确认，R208）** ✗ —— ⛔ 不再说"两边都通了" ✗：
      //   这一下只开**本机允许它来拿**这个方向；对面也要点一次「接入」并确认，双向才通 ✓。
      toast("配对成功：这一侧已开 —— 对面也要点一次「接入」并确认，双向才通", "success");
      // ⭐⭐ **2026-10-19（owner：「配对成功，没有同步发生？」）**：⭐ 配对**只做信任、不搬数据** ✗ ——
      //   真正搬运原先只发生在**同步节拍**上（面板默认 5 秒一档，但"最小一档"也可能是分钟级），
      //   所以配完看起来"什么都没发生" ✓。⇒ 信任成功后**立刻对该空间跑一轮网格交换** ✓
      //   （与「立即同步」走**同一条**命令 `mesh_sync_now` ✓；"没配网格 ⇒ 一个字节都不动"由 Rust 早退保证 ✓）。
      //   ⚠️ 交换会改数据 ⇒ 那两份清单必须跟着刷（页面列表 ＋ 待取回的远端版本）✓ ——
      //      与 `syncOne` 的 `finally` 里那段**同一条纪律**（不刷就会出现"说拉了 2 页、列表还是空"✗）。
      for (const spaceId of spaceIds) {
        try {
          const rep = await api.meshSyncNow(spaceId);
          // `rep.note` **自带**「网格：」前缀（Rust 拼好的人话）⇒ 这里别再写一遍 ✓
          setStatus(rep.note);
          await useNotes.getState().loadPages();
          await loadPendingRemote();
        } catch (e) {
          // 交换失败**照实报**（⛔ 不吞掉 ✗）：信任本身已经成立，这一步只是"立刻搬一次"失败 ✓
          setStatus(`配对成功，但立刻交换失败：${e instanceof Error ? e.message : String(e)}`);
        }
      }
      // ⭐⭐ **2026-10-19（owner：「配对成功后，页面不能自动刷新」）**：⭐ 成功之后**立刻重读一次**局域网读数 ✗
      //   —— 原来这里只有一句 toast ⇒ 那一行还停在「待配对」（要等下一轮 5 秒轮询）⇒ 用户以为没配上 ✓。
      setLanNonce((n) => n + 1);
      // ⚠️ **2026-10-14**：这一格原来会「点完再读一次」后端那份信任读数 ✓ —— ⭐ 而显示它的那一屏
      //    （`TrustDevicePanel` ✓）**已随「附近设备」那一行删掉** ✗ ⇒ 那格读数**没人看**了 ✓ ⇒
      //    ⭐ 那一下也一起去掉 ✓（⛔ 不去刷一个看不见的状态 ✗；命令与参数一个字没动 ✓）。
    } catch (e) {
      // ⭐ 失败**照实报**（⛔ 不假装成功 ✗）—— 这一条失败时**也要**把读数刷一遍 ✓
      //    （多半还是"还没开始" ✓ —— 那正是**如实**✓）。
      toast(`信任失败：${e}`, "error");
      // 失败也重读：让那台设备**回到该在的那一段**（⛔ 不留一个刚被点过、状态却停在旧读数的行 ✗）
      setLanNonce((n) => n + 1);
    }
  };

  // 同步历史：条数 ＋ 今天有没有失败。
  // ⚠️ 「失败」的判据与历史列表里那个 ✓/✗ **同一个**（`h.ok ? "✓" : "✗"`）。服务端
  //    `SyncHistoryEntry.ok` 是 Rust 的 `bool`（JSON 里 true/false）⇒ **不能**写 `ok !== 1`
  //    （`true !== 1` 为真，会把每一次成功都读成失败）。
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayHistory = history.filter((h) => h.at >= todayStart.getTime());
  const historyText = `${history.length} 条 · 今天 ${todayHistory.length} 项 · ${
    todayHistory.some((h) => !h.ok) ? "有失败" : "没有失败"
  }`;
  // 同步预算：两个档位与展开后下拉里的 <option> 逐字一致（见 `optMb`）。
  const budgetText = budget
    ? `磁盘余量 ${optMb(budget.disk_floor_mb)} · 单文件 ${budget.max_file_mb === 0 ? "不限" : optMb(budget.max_file_mb)}`
    : "";

  return (
    <div className="sync-panel">
      {/* ⭐ **P-2a-1**：`contentOnly` ⇒ ⛔ **不渲染抽屉触发器** ✗（它是抽屉那支的东西 ✓ ——
          内容区那一支只要内容体 ✓）；⭐ 默认那支**逐字不变** ✓。 */}
      {!contentOnly && (
      <button
        ref={triggerRef}
        className="btn-sync"
        onClick={() => {
          // ⭐ 2026-10-10：手机档 ⇒ 进我们自己的「设备配对 · 同步」屏 ✓（与 03/04/10 同一处置 ✓）。
          // ⚠️ **故意不用 `useMobile()`** ✗ —— 那个 hook 有副作用（进窄屏时**强制把侧栏关掉** ✓，
          //    见它自己的文档）：在 SyncPanel 里再挂一个 ⇒ 等于**第二个订阅者** ⇒ 会把用户
          //    手动打开的侧栏抽屉又压回去 ✗（实测：`mobile-layout` 三条抽屉断言因此变红 ✗）。
          //    ⇒ 这里要的是**一次纯判定**，所以用同模块导出的**纯函数** `isMobileViewport()` ✓
          //      （点击时求值 ✓，不订阅、不产生副作用 ✓）。
          if (isMobileViewport()) {
            useMobileNav.getState().setScreen("pair");
            return;
          }
          toggle();
        }}
        title={pendingTotal > 0 ? `同步设置（有 ${pendingTotal} 页等你裁决）` : "同步设置"}
      >
        {/* ⛔⭐ **2026-10-14（owner 逐字：「去掉侧边工具栏按钮里面的汉字」）** ✗ —— 这一格**之前漏了** ✓：
            ① 上一次只把 `ActivityBar.tsx` 里的文字 span 去掉了 ✓，而**真正渲染在屏幕上的**
            是**这里这一颗**（`.btn-sync` 触发器 ✓）⇒ ⭐ 屏幕上「同步」两个字**一直都在** ✗，
            而判据查的是 `ActivityBar` ⇒ **判据一直绿** ✓（"判据在它能看见的范围之外" ✓）。
            ⇒ ⭐ 现在去掉（⛔ **不动** `title` ✗ —— 那是悬停提示与无障碍名字 ✓，去了汉字 ≠ 去了名字 ✓）；
            角标与脉冲点照旧 ✓。 */}
        <CloudSyncIcon width={14} height={14} />
        {/* ★ 角标：只报"要你动手"的那一件事（待取回的远端版本），不报"你输了但没丢" */}
        {pendingTotal > 0 && (
          <span className="sync-badge" aria-label={`有 ${pendingTotal} 页等你裁决`}>
            {pendingTotal}
          </span>
        )}
        {liveSyncing && <span className="sync-pulse" aria-hidden />}
      </button>
      )}
      {/* ⭐ **P-2a-1**：`contentOnly` ⇒ **强制渲染内容体** ✓（⛔ 一行 JSX 都没搬 ✗）；
          ⚠️ 并且**去掉浮层定位** ✗ —— 否则 `top/left` 会漏进内容区（那会让它飘起来 ✓）。 */}
      {(open || contentOnly) && (
        <div
          ref={contentRef}
          className={`sync-popover is-sync${isSheet ? " is-sheet" : ""}${contentOnly ? " is-inline" : ""}`}
          style={contentOnly ? undefined : { top: pos.top, left: pos.left }}
          role="dialog"
          aria-label="同步设置"
        >
          {/* ⭐ **P-3e-1（R9 最小片）**：⭐ 未加密空间的**主动提醒** ✗ ——
              ⚠️ 只在**真读到 `N ≥ 1`** 时出现 ✓；⛔ `null`（读不到）与 `0` **都不出现** ✓（读不到 ≠ 0 ✓）。
              ⭐ 只说**个数** ✓，⛔ 不摆空间名 ✗（信息泄露 ✓）。
              ⚠️ ⛔ 这里**不许**写 Markdown 的 `**…**` ✗ —— 要强调用 `<b>` ✓（`syncPanelMesh` ⑨c ✓）。
              ⚠️ 本片**没做**「去开加密」那颗按钮 ✓（留下一片 ✓，见收口 ✓）。 */}
          {plaintextCount !== null && plaintextCount > 0 && (
            <div
              className="sync-hint"
              data-testid="plaintext-warning"
              style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}
            >
              {/* ⚠️⭐ **2026-10-14（纯排布修复，owner 截图：文字与按钮撞车）** ✗ ——
                  ⭐ 症状的机械原因：⭐ 这一格原来只有 `className="sync-hint"` ✓，而
                  `.sync-hint`（`App.css:1839`）**只有** margin／字号／行高／颜色 ⇒ ⭐ **没有 flex 容器** ✗
                  ⇒ ⭐ 文字与 `<button>` 挤在**同一个行盒**里 ✓（⭐ 与 `.sync-btn` 无关：它（`App.css:1895`）
                  是 `display:inline-flex` ✓、⭐ **没有 `position`** ✗ ⇒ ⛔ 样式表一个字节都没动 ✗）。
                  ⇒ ⭐ 修法：⭐ **行内** flex ＋ `flexWrap` ✓ ＋ 文字那一半 `flex:1 1 auto` ＋ `minWidth:0` ✓
                  （⭐ 于是文字在**按钮之前**结束 ✓，⛔ 不钻到按钮下面 ✗）。
                  ⚠️ 本仓**已有**同一形状的先例 `.sync-space-guide`（`App.css:1846-1855` ✓ —— 「提示 ＋ 按钮并排」✓）；
                  ⭐ 这里照抄**行内**那版（⛔ 不新造 CSS 类 ✗）。 */}
              <span style={{ flex: "1 1 auto", minWidth: 0 }}>
                ⚠️ 本机有 <b>{plaintextCount}</b> 个空间<b>没开加密</b> ⇒ 它们的内容会在局域网上<b>明文</b>传输
              </span>
              {/* ⚠️⭐ **本片只放按钮 ＋ testid** ✗ —— ⛔ **不做跳转** ✗：既有入口在 `SettingsDialog` 里
                  （`SettingsDialog.tsx:19` 挂的 `SpacePrivacySection` ✓），从本组件过去要**开那个对话框** ✗
                  ⇒ ⭐ 没有既有的 `setView` 路可接 ✓ ⇒ 按 Lead 的退路只放按钮 ✓（跳转留下一片 ✓）。 */}
              {/* ⭐ **2026-10-25（owner：「去开加密没有动作」）**：这颗按钮此前**没有 onClick** ——
                  当时按"本片只放按钮、不做跳转"留下的空片 ⇒ 点了一点反应都没有（假按钮）。
                  现在接**既有**那条路：`openSettings("spaces")` —— `SettingsDialog` 的「空间」页
                  （切换 / 配色 / 加密 / 迁移 / 删除；每行就是那个空间的加密入口）。
                  ⚠️ **2026-10-25 二次修正（owner 截图）**：先接到「安全」页是**接错了** ——
                  那一页是"会话锁定 ＋ 按空间加密"，而 owner 要的是**空间列表那一页**。
                  浮层形态下顺手 `close()` 收起自己；`contentOnly`（左栏内容区）不关。
                  ⛔ 没有新命令、没有新面板。 */}
              <button
                className="sync-btn"
                data-testid="plaintext-go-encrypt"
                onClick={() => {
                  useEditorStore.getState().openSettings("spaces");
                  if (!contentOnly) close();
                }}
              >
                去开加密
              </button>
            </div>
          )}
          <header className="sync-head">
            <div className="sync-head-text">
              {/* ⛔⭐ **2026-10-14（owner）**：「设备直连」⇒「**局域网同步（近网同步）**」✓
                  （⭐ 一个名字要同时说清"**范围**＝局域网"与"**走法**＝近网直连"✓ ——
                    原来的「设备直连」只说走法 ✗；括号里那个是 owner 点名的同义说法 ✓）。
                  ⚠️ 判据 `SyncPanel.trustDevicePanel.wiring.test.tsx` ① 钉的就是**这一屏的标题** ✓
                  ⇒ 按 R192 **换对象**（⛔ 断言不删 ✗）。 */}
              <div className="sync-title">局域网同步（近网同步）</div>
              {/* ⭐ 2026-10-11（owner：「参照效果图实现」）：⭐ 副标题按效果图改写 ✓ ——
                  原文是「⭐ 填一个配对暗号就能和附近的设备直连 ✗」⇒ ⭐ 那句把"⭐ 码 ✗"摆在了**这一屏最显眼的位置** ✓。
                  ⚠️ 新句**不改事实** ✗：⭐ 今天建信任那一步**仍然**要那串码 ✓（⭐ 见文件头的拍板口径 ✓）⇒
                     ⭐ 所以只说"⭐ 建立信任之后 ✗" ✓，⛔ **不说**"⭐ 不用码 ✗"（⭐ 那要等新拍板 ✓）。 */}
              <div className="sync-subtitle">{isPersonalActive ? "同一个 Wi-Fi 自动发现：两边各确认一次后，不用再点任何东西" : "每个空间各自绑定服务器与组织空间"}</div>

          {/* ⭐ **刀二十（2026-10-14，owner：按设计图）** ✗：⭐ **绿色状态条** ✓ —— 副标题之后、三段设备之前 ✓。
              ⭐ 值**全由 props 传** ✓（那些读数在别处一处一处算好 ✓，见上面 `heroState` / `heroDot` / `heroSub` ✓）：
              ⭐ 地址／端口 ← `lanStatus.mesh.bind`（经 `splitMeshBind` ✓）、⭐ 别人拉不拉得到 ← `lanStatus.mesh.reach`（Rust 侧原文 ✓）、
              ⭐「已配对」← `duList`、⭐「在线」← `lanStatus.enabled`、⭐「同步中／自动同步中」← `syncing` ✓。
              ⚠️ ⭐ 取不到就如实说「未读到」✗（那一句在 `SyncStatusStrip.tsx` 里**只有一处** ✓）。
              ⚠️ 旧注释这里写着「本轮不动那张大卡」✗ —— ⭐ 那张卡**已经不在**了 ✓（`9edc0a44` 拆的 ✓），
                 ⭐ 现在「立即同步」在**已信任的卡片**上 ✓（`nearby-sync` ✓）。 */}
            <SyncStatusStrip
              dotClass={heroDot}
              state={heroState}
              // ⭐ **2026-10-27（owner：「关闭局域网同步按钮布局太丑，优化一下」）**：
              //   那一枚动作**收进状态条右上角**（小胶囊 ✓），⛔ 不再在下面单独占一行 ✗
              //   （原来是一行「按钮 ＋ 一长串自动开启说明」⇒ 文字比按钮长、换行后像两坨 ✓）。
              action={
                isPersonalActive && isDesktopPlatform() ? (
                  <button
                    className="sync-mini-btn"
                    data-testid="lan-sync-toggle"
                    title={
                      lanStatus?.mesh?.enabled
                        ? "关闭后本机不再被同网络设备发现（配对关系保留）"
                        : "开启后同一 Wi-Fi 内的设备能发现本机"
                    }
                    onClick={() => void lanToggle()}
                  >
                    {lanStatus?.mesh?.enabled ? "关闭局域网同步" : "开启局域网同步"}
                  </button>
                ) : null
              }
              addr={splitMeshBind(lanStatus?.mesh?.bind ?? "").addr}
              port={splitMeshBind(lanStatus?.mesh?.bind ?? "").port}
              reach={lanStatus?.mesh?.reach ?? ""}
              announced={(() => {
                // ⭐ 参照图那半句是**裸地址**（`报出去的是 192.168.43.206` ✓）⇒ 从结构化字段取 host ✓。
                // ⚠️ 用 `mesh.announced`（枚举到的可达 base ✓），⛔ **不是** `mesh.window`（那是绑定地址：
                //    绑通配时它是 `0.0.0.0` ✗ —— 拿它当"报出去的"会写出 0.0.0.0，那是编造 ✓）。
                const a = lanStatus?.mesh?.announced ?? "";
                if (!a) return "";
                try {
                  return new URL(a).hostname;
                } catch {
                  return "";
                }
              })()}
            />
            {/* ⭐⭐ **R176-A（owner 2026-10-28 拍 A）④「能读的状态」** ✗：状态条下面**紧挨着**摆那三格
                ——「这一轮走的是：设备直连」／「服务 N 个空间」／「本机：已信任 N 台」✓
                （⭐ 个人版专属：团队档那条路是服务器，规模读数的口径不同 ✓ ⇒ 只在个人空间显示 ✓；
                  ⛔ 值一个都不写死 ✗ —— 全由 `personalReadout` 从真读数算出来 ✓）。
                ⚠️ 为什么单立一个组件（`SyncReadout.tsx`）：状态条那三格是**网络层**读数
                （监听地址／端口／报出去的是），这三格是**规模与路线**读数 —— 各管各的来源，
                混进一个组件迟早有人拿状态条的值去凑规模 ✓。
                ⚠️ 与 2026-10-14 那次删除的区别（如实记）：那次删的是旧面板里**四条变体**拼出的
                `heroRoute` 那行；本轮按 R176-A 把它列成**必有项**，用**逐格可点名来源**的三格回来 ✓
                （旧判据「`heroRoute` 不许再出现」仍然绿 —— 它钉的是旧标识 ✓）。 */}
            {isPersonalActive && isDesktopPlatform() && <SyncReadout {...personalReadout} />}
            {/* ⭐ 2026-10-23：「对端有、你没有的空间」—— 用户勾了才建（默认一个都不勾） */}
            <MeshMissingSpaces />
            </div>
            {/* 顶部胶囊反映【当前激活空间】的绑定状态（与该空间卡片一致），
                避免全局 authed 显示"已登录"但当前空间仍显示登录表单的矛盾。 */}
            {/* ⚠️ **2026-10-04 改**（owner：「去掉个人空间的登录状态」）：⭐ 个人空间下**整枚藏掉** ✗ ——
                它不经过服务器 ⇒ 没有"登录"这回事 ✓（原来会显示一枚「未登录」，看着像出了故障 ✓）。
                ⚠️ 团队空间照旧 ✓（那一枚反映的是**当前激活空间**的绑定状态 ✓）。 */}
            {!isPersonalActive && (
                          <span className={`sync-chip${rows.some((r) => r.ws_id === activeId && r.token) ? " is-on" : ""}`}>
                            {rows.some((r) => r.ws_id === activeId && r.token) ? "已登录" : "未登录"}
                          </span>
            )}
          </header>

          {!nearbyReadable || !lanStatus.enabled ? (
            <div className="sync-hint">附近的设备：这台机器上看不到这一层</div>
          ) : nearby.length === 0 ? (
            // ⭐⭐ **片 D1a-1（2026-10-14，owner 图）** ✗：⭐ **0 台时三段标题也要在** ✓
            //   （⭐ 原来这一支只给一句灰字 ✓ ⇒ ⭐ 用户看不到「分三段」这件事 ✗）。
            //   ⚠️ ⭐ 每段底下一行**实话** ✓（⛔ 不编数字 ✗ —— 仓规「读不到 ≠ 0」同族 ✓）；
            //   ⛔⭐ **2026-10-14（owner 选 C：「文案合并」）** ✗：⭐ 原来那句「还没发现别的设备… 正在找」
            //   **删掉了** ✓ —— ⭐ 它与下面三段的计数（三段都是 **0 台** ✓）说的是**同一件事** ✓，
            //   留着就是两处同义 ✓。⚠️ 判据按 R192 **换对象**（见 `syncPanelMesh` 片 D1a-1 ① ✓）。
            //   ⚠️ ⭐ testid 写**字面** ✓（⭐ 判据要能在这一支里逐字找到它 ✓），
            //   ⭐ 而**文案取自** `NEARBY_GROUPS` ✓（⭐ 单一来源 ⇒ ⛔ 不会与上面那份漂开 ✗）。
            <>
              {/* ⭐ **2026-10-14（owner）**：显示顺序照 `NEARBY_ORDER` ＝ 已信任 → 待配对 ✓
                  （⚠️ ⛔ 不改 `NEARBY_GROUPS` 的条目 ✗：那份**按桶号索引** ✓）。
                  ⛔⭐ **2026-10-14（owner：「这部分默认不出现可以吗？」）** ✗：⭐「需要重新配对」是
                  **异常段** ✓ —— ⭐ **一台都没有时不出现** ✓；⚠️ 这与**有设备那一支**本来就一致 ✓
                  （那支里 `showWhenEmpty: g.testid !== "nearby-group-keychanged"` ✓）
                  ⇒ 上一版在这一支硬渲染它 ✗ 属于**两支不一致** ✓。
                  ⚠️ 判据按 R192 **换对象**（`syncPanelMesh` 片 D1a-1 ① ✓）。 */}
              <div className="sync-hint" data-testid="nearby-group-trusted">
                {NEARBY_GROUPS[1].label} · {nearby.filter((q) => nearbyBucket(q) === 1).length} 台
              </div>
              <div className="sync-hint sync-empty-state" style={{ paddingLeft: 12 }}>这一轮没找到这一段的设备</div>
              <div className="sync-hint" data-testid="nearby-group-pending">
                {NEARBY_GROUPS[2].label} · {nearby.filter((q) => nearbyBucket(q) === 2).length} 台
              </div>
              <div className="sync-hint sync-empty-state" style={{ paddingLeft: 12 }}>这一轮没找到这一段的设备</div>
              {/* ⛔⭐ **2026-10-14（owner：「去掉这部分」）** ✗：⭐ 那句「两台要在同一个网络、且这个网络没开
                  「AP 隔离／客户端隔离」…」**整块删掉了** ✓（连着它那个 `lanStatus.peers === 0 &&` 条件块 ✓）。
                  ⚠️ 那条**结构化口径**（"界面不许解析 `lanStatus.line`" ✓）本身没变 ✓ —— 它现在由**别处**
                  承重（`activityBarSyncEntry` 那条：`peers === 0` ⇒ 不显示徽标 ✓）。
                  ⚠️ 判据按 R192 **换对象**（⛔ 不是删断言 ✗）：`syncPanelMesh` ⑨b 那三条从
                  「必须挂着／不许删」翻成「**不许再渲染**」✓。 */}
            </>
          ) : (
            /* ⭐ 同上：按 `NEARBY_ORDER` 遍历 ✓（⛔ 归段判据仍是 `NEARBY_GROUPS[nearbyBucket(p)]` ✗ ——
               那是"哪台归哪一段"的唯一来源 ✓，与"显示顺序"是两件事 ✓）。
               ⚠️ ⭐ 这里处在**三元分支**位置 ⇒ 只能是**一个表达式** ⇒ 注释要用 JS 块注释 ✓；
               ⛔ 不能写成 JSX 的「花括号 ＋ 块注释」那种（那是子节点写法 ✓）；也⛔ 不能塞进属性列表 ✗。
               ⚠️ ⭐ 而且注释**正文里不许再出现块注释的结束符** ✗ —— 我刚写过一次：注释在那一点提前闭合 ✓、
               报错行号乱跳（1422／1569 ✓），花了三轮才看明白 ✓。 */
            <SyncNearbyGroups
              sections={NEARBY_ORDER.map((idx) => NEARBY_GROUPS[idx]).map((g) => ({
                testid: g.testid,
                label: g.label,
                // ⭐⭐ **P-3d（2026-10-13）：第三段已落地** ✓ —— 「**需要重新配对**」✓，
                //   判据取 ⭐ **逐台读数** `key_changed`（P-3a 供的 ✓ `commands.ts` 的 `NearbyPeer` ✓）。
                //   ⚠️ ⭐ **读不到（`null`）不算变了** ✗（`false` 也不算 ✓）⇒ 只有 `=== true` 才进这一段 ✓
                //   （「读不到」是**没有结论** ✓ —— 与那几格读数同一把尺 ✓）。
                //   ⚠️ 这几句原来长在被删掉的「附近设备」那条注释里 ✓ —— ⭐ 按 R192：⛔ 口径不许跟着块一起丢 ✗。
                //   ⚠️ 另：三段归哪一段的**唯一判据**是 `nearbyBucket` ✓（排序键与分段键同一个 ✓）。
                // ⚠️ 「需要重新配对」是**异常段** ✗：一台都没有时**整段不出现** ✓ —— 判据钉着
                //   （`SyncPanel.trustDevicePanel.wiring.test.tsx` P-3d ②③：`key_changed` 读不到（`null`）
                //   与 `false`（没变）**都不许**被当成「变了」⇒ 那两段自然也不该出现 ✓）。
                //   ⭐ 其余两段空着时照渲染 ✓：`label · 0 台` ＋ 一行高的虚线框 ✓（设计图 ✓）。
                showWhenEmpty: g.testid !== "nearby-group-keychanged",
                // ⭐ 段的归属与段标题的 testid **同一个来源**（`NEARBY_GROUPS[nearbyBucket(p)].testid`）✓
                //   ⇒ ⛔ 不按数组下标另抄一份映射 ✗（两份真相迟早各说各话 ✓）。
                peers: nearby
                  .filter((p) => NEARBY_GROUPS[nearbyBucket(p)].testid === g.testid)
                  .sort((a, b) => nearbyBucket(a) - nearbyBucket(b)),
              }))}
              renderPeer={(p) => {
                // ⭐ 2026-10-26（owner：「界面不美观，优化一下」）：⭐ 这一行的**内容与动作一个字没改** ✓，
                //   只把原来"一长串 span 平铺"改成**三段式**：头像 ＋ 主信息（名字/身份/状态）＋ 右侧动作 ✓。
                //   ⛔ 六个 data-testid 一个不动 ✗（判据仍按它们取元素 ✓）。
                const paired = duList.some((d) => d.deviceId === p.device_id);
                const displayName = p.device_name || "这台设备没报名字";
                const identity = peerIdentityLine(p.device_name, p.short_id);
                // 头像只取**名字首字**（⛔ 不取 device_id 的任何前缀 ✗ —— 内部 id 不许进界面）。
                const unnamed = displayName === "这台设备没报名字" || displayName.trim().startsWith("未命名");
                const initial = unnamed ? "设" : displayName.trim().slice(0, 1).toUpperCase();
                const stateTone =
                  p.key_changed === true
                    ? "warn"
                    : paired
                      ? "ok"
                      : p.serves_current || isPersonalActive
                        ? "info"
                        : "muted";
                const showOtherSpace = !paired && !p.serves_current;
                return (
                  <>
                    <span className="sync-nearby-avatar" aria-hidden>
                      {initial}
                    </span>
                    <div className="sync-nearby-main">
                      <div className="sync-nearby-titleline">
                        {/* 名字空的 ⇒ **如实说没报名字**，不许回落成 id 前几位（内部 id 不进界面）。 */}
                        <span className="sync-nearby-name">{displayName}</span>
                        {/* J21：信任前要看得见「设备名 ＋ 短标识」✓ —— 名字已在左边，这枚只放短标识；
                            ⛔ 老对端没报 ⇒ 如实说「对方没报短标识」✗，⛔ 不回落成 id ✗。
                            identity 仍由唯一实现 peerIdentityLine 生成，放在 title 里供悬停核对 ✓。 */}
                        <span className="sync-nearby-id" title={identity}>
                          {p.short_id ? p.short_id : "对方没报短标识"}
                        </span>
                      </div>
                      <div className="sync-nearby-meta">
                        <span className={`sync-nearby-dot is-${stateTone}`} aria-hidden />
                        <span className="sync-hint">{nearbySecondColumn(p)}</span>
                        {paired && (
                          <span className="sync-hint sync-nearby-paired" data-testid="nearby-paired">
                            已配对
                          </span>
                        )}
                        {!p.invitable && p.serves_current && (
                          <span className="sync-hint">它没报可以直连的地址</span>
                        )}
                      </div>
                      {/* ⭐⭐ **R176-A（owner 2026-10-28 拍 A）⑤** ✗：「不再信任」的**语义写在按钮旁** ✓ ——
                          ⭐ 只停止同步、⭐ **本机数据一个字节都不动**（owner 最怕的是"取消信任把笔记删了"✓）。
                          ⚠️ 口径唯一实现在 `../lib/personalSyncReadout`（`UNTRUST_SCOPE_NOTE` ✓）——
                          ⛔ 不在这里再写一句近义的 ✗（两份写法迟早漂开 ✓）。
                          ⚠️ 这一句**只给已信任的那一台看** ✓（没认过的设备没有"不再信任"这回事 ✓）。 */}
                      {paired && (
                        <div className="sync-nearby-note" data-testid="untrust-scope-note">
                          {UNTRUST_SCOPE_NOTE}
                        </div>
                      )}
                      {/* P-B：原因说全（⛔ 两种处境不许都长得像"对端没服务我" ✗；⛔ 不引用任何值 ✗）。 */}
                      {p.serves_reason === "no_secret" && (
                        <div className="sync-nearby-note is-warn" data-testid="nearby-no-secret">
                          本机这个空间还没设配对暗号 —— 没设之前认不出它在服务谁（团队空间则是还没绑组织空间）
                        </div>
                      )}
                      {p.serves_reason === "space_deleted" && (
                        <div className="sync-nearby-note is-warn" data-testid="nearby-space-deleted">
                          它服务的那个空间在本机已删 —— 删了就不再直连它；要接着同步得先把那个空间放回来
                        </div>
                      )}
                      {/* ⛔ 不许静默 null ✗：看得见、只是服务别的空间 ⇒ 把这句话放在这一行里说清 ✓。 */}
                      {showOtherSpace && (
                        <div className="sync-nearby-note" data-testid="nearby-other-space">
                          {isPersonalActive
                            ? "它服务的是别的空间 —— 个人版按设备配对：直接点「接入」即可，配对后所有个人空间自动同步，不用切空间。"
                            : "它服务的是别的空间 —— 团队空间首次配对要两边在同一个组织空间；先切到它服务的那个空间再点「接入」。"}
                        </div>
                      )}
                    </div>
                    <div className="sync-nearby-actions">
                      {p.key_changed === true && (p.serves_current || isPersonalActive) ? (
                        // P-3d：钥匙变了 ⇒ 主动作是「重新配对」（复用 trustDevice 那一条主路径 ✓）。
                        <button
                          className="sync-btn"
                          data-testid="nearby-repair"
                          onClick={() => {
                            if (!activeId) return;
                            setDpPeer(p.device_id);
                            void trustDevice([activeId], p);
                          }}
                        >
                          重新配对
                        </button>
                      ) : paired ? (
                        <>
                          {/* 刀十七①：已信任的每一台都给「立即同步」—— 复用同一条动作（按**空间**同步 ✓）。 */}
                          <button
                            className="sync-btn"
                            data-testid="nearby-sync"
                            disabled={meshBusy}
                            onClick={() => void syncMeshNow()}
                          >
                            立即同步
                          </button>
                          {/* D1b：撤销配对（复用 duUnpair ⇒ 二次确认 ✓，⛔ 不新增命令 ✗）。
                              ⭐ **R176-A ①⑤（owner 2026-10-28）**：字改成 owner 逐字给的「不再信任」✓
                              （⛔ 动作与二次确认一个字没改 ✗）；语义句在**同一张卡**上紧挨着
                              （`untrust-scope-note` ✓ —— 只停同步、本机数据一个字节都不动 ✓）。 */}
                          <button
                            className="sync-btn is-ghost"
                            data-testid="nearby-unpair"
                            disabled={duBusy === p.device_id}
                            onClick={() => void duUnpair(p.device_id)}
                          >
                            {UNTRUST_LABEL}
                          </button>
                        </>
                      ) : p.serves_current || isPersonalActive ? (
                        // 修 B：这一行自己就是「允许」入口 —— 只打开对码屏，人确认前一个字节都不发 ✓。
                        // ⭐ 2026-10-26：个人档信任是设备级 ⇒ 服务别的空间也能在这里接入（配对后全部个人空间同步）；
                        // 团队档仍要求服务当前空间。
                        <button
                          className="sync-btn"
                          data-testid="nearby-allow"
                          onClick={() => {
                            if (!activeId) return;
                            setPairPeer(p);
                            setPairScreen(true);
                            void preparePairCode(p);
                          }}
                        >
                          接入
                        </button>
                      ) : null}
                    </div>
                  </>
                );
              }}
            />
          )}

          {/* ⭐⭐ **2026-10-28（owner：「同步面板适配一下视觉体系」）**：本块**用回**面板既有的那套零件 ✗ ——
              「段标题 ＋ 数量胶囊」＋「`sync-nearby-row` 卡片（头像/主信息/状态点/胶囊）」✓，
              ⛔ 不再是一根蓝条配一行灰字（那是另一套视觉语言，和上下两段不是一家人 ✗）。 */}
          {spaceSync && (spaceSync.encrypted.length > 0 || spaceSync.pendingAdopt > 0) && (
            <div data-testid="encrypted-sync-state">
              <div className="sync-hint sync-nearby-group">
                <span className="sync-nearby-group-label">加密空间同步</span>
                <span className="sync-nearby-group-count">{spaceSync.encrypted.length} 个</span>
              </div>
              {spaceSync.encrypted.map((s) => {
                // 头像只取**空间名首字**（⛔ 不把内部 id 放进界面 ✗，与「附近设备」同一条纪律）
                const initial = (s.name || "?").trim().slice(0, 1);
                const tone = s.unlocked ? (s.peersServing.length > 0 ? "ok" : "info") : "warn";
                return (
                  <div
                    key={s.wsId}
                    className={"sync-nearby-row sync-enc-row" + (s.unlocked ? "" : " is-locked")}
                    data-testid="encrypted-sync-row"
                  >
                    <span className="sync-nearby-avatar" aria-hidden>
                      {initial}
                    </span>
                    <div className="sync-nearby-main">
                      <div className="sync-nearby-titleline">
                        <span className="sync-nearby-name">{s.name}</span>
                        <span className={"sync-chip" + (s.unlocked ? " is-on" : "")}>
                          {s.unlocked ? "已解锁" : "锁着"}
                        </span>
                        {s.pendingInbox > 0 && (
                          <span className="sync-nearby-id" title="已收下的封包，解锁后自动应用">
                            {s.pendingInbox} 条待应用
                          </span>
                        )}
                      </div>
                      <div className="sync-nearby-meta">
                        <span className={`sync-nearby-dot is-${tone}`} aria-hidden />
                        <span className="sync-hint">{s.note}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
              {spaceSync.pendingAdopt > 0 && (
                <div className="sync-enc-adopt" data-testid="encrypted-pending-adopt">
                  <span className="sync-hint">
                    对端还有 {spaceSync.pendingAdopt} 个加密空间没接入本机
                  </span>
                  {/* ⭐ 2026-10-28（owner 选 A）：**一次性口令接入** —— 输一次口令，解锁后后端自动
                      依公开材料建空间；这里只负责问口令 + 重读读数 ✓（⛔ 口令不落日志 ✗）。 */}
                  <button
                    className="sync-btn"
                    data-testid="encrypted-adopt-open"
                    onClick={() =>
                      startEncryptedAdopt(spaceSync.pendingAdopt, {
                        refresh: async () => {
                          const next = await api.spaceSyncState();
                          setSpaceSync(next);
                        },
                      })
                    }
                  >
                    接入 {spaceSync.pendingAdopt} 个
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ⭐⭐ **owner 2026-10-14** ✗：⭐ 对码屏**搬进主视图** ✓ —— ⭐ 原来它住在下面那个
              **默认收起**的「高级」折叠里 ✗ ⇒ ⭐ 主视图那张卡上点「接入」，用户**什么都看不见** ✓
              （真机实测 ✓）。⭐ 现在它排在**三段设备之后、折叠之前** ✓（图上它就是独立的一屏 ✓）。 */}
          {/* ══════════════════════════════════════════════════════════════════════
              ⭐⭐ **P-4 片②a（2026-10-13）**：⭐ 「**对码**」那一屏 ✗ —— ⭐ 由「接入」那一下打开 ✓。
              ⚠️ ⭐ **只显示、不下结论** ✓：⭐ `kind === "ok"` 才渲染那串码 ✓，⭐ 读不到 ⇒
                 ⭐ **如实说为什么** ✓（⛔ 不编一个码 ✗）。
              ⚠️ ⭐ **分组 ＝ 5 组 × 4 位** ✓（`pairing.rs:369` 的 `format!("{n:020}")` ＋ `:371` 的
                 `.chunks(4)` ✓ ⇒ 屏上写 `XXXX-XXXX-XXXX-XXXX-XXXX` ✓，⛔ 不是 4 组 ✗）。
              ⛔ 屏上**没有**任何「继续／自动通过」一类入口 ✗（⭐ 仓里逐字：状态机里**没有"自动通过"这一格** ✓）。
              ══════════════════════════════════════════════════════════════════════ */}
          {pairScreen && (
            <div className="set-section" data-testid="pair-code-screen">
              <div className="set-section-title">两台设备核对这串码</div>

              {pairReading.kind === "unavailable" ? (
                <div className="sync-status is-warn" data-testid="pair-code-unavailable">
                  读不到比对码（{pairReading.reason}）
                </div>
              ) : pairReading.value === null ? (
                <div className="sync-hint" data-testid="pair-code-empty">这一轮还没有比对码</div>
              ) : (
                <div
                  className="sync-status"
                  data-testid="pair-code-value"
                  // ⚠️ 大字（⭐ 只为"念得清" ✓）：⭐ 不新造 CSS 类 ✗（行内样式与别处同一手法 ✓）
                  style={{ fontSize: 22, letterSpacing: 2, fontWeight: 700, wordBreak: "break-all" }}
                >
                  {pairReading.value}
                </div>
              )}

              <div className="sync-hint">
                两边一样 ⇒ 点「确认」 ✓
              </div>
              <div className="sync-hint" data-testid="pair-code-mismatch">
                ⚠️ 不一样 ⇒ 先别确认（可能连到别的设备）✓
              </div>

              <div className="sync-field">
                <button
                  className="sync-btn primary"
                  data-testid="pair-confirm"
                  type="button"
                  // ⭐ **P-4 片②b（2026-10-13）**：⭐ **原来那两步搬到这里** ✗ —— 逐字是
                  //   `setDpPeer(peer.device_id)` ＋ `void trustDevice([activeId], peer)` ✓
                  //   （⚠️ ⭐ 命令名 `mesh_trust_begin`／参数 `{spaceId, peerDeviceId, peerPubkey}`／
                  //    ⭐ 而「点完再读一次后端那一格」那一下**已随信任读数那一屏一起删掉** ✓（见 `trustDevice` ✓））。
                  onClick={() => {
                    const peer = pairPeer;
                    if (!activeId || !peer) return;
                    setDpPeer(peer.device_id);
                    void trustDevice([activeId], peer);
                    setPairScreen(false);
                  }}
                >
                  码对得上，确认
                </button>
                <button
                  className="sync-btn"
                  data-testid="pair-cancel"
                  type="button"
                  // ⭐ P-4 片②b：⭐ 取消 ⇒ 关屏 ＋ ⭐ **一个字节都不发** ✓（⛔ 不调任何东西 ✗）
                  onClick={() => {
                    setPairPeer(null);
                    setPairScreen(false);
                  }}
                >
                  取消
                </button>
              </div>

              {/* ⚠️ 三句如实（⭐ 一句都不许省 ✗）：⭐ 这是"比对码"✓／⭐ 它含窗口口令 ⇒
                  只发自己那台 ✓／⭐ 它**不是一次性的** ✓。⛔ JSX 里不用 Markdown `**…**` ✗（用 <b> ✓）。
                  ⭐ **2026-10-13（owner 拍「不要 pake 了，就 20 位比对码」）**：⭐ **不做 PAKE** ✗ ⇒
                    ⛔ 旧那句"更短的 6 位码**要等** PAKE 落地"是一句**过期的承诺** ✗（已删 ✓）；
                    ⭐ 这串 20 位比对码**就是现在的做法** ✓（⛔ 不再有"以后换 6 位"的暗示 ✗）。 */}
              <div className="sync-hint" data-testid="pair-code-notes">
                这是<b>比对码</b>（20 位、5 组）；6 位码要 PAKE —— <b>已决定不做</b> ✓
                <br />
                <b>含窗口口令</b> ⇒ <b>只发你自己那台</b> ✓；<b>不是一次性的</b> ⇒ 用后建议换窗口口令 ✓
              </div>
            </div>
          )}
          {/* ⭐ **刀二十（2026-10-14，owner 设计图）** ✗：⭐ 主视图到三段设备（＋对码屏）为止 ✓
              ⇒ ⭐ **其余全部**收进**一个**默认收起的折叠 ✓（⛔ 不再有几个并排的折 ✗）。
              ⚠️ 里面的 JSX **一个字都没搬走** ✗ —— 那些源码级判据（`syncPanelMesh.wiring` ／
                 `syncPanelDevicePair.wiring` ／ `syncPanelDeviceUnpair.wiring` ／
                 `SyncPanel.trustDevicePanel.wiring`）逐字读的**就是本文件** ✓。 */}
          {/* ⭐⭐ **2026-10-20（owner 真机：「没看到三个选项的界面」）**：
              这一段原来是**藏在默认收起的「高级」折叠里**的（2026-10-14 那次"其余全收进一个折叠"）✗
              ⇒ 队列里真有 5 页要裁决，主人却**根本看不到入口** ✓
              ⇒ 它是**要人动手的事**（不是高级设置），挪到主视图 ✓；读失败时也**说一句真话** ✓（⛔ 不静默 ✗）。 */}
          {pendingError && (
            <div className="sync-hint" role="status">
              ⚠️ 读不到「待取回的远端版本」清单：{pendingError}
            </div>
          )}
          {pending.length > 0 && (
            <div className="sync-pending-remote" role="status">
              <div className="sync-conflict-title">📥 待取回的远端版本（{pendingTotal} 页）</div>
              <ul className="sync-conflict-list">
                {pending.map((p) => (
                  <li key={p.page_id}>
                    《{p.title || "（无标题）"}》
                    <span className="sync-pending-actions">
                      <button onClick={() => void resolveOne(p.page_id, "merge")}>合并这一页</button>
                      <button onClick={() => void resolveOne(p.page_id, "take_remote")}>采用远端</button>
                      <button onClick={() => void resolveOne(p.page_id, "keep_local")}>保留本地</button>
                    </span>
                  </li>
                ))}
              </ul>
              <div className="sync-conflict-hint">
                这些页面当时保留了本地（本地有未推送的改动），对端那一版已替你存下 —— 三个选项都会真的改数据。
              </div>
            </div>
          )}
          <SyncAdvancedFold>

          {!isDesktopPlatform() && (
            // ⭐⭐ **2026-10-22（owner 拍 A）**：换成**如实说明 ＋ 引导下载** ✓
            //   旧文案「受浏览器环境限制」太含糊：用户看不出"这里到底能不能同步、为什么"。
            //   三句硬事实（都能自证）：① Web 版**不提供**多设备同步（这是产品决定）；
            //   ② 原因是**浏览器存储可能被系统回收**，不能当数据的唯一副本；
            //   ③ 要用同步 ⇒ 装桌面版（或手机 App）。
            <div className="sync-web-note" role="note">
              <div>
                <b>Web 版不提供多设备同步。</b>
                浏览器存储可能被系统回收，不能当作笔记的唯一副本。
              </div>
              <div style={{ marginTop: 6 }}>
                要在多台设备之间同步，请安装 <b>桌面版</b>（Windows / Linux / macOS）或 <b>手机 App</b>：
                <a
                  href="https://shuyo.cn/"
                  target="_blank"
                  rel="noreferrer noopener"
                  className="sync-btn ghost"
                  style={{ marginLeft: 8, display: "inline-block", textDecoration: "none" }}
                >
                  前往下载页 ↗
                </a>
              </div>
              <div style={{ marginTop: 4, opacity: 0.75 }}>
                这一页上的笔记仍然可以读写，只是<b>只存在这台浏览器里</b>（换浏览器/清站点数据就会丢）。
              </div>
            </div>
          )}
          {conflicts.length > 0 && (
            <div className="sync-conflict-banner" role="alert">
              <div className="sync-conflict-title">⚠️ 有页面被多人同时修改</div>
              {/* ★ 丙-⑤（2026-09-26）：**分两类说**，因为两类页能做的事**不一样**：
                  · 有「待取回的远端版本」的（页级保留了本地）⇒ 两颗按钮**真的**动数据；
                  · 戳判"用远端"已生效的 ⇒ 本机那一版**已经进了版本历史**（`sync.rs` 在覆盖前
                    先存了一份），**没有**待取回的版本可裁决 ⇒ 说清去哪找回，而不是摆两颗假按钮。 */}
              {conflictsWithStash.length > 0 && (
                <>
                  <ul className="sync-conflict-list">
                    {conflictsWithStash.map((c) => (
                      <li key={c.entity_id}>《{c.title}》</li>
                    ))}
                  </ul>
                  <div className="sync-conflict-actions">
                    <button
                      onClick={() => void resolveAll(conflictsWithStash.map((c) => c.entity_id), "keep_local")}
                      className="btn-sync-conflict keep"
                    >
                      保留本地
                    </button>
                    <button
                      onClick={() => void resolveAll(conflictsWithStash.map((c) => c.entity_id), "take_remote")}
                      className="btn-sync-conflict adopt"
                    >
                      采用服务端
                    </button>
                  </div>
                  <div className="sync-conflict-hint">
                    提示：你在这些页有未推送的改动，另一台设备改了同一页。远端那一版已经存在本地（不会因为游标走过去而丢）：
                    选「保留本地」= 你这份优先（下次同步推上去）；选「采用服务端」= 真的放弃本地未推送的改动。
                  </div>
                </>
              )}
              {conflictsTakenRemote.length > 0 && (
                <>
                  <ul className="sync-conflict-list">
                    {conflictsTakenRemote.map((c) => (
                      <li key={c.entity_id}>《{c.title}》</li>
                    ))}
                  </ul>
                  <div className="sync-conflict-hint">
                    这些页已经按判序采用了远端（对端那枚戳更晚）：你本地未推送的那一版在覆盖前
                    已存进版本历史 —— 在编辑器工具栏点「版本历史」就能找到它、恢复它。
                  </div>
                </>
              )}
            </div>
          )}
          <div className={`sync-profiles${isDesktopPlatform() ? "" : " is-disabled"}`}>
            {/* 刀二（2026-10-14）＋ 刀二十（2026-10-14）：⭐ 这一层是「浅那层设置」✓ ——
                它现在由**主视图那一个**折叠（`<SyncAdvancedFold>` ✓）装着 ✓（⛔ 这里不再有第二层壳 ✗）。 */}
            {/* ⭐ 刀二十（2026-10-14）：⭐ 原来这里还套着「高级（已自动填好）」那一折 ✗ ——
                它现在**就是**上面那个唯一的折叠 ✓ ⇒ 这一层壳去掉 ✓（⛔ 里面那些行一行没动 ✗）。 */}
                  {/* ⭐⭐ **2026-10-14（owner：选了「把这两行读数提到主视图」）** ✗ —— ⭐ 实测结论：
                      ⭐ **它已经在主视图了** ✓：绿条那行就写着 `监听地址 0.0.0.0（自动）· 端口 8788（默认）`
                      （⭐ 同一份 `lanStatus.mesh.bind`、同一个 `splitMeshBind` ✓）。⛔ 再搬一份上去 ＝ 同一件事
                      屏上两处 ✗（⭐ 那正是 owner 今天一路在清的东西 ✓）⇒ ⭐ 这里**删掉重复的这一份** ✓，
                      ⭐ 「一眼看到绑在哪」由绿条那行负责 ✓；⭐ 值也能 hover 看全（绿条那格带 `title` hmm ——
                      绿条两行本就把地址与端口都写全了 ✓）。
                      ⚠️ 要改成"把行搬上去、同时把绿条那半句去掉"⇒ 说一声 ✓（⭐ 两处只能留一处 ✓）。 */}
                {/* ⛔ **2026-10-14（owner：「去掉这部分」）** ✗：「这一轮走的是：…」那句已删 ✓；
                    ⭐ `heroSub`（空间名 · 上次同步 · 今天同步了 N 项）**留着** ✓ —— 它是真读数、主人点名删的不是它 ✓。 */}
                {heroSub && <div className="sync-hint">{heroSub}</div>}
            {/* ⛔ **2026-10-14（owner：「去掉这部分」）** ✗：这一组的标题「设置」也去掉了 ✓
                （⭐ 它下面那些行自己说得清 ✓；⛔ 组容器留着 ✗ —— 折叠与中继卡都在它里面 ✓）。 */}
            <div className="sync-group">

              {/* ⚠️ 2026-09-28（D1）：**设置类控件搬出吸底条** ——
                 §2 第 2 条 `INV-UI-sync-panel-persistent-chrome` 的口径是：
                 「常驻 chrome（`.sync-foot` 这类 `position:sticky` 的段）里**不许有需要阅读与填写的表单**
                   —— 读数行可以有，设置控件不行」。
                 实测（改前）：`.sync-foot` 里【可见】表单 = **Web 4 ／ app 手机 3 ／ app 桌面 3**，
                 逐个查是：① `.sync-auto` 的「同步方式」select；②③ `.sync-mesh` 的「监听地址」/「口令」两个 input；
                 ④ web 上还有 `.sync-budget-row` 的三个 select。**三个对象上都是红的。**
                 ⇒ 把这三块搬进【滚动区】（底下仍在 footer 的都是**读数行**与进度/历史：
                   `.sync-lan` 实测 0 个表单控件，`.sync-net` 的 checkbox 是 `display:none`）。
                 ⚠️ 保留在 footer 的 `.sync-lan` 是【读数行】，按上面那条口径**允许**留在常驻区。
                 ⚠️ 本笔只搬位置，**一个字都不改**（文案是另一条不变式的事）。 */}

              {/* ① 同步方式 ← 原来的 `.sync-auto` ＋ `.sync-auto-hint`
                  （还是同一个 <select>、同一句 `syncModeHint`；行头那颗字是它的 `<label>`） */}
              <details className="sync-row">
                <summary>
                  <span className="sync-row-label">同步方式</span>
                  <span className="sync-row-value">{SYNC_MODE_TEXT[syncMode]}</span>
                  <span className="sync-row-caret" aria-hidden>›</span>
                </summary>
                <div className="sync-row-body">
                  <div className="sync-auto">
                    <select
                      className="sync-input"
                      value={syncMode}
                      onChange={(e) => applySyncMode(e.target.value as SyncMode)}
                    >
                      <option value="off">关闭</option>
                      <option value="interval">按间隔（每 30 秒）</option>
                      {/* ⚠️ 只有桌面才有那条流（Web 上是浏览器自带 SSE、没有开关；Rust 侧才有
                          `sync_stream_*`）。Web 上不摆这一档 —— 摆了就是承诺一个不存在的档。 */}
                      {isDesktopPlatform() && <option value="realtime">近实时（连着服务端时立刻拉）</option>}
                    </select>
                  </div>
                  <span className="sync-hint sync-auto-hint">{syncModeHint(syncMode)}</span>
                </div>
              </details>

              {/* ⭐⭐ **R176-A（owner 2026-10-28 拍 A）②③** ✗：个人版那两格**只在这里**（「高级」里）——
                  · **广播端口**：⭐ 预置好了、**默认藏起来**（主界面一个端口输入都没有 ⇒ J12
                    「首次同步零手输端口」✓）；⭐ 只在「高级」里**能改** ✓；两端改成不同端口后彼此看不到
                    ⇒ 状态里会把原因说出来（J9，见 `SyncReadout` 的诊断句 ✓）。
                    ⚠️ 只改端口那一半：地址还是**当前绑定里那个**（界面在 2026-10-14 已按 owner
                    的决定撤掉填地址的入口，本笔⛔ 不加回来 ✗）。
                  · **同步密码**：⭐ **自动派生**、用户**不用知道**它 ⇒ 这一格**只读**一句「自动生成 · 不用你填」✓
                    （⛔ 没有手填框 ✗ —— 口径与理由见 `personalSyncReadout.ts` 里那段"为什么没有手动入口"✓）。
                  ⚠️ 只在**个人空间 ＋ 桌面**出现：团队档的远程路径是服务器，端口/密码不是它的事 ✓。 */}
              {isPersonalActive && isDesktopPlatform() && (
                <>
                  <details className="sync-row" data-testid="mesh-port-row">
                    <summary>
                      <span className="sync-row-label">广播端口</span>
                      <span className="sync-row-value">{bindPort || "未读到"}</span>
                      <span className="sync-row-caret" aria-hidden>›</span>
                    </summary>
                    <div className="sync-row-body">
                      <div className="sync-field">
                        <label htmlFor="sync-mesh-port">端口</label>
                        <input
                          id="sync-mesh-port"
                          className="sync-input"
                          data-testid="mesh-port-input"
                          value={shownPort}
                          inputMode="numeric"
                          placeholder="预置值（读到这里就能改）"
                          disabled={!bindPort}
                          onChange={(e) => setMeshPortDraft(e.target.value)}
                        />
                        <button
                          className="sync-btn"
                          data-testid="mesh-port-save"
                          disabled={!bindPort}
                          onClick={() => void saveMeshPort()}
                        >
                          保存端口
                        </button>
                      </div>
                      <p className="sync-hint">{PORT_ADVANCED_HINT}</p>
                    </div>
                  </details>
                  <details className="sync-row" data-testid="mesh-password-row">
                    <summary>
                      <span className="sync-row-label">同步密码</span>
                      <span className="sync-row-value">{PASSWORD_AUTO_VALUE}</span>
                      <span className="sync-row-caret" aria-hidden>›</span>
                    </summary>
                    <div className="sync-row-body">
                      <p className="sync-hint">{PASSWORD_AUTO_HINT}</p>
                    </div>
                  </details>
                </>
              )}

              {/* ★ 2026-09-29（规格 §9.2）：**总闸关了要说出来** —— 而且要说清"设备直连也停着"。
                  owner 原话「服务器不灰」，但他要求**在值旁边标明**「当前不自动同步」，不许让用户
                  以为它已经在跑；这一块就是那句话（照效果图的黄框：位置在「同步方式」下面）。
                  ⚠️ 用的是既有那一类"提示框"的样式（`.sync-web-note` 的**底色来自既有变量**），
                    不新引色值（规格 §9 的落地要求：新增 CSS 只用既有变量）。 */}
              {totalOff && (
                <div className="sync-web-note is-inline" role="note">
                  <span>【注意】设备直连也停着</span>
                  <span>（总闸优先：关了就不动，如实说）</span>
                </div>
              )}

              {/* C2 网络闸门：只在**真查得到**网络类型的平台上出现（桌面回 "n/a" = 不适用）。
                  与其在桌面上显示一个永远不起作用的开关，不如按能力把它收起来。 */}
              {netKind !== "n/a" && (
                <details className="sync-row">
                  <summary>
                    <span className="sync-row-label">只在 Wi-Fi 下自动同步</span>
                    <span className="sync-row-value">{wifiText}</span>
                    <span className="sync-row-caret" aria-hidden>›</span>
                  </summary>
                  <div className="sync-row-body">
                    <label className="sync-att sync-net">
                      <input
                        type="checkbox"
                        checked={budget?.wifi_only ?? true}
                        disabled={budgetBusy}
                        onChange={(e) => budget && void saveBudget({ ...budget, wifi_only: e.target.checked })}
                      />
                      <span className="sync-att-text">
                        <span className="sync-hint">
                          关掉后蜂窝网络也会自动同步（可能消耗流量）。手动点「同步」始终可用——这条只管自动同步。
                        </span>
                      </span>
                    </label>
                  </div>
                </details>
              )}

              {/* ③ 服务器 ← 原来 `.sync-profiles` 里那串 `<section class="sync-card">`
                  （服务器 / 账号 / 组织空间 / 成员管理 / 附件 / 保存 —— 一块都没删，只是折进这一行）
                  ★ 2026-09-29（规格 §9.2）：**总闸关闭时这一行【不灰】** —— owner 原话「服务器不灰」，
                     因为那一行装的是**配置入口**（地址/账号/组织空间/成员），不是开关；灰掉它 ⇒
                     用户没法先准备配置。**但要在值旁边标明「当前不自动同步」**（不许让用户以为它在跑）。 */}
              {/* ⚠️ **2026-10-04 改**（owner：「个人空间不显示登录状态文案信息」）：
                  ⭐ 个人空间**整行不显示** ✗ —— 这一行的摘要写的是「未绑定」（服务器口径 ✓），
                  而个人空间根本不经过服务器 ✓（owner 裁定），它的远程路径是下面的**设备直连** ✓。 */}
              {!isPersonalActive && (
              <details className="sync-row">
                <summary>
                  <span className="sync-row-label">服务器</span>
                  {/* ⚠️ **2026-10-04**：摘要也按 `serverRows` 算 ✓ —— 否则个人空间会把值算进去、
                      而下面一张卡都没有（看起来像坏了）✓。 */}
                  <span className="sync-row-value" title={serverText}>
                    {totalOff ? `${serverText} · 当前不自动同步` : serverText}
                  </span>
                  <span className="sync-row-caret" aria-hidden>›</span>
                </summary>
                <div className="sync-row-body">
                  {/* ⚠️ **2026-10-04 改**（owner：「个人空间不显示服务器同步内容」）：
                      ⭐ 这一段装的是**服务器 / 账号 / 组织空间 / 成员管理** ✓ ⇒ ⭐ 只列**团队空间** ✓。
                      ⭐ 个人空间不该出现在这里（它不经过服务器 —— owner 裁定「个人空间不绑服务器」✓），
                      而它的远程路径是下面那块**设备直连** ✓。 */}
                  {serverRows.length === 0 && <div className="sync-empty-state">还没有可配置的团队空间</div>}
                  {serverRows.map((r) => {
                    const myRole = r.remoteSpaces.find((x) => x.id === r.space_id)?.role ?? "";
                    const state = r.server_url && r.space_id ? "bound" : r.server_url ? "partial" : "none";
                    return (
                      <section key={r.ws_id} className="sync-card">
                        <div className="sync-card-head">
                          <span className="sync-card-avatar" aria-hidden>{initial(r.name)}</span>
                          <span className="sync-card-name" title={r.name}>{r.name}</span>
                          <span className={`sync-state is-${state}`}>
                            {state === "bound" ? "已绑定" : state === "partial" ? "待选空间" : "未配置"}
                          </span>
                        </div>

                        <div className="sync-field">
                          <label htmlFor={`sync-srv-${r.ws_id}`}>服务器</label>
                          <input
                            id={`sync-srv-${r.ws_id}`}
                            className="sync-input"
                            value={r.server_url}
                            placeholder="http://localhost:8787"
                            onChange={(e) => update(r.ws_id, "server_url", e.target.value)}
                          />
                        </div>

                        {/* 已拿到令牌就不再堆登录表单——只留一枚「已登录」胶囊 + 登出。 */}
                        {r.token ? (
                          <div className="sync-account">
                            <span className="sync-account-dot" aria-hidden />
                            <div className="sync-account-text">
                              <b>{authEmail || "已登录"}</b>
                              <span title={r.server_url}>{r.server_url || "—"}</span>
                            </div>
                            {/* 管理账号/组织：跳转到设置中心「账户」页（登录身份、组织管理、注销）。 */}
                            <button className="sync-btn ghost" onClick={() => useEditorStore.getState().openSettings("account")}>管理</button>
                            <button className="sync-btn ghost" onClick={() => void logout(r)}>登出</button>
                          </div>
                        ) : (
                          <div className="sync-field">
                            <label htmlFor={`sync-mail-${r.ws_id}`}>账号</label>
                            {/* 登录/注册 tab：登录只需邮箱+密码；注册需额外 注册邀请码。 */}
                            <div className="sync-auth-tabs">
                              <button
                                className={`sync-tab${r.authMode === "login" ? " on" : ""}`}
                                onClick={() => update(r.ws_id, "authMode", "login")}
                              >登录</button>
                              <button
                                className={`sync-tab${r.authMode === "register" ? " on" : ""}`}
                                onClick={() => update(r.ws_id, "authMode", "register")}
                              >注册</button>
                            </div>
                            <div className="sync-auth-grid">
                              <input
                                id={`sync-mail-${r.ws_id}`}
                                className="sync-input"
                                value={r.loginEmail}
                                placeholder="邮箱"
                                autoComplete="username"
                                onChange={(e) => update(r.ws_id, "loginEmail", e.target.value)}
                              />
                              <input
                                className="sync-input"
                                type="password"
                                value={r.loginPassword}
                                placeholder="密码"
                                autoComplete="current-password"
                                onChange={(e) => update(r.ws_id, "loginPassword", e.target.value)}
                              />
                            </div>
                            {r.authMode === "register" && (
                              <div className="sync-field" style={{ marginTop: 8 }}>
                                <label htmlFor={`sync-regcode-${r.ws_id}`}>注册邀请码（必填）</label>
                                <input
                                  id={`sync-regcode-${r.ws_id}`}
                                  className="sync-input"
                                  value={r.loginRegisterCode}
                                  placeholder="比如：SHUYOABC"
                                  onChange={(e) => update(r.ws_id, "loginRegisterCode", e.target.value)}
                                />
                                <p className="sync-hint">
                                  {r.server_url ? "注册必须有邀请码。把服务端管理员给你的邀请码填到这里（填错或留空会注册失败）。" : "需先填服务器地址。"}
                                </p>
                              </div>
                            )}
                            <div className="sync-auth-btns">
                              {r.authMode === "login" ? (
                                <button className="sync-btn primary" disabled={loggingIn || !r.server_url} onClick={() => login(r)}>
                                  {loggingIn ? "处理中…" : "登录"}
                                </button>
                              ) : (
                                <button className="sync-btn primary" disabled={loggingIn || !r.server_url} onClick={() => register(r)}>
                                  {loggingIn ? "处理中…" : "注册"}
                                </button>
                              )}
                            </div>
                            <p className="sync-hint">密码 ≥8 位，注册成功即自动登录。</p>
                          </div>
                        )}

                        <div className="sync-field">
                          <label htmlFor={`sync-space-${r.ws_id}`}>组织空间</label>
                          {r.remoteSpaces.length > 0 ? (
                            <div className="sync-space-row">
                              <select
                                id={`sync-space-${r.ws_id}`}
                                className="sync-input"
                                value={r.space_id}
                                onChange={(e) => void pickSpace(r, e.target.value)}
                              >
                                <option value="">选择我加入的空间…</option>
                                {r.remoteSpaces.map((sp) => (
                                  <option key={sp.id} value={sp.id}>{sp.name}</option>
                                ))}
                              </select>
                              {myRole && <span className={`sync-role ${roleClass(myRole)}`}>{myRole}</span>}
                            </div>
                          ) : (
                            <input
                              id={`sync-space-${r.ws_id}`}
                              className="sync-input"
                              value={r.space_id}
                              placeholder="组织空间 id（多设备同步需绑定一个组织空间）"
                              onChange={(e) => update(r.ws_id, "space_id", e.target.value)}
                            />
                          )}
                          {/* 已登录但还没有可绑定的组织空间 → 引导 + 创建入口，避免卡住 */}
                          {r.token && r.remoteSpaces.length === 0 && (
                            <div className="sync-space-guide">
                              <p className="sync-hint">还没有组织空间。点「创建空间」新建一个，或让管理员邀请你加入。</p>
                              <button className="sync-btn primary" onClick={() => createSpace(r)}>创建空间</button>
                            </div>
                          )}
                          {/* 已登录、有空间可选但还没选 → 轻引导 */}
                          {r.token && !r.space_id && r.remoteSpaces.length > 0 && (
                            <p className="sync-hint">请在上面下拉选择一个组织空间，才能同步。</p>
                          )}
                        </div>

                        {r.space_id && r.token && canManageSpace(r) && (
                          <div className="sync-field">
                            <button
                              className="sync-members-toggle"
                              aria-expanded={r.memberOpen}
                              onClick={() => toggleMembers(r)}
                            >
                              <span>成员管理</span>
                              {r.members.length > 0 && <span className="sync-members-count">{r.members.length}</span>}
                              <span className={`sync-caret${r.memberOpen ? " is-open" : ""}`} aria-hidden>▾</span>
                            </button>
                            {r.memberOpen && (
                              <div className="sync-members">
                                {r.members.length === 0 ? (
                                  <div className="sync-members-empty">还没有成员</div>
                                ) : (
                                  r.members.map((m) => {
                                    const canManage = canManageSpace(r);
                                    const isOwnerRow = m.role === "owner";
                                    return (
                                      <div key={m.user_id} className="sync-member">
                                        <span className="sync-member-avatar" aria-hidden>{initial(m.email)}</span>
                                        <span className="sync-member-email" title={m.email}>{m.email}</span>
                                        <select
                                          className={`sync-member-role ${roleClass(m.role)}`}
                                          value={m.role}
                                          aria-label={`${m.email} 的角色`}
                                          disabled={!canManage || isOwnerRow}
                                          onChange={(e) => void setMemberRole(r, m.email, e.target.value)}
                                        >
                                          <option value="viewer">viewer</option>
                                          <option value="editor">editor</option>
                                          <option value="admin">admin</option>
                                        </select>
                                        <button
                                          className="sync-member-remove"
                                          title={isOwnerRow ? "空间所有者不可移除" : "移除成员"}
                                          aria-label={`移除 ${m.email}`}
                                          disabled={!canManage || isOwnerRow}
                                          onClick={() => void removeMember(r, m.user_id)}
                                        >
                                          ✕
                                        </button>
                                      </div>
                                    );
                                  })
                                )}
                                <div className="sync-invite">
                                  <input
                                    className="sync-input"
                                    value={r.inviteEmail}
                                    placeholder="被邀请者邮箱"
                                    disabled={!canManageSpace(r)}
                                    onChange={(e) => update(r.ws_id, "inviteEmail", e.target.value)}
                                  />
                                  <select
                                    className="sync-input sync-invite-role"
                                    value={r.inviteRole}
                                    aria-label="邀请角色"
                                    disabled={!canManageSpace(r)}
                                    onChange={(e) => update(r.ws_id, "inviteRole", e.target.value)}
                                  >
                                    <option value="viewer">viewer</option>
                                    <option value="editor">editor</option>
                                    <option value="admin">admin</option>
                                  </select>
                                  <button className="sync-btn" disabled={!canManageSpace(r)} onClick={() => void inviteMember(r)}>
                                    邀请
                                  </button>
                                </div>
                                {!canManageSpace(r) && (
                                  <p className="sync-hint">只有 admin / owner 能邀请成员或改角色。</p>
                                )}
                              </div>
                            )}
                          </div>
                        )}

                        {/* 手动令牌是老配置法的后路，默认收起，避免面板一眼全是输入框。
                            两用途：① 团队版临时贴一个会话 token；② **「个人自建同步」那一档**
                            （服务端由自己部署、没有账号）—— 把服务端 CLI 签发的那把 `sk_…` 设备密钥
                            贴进来即可，**不需要注册/登录**（服务端侧见 sync-server 的 K1：
                            `--issue-device-key`，持钥即拥有该空间）。 */}
                        <details className="sync-advanced">
                          <summary>高级：手动填令牌 / 设备密钥{r.token ? "（已填）" : ""}</summary>
                          <input
                            className="sync-input"
                            type="password"
                            value={r.token}
                            placeholder="组织 token，或个人自建部署签发的 sk_ 密钥"
                            onChange={(e) => update(r.ws_id, "token", e.target.value)}
                          />
                          <div className="sync-hint">
                            自己部署服务端（无账号）时：在服务器上跑
                            <code> --issue-device-key</code> 拿到一串 <code>sk_…</code>，贴到这里即可；丢了只能重新签发。
                          </div>
                        </details>

                        {/* P6.1 每空间附件开关：默认开。关掉只影响附件**字节**，元数据照常
                            同步——另一端能看到附件条目但打不开，所以文案要说清后果而不是
                            写成"不同步附件"（那听起来像附件也跟着消失）。 */}
                        <div className="sync-att">
                          <div className="sync-att-text">
                            <div className="sync-att-name">同步附件文件</div>
                            <div className="sync-hint">
                              关闭后只同步笔记内容，不传图片 / 附件文件（省流量与磁盘；另一端会看到附件但打不开）。
                              改变立即生效，正在同步的任务会在传完当前文件后停下。
                            </div>
                          </div>
                          <input
                            type="checkbox"
                            checked={r.syncAttachments}
                            aria-label={`同步「${r.name}」的附件文件`}
                            onChange={(e) => void setAttachments(r, e.target.checked)}
                          />
                        </div>

                        <div className="sync-card-actions">
                          {/* 登录/注册与选空间都会自动落盘，这里的「保存」只用于手填
                              服务器地址或手动粘贴令牌的情况。 */}
                          <button className="sync-btn" onClick={() => save(r)} title="保存手填的服务器地址 / 令牌">
                            保存
                          </button>
                          <button className="sync-btn primary" disabled={syncing} onClick={() => syncOne(r)}>
                            {syncing ? "同步中…" : "同步"}
                          </button>
                        </div>
                      </section>
                    );
                  })}
                </div>
              </details>
              )}


            </div>
          </div>
          {/* ⚠️ **刀二十（2026-10-14）** ✗：⭐ 原来这里有一句「【进阶】这一组是 `.sync-profiles` 的**兄弟**」，
              ⭐ 那是为 `SpacePrivacySection` 的位置写的 ✓ —— ⭐ 而它**已经删掉**（owner：与设置的安全面板重复 ✓）
              ⇒ ⭐ 这句连同那个理由一起退役 ✓（⛔ 不留一句描述已删东西的注释 ✗）。 */}
          <div className="sync-group is-advanced">


            {/* ⑥ 同步历史 ← 原来吸底条里的 `.sync-history`（内部结构一个字没改）。
                它以前是 `.sync-foot` 的常驻内容 —— 折进这里之后吸底条只剩读数行。 */}
            {history.length > 0 && (
              <details className="sync-row">
                <summary>
                  <span className="sync-row-label">同步历史</span>
                  <span className="sync-row-value">{historyText}</span>
                  <span className="sync-row-caret" aria-hidden>›</span>
                </summary>
                <div className="sync-row-body">
                  <div className="sync-history">
                    <div className="sync-history-head">
                      <button className="sync-history-toggle" aria-expanded={historyOpen} onClick={() => setHistoryOpen((v) => !v)}>
                        <span className="sync-history-toggle-title">同步历史</span>
                        <span className="sync-history-count">{history.length}</span>
                        <span className={`sync-history-caret${historyOpen ? " is-open" : ""}`} aria-hidden>▾</span>
                      </button>
                      <button className="sync-history-clear" onClick={() => void clearHistory()} title="清空同步历史">清空</button>
                    </div>
                    {historyOpen && (
                      <div className="sync-history-list">
                        {history.slice(0, 8).map((h, i) => {
                          const d = new Date(h.at).toLocaleString("zh-CN");
                          const open = detailOpenIdx === i;
                          return (
                            <div key={i} className="sync-history-item">
                              <span className={`sync-history-status${h.ok ? " is-ok" : " is-err"}`}>{h.ok ? "✓" : "✗"}</span>
                              <div className="sync-history-main">
                                <div className="sync-history-title">
                                  <span className="sync-history-at" title={d}>{relTime(h.at)}</span>
                                  <span className="sync-history-stats">
                                    <span className="sync-stat">↑ {h.pushed}</span>
                                    <span className="sync-stat">↓ {h.pulled}</span>
                                  </span>
                                  {h.items.length > 0 && (
                                    <button
                                      className="sync-history-detail-toggle"
                                      onClick={() => setDetailOpenIdx(open ? null : i)}
                                    >
                                      {h.items.length} 项明细 ▾
                                    </button>
                                  )}
                                </div>
                                {h.message && <div className="sync-history-msg">{h.message}</div>}
                                {open && (
                                  <div className="sync-history-items">
                                    {h.items.slice(0, 30).map((it, j) => (
                                      <div key={j} className="sync-history-item-row">
                                        <span className={`sync-dir-${it.dir}`}>{it.dir === "push" ? "↑" : "↓"}</span>
                                        <span className="sync-entity">{entityLabel(it.entity)}</span>
                                        <span className={`sync-op${it.op === "delete" ? " is-del" : ""}`}>{it.op === "delete" ? "删除" : "变更"}</span>
                                        <span className="sync-id" title={it.entity_id}>{it.title || it.entity_id.slice(0, 10)}</span>
                                      </div>
                                    ))}
                                    {h.items.length > 30 && <div className="sync-history-more">…等 {h.items.length - 30} 项</div>}
                                </div>
                              )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              </details>
            )}

            {/* ⑦ 同步预算 ← 原来的 `<details class="sync-advanced sync-budget">`
                （三个下拉与那段解释一个字没改；`<summary>` 换成统一的行头） */}
            {/* C1 预算刹车：磁盘余量下限是**硬性**的（没有"关闭"选项）。 */}
            {budget && (
              <details className="sync-row sync-budget">
                <summary>
                  <span className="sync-row-label">同步预算</span>
                  <span className="sync-row-value">{budgetText}</span>
                  <span className="sync-row-caret" aria-hidden>›</span>
                </summary>
                <div className="sync-row-body">
                  <div className="sync-budget-row">
                    <span className="sync-auto-label">磁盘余量下限</span>
                    <select
                      className="sync-input"
                      value={String(budget.disk_floor_mb)}
                      disabled={budgetBusy}
                      onChange={(e) => void saveBudget({ ...budget, disk_floor_mb: Number(e.target.value) })}
                    >
                      <option value="256">256 MB</option>
                      <option value="512">512 MB</option>
                      <option value="1024">1 GB</option>
                      <option value="2048">2 GB</option>
                      <option value="5120">5 GB</option>
                    </select>
                  </div>
                  <div className="sync-budget-row">
                    <span className="sync-auto-label">单文件上限</span>
                    <select
                      className="sync-input"
                      value={String(budget.max_file_mb)}
                      disabled={budgetBusy}
                      onChange={(e) => void saveBudget({ ...budget, max_file_mb: Number(e.target.value) })}
                    >
                      <option value="0">不限</option>
                      <option value="50">50 MB</option>
                      <option value="100">100 MB</option>
                      <option value="500">500 MB</option>
                    </select>
                  </div>
                  <div className="sync-budget-row">
                    <span className="sync-auto-label">本次下载上限</span>
                    <select
                      className="sync-input"
                      value={String(budget.max_run_mb)}
                      disabled={budgetBusy}
                      onChange={(e) => void saveBudget({ ...budget, max_run_mb: Number(e.target.value) })}
                    >
                      <option value="0">只报告，不拦</option>
                      <option value="500">500 MB</option>
                      <option value="1024">1 GB</option>
                      <option value="5120">5 GB</option>
                    </select>
                  </div>
                  <p className="sync-hint">
                    余量低于下限、或超过单文件上限的附件会停在安全的地方：已经下载的字节全部保留，
                    下次同步接着下（按内容寻址，不会重复下）。磁盘余量下限不可关闭。
                  </p>
                </div>
              </details>
            )}

            {/* ④ 中继 ← 2026-10-10：**跨网送达那一格**（owner 2026-10-10 要的两格之一）。
                ⭐ 两句话都是**后端出的原文**（`api.relayStatus` / `api.relayProbe` ⇒
                `src/lib/relay/statusView.ts` ⇒ 这一块只摆上去）——
                ⛔ 界面不自己算天数、⛔ 读不到时也不编一个数（那两格说"读不到有效期"）✓。 */}

            {/* ⚠️ **2026-10-04 改**（owner：「要显示设备直连的条目」）：⭐ 门槛去掉 `space_id` ✗ ——
                原来要求 `!!activeRow?.space_id.trim()` ✓，而 ⭐ 个人空间**永远拿不到** `space_id`
                （今天 `set_sync_profile` 装了真拦：只有团队空间能绑服务器 ✓）
                ⇒ ⭐ 个人空间的「设备直连」**永远不显示** ✗ —— 而那正是它唯一的远程路径 ✓。
                ⚠️ 原顾虑「会显示**别的空间**的地址」已不成立：`api.lanStatus(activeId)` 是**按空间查**的
                （Rust `lan_status(db, workspace_id)` ✓）。
                ⚠️⭐ **2026-10-14（owner 连问三次「同步面板还是旧的」⇒ 真因就是这一行）** ✗：
                门槛原先把 `!!activeRow` 留着 ✗ ⇒ 个人空间整块不渲染 ✓ ⇒ 修法＝放行 `isPersonalActive` ✓。
                ⭐⭐ **同日再改（owner 拍删那一折）** ✗：⭐ 里面那条**读数行**（`lanStatus.line` ＋
                `mesh.note` ＋「AP 隔离」那句 ✓）**已删** ✓ —— 前两项绿条已说全 ✓（⛔ 不重复摆 ✗），
                ⭐ 而「AP 隔离／开手机热点」那句**按图搬到主视图三方段之后的虚线空框**里 ✓（⛔ 没删字 ✗）。
                ⇒ ⭐ 这条门槛现在的对象＝ ⭐「设备直连设置」那一组（`MeshAdvancedForm` ✓）
                   ＋ 中继（`RelayStatusSection` ✓）⭐ 仍然是**个人空间也要看得到** ✓（判据 `syncPanelMesh` ② 钉着 ✓）。 */}
            {isDesktopPlatform() && lanStatus && (!!activeRow || isPersonalActive) && (
              <>
                  <RelayStatusSection />
                  {/* ⭐ 2026-10-18：个人版「跨网同步订阅」的状态与续期（桌面专属 —— Web 没有本机私钥）。
                      ⚠️ 停卡那一档写的是「已停卡 · 只停了跨网」，⛔ 不许写"已过期"（判据 `license/uiText.test.ts`）。 */}
                  <LicenseSection />
              {/* ⭐⭐ **2026-10-14（owner：「和上面重复了」⇒ 拍「整张卡连输入框一起去掉」）** ✗ ——
                  ⭐ 这一块原来是「设备直连设置」那张卡 ✓（说明 ＋ 监听地址输入框 ＋ 保存地址 ＋ 用自动选开启
                  ＋ 关掉网格 ＋ `<MeshAdvancedForm` ✓）⇒ ⛔ **整张卡已删** ✗。
                  ⚠️⭐ **两条后果（如实记下，⛔ 不许当没发生 ✗）**：
                    · ① 界面上**再也没有改监听地址的地方** ✓ —— `MeshAdvancedForm.tsx` 仍在仓里 ✓（它自己的
                      7 条判据直接渲染它、照旧绿 ✓），⛔ 但**没有挂载点**了 ✗ ⇒ 它现在是**孤儿组件** ✓
                      （与 `TrustDevicePanel` 同一形状 ✓ —— 要留还是要删，等 owner 一句话 ✓）。
                    · ② 界面上**再也没有「关掉网格」** ✓ ⇒ 网格一旦开着（它还**监听所有网卡** ✓），
                      用户**从界面上关不掉** ✓。⚠️ 这两条都是 owner 在**被告知**会撞「必留监听地址输入框」
                      与 VL-2「手填本机内网地址那条路也不许删」之后拍的 ✓ —— ⛔ 不是本笔自作主张 ✗。
                      要恢复只需把这一段改回来（改前现场在 `_tmp/scratch/round6-before/` ✓）。
                  ⭐ 这条门槛（`isDesktopPlatform() && lanStatus && (!!activeRow || isPersonalActive)` ✓）
                    **一个字没动** ✓ —— 它现在的对象＝ ⭐ **中继**（`RelayStatusSection` ✓），
                    判据 `syncPanelMesh` ② 钉的仍是「个人空间也要看得到它」 ✓。
                    ⚠️ ⭐ 另记一条**后端口径**（⛔ 界面删了，它也不能跟着丢 ✗）：⭐ 传给 `meshSetConfig` 的
                      `activeId` **空串 ＝ 设备级** ✓（后端 `DEVICE_LEVEL_SPACE` ✓；⛔ 别改成 `null` ✗ ——
                      `mesh_set_config` 里那句 `.filter(|w| !w.trim().is_empty())` 会不一样 ✓）。
                      它原来写在被删掉的那段注释里 ✓ —— 本笔把它搬到这里 ✓（⛔ 不删事实 ✗）。 */}
              </>
            )}

          </div>
          {/* ⭐⭐ **owner 2026-10-14「去掉最下边这（根）横线」** ✗ —— ⭐ 真机读数（CDP `:9222`）：
              这一格在没有进度、也没有状态时**一个字节都不渲染** ✓（`textLen=0` ✓），可它自己带着
              `border-top: 1px solid` ＋ `padding: 12px 16px` ✓ ⇒ ⭐ 结果是**一条 25px 高的空横线**
              摆在面板最底下 ✓（⭐ 就是 owner 圈的那根 ✓）。
              ⇒ ⭐ 既然里面那两支（`syncing` ／ `status` ✓）本来就决定「有没有话说」，
              就把**整格**按**同一个条件**挂 ✓ —— ⛔ 不碰样式表 ✗（改 CSS 会动到常驻 chrome 那条
              不变量 `INV-UI-sync-panel-persistent-chrome` ✓）。判据：`syncControls.wiring` ⑧ ✓。
              ⚠️ 移动版那条门禁（`verify-mobile-views.mjs`）对「没有 `.sync-foot`」本来就写好了
              **不算通过也不算红** 的分支 ✓ ⇒ 这一改不会让它假红 ✓。 */}
          {(syncing || status) && (
            <footer className="sync-foot">

              {/* 甲-1 接线第 3 件：**局域网发现的读数**（施工单 §2 ④）＋ 丙-③-b 的**网格读数**。
                  口径：**「没走成直连」必须是可断言的结果，不是静默降级** —— 所以这里显示的是
                  Rust 侧 `lan::status_line` 的**原文**（"直连（同一网络）…" ／ "公网 … ｜ 附近发现 N 台"
                  ／ "…其中没有服务这个空间的中枢" ／ "尚未绑定"），界面**不**自己按地址形状再判一次档。
                  ⚠️ 2026-10-01：引用的原文按 `lan.rs` 的**现口径**改（`02c2e4c3` 起 Rust 侧已是
                  「同一网络」／「附近发现 N 台」✓）；旧词「直连（局域网）／本网段发现」只作历史保留 ✓。
                  ★ 2026-09-26 口径收敛：**地址只说一处** —— 网格那一块的"窗口在哪、别人拉不拉得到"
                  （`lanStatus.mesh.note`）也并到这一行里。两处各说一遍地址，看起来就像两个互相矛盾的读数。
                  ⚠️ 门槛同时收 `mesh.enabled`：**"只开网格、不绑服务端"** 是丙要支持的配置，
                  那种空间没有服务端（`lanRowBound` 假）但这一行照样得有内容。
                  只在桌面显示：发现层是 Rust 的 UDP（Web 上没有这一层，`lan_status` 那边如实回"公网"）。 */}
              {/* ⚠️ **2026-10-04 改**：同上 —— 这一行（附近发现/地址）也不该因为没绑服务器就不显示 ✓。
                  ⚠️ 里面那句 `lanRowBound ? lanStatus.line : ""` **照旧** ✓ ⇒ ⭐ 个人空间看不到
                  "去绑服务器"那句读数 ✓（那个三元本来就是为这一刻写的 ✓）。 */}

              {/* 丙-③-b-2b-2：**网格（对等交换）** —— "不装服务端也能同步"在这里有一个可点的入口。
                  ⚠️ 门槛**不是** `lanRowBound`：网格**不需要**服务端地址，只要这个空间有 `space_id`
                  （"只开网格、不绑服务端"正是这一档要支持的配置）。
                  ⚠️ 读数那句人话来自 Rust（`mesh::config_state`）—— 界面**不**自己判断
                  "别人拉不拉得到"（那要按地址形状判档，而档位只许由 Rust 出，与上面那条同一纪律）。 */}

              {syncing ? (
                <div className={`sync-status is-progress${syncPhase === "error" ? " is-err" : ""}`}>
                  <div className="sync-progress-row">
                    <span className="sync-spin" aria-hidden />
                    <span className="sync-status-text">{syncMessage || "正在同步…"}</span>
                    {attTotal > 0 && (
                      <span className="sync-progress-count" title={attName || ""}>
                        {attCurrent}/{attTotal}
                      </span>
                    )}
                  </div>
                  {syncPhase === "attachments" && attTotal > 0 && (
                    <div className="sync-progressbar">
                      <div
                        className="sync-progressbar-fill"
                        style={{ width: `${(attCurrent / attTotal) * 100}%` }}
                      />
                    </div>
                  )}
                </div>
              ) : status ? (
                <div className={`sync-status is-${statusKind(status)}`}>
                  {/* ⚠️ 2026-09-29（丙-乙片）：这一行显示的是**后端给的人话**
                      （`mesh_set_config` 的 `note`），而后端是按**行内 Markdown**
                      写的（`**没有**钥匙材料`、`**密文**`）⇒ 在**渲染边界**过 `inlineMd`
                      —— 与上面那条读数行、`:1633` 那一处同一口径（`inlineMd` 对不含成对 `**` 的
                      文本**原样返回**，所以既有那几句一个字都不会变）。 */}
                  {inlineMd(status)}
                  {syncDurationMs > 0 && (
                    <span className="sync-duration">耗时 {fmtDuration(syncDurationMs)}</span>
                  )}
                </div>
              ) : null}
            </footer>
          )}
          </SyncAdvancedFold>
        </div>
      )}
    </div>
  );
}


