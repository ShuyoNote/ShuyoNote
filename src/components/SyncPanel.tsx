import { Fragment, useCallback, useEffect, useState } from "react";
import { isMobileViewport } from "../hooks/useMobile";
import { useMobileNav } from "../store/mobileNav";
import { usePopover } from "../hooks/usePopover";
import { useOverlayScrollLock } from "../hooks/useOverlayScrollLock";
import { useOverlayLayer } from "../hooks/useOverlayLayer";
import { api, type SyncProfile, type SyncBudget, type LanStatus, type NearbyPeer, type DevicePairExportOutcome } from "../lib/api";
import { autoPickPeer } from "../lib/pairTarget"; // ⭐ 常驻判据在 src/lib/pairTarget.test.ts ✓
import { peerIdentityLine } from "../lib/peerIdentity"; // ⭐ 规格 J21 的**唯一实现**（信任前展示身份 ✓）
import { toast } from "../store/toast";
import { TrustDevicePanel, type Reading, type TrustStateReading } from "./TrustDevicePanel";
// ⭐ **2026-10-14**：⭐ `MeshAdvancedForm` **又回到面板了** ✓（⭐ 设备级那三格在 `:2120` 一带 ✓）——
//   ⚠️ 旧注释那句"已搬到「设置 · 同步」⇒ 面板不再引它"是**旧口径** ✗，已改 ✓；⭐ 设置那边已去掉 ✓。
import {
  MESH_TRUST_BEGIN_COMMAND,
  readTrustState,
  unavailableTrustDeviceReadings,
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
import { isNearRealtimeEnabled, applyNearRealtime } from "../lib/nearRealtime";
// ★ 2026-09-29（丙档「设备直连」）：**「拉取间隔」这一档** —— 用户可见、可持久化，
//   读写口径都在 `lib/syncMode.ts` 那一处（面板只调它，不自己碰 localStorage）。
//   ⚠️ 它替换掉了原来"按 `mesh.enabled` 在代码里悄悄换成 5 秒"那条路（见 `effectiveAutoSyncMs`）。
import {
  PULL_INTERVALS,
  broadcastAutoSyncChanged,
  pullIntervalLabel,
  readAutoSyncMs,
  readPullIntervalMs,
  settingsForMode,
  syncModeHint,
  syncModeOf,
  setLanMeshActive,
  writeAutoSyncMs,
  writePullIntervalMs,
  type SyncMode,
} from "../lib/syncMode";
import { SpacePrivacySection } from "./SpacePrivacySection";
// ⭐ **片 B（2026-10-14）**：⭐ 设备直连那三格（监听地址／配对暗号／自动选）**也**渲染进本面板 ✓
//   （⭐ 原来只在「设置 · 同步」里 ✓ —— ⭐ 那边**先不动** ✓，⭐ 片 C 才删 ✓）。
import { MeshAdvancedForm } from "./MeshAdvancedForm";
// ⭐ 跨网中继那两格（图⑤「中继」／图⑧「中继许可证」，2026-10-10）——
//    读数（连上没连上 ＋ 剩余 N 天）**全部来自后端**，这一块只摆上去 ✓。
import { RelayStatusSection } from "./RelayStatusSection";
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
/**
 * ⭐ 信任设备那一屏的四条读数（task 派单）—— **这一轮一律如实给"读不到"** ✓：
 * 后端那几条读数命令还没到位 ✓ ⇒ ⛔ 不编 0、⛔ 不编假数 ✗（界面上出现「读不到」是**预期**的 ✓）。
 * ⚠️ 放在**模块级常量**：它是常量 ⇒ 不必每帧新建对象 ✓（后端到位后只改 `src/lib/trustDevicePanelReadings.ts` ✓）。
 */
const TRUST_DEVICE_READINGS = unavailableTrustDeviceReadings();

/** ⭐ **P-4 片②a（2026-10-13）**：那一屏要显示的**比对码** ✗ —— ⭐ 默认**如实「读不到」** ✓
 *  （手法照上面 `TRUST_DEVICE_READINGS` 那条 ✓：⭐ 模块级常量 ⇒ 不必每帧新建对象 ✓）。
 *  ⚠️ ⛔ **不许编一个码** ✗ —— ⭐ 码由 `pairing_trust::pairing_code_for`（片① 已入库 ✓）算 ✓，
 *  ⭐ 而**接线**归**下一片**（片②b ✓）⇒ ⭐ 今天这一屏只会如实说"读不到" ✓。 */
const PAIR_CODE_UNAVAILABLE: Reading<string | null> = {
  kind: "unavailable",
  reason: "还没接上读数（码 ＝ 本机公钥 ＋ 对方公钥 ＋ 这一轮的 trust_ask 算出来的）",
};

/** ⭐ **P-3d（2026-10-13）**：设备列表那**三段**的名字与 testid ✓ ——
 *  ⭐ 数组下标 ＝ 段序（`nearbyBucket` 的返回值 ✓）：需要重新配对 ⇒ 已信任 ⇒ 待配对 ✓。 */
const NEARBY_GROUPS = [
  { testid: "nearby-group-keychanged", label: "需要重新配对" },
  { testid: "nearby-group-trusted", label: "已信任" },
  { testid: "nearby-group-pending", label: "待配对" },
] as const;
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
        if (alive) {
          setLanStatus(st);
          // ★ 2026-09-29：把"局域网这一档开着吗"喂给 `syncMode`（它就是 `App` 那个自动同步
          //   定时器的间隔来源）。owner 判定：**局域网这一档的节拍 = 用户在「拉取间隔」里选的那一档**
          //   （默认 5 秒，见 `syncMode.ts` 的 `PULL_INTERVALS`）。
          //   ⚠️ 用的是 Rust 判好的两个**结论**（`mesh.enabled` ＝ `cfg.bind.is_some()`、
          //      `syncMode` ＝ 总闸那一档），**不按地址形状自己再判一次档**（判据 ⑭ 钉的是后者）。
          setLanMeshActive(!!st.mesh.enabled);
        }
      } catch {
        // 读不到（命令没注册 / 老构建）⇒ 这一行**不显示**，别把它装成"没有发现到对端"。
        if (alive) setLanStatus(null);
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [open, contentOnly, activeId]);
  // ★ 2026-09-29（丙档）：「拉取间隔」—— 设备直连这一档的节拍。**默认 5 秒**（owner 拍的）。
  // ⚠️ 写入口只有 `writePullIntervalMs`（它会顺便**广播**，让 App 那条定时器按新节拍重挂）——
  //    与 `setAuto` 同一套纪律：面板不自己碰 localStorage、也不自己算有效间隔。
  const [pullMs, setPullMs] = useState<number>(() => readPullIntervalMs());
  const applyPull = (ms: number) => {
    writePullIntervalMs(ms);
    setPullMs(ms);
  };
  // ⚠️ 只有**当前空间这条档案绑全了**才显示那一行：`lan_status` 没绑定时会回落"第一条绑定"
  //（那是给无参调用兜底的），在面板上显示**别的空间**的地址是错的。
  const activeRow = rows.find((r) => r.ws_id === activeId);
  const lanRowBound = !!activeRow && !!activeRow.server_url.trim() && !!activeRow.space_id.trim();
  // 丙-③-b-2b-2：**网格（对等交换）**那一档的设置面。
  // ⚠️ 三个输入各自独立，保存时按命令面的口径给值（`""` ＝ 清除那一项、`null` ＝ 不动）——
  //   这里**不再自己解释一遍**（两处各解释一次，迟早会有一处说错）。
  // ⚠️ 它的门槛**不是** `lanRowBound`：网格**不需要**服务端地址，只要求这个空间有 `space_id`
  //   （"只开网格、不绑服务端"正是这一档要支持的配置）。
  // ⚠️ 监听地址／配对暗号／口令 那几个 state 与 handler **已抽到 `MeshAdvancedForm`** ✓
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
  const [duNote, setDuNote] = useState("");
  /** 人读的**短码**：只用于"认得出是哪一台" ✓（⛔ 不是安全校验、也不许当密码用 ✗）。 */
  const duCode = (id: string) => {
    let h = 2166136261;
    for (let i = 0; i < id.length; i++) {
      h ^= id.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16).toUpperCase().padStart(8, "0").slice(0, 6);
  };
  // ⚠️ 固定成 `YYYY-MM-DD HH:mm` ✓ —— ⛔ 不用 `toLocaleString()` ✗：
  //    它在中文界面里会渲染成美式的 `9/28/2026, 2:03:00 PM`（实测 ✓），与整屏中文不一致 ✓
  const duWhen = (ms: number) => {
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return "时间读不出";
    const p2 = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
  };
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
      message: "解除后它会拉不动你的内容，想再连要重新配对一次。",
    });
    if (!ok) return;
    setDuBusy(deviceId);
    setDuNote("");
    try {
      const r = await api.deviceUnpair(activeId, deviceId);
      // ⚠️ 别和后端那句重复：`r.note` 自己已经以「已解除这一台：…」开头（实测 ✓）⇒ 这里只说结果与台数 ✓
      setDuNote(
        (r.wasPaired ? "" : "这一台本来就不在名单里。") + `还认 ${r.pairedCount} 台。` + r.note,
      );
      setDuList((prev) => prev.filter((d) => d.deviceId !== deviceId));
    } catch (e) {
      setDuNote(`没解除成：${e instanceof Error ? e.message : String(e)}`);
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
  //   ① 生成：显示比对码（**这一轮显示用** ✓；⚠️ 那段文本／载荷**不是一次性的** ✗ —— 它里面
  //      **没有** nonce／时间戳／有效期 ✓，采纳侧也**幂等**（可以再次采纳 ✓）⇒ ⛔ 别把这句写成"一次性" ✗）
  //   ② **人读码核对**：采纳侧先把**算出来的码**显示出来，**等用户把对方那串填回来** ✓
  //   ③ 采纳：逐位相同才写；**对不上 ⇒ 停在"停"态，且那一态里没有继续入口** ✗（判据钉着）
  const [plaintextCount, setPlaintextCount] = useState<number | null>(null);
  const [dpExport, setDpExport] = useState<DevicePairExportOutcome | null>(null);
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
  const [dpText, setDpText] = useState("");          // 对方给来的码（要采纳的那段）
  const [dpCode, setDpCode] = useState("");          // 用户填回来的**核对过的**码
  const [dpPreview, setDpPreview] = useState<string>(""); // 我们这边算出来的码（给人核对）
  const [dpOutcome, setDpOutcome] = useState<"idle" | "ok" | "stopped">("idle");
  const [dpNote, setDpNote] = useState("");
  const [dpBusy, setDpBusy] = useState(false);
  /**
   * ⭐ **R110（owner 2026-10-02 拍 A）**：**这段码给哪一台**（空 ＝ 不指定 ✓）。
   * ⚠️ 存的是**对方的 `device_id`**（进载荷、也用于本机先登记 ✓）—— 但**屏幕上只显示短码** ✓：
   *    ⛔ 可见文案不出现裸设备号 ✗（`INV-UI-copy-no-internal-ids`，同解除块那套 `duCode` ✓）。
   */
  const [dpPeer, setDpPeer] = useState("");
  const dpGenerate = async () => {
    if (!activeId) { setDpNote("先选一个空间"); return; }
    setDpBusy(true);
    try {
      // ⭐ 选了对面 ⇒ 传它的设备号 **＋ 它的公钥** ✗（本机**生成时就登记它这把钥匙** ⇒
      //    对面采纳一次、两个方向都通 ✓ —— ⭐ 1C 之后"登记"的落点就是**钥匙** ✓）；
      //    没选 ⇒ 不传（那条路照旧：码可离线传、要配两次 ✓）
      //   ⚠️ 点了对面但它**没报身份**（老版本／不在附近）⇒ 后端如实说、这一趟退回两台各配一次 ✓。
      const dpPeerRow = dpPeer ? nearby.find((p) => p.device_id === dpPeer) ?? null : null;
      const r = await api.devicePairExport(activeId, dpPeer || undefined, dpPeerRow?.pubkey || undefined);
      setDpExport(r);
      setDpOutcome("idle");
      setDpNote(r.message);
    } catch (e) {
      setDpNote(`没有生成：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDpBusy(false);
    }
  };
  /** ② 先只**看**：不传码 ⇒ 后端**一个字节都不写**，只把算出来的码回给我们 ✓ */
  const dpPreviewImport = async () => {
    if (!activeId || !dpText.trim()) return;
    setDpBusy(true);
    try {
      const r = await api.devicePairImport({ space_id: activeId, text: dpText.trim() });
      if (r.outcome === "need_confirm") {
        setDpPreview(r.check_code);
        setDpOutcome("idle");
        setDpNote(r.message);
      } else if (r.outcome === "rejected") {
        setDpPreview("");
        setDpOutcome("stopped");   // ⛔ 停态：**没有继续入口**（见下面的渲染 ✓）
        setDpNote(r.message);
      } else {
        setDpOutcome("ok");        // 理论上到不了（不传码不会 ok）—— 到了就是后端坏了，如实显示
        setDpNote(r.message);
      }
    } catch (e) {
      setDpOutcome("stopped");
      setDpNote(`这段配对码没用上：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDpBusy(false);
    }
  };
  /** ③ 采纳：**必须**带上人核对过的那一串 ⇒ 对不上 ⇒ 后端 `rejected`（零写入）✓ */
  const dpAccept = async () => {
    if (!activeId || !dpCode.trim()) return;
    setDpBusy(true);
    try {
      const r = await api.devicePairImport({ space_id: activeId, text: dpText.trim(), confirmed_check_code: dpCode.trim() });
      if (r.outcome === "ok") {
        setDpOutcome("ok");       // 文案红线：成功**只许说「已配对」** ✓
        setDpPreview("");
        setDpNote(r.message);
        setStatus("已配对");
      } else {
        setDpOutcome("stopped");  // ⛔ 对不上 ⇒ 停，而且**不显示继续按钮** ✓
        setDpNote(r.message);
      }
    } catch (e) {
      setDpOutcome("stopped");
      setDpNote(`没有采纳：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDpBusy(false);
    }
  };
  // ⚠️ `disableMesh` **已抽到 `MeshAdvancedForm`** ✓（Round 1 纯抽取 ✓）—— 那条命令仍在原来那一处调用 ✓：
  //    `api.meshSetConfig(activeId, "", null)`（`""` ＝ 清除监听地址 ⇒ 网格关掉 ✓，判据 ③ 钉着 ✓）。
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
  const [pendingTotal, setPendingTotal] = useState(0);

  /** 读待取回清单（面板打开 / 每次同步 / 每次裁决之后）。失败不打扰用户：它只是提示面。 */
  const loadPendingRemote = async () => {
    try {
      const q = await api.listPendingRemotePages(20);
      setPending((q?.pages ?? []) as { page_id: string; title: string; seq: number }[]);
      // ★ 角标那个数字**公布给单例**（`lib/pendingRemoteBadge.ts`）：它与这里的清单读的是
      //   **同一张表**，公布进去就省掉一次读，而且两处永远是同一个数（不会"角标说有、清单没有"）。
      publishPendingRemoteTotal(Number(q?.total ?? 0));
    } catch {
      setPending([]);
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
    if (open) {
      void refresh();
      // C1/C2 的设备级设置与网络类型（与 profile 列表分开读：它们失败也不该让面板空白）。
      void refreshBudget();
    }
    // 打开面板 / 切换活动空间 / 空间列表变化时，都刷新到当前活动空间。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activeId, spaces]);

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
  const heroBound = !!activeRow && !!activeRow.server_url.trim() && !!activeRow.space_id.trim();
  // ⭐ 当前空间是个人空间吗？⚠️ `rows` 只有**当前活动空间**那一行（见 refresh 里的 ids）
  //   ⇒ ⭐「服务器那一段一行都没有」就等于「当前不是团队空间」✓（取不到 kind 时兜底当团队 ✓）。
  //   ⚠️ 必须定义在这里 —— 下面的 `heroState` / `heroRoute` 都要用它（放后面会「used before declaration」）。
  const isPersonalActive = serverRows.length === 0;
  // ⚠️ **2026-10-04 改**（owner：「个人空间不显示登录状态文案信息」）：
  //   ⭐ 个人空间**不经过服务器** ⇒ ⭐ 不该说「还没绑同步」✗（那是服务器口径的提醒 ✓）；
  //   ⭐ 它该说的是自己那条路：**附近设备直连** ✓。
  const heroState = syncing
    ? "正在同步"
    : lastSync
      ? lastSync.ok
        ? "已同步"
        : "上次同步没成功"
      : isPersonalActive
        ? "附近设备直连"
        : heroBound
          ? "还没同步过"
          : "还没绑同步";
  const heroDot = syncing ? " is-busy" : lastSync && lastSync.ok ? " is-ok" : "";
  const heroSub = [
    activeRow?.name ?? "",
    lastSync ? relTime(lastSync.at) : "",
    todayItems > 0 ? `今天同步了 ${todayItems} 项` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const heroRoute =
    lanStatus?.kind === "lan"
      ? lanStatus.peers === 0
        ? // ★ 2026-09-29（owner 裁定「修」）：与摘要**同一口径** ——
          //   一个对端都没发现时**不说"本网段 0 台可用"**（那会被读成"没有"），
          //   ⚠️ 2026-10-01：这里的用词已按 `lan.rs` 现口径改成「附近发现」✓ —— 上面这句保留当时的说法 ✓
          //   而真相是"还没找到"（看不见 ≠ 不存在，规格 §12.1 ／ 需求 §4.4）。
          "这一轮走的是：设备直连 · 正在找附近的设备…"
        : `这一轮走的是：设备直连 · ${lanStatus.peers} 台可用`
      : lanStatus?.kind === "configured"
        ? "这一轮走的是：服务器"
        // ⚠️ **2026-10-04 改**：⭐ 个人空间不说「还没绑同步」✗（那是叫他去绑服务器 ✓），
        //   而是如实说它自己这条路：**附近设备直连** ✓。
        : isPersonalActive
          ? "这一轮走的是：附近设备直连（个人空间不经过服务器）"
          : "这一轮走的是：还没绑同步";
  // ── ★ 2026-09-29（IA）：分组 ＋ 每行一个可展开项 —— 每行右边那个【摘要值】────────
  // 口径：**每一行的值都由真实读数算出来**（写死就是在骗人），且尽量复用既有 <option> /
  //       既有小标题的词 —— 本笔不动任何一句既有文案。
  //
  // 只在 Wi-Fi 下同步：默认值与下面那颗复选框**同一处口径**（`?? true`），
  // 否则会出现"行上写关、点开复选框却是开的"。
  const wifiText = (budget?.wifi_only ?? true) ? "开" : "关";
  // 服务器：owner 明确「未绑定时显示『未绑定』」（不是空白，也不是占位 URL）。
  const serverText = activeRow?.server_url.trim() || "未绑定";
  // 设备直连：`lanStatus.mesh` 的两个布尔 → 三态（读不到 `lanStatus` 时这一行本来就不渲染）。
  // ★ 2026-09-29（owner 裁定 §9.1）：这一块现在的名字是「设备直连」——**沿用既有读数行
  //   `.sync-lan` 的措辞**（"设备直连（同一网络）"），不新造词。⚠️ 面板底部那条 `.sync-lan`
  //   是**另一条路**（走中枢），两条都叫"局域网…"是历史命名，**本档不合并它们**（规格 §9.1）。
  // ⚠️ 摘要值改成 **开／关**（照效果图那一行）：它现在是一个**开关**行，而"口令设没设"在它
  //    展开后的行体里照样写着一遍（不在两处说同一件事的两半）。
  const meshText = !lanStatus?.mesh.enabled
    ? "关"
    : lanStatus.mesh.tokenSet
      ? "开"
      : "开 · 口令未设";
  // ★ 2026-09-29（规格 §9.2／§9.3）：**总闸优先** ——
  //   · 总闸（「同步方式」）＝ 关闭 ⇒ 设备直连那一行**灰掉**（它是开关；总闸关了它不可能生效），
  //     而「拉取间隔」与「附近设备」**都不出现**（父项已灰 ⇒ 子项不显示）；
  //   · 设备直连 = 关 ⇒ 「拉取间隔」这一行**不出现**（不是灰掉 —— 关了就没有间隔可谈），
  //     「附近设备」也不显示（**没开就不会去发现**）。
  //   ⇒ 两句话都收在这一个布尔里（**一处判定**，免得两处各判一半）。
  const lanDirectOn = !!lanStatus?.mesh.enabled && syncMode !== "off";
  const totalOff = syncMode === "off";
  // 附近设备那一块要的读数（**列表只有一处来源**：`lanStatus.nearby`，与 `peers` 同一次读数）。
  // ⚠️ `Array.isArray` 那一层是给**老 Rust 构建**留的：读数里没有这一项时，界面说"看不到这一层"，
  //    **不许**把"读不到列表"渲染成"网段里没人"（空数组与"不可用"长得一样、含义相反）。
  const nearbyReadable = Array.isArray(lanStatus?.nearby);
  const nearby = lanStatus?.nearby ?? [];
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
  /**
   * ★ 2026-09-29（规格 §12.1）：「附近设备」那一行的**摘要**（默认折叠 ＝ 只显示这一格）。
   *
   * 四态一处判定（**不要再在别处各判一半**）：
   *   · 这一层读不到（老 Rust 构建）／局域网那条没开 ⇒ 如实说「看不到这一层」——
   *     **不是**"网段里没人"（空数组与"不可用"长得一样、含义相反）；
   *   · 开着但一台都没发现 ⇒ 「**正在找…**」——⚠️ **永不**说"0 台"：
   *     那会被读成"没有设备"，而真相是"还没找到"（看不见 ≠ 不存在，需求 §4.4）；
   *   · 发现了 N 台 ⇒ 「**N 台**」。
   */
  const nearbySummary =
    !nearbyReadable || !lanStatus?.enabled
      ? "看不到这一层"
      : nearby.length === 0
        ? "正在找…"
        : `${nearby.length} 台`;
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
  // ⭐⭐ 2026-10-11（任务 B）：⭐ **读"信任走到哪一步"** ✗ —— 打开这一屏时读一次 ✓、点过之后**再读一次** ✓
  //    （⛔ 先前只靠一句 toast 说"已信任" ✗ —— 那既不是读数、也**读不回来** ✓）。
  //    ⚠️ 初始值如实写"还没读过" ✗：⛔ 不许拿 `idle`（"还没开始"）当默认 ✗ —— 那是一**个结论** ✓
  //      （与那四条读数同一条口径：⛔ 读不到 ≠ 没有 ✓）。
  const [trustState, setTrustState] = useState<Reading<TrustStateReading>>({
    kind: "unavailable",
    reason: "还没读过（打开这一屏时会读一次）",
  });
  const refreshTrustState = useCallback(async () => {
    if (!isDesktopPlatform()) {
      // ⛔ 不假装"还没开始" ✗ —— 这一层是桌面才有的（发现层在 Rust 侧 ✓）。
      setTrustState({
        kind: "unavailable",
        reason: "信任这件事只在桌面端（发现层是桌面才有的那一层）",
      });
      return;
    }
    setTrustState(await readTrustState((cmd) => platform.executor.invoke(cmd as "mesh_trust_state")));
  }, []);
  useEffect(() => {
    if (!open) return;
    void refreshTrustState();
  }, [open, refreshTrustState]);
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
      // ⭐ 文案说的是**方向** ✗（⛔ 不声称"双向已通" ✗ —— 那要对面也点一次 ✓）
      toast("已允许这台设备来拿你的内容（要双向，得它那边也点一次）", "success");
      // ⭐ 2026-10-11（任务 B）：⭐ 点完之后**再读一次后端那一格** ✗ —— 界面上要说的是**读数** ✓，
      //    ⛔ 不是一句 toast（它下一秒就没了，而"通了没有"要一直看得见 ✓）。
      await refreshTrustState();
    } catch (e) {
      // ⭐ 失败**照实报**（⛔ 不假装成功 ✗）—— 这一条失败时**也要**把读数刷一遍 ✓
      //    （多半还是"还没开始" ✓ —— 那正是**如实**✓）。
      await refreshTrustState();
      toast(`信任失败：${e}`, "error");
    }
  };
  const [strictTrust, setStrictTrust] = useState(false); // 图④ 严格模式（默认**关** ✓）

  // 空间隐私：`SpacePrivacySection` 那一份读数（`space_security_overview`）**没有上抛**给外面，
  // 本面板不替它再问一次（问了就是第二份真相，两份迟早各说各话）⇒ 这里只放一句中性摘要，
  // 用词取自它自己的小标题（`🔐 空间隐私 —— 每个空间能不能绑同步`），不编状态。
  const privacyText = activeRow ? "每个空间能不能绑同步" : "还没有可配置的空间";
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
        <CloudSyncIcon width={14} height={14} />
        <span>同步</span>
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
              <button className="sync-btn" data-testid="plaintext-go-encrypt">去开加密</button>
            </div>
          )}
          <header className="sync-head">
            <div className="sync-head-text">
              <div className="sync-title">设备直连</div>
              {/* ⭐ 2026-10-11（owner：「参照效果图实现」）：⭐ 副标题按效果图改写 ✓ ——
                  原文是「⭐ 填一个配对暗号就能和附近的设备直连 ✗」⇒ ⭐ 那句把"⭐ 码 ✗"摆在了**这一屏最显眼的位置** ✓。
                  ⚠️ 新句**不改事实** ✗：⭐ 今天建信任那一步**仍然**要那串码 ✓（⭐ 见文件头的拍板口径 ✓）⇒
                     ⭐ 所以只说"⭐ 建立信任之后 ✗" ✓，⛔ **不说**"⭐ 不用码 ✗"（⭐ 那要等新拍板 ✓）。 */}
              <div className="sync-subtitle">{isPersonalActive ? "同一个 Wi-Fi 自动发现：配对一次之后，不用再点任何东西" : "每个空间各自绑定服务器与组织空间"}</div>

          {/* ⭐ **刀十五①（2026-10-14，owner：按设计图）** ✗：⭐ **绿色状态条** ✓ —— 副标题之后、三段设备之前 ✓。
              ⭐ 三个值全来自**真读数** ✓（⛔ 一个都没写死 ✗）：地址／端口 ← `lanStatus.mesh.bind` ✓（经 `splitMeshBind` ✓）；
              ⭐ 报出去的地址 ← `lanStatus.mesh.note`（⭐ Rust 侧原文 ✓）；⭐「已配对」← `duList`（本机认过的名单 ✓）、
              ⭐「在线」← `lanStatus.enabled`（发现层开着 ✓）、⭐「同步中／自动同步中」← `syncing` ✓。
              ⚠️ ⭐ 本轮**不动**那张大卡 ✗ —— ⭐「立即同步」那颗按钮还在它里面 ✓（⭐ 移按钮是下一刀的事 ✓）。 */}
          <div className="sync-hero-state">
            <span className={`sync-hero-dot${heroDot}`} aria-hidden />
            <span>{heroState}</span>
          </div>
          <div className="sync-hero-sub">
            监听地址 {splitMeshBind(lanStatus?.mesh?.bind ?? "").addr || "未读到"}（自动）· 端口 {splitMeshBind(lanStatus?.mesh?.bind ?? "").port || "未读到"}（默认）· 报出去的是 {lanStatus?.mesh?.note || "未读到"}
            {heroSub && <span> · {heroSub}</span>}
            {heroRoute && <span> · {heroRoute}</span>}
          </div>
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

          {!isDesktopPlatform() && (
            <div className="sync-web-note">建议使用桌面版以获得稳定多设备同步；Web 版同步受浏览器环境限制。</div>
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
          {/* 隐私边界 ②b（2026-09-24）：**这个空间敢不敢绑同步**（分类 ＋ 加密 ＋ 闸门裁决）。
              ⚠️ 放在这一屏是因为闸门拦的正是「绑同步」这个动作（`sync::sync_bind_gate`）——
              读数与动作同屏，用户不用去别处找「为什么绑不上」。
              平台判定在组件内部（Web 上只渲染解释句、一次 api 都不调）。 */}

          {!nearbyReadable || !lanStatus.enabled ? (
            <div className="sync-hint">附近的设备：这台机器上看不到这一层</div>
          ) : nearby.length === 0 ? (
            // ⭐⭐ **片 D1a-1（2026-10-14，owner 图）** ✗：⭐ **0 台时三段标题也要在** ✓
            //   （⭐ 原来这一支只给一句灰字 ✓ ⇒ ⭐ 用户看不到「分三段」这件事 ✗）。
            //   ⚠️ ⭐ 每段底下一行**实话** ✓（⛔ 不编数字 ✗ —— 仓规「读不到 ≠ 0」同族 ✓）；
            //   ⭐ 原来那句「还没发现别的设备… 正在找」**保留** ✓，⭐ 降级成三段**之外**的总说明 ✓。
            //   ⚠️ ⭐ testid 写**字面** ✓（⭐ 判据要能在这一支里逐字找到它 ✓），
            //   ⭐ 而**文案取自** `NEARBY_GROUPS` ✓（⭐ 单一来源 ⇒ ⛔ 不会与上面那份漂开 ✗）。
            <>
              <div className="sync-hint">还没发现别的设备… 正在找</div>
              <div className="sync-hint" data-testid="nearby-group-keychanged">
                {NEARBY_GROUPS[0].label} · {nearby.filter((q) => nearbyBucket(q) === 0).length} 台
              </div>
              <div className="sync-hint sync-empty-state" style={{ paddingLeft: 12 }}>这一轮没找到这一段的设备</div>
              <div className="sync-hint" data-testid="nearby-group-trusted">
                {NEARBY_GROUPS[1].label} · {nearby.filter((q) => nearbyBucket(q) === 1).length} 台
              </div>
              <div className="sync-hint sync-empty-state" style={{ paddingLeft: 12 }}>这一轮没找到这一段的设备</div>
              <div className="sync-hint" data-testid="nearby-group-pending">
                {NEARBY_GROUPS[2].label} · {nearby.filter((q) => nearbyBucket(q) === 2).length} 台
              </div>
              <div className="sync-hint sync-empty-state" style={{ paddingLeft: 12 }}>这一轮没找到这一段的设备</div>
            </>
          ) : (
            nearby
              .slice()
              // ⚠️ 排序键与分段键**同一个**（`nearbyBucket` ✓）⇒ 两处不可能各说各话 ✓
              .sort((a, b) => nearbyBucket(a) - nearbyBucket(b))
              .map((p, i, arr) => (
                <Fragment key={p.device_id}>
                  {(i === 0 || nearbyBucket(p) !== nearbyBucket(arr[i - 1])) && (
                    <div
                      className="sync-hint"
                      data-testid={NEARBY_GROUPS[nearbyBucket(p)].testid}
                    >
                      {NEARBY_GROUPS[nearbyBucket(p)].label} · {nearby.filter((q) => nearbyBucket(q) === nearbyBucket(p)).length} 台
                    </div>
                  )}
              <div className="sync-nearby-row">
                {/* 名字空的 ⇒ **如实说没报名字**，不许回落成 id 前几位
                    （`INV-UI-copy-no-internal-ids`；`lan_state.rs` 的 `host_name()` 拿不到就留空）。 */}
                <span className="sync-nearby-name">{p.device_name || "这台设备没报名字"}</span>
                {/* ⭐ 2026-10-11（owner：「参照效果图实现」）：⭐ 效果图第 ④ 屏「信任该设备」＋
                    规格 **J21**「信任前必须展示对方的身份（设备名 ＋ 短标识）」✗ ⇒
                    ⭐ 这一行**就是"信任前"看得见它的地方** ✓ ⇒ ⭐ 补上短标识 ✓。
                    ⚠️ 走 `peerIdentityLine` ✓（⭐ 它的**唯一实现** ✓）—— ⭐ 它结构上拿不到 `device_id` ✓
                       ⇒ ⭐ 不可能回落成设备号 ✓；⭐ 老对端没报短标识时它**如实说**「对方没报短标识」✓
                       （⭐ 那不是降级处理，⭐ 是那段过渡期的正确答案 ✓）。 */}
                <span className="sync-hint">{peerIdentityLine(p.device_name, p.short_id)}</span>
                <span className="sync-hint">{nearbySecondColumn(p)}</span>
                {/* ⭐ **P-B（2026-10-13）**：把**原因**说全 ✗ —— ⛔ 这两种处境原先都长得像
                    "对端没服务我" ✗（真正的原因在**我们这一侧** ✓）：
                    · 没设配对暗号 ⇒ ⭐ 说"本机这个空间还没设暗号" ✓（⛔ **值**一个字符都不出现 ✗）；
                    · 对端那个空间在本机已删 ⇒ ⭐ 说"已删" ✓（⛔ 过滤有意不动 ✗ —— 只是说出来 ✓）。 */}
                {p.serves_reason === "no_secret" && (
                  <span className="sync-hint" data-testid="nearby-no-secret">
                    本机这个空间还没设配对暗号 —— 没设之前认不出它在服务谁（团队空间则是还没绑组织空间）
                  </span>
                )}
                {p.serves_reason === "space_deleted" && (
                  <span className="sync-hint" data-testid="nearby-space-deleted">
                    它服务的那个空间在本机已删 —— 删了就不再直连它；要接着同步得先把那个空间放回来
                  </span>
                )}
                {!p.invitable && p.serves_current && (
                  // 看得见但拉不到：**如实说为什么**（口径与 `mesh::invitable_base` 同一把尺）。
                  <span className="sync-hint">它没报可以直连的地址</span>
                )}
                {/* ⭐ 效果图那一行的右端：⭐ 「已配对」／⭐ 「配对」✗。
                    ⚠️ 「已配对」的判据取**本机认过的那份名单**（`duList` ✓，⭐ 与下面「解除」那块
                       **同一个源** ✓）—— ⛔ 不自己再算一遍"算不算配上了" ✓（⭐ 两份真相迟早各说各话 ✓）。
                    ⚠️⭐ 「信任这台设备」这一下**今天真做的是**：⭐ 把这一台**指定为这次配对的对端** ✓
                       （⭐ 复用手边那条「生成投放码 ⇒ 采纳」的路 ✓，⭐ `dpPeer` 就是那个格 ✓）。
                       ⇒ ⭐ 所以这里**不写**"点一下就通" ✗ —— ⭐ 那句话要等一键握手做出来才算真 ✓
                          （⛔ 不说假话 ✓，⭐ 本仓最忌这个 ✓）。 */}
                {p.key_changed === true && p.serves_current ? (
                  // ⭐ **P-3d（2026-10-13）**：⭐ 钥匙变了 ⇒ 这一行的主动作是**重新配对** ✓
                  //   （⭐ 复用「接入」那条主路径 ✓：`trustDevice` ⇒ `mesh_trust_begin` ⇒
                  //   把**新的**那把公钥登记上 ✓ —— ⛔ 不改任何判定语义 ✗，判定仍是 `serves_current` ✓）。
                  //   ⚠️ 它**不服务当前空间**时 ⇒ 落回下面那句「它服务的是别的空间」✓
                  //   （⭐ 不在这儿硬塞一颗会动错空间的按钮 ✗）。
                  <button
                    className="sync-btn"
                    disabled={dpBusy}
                    data-testid="nearby-repair"
                    onClick={() => {
                      if (!activeId) return;
                      setDpPeer(p.device_id);
                      void trustDevice([activeId], p);
                    }}
                  >
                    重新配对
                  </button>
                ) : duList.some((d) => d.deviceId === p.device_id) ? (
                  <>
                    <span className="sync-hint" data-testid="nearby-paired">
                      已配对
                    </span>
                    {/* ⭐⭐ **片 D1b（2026-10-14，owner：「缺撤销配对的按钮」）** ✗：
                        ⭐ 这台**已经信任** ✓ ⇒ ⭐ 就在它旁边给一颗「撤销配对」✓
                        （⭐ 未配对的那几支**不显示** ✓）。
                        ⚠️ ⭐ 它**复用**既有那个 handler（`duUnpair` ✓）⇒ ⭐ **二次确认**
                        （`confirmDialog` ✓，⭐ 文案含「重新配对」✓）与 ⭐ `api.deviceUnpair`
                        **都不新增** ✓（⛔ 不写第二套 invoke ✗）；⭐ 样式用**行内** ✓（⛔ 不动样式表 ✗）。 */}
                                  {/* ⭐ 刀十七①：⭐「已信任」每一台上给一颗**立即同步** ✓ —— ⭐ 复用大卡那颗**同一条**动作（`syncOne(activeRow)` ✓，
                                      ⚠️ ⭐ 如实注明：⭐ 它按**空间**同步 ✗（⭐ 与那颗逐字同形 ✓），⛔ 不是「按那台设备」✗；
                                      ⭐ 忙态同一条：⭐ `syncing || !activeRow` ✓；⛔ 不造新参数／不加 Rust 命令 ✗。 */}
                                  <button
                                    className="sync-btn"
                                    data-testid="nearby-sync"
                                    disabled={syncing || !activeRow}
                                    onClick={() => activeRow && void syncOne(activeRow)}
                                    style={{ marginLeft: 8 }}
                                  >
                                    立即同步
                                  </button>
                    <button
                      className="sync-btn"
                      data-testid="nearby-unpair"
                      disabled={duBusy === p.device_id}
                      onClick={() => void duUnpair(p.device_id)}
                      style={{ marginLeft: 8 }}
                    >
                      撤销配对
                    </button>
                  </>
                ) : p.serves_current ? (
                  // ⭐ **修 B（2026-10-13，Lead 拍板 ＋ owner 实测「点不了」）**：
                  //   ⭐ 这一行**自己**就是「允许」的入口 ✗ —— 走 `trustDevice`（⇒ `mesh_trust_begin` ✓），
                  //   ⛔ **不经勾选**（`pickedCount`）✗；⛔ 也不再只 `setDpPeer`（那是"指定投放码对端"，
                  //   点完屏幕上**什么都不变** ⇒ 用户读到的就是"点了没反应" ✓ —— 那正是这一单的词）。
                  //   ⚠️ 顺带**保留** `setDpPeer`：下面「严格模式（高级）」那条抄码路照旧预选这一台 ✓（老行为不丢 ✓）。
                  //   ⚠️ 没有活动空间 ⇒ **一个字节都不动** ✓（⛔ 不拿空串／编一个 spaceId 去调 ✗）。
                  <button
                    className="sync-btn"
                    disabled={dpBusy}
                    data-testid="nearby-allow"
                    onClick={() => {
                      if (!activeId) return;
                      // ⭐ **P-4 片②b（2026-10-13）**：⭐ **时点挪走了** ✗ ——
                      //   `setDpPeer(p.device_id)` ＋ `void trustDevice([activeId], p)`
                      //   这两步**逐字搬进**「码对得上，确认」那个处理里 ✓（⭐ 命令／参数／
                      //   返回值处理一字未改 ✓）；⭐ 这一下现在**只**记下这一台 ＋ 打开那一屏 ✓
                      //   ⇒ ⭐ 人**没确认**之前，⭐ 一个字节都不发 ✓。
                      setPairPeer(p);
                      setPairScreen(true);
                      // ⭐ **P-4 片③**：⭐ 就在这一下里取真读数 ✓（⛔ 不用 effect ✗）
                      void fetchPairCode(p);
                    }}
                  >
                    接入
                  </button>
                ) : (
                  // ⛔ **不许再静默 `null`** ✗（owner 截图那一行正是这一档 ✓ —— 屏幕上连一个
                  //   可点的东西都没有，就是"点不了"的**直接原因** ✓）。
                  //   ⚠️ 也不许写成"网段里没人"／"这一层看不到" ✗ —— 它**看得见、只是服务别的空间** ✓
                  //   （判据 `SyncPanel.trustDevicePanel.wiring.test.tsx` 第 5 条钉这句 ✓）。
                  <span className="sync-hint" data-testid="nearby-other-space">
                    它服务的是别的空间 —— 要在那个空间里点「接入」才动得了它（这一行不动它）
                  </span>
                )}
              </div>
                </Fragment>
            ))
          )}
          <div className={`sync-profiles${isDesktopPlatform() ? "" : " is-disabled"}`}>
            {/* 刀二（2026-10-14）：浅那层（「已自动填好」的设置）⇒ 收进一个折叠 ✓ */}
            <details className="sync-advanced">
              <summary>高级（已自动填好，一般不用动）</summary>
                  {/* 刀十四②：⭐ 图上「高级」里就两行只读读数 ✓ —— ⭐ 数据取自真读数 `lanStatus.mesh.bind`（⭐ 按最后一个 `:` 拆成地址／端口 ✓，⛔ 不写死 ✗）。 */}
                  <div className="sync-row">
                    <span className="sync-row-label">监听地址</span>
                    <span className="sync-row-value">
                      {(lanStatus?.mesh?.bind ?? "").includes(":") ? (lanStatus?.mesh?.bind ?? "").slice(0, (lanStatus?.mesh?.bind ?? "").lastIndexOf(":")) + " · 自动" : (lanStatus?.mesh?.bind ?? "") || "未读到"}
                    </span>
                  </div>
                  <div className="sync-row">
                    <span className="sync-row-label">端口</span>
                    <span className="sync-row-value">
                      {(lanStatus?.mesh?.bind ?? "").includes(":") ? (lanStatus?.mesh?.bind ?? "").slice((lanStatus?.mesh?.bind ?? "").lastIndexOf(":") + 1) + " · 默认" : "未读到"}
                    </span>
                  </div>
            <div className="sync-group">
              <div className="sync-group-title">设置</div>

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
            </details>
          </div>

          {/* ⚠️ 2026-09-29（IA）：【进阶】这一组是 `.sync-profiles` 的**兄弟**，不是孩子 ——
              `SpacePrivacySection` 不能进 `.sync-profiles`（Web 档那一层带 `is-disabled`：
              `opacity:.45 ＋ pointer-events:none` ⇒ 搬进去就是「变灰且点不动」，
              见 `.sync-profiles.is-disabled` 的注释与 D5 修正② 那条现场）。 */}
          <div className="sync-group is-advanced">

            {/* ⑤ 空间隐私 ← 原来的 `<SpacePrivacySection>`（组件本身一个字没改） */}

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

            {/* ④ 设备直连 ← 原来的 `.sync-att.sync-mesh`（名字照 owner 裁定 §9.1 改，别的没动）
                （门槛一个字没改：网格不需要服务端地址，只要这个空间有 `space_id`）
                ★ 2026-09-29（§9.2）：**总闸＝关闭 ⇒ 这一行灰掉**（它是开关；总闸关了它不可能生效）。
                   灰是"不能点"，**不是"藏起来"** —— 用户要看得到"它停着"这件事（上面那个黄框在说为什么）。 */}
            {/* ⚠️ **2026-10-04 改**（owner：「要显示设备直连的条目」）：⭐ 门槛去掉 `space_id` ✗ ——
                原来要求 `!!activeRow?.space_id.trim()` ✓，而 ⭐ 个人空间**永远拿不到** `space_id`
                （今天 `set_sync_profile` 装了真拦：只有团队空间能绑服务器 ✓）
                ⇒ ⭐ 个人空间的「设备直连」**永远不显示** ✗ —— 而那正是它唯一的远程路径 ✓。
                ⚠️ 原顾虑「会显示**别的空间**的地址」已不成立：`api.lanStatus(activeId)` 是**按空间查**的
                （Rust `lan_status(db, workspace_id)` ✓）。 */}
            {/* ⚠️⭐ **2026-10-14（owner 连问三次「同步面板还是旧的」⇒ 真因就是这一行）** ✗ ——
                ⭐ 上面把 `space_id` 那条门槛去掉了 ✓，⛔ **但 `!!activeRow` 还留着** ✗，
                ⭐ ⭐ 而**个人空间根本没有同步档案行** ⇒ `activeRow` 为空 ⇒ ⭐ **整折不渲染** ✗：
                ⭐ 刚从设置搬进来的那三格（`MeshAdvancedForm` ✓）、⭐ 说明句、⭐ 这一折**全都看不见** ✓。
                ⇒ ⭐ 这才是"⭐ 代码改了、⭐ 界面一个字没变" ✓ 的机械原因 ✓（⛔ 不是没做 ✗、⛔ 不是旧产物 ✗）。
                ⇒ ⭐ 修法：⭐ 个人空间（`isPersonalActive` ✓ —— 它**本来**就该走设备直连这条路 ✓）也放行 ✓；
                   ⭐ 团队空间仍按原口径要求 `activeRow` ✓。⭐ 同一门槛的另一处（`附近发现/地址` 那一行 ✓）一起改 ✓。
                ⚠️ 本块只用 `lanStatus`／`syncMode`（`meshText:1195`／`totalOff:1207` ✓）⇒ ⛔ 去掉门槛不会读到空对象 ✓。
                ⚠️ ⭐ 判据面：⭐ 夹具停在别的档位 ⇒ 这条 **DOM 级测不到** ✗ ⇒ 本笔靠**真窗口 CDP 读数**收口 ✓
                （⭐ 逐字：⭐ `details` 只有「同步方式／空间隐私」⇒ 改后应多出「设备直连」✓），⛔ 不假称有单测覆盖 ✗。 */}
            {isDesktopPlatform() && lanStatus && (!!activeRow || isPersonalActive) && (
              <>

                {/* ⑤ 「拉取间隔」——**上一行的子项**（缩进 ＋ 竖线，见 `.sync-row.is-child`）。
                    ★ 规格 §9.3：「设备直连 = 关」⇒ 这一行**不出现**（不是灰掉 ——
                      关了就没有间隔可谈；灰掉会暗示"还能开、只是暂时不能点"）。
                    ★ 规格 §9.2：总闸关闭 ⇒ 父项已灰 ⇒ 子项同样不显示（两者都收在 `lanDirectOn` 里）。 */}
                {/* 片 D1e-4（2026-10-14，owner 拍）：深一层的那些 ⇒ 另一个折叠 ✓（⭐ 只包拉取间隔那一块 ✓）*/}
            {isDesktopPlatform() && lanStatus && (!!activeRow || isPersonalActive) && (
              <div className="sync-att sync-lan" title="附近自动找到这个空间的中枢时，同步就走设备直连地址（不经服务器）">
                <span className="sync-att-text">
                  {/* 标题只按 `kind` 换（那一档来自 Rust 的 Route）；**不**按地址形状自己判。 */}
                  <span className="sync-att-name">
                    {lanStatus.kind === "lan" ? "设备直连（同一网络）" : "设备直连"}
                  </span>
                  <span className="sync-hint">
                    {/* ⚠️ 2026-09-29（D3）：这一行【拼了 Rust 来的文案】（`lanStatus.line` 与 `mesh.note`），
                        而后端是按行内 Markdown 写的（`mesh.rs:602` 那句就是 `**能被别人拉到**`）
                        ⇒ 在【渲染边界】过 `inlineMd`。这正是契约推荐的方向：Rust 侧一个字不改。 */}
                    {inlineMd([lanRowBound ? lanStatus.line : "", lanStatus.mesh.note].filter(Boolean).join(" ｜ "))}
                  </span>
                  {/* ★ 2026-10-01（免费版上线实测）：**"附近发现 0 台"是第一现场** ✓ ——
                      原先这一块只给读数、不给"然后呢" ✗ ⇒ 用户会以为产品坏了 ✓。
                      ⚠️ **2026-10-11 改（owner 拍「只动前端」）**：这句话原先**故意常显** ✓
                      （当时注释写着"代价是多一行字"✓）⇒ 现在按设计图⑦ 收成**只在真的找不到时出现** ✗：
                      ⭐ 条件用 ⭐ **结构化的 `lanStatus.peers === 0`** ✗ —— ⛔ **不**去解析 `lanStatus.line` ✗
                      （那是上面钉着的口径：⭐ 界面不自己按读数再判一次档 ✓；`peers` 与状态行那个
                      "N 台"**是同一个数** ✓，⭐ 由 `INV-NEARBY-one-source` 保证不漂 ✓）。
                      ⛔ 不写"一定能修好"那种话 ✗ —— 只列**最可能的两个**原因 ＋ 指向完整指引 ✓。 */}
                  {lanStatus.peers === 0 && (
                    <span className="sync-hint">
                      {inlineMd("两台要在**同一个网络**、且这个网络没开「**AP 隔离／客户端隔离**」（最快的验证：**开手机热点**再试）。")}
                    </span>
                  )}
                </span>
              </div>
            )}
            <details className="sync-row">
              <summary>
                <span className="sync-row-label">空间隐私</span>
                <span className="sync-row-value">{privacyText}</span>
                <span className="sync-row-caret" aria-hidden>›</span>
              </summary>
              <div className="sync-row-body">
                <SpacePrivacySection nameOf={(id) => spaces.find((s) => s.id === id)?.name ?? id} />
              </div>
            </details>
                  <RelayStatusSection />
                <details className={`sync-row${totalOff ? " is-off" : ""}`}>
                  <summary>
                    <span className="sync-row-label">设备直连</span>
                    <span className="sync-row-value">{meshText}</span>
                    <span className="sync-row-caret" aria-hidden>›</span>
                  </summary>
                  <div className="sync-row-body">
                    {/* ⭐⭐ **片 B（2026-10-14，owner「完成同步面板」）** ✗：⭐ 设备直连那三格**也**在这里 ✓
                        —— ⭐ 与上面那段「连不上时去哪看」是**一家人** ✓（⭐ 这段是「怎么让它连上」✓）。
                        ⚠️ ⭐ 空串 ＝ **设备级** ✓（⭐ 后端 `DEVICE_LEVEL_SPACE` ✓，⛔ 别改成 `null` ✗：
                        `mesh_set_config` 里那句 `.filter(|w| !w.trim().is_empty())` 会不一样 ✓）。 */}
                    <p>
                      ⭐ 这里是「这台设备」的设备直连设置 ✗：填一次，「所有个人空间共用」 ✓
                      （⛔ 团队空间不受影响 —— 它们各自按空间来 ✓）。
                    </p>
                    {lanStatus ? (
                      <MeshAdvancedForm
                        activeId=""
                        lanStatus={lanStatus}
                        onStatus={setStatus}
                        onMeshChanged={(mesh) => setLanStatus((prev) => (prev ? { ...prev, mesh } : prev))}
                      />
                    ) : (
                      <p>正在读取本机的设备直连设置…</p>
                    )}
                    {/* ⭐ **2026-10-14**：⭐ 那三格（监听地址／配对暗号／自动开启）**已回到面板** ✓ ——
                        「设置 · 同步」那一页**已经去掉** ✗（`SyncSettingsPane.tsx` 已删 ✓）⇒ ⭐ **面板是唯一去处** ✓。
                        ⚠️ 旧注释说"它们跟着 `MeshAdvancedForm` 去了设置面"是**旧口径** ✗，已改 ✓。
                        ⭐ 判据里的**四条承诺一条没删** ✓ —— `syncPanelMesh.wiring` 的 ③⑨ 本来就是「两个文件一起读」✓。 */}
                    {/* ⚠️⭐ **2026-10-14（片 B 之后的收尾）** ✗：⭐ 上一版这句写着
                        「这一折现在只报读数。要改地址／配对暗号／口令，去 **设置 · 同步**」✓ ——
                        ⭐ ⭐ **现在两句都错了** ✗：⭐ ① 它**不再只报读数** ✓（上面那三格直接可改 ✓）；
                        ⭐ ② 「设置 · 同步」那一页**已经被删掉** ✗（`SyncSettingsPane.tsx` 已删 ✓）
                        ⇒ ⭐ 按旧句去设置里找，⭐ **找不到** ✓。⭐ 这条是 owner 说"还是旧面板"时
                        顺手核出来的**真过时文案** ✓ —— ⛔ 不是视觉问题 ✗。 */}
                    <div className="sync-hint">
                      上面那三格现在<b>直接可改</b> ✓ —— 改的就是<b>这台设备</b>的一份设置，
                      填一次，<b>所有个人空间共用</b>（⛔ 团队空间不受影响）。
                      ⚠️ 旧提示里的「去 <b>设置 · 同步</b>」已经失效：那一页<b>已经去掉</b>了。
                    </div>
                  </div>
                </details>
                {lanDirectOn && (
                  <details className="sync-row is-child">
                    <summary>
                      <span className="sync-row-label">拉取间隔</span>
                      <span className="sync-row-value">{pullIntervalLabel(pullMs)}</span>
                      <span className="sync-row-caret" aria-hidden>›</span>
                    </summary>
                    <div className="sync-row-body">
                      <div className="sync-auto">
                        <select
                          className="sync-input"
                          value={String(pullMs)}
                          onChange={(e) => applyPull(Number(e.target.value))}
                        >
                          {PULL_INTERVALS.map((o) => (
                            <option key={o.ms} value={String(o.ms)}>{o.label}</option>
                          ))}
                        </select>
                      </div>
                      <span className="sync-hint">
                        {/* ⚠️ 这句话是 owner 2026-09-29 特意要纠正的那个误会（规格 §9.4）：
                            这个 5 秒**不是"只管非正文"**，它是一条**路的节拍** —— 正文（CRDT 状态）
                            就是随这条拉取一起搬的。说错会让用户以为"正文是实时的"。
                            ⚠️ 本仓口径：**行内 Markdown 只在渲染边界的 `inlineMd` 里生效** ——
                            这里是面板自己写的句子，所以一个星号都不写（写了就会原样显示）。 */}
                        这条路的节拍：每 {pullIntervalLabel(pullMs)}自动跑一次（服务端那条 ＋ 设备直连那条
                        都跟着它走）。正文也在这条路上，不是实时推送。
                      </span>
                    </div>
                  </details>
                )}

                {/* ⑥ 附近设备（丙档需求 §4.1 的那一块）。
                    ★ 门槛：**与父项同一个 `lanDirectOn`** —— 设备直连直连关着 ⇒ 不显示（"没开就不会去发现"）。
                    ⚠️ 列表**只有一处来源**（`lanStatus.nearby`，与 `peers` 同一次读数）；
                       行数**不许**自己数 `lanStatus.peers`（两条数法迟早会漂，规格 §2 第一条不变式）。
                    ★ 2026-09-29（规格 §12.1）：这一块**原本默认折叠**，形态与面板里其它行一致
                       （`<details className="sync-row">` ＋ 摘要「N 台」＋ `›`）——
                       摘要那一格是 `nearbySummary`（四态见上面那段注释）。
                       ⚠️ **2026-10-14**：⭐ 那三段设备**已搬到 hero 之后**（片 D1d ✓）⇒
                       这一块（配对那两块：`device-unpair` ／ `device-pair` ✓）**默认折叠** ✓
                       （⛔ 不再 `open` ✗ —— 它是设置类的 ✓，图上也没有 ✓）；⭐ 而「附近设备」整块留在主视图 ✓。
                       ⚠️ 没开设备直连时整块**不出现**（不是灰掉，§9.3）。 */}
                {/* 刀三-2（2026-10-14）：配对那两块 ＋ 它所在的这一层条件 ⇒ 收进一个折叠 ✓（⭐ 主视图只留三段设备 ✓） */}
                {lanDirectOn && (
                  <details className="sync-row">
                    <summary>
                      <span className="sync-row-label">附近设备</span>
                      <span className="sync-row-value">{nearbySummary}</span>
                      <span className="sync-row-caret" aria-hidden>›</span>
                    </summary>
                    <div className="sync-row-body">
                      <div className="sync-nearby">
                        {/* 三种处境三句话（规格 §4 的表）：
                            ① 这一层不可用／读不到列表 ⇒ "看不到这一层"（**不是**"网段里没人"）；
                            ② 开着但一台都没发现 ⇒ "还在找…"（**永不**说"网段里没有设备"：看不见 ≠ 不存在）；
                            ③ 有设备 ⇒ 每台一行。
                            ⭐ **P-2b（2026-10-13）**：③ 里按「本机认没认过」分**两段**（`已信任`／`待配对` ✓）——
                              判据取**本机认过的那份名单** `duList`（与下面「解除」那块同一份 ✓，⛔ 不新造读数 ✗）。
                            ⭐⭐ **P-3d（2026-10-13）：第三段已落地** ✓ —— 「**需要重新配对**」✓，
                              判据取 ⭐ **逐台读数** `key_changed`（P-3a 供的 ✓ `commands.ts` 的 `NearbyPeer` ✓）。
                              ⚠️ ⭐ **读不到（`null`）不算变了** ✗（`false` 也不算 ✓）⇒ 只有 `=== true` 才进这一段 ✓
                              （「读不到」是**没有结论** ✓ —— 与那几格读数同一把尺 ✓）。 */}
                        {/* ★ 第一轮广播的代价必须如实说（需求 §4.4／方案 §4 风险 1）：
                            ⚠️ **不写数字** —— 常量是 30s（`lan_state.rs:138`），而真机读数记的是 ≈45 秒
                               （`2026-09-24-lan-p2p-topology-decision.md` §18）⇒ 两处不一致，
                               文案**不替它下结论**（需求 §7 待查 D2），只说"要等一轮"。 */}
                        {lanStatus.enabled && nearby.length === 0 && (
                          <div className="sync-web-note is-inline" role="note">
                            <span>【注意】第一轮广播要约等一轮才认全</span>
                            <span>（这期间这里写「正在找…」）</span>
                          </div>
                        )}
                        {/* ⭐ **T4（2026-10-01）：把这台设备接进来** —— owner 拍「乙」：两个入口两个名字 ✓
                            这一块搬的**不是钥匙袋**（那是设置里「换设备」的活 ✓），而是**接线**：
                            绑哪个地址 ＋ 带什么口令 ⇒ 所以名字必须**说清是接线** ✓。
                            ⚠️ 三步两态：生成 → 人读码核对 → 采纳；**对不上就停在"停"态**，
                               而那一态里**没有继续入口** ✗（判据钉着 —— 见下面 `dpOutcome !== "stopped"` ✓）。
                            ⚠️ 文案红线：块内**不出现裸 id／裸 IP**（地址来自读数原样显示 ✓）；
                               ⛔ 不出现「已确认／已验证」这类**判定语** ✗（判据 `syncPanelMesh.wiring.test.ts` ⑩ 扫得到这一屏 ⇒ ⚠️ **反例本身也不许原样写进来**，实测踩到 ✓）；成功**只许说「已配对」** ✓。 */}
                        {/* ⭐ U11/T5：**逐台解除** —— 只踢那一台 ✓；⛔ 不必给所有设备换口令 ✗。
                            ⚠️ 屏幕上只给**短码 ＋ 时间**（人读认台 ✓），⛔ **不出现裸设备号** ✗。 */}
                        {duList.length > 0 && (
                          <div className="sync-nearby" data-testid="device-unpair">
                            <div className="sync-hint">
                              【要点】这台机器认了 {duList.length} 台设备。想踢掉某一台，点它那行的「解除」。
                              只影响那一台，别的照常；也不用给所有设备换口令。
                            </div>
                            {duList.map((d) => (
                              <div className="sync-actions" key={d.deviceId}>
                                <span className="sync-hint">
                                  设备 {duCode(d.deviceId)} · 配于 {duWhen(d.addedAtMs)}
                                </span>
                                <button
                                  className="sync-btn"
                                  disabled={duBusy !== ""}
                                  onClick={() => void duUnpair(d.deviceId)}
                                >
                                  解除
                                </button>
                              </div>
                            ))}
                            {duNote && <div className="sync-hint">{duNote}</div>}
                          </div>
                        )}
                        {/* ⭐ 这一步的提示留在**折外** ✗ —— 「附近的设备」里点「信任这台设备」会写进
                            `dpNote` ✓，⭐ 而它要落在**你看得见的地方** ✓（⛔ 不能藏在刚折起来的那层里 ✓）。 */}
                        {dpNote && <div className="sync-hint" style={{ whiteSpace: "pre-wrap" }}>{dpNote}</div>}
                        {/* ⭐ 2026-10-11：把**「信任设备」那一屏**（图①/②/④/⑥ 的界面）挂上来 ✓ ——
                            它原先全仓**挂载点 0 处** ✗（`TrustDevicePanel.tsx` 写好了、17 条判据在跑，
                            但界面上点不到 ✓ ⇒ 这一块就是"把它接到底" ✓）。
                            ⭐ 位置按图④：**紧挨着「附近的设备」那一块** ✓，并且在
                              「严格模式（高级）」那一折**之前** ✓（⛔ 老路一个字不动 ✗ —— 它就在下面 ✓）。
                            ⚠️ 四条读数这轮**一律如实"读不到"** ✓（见模块级 `TRUST_DEVICE_READINGS` ✓），
                              点「接入」走 owner 拍的**甲**：一端点就通 ⇒ `trustDevice()` ✓。 */}
                        <TrustDevicePanel
                          {...TRUST_DEVICE_READINGS}
                          trustState={trustState}
                          initialStrictMode={strictTrust}
                          onStrictModeChange={setStrictTrust}
                          onAttach={(spaceIds) => void trustDevice(spaceIds)}
                        />
                        {/* ⭐ 2026-10-11（owner：「参照效果图实现」＋「把同步面板做好」）：⭐ 效果图把"码"收进
                            **「严格模式（高级）」** ✗ ⇒ ⭐ 主路径（⭐ 附近设备 ＋ ⭐ 信任这台设备 ✓）**不再出现任何码** ✓。
                            ⚠️ 折起来的是**同一套机制** ✗，⛔ 机制一个字没动 ✓（⭐ 仍是 `device_pair_export` ／ `import` ✓）：
                               ⭐ 两台不在一起（⭐ 不在同一网络 ✓）时这条路照旧可用 ✓ ——
                               ⭐ 它只是**不再是第一眼看到的东西** ✓（⭐ 效果图上就是这么摆的 ✓）。
                            ⚠️ 不给 `open` ⇒ ⭐ 默认**收起** ✓（⭐ 收的正是那两块码 ✓）。 */}
                        <details className="sync-advanced" data-testid="device-pair-advanced">
                          <summary>严格模式（高级）—— 两台设备不在同一网络时用这条（要抄一串码）</summary>
                          <div className="sync-nearby" data-testid="device-pair">
                          <div className="sync-hint">
                            【要点】把这台设备接进来：把这台的接线（地址 ＋ 窗口口令）交给对方那台。
                            ⚠️ 它含窗口口令 ⇒ 只交给你自己那台设备，⛔ 别外传 ✗。⚠️ 这串码／这段文本<b>不是一次性的</b> ⇒ 配对完成后建议<b>换一次窗口口令</b> ✓。
                          </div>
                          {/* ⭐ R110（owner 2026-10-02 拍 A）：**先说清这段码给哪一台** ——
                              · 从「附近的设备」里**点选**那一台 ⇒ 本机**生成时就把它登记好** ⇒
                                对方采纳**一次**、**两个方向都通** ✓；
                              · 不选（它不在附近／想把码抄下来离线传）⇒ 照旧**要配两次** ✓
                                —— 两条路都留着 ✓（A 是加法，⛔ 不是替换 ✗）。
                              ⚠️ 屏幕上只给**短码**（复用解除块那把 `duCode` ✓）：
                                 ⛔ 可见文案不出现裸设备号 ✗（`INV-UI-copy-no-internal-ids` ✓）。 */}
                          <label className="sync-field">
                            <span>这段码给哪一台：</span>
                            <select
                              className="sync-input"
                              value={dpPeer}
                              onChange={(e) => setDpPeer(e.target.value)}
                              data-testid="dp-peer"
                            >
                              <option value="">不指定（两台不在一起时才用这条：码离线传，要配两次）</option>
                              {nearby
                                .filter((p) => p.serves_current)
                                .map((p) => (
                                  <option key={p.device_id} value={p.device_id}>
                                    设备 {duCode(p.device_id)}
                                    {p.device_name ? ` · ${p.device_name}` : ""}
                                  </option>
                                ))}
                            </select>
                          </label>
                          {nearby.filter((p) => p.serves_current).length === 0 && (
                            // ⚠️ 看不到候选 ⇒ **如实说**（⛔ 不说"网段里没有设备" ✗：看不见 ≠ 不存在 ✓）
                            <div className="sync-hint">
                              「附近的设备」里暂时没有服务这个空间的设备 ⇒ 不指定也能配，只是要<b>配两次</b> ✓。
                            </div>
                          )}
                          <button className="sync-btn" disabled={dpBusy} onClick={() => void dpGenerate()}>
                            生成投放码
                          </button>
                          {dpExport && dpExport.outcome === "ok" && (
                            <div className="sync-hint">
                              <div>比对码（一次性）：<b data-testid="dp-own-code">{dpExport.check_code}</b></div>
                              <div style={{ wordBreak: "break-all" }} data-testid="dp-text">{dpExport.text}</div>
                              {dpPeer ? (
                                <div data-testid="dp-one-shot">
                                  ⭐ 已指定对端 ⇒ 把这段码交给它，<b>它采纳一次就够</b> ✓：
                                  本机生成时已经把它登记好了 ⇒ 采纳完<b>两个方向都通</b>（不用再配第二次 ✓）。
                                </div>
                              ) : (
                                <div>
                                  对端收下后，请当面核对两边的比对码：一样才继续 ✓。
                                  ⚠️ 没指定对端 ⇒ 这条兜底要<b>配两次</b>（见上面的下拉 ✓）。
                                </div>
                              )}
                            </div>
                          )}
                          {dpExport && dpExport.outcome === "not_configured" && (
                            <div className="sync-hint">{dpExport.message}</div>
                          )}
                          <div className="sync-hint">—— 或者，采纳对方给来的码 ——</div>
                          <input
                            className="sync-input"
                            placeholder="把对方那段码粘到这里"
                            value={dpText}
                            disabled={dpBusy || dpOutcome === "stopped"}
                            onChange={(e) => { setDpText(e.target.value); setDpPreview(""); setDpOutcome("idle"); }}
                          />
                          {/* ⛔ **停态里没有"继续"** ✗ —— 这是 `U3` 的界面半边（矩阵 U3 的注入点就在这）✓ */}
                          {dpOutcome === "stopped" ? (
                            <div className="sync-hint" data-testid="dp-stopped">
                              【禁】停下了：两边的码对不上 ⇒ 不采纳、本机一个字节都没改。
                              请回到给出这段码的那台设备上重新核对，然后重新粘一次（对不上时这里不给继续的入口）。
                            </div>
                          ) : (
                            <>
                              <button className="sync-btn" disabled={dpBusy || !dpText.trim()} onClick={() => void dpPreviewImport()}>
                                先看比对码
                              </button>
                              {dpPreview && (
                                <div className="sync-hint">
                                  <div>这边算出来是：<b data-testid="dp-computed-code">{dpPreview}</b></div>
                                  <div>与对方那台上显示的逐位相同才继续；不一样千万别继续 ✗。</div>
                                  <input
                                    className="sync-input"
                                    placeholder="把核对过的比对码填回来"
                                    value={dpCode}
                                    disabled={dpBusy}
                                    onChange={(e) => setDpCode(e.target.value)}
                                  />
                                  <button className="sync-btn" disabled={dpBusy || !dpCode.trim()} onClick={() => void dpAccept()}>
                                    我核对过了，采纳
                                  </button>
                                </div>
                              )}
                            </>
                          )}
                          {dpOutcome === "ok" && <div className="sync-hint" data-testid="dp-ok">已配对 ✓</div>}
                          </div>
                        </details>
                      </div>
                    </div>
                  </details>
                )}
              </>
            )}

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
                <div className="set-section-title">两台设备核对一下这串码</div>

                {pairReading.kind === "unavailable" ? (
                  <div className="sync-status is-warn" data-testid="pair-code-unavailable">
                    读不到比对码（{pairReading.reason}）—— ⭐ 读不到就<b>不显示任何码</b> ✓
                  </div>
                ) : pairReading.value === null ? (
                  <div className="sync-hint" data-testid="pair-code-empty">这一轮还没有比对码 ✓</div>
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
                  请在两台设备上核对：<b>两边一样</b> ⇒ 确认 ✓
                </div>
                <div className="sync-hint" data-testid="pair-code-mismatch">
                  ⚠️ 两边的码不一样 ⇒ 先别确认（你可能正连到另一个设备）✓
                </div>

                <div className="sync-field">
                  <button
                    className="sync-btn primary"
                    data-testid="pair-confirm"
                    type="button"
                    // ⭐ **P-4 片②b（2026-10-13）**：⭐ **原来那两步搬到这里** ✗ —— 逐字是
                    //   `setDpPeer(peer.device_id)` ＋ `void trustDevice([activeId], peer)` ✓
                    //   （⚠️ ⭐ 命令名 `mesh_trust_begin`／参数 `{spaceId, peerDeviceId, peerPubkey}`／
                    //    `refreshTrustState` 那段返回值处理**一字未改** ✓ —— ⛔ 只挪了**时点** ✗）。
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
                  这是<b>比对码</b>（20 位、5 组）—— 这是<b>现在的做法</b>；更短的 6 位码需要 PAKE，而<b>已决定不做</b> ✓
                  <br />
                  含窗口口令 ＝ 钥匙材料 ⇒ <b>只发你自己那台</b> ✓
                  <br />
                  <b>不是一次性的</b> ⇒ 用后建议换一次窗口口令 ✓
                </div>
              </div>
            )}
          </div>

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
        </div>
      )}
    </div>
  );
}


