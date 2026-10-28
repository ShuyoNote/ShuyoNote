// ⭐ **R176-A（owner 2026-10-28 拍 A）**：个人版同步的**权限模型**落在界面上的那几格读数与文案。
//
// ## 这个文件为什么存在（它替谁承重）
// 台账 `REQUESTS.md` 的 **R176** 行给 owner 的建议里有两条是「必有项」：
//   · （a）**能读的状态**：「这一轮走的是：**设备直连** · N 台已信任」＋「**服务 N 个空间**」
//     ＋「**本机：已信任 N 台**」；
//   · （b）**「不再信任」的语义写在按钮旁**：⭐ **只停止同步**、⭐ **本地数据一个字节都不动**。
// ⇒ 本文件是那两件事的**唯一实现**（纯函数 ＋ 文案常量）：面板只负责把读数传进来、把结果摆出去 ✓。
//
// ## 判据（可机器判的那些，见 `personalSyncReadout.test.ts` 与
//    `syncPanelPersonalTrust.wiring.test.ts`）
//   · **J9**（`2026-10-09-multidevice-merge-semantics.md` §9）：「两端发现参数不一致 ⇒ 界面必须解释原因」
//     ⇒ `discoveryDiagnosis()`：⭐ 已信任 N 台、但这一轮**一台都没出现在附近**时，必须把那几条
//     **可能的原因**说出来（含「端口」与「同一网络」），⛔ 不许只剩一句「连不上」✗；
//   · **J10**：「不再信任」后本地数据零变化 ⇒ 那条路只发 `device_unpair`（判据钉在面板那半边：
//     `duUnpair` 里**只有**这一条数据面命令），Rust 那半边由 `sync.rs::device_unpair_at` 的
//     源码级判据钉着（只动信任表／卡表，⛔ 不删页面与附件）；
//   · **J12**：端口预置 ⇒ 首次同步**零手输端口** ⇒ 默认流程（「高级」**外面**）一个端口输入都没有；
//     端口**只在「高级」里能改**（`portTextToBind` 这条纯函数负责校验与拼串）；
//   · **J13**：密码自动 ⇒ 用户**不用知道密码**也能接入 ＋ 「能读的状态」**必须出现走的是哪条路**
//     ⇒ `routeReading()` 的输出**永远不是空串**（读不到就如实说「未读到」）。
//
// ## ⚠️ 两条口径（与仓内既有那几条同源）
// 1. **「读不到」≠「0」**：`countFrom()` 对 `null`／`undefined`／非数组一律回 `{ kind: "unread" }`，
//    界面显示「未读到」—— ⛔ 不拿 0 冒充「一台都没有」✗（本仓 `trustDevicePanelReadings` 同族口径）。
// 2. **不编**：本文件**不写死任何端口号**（端口值只从 Rust 的 `mesh.bind` 来 ✓）；
//    `routeReading()` 的每一句都对应一个**真读数**（`syncMode`／`lanStatus.kind`／`mesh.enabled`），
//    没有读数就走「未读到」那一支 ✓。
//
// ⚠️ **与 2026-10-14 那次删除的关系（如实记，免得下一个人以为是回滚）**：2026-10-14 owner 让
//    「去掉这部分」，删的是**旧面板里四条变体拼出来的那一行**（`heroRoute`，逐字「这一轮走的是：…」）。
//    2026-10-28 拍 R176-A 时又把「能读的状态」列成**必有项**（走哪条路／服务几个空间／已信任几台）✓
//    ⇒ 这一屏按**新对象**回来：读数的**口径**（旧面板那四条变体：附近直连／设备直连·N 台可用／
//    服务器／还没绑同步）**不恢复**，换成这三格**逐格来源都能点名**的读数 ✓（见 `routeReading` 的注释）。
//    ⚠️ 旧判据（`SyncPanel.trustDevicePanel.wiring.test.tsx` ②「`heroRoute` 不许再出现」）
//    **一条没删、仍然绿** ✓ —— 它钉的是旧标识，本文件不叫那个名字。

/** `lanStatus.mesh.enabled` ／ `kind` 这类**可空**读数：`null`／`undefined` ＝ 这一轮读不到。 */
export type MaybeRead<T> = T | null | undefined;

/** 一格计数读数：要么**有个数**，要么**读不到** —— ⛔ 没有第三种（尤其没有「0 冒充读不到」）✗。 */
export type ReadoutCount = { kind: "ok"; n: number } | { kind: "unread" };

/** 「未读到」那一句**只有一处**（⛔ 不在调用方各写一份 ✗ —— 两份写法迟早漂开）。 */
export const READOUT_UNREAD = "未读到";

/**
 * 把一份**名单类**读数（`mesh.served` ／ `mesh.paired` ／ `nearby`）变成计数。
 *
 * ⚠️ 判据是 `Array.isArray` ✗（⛔ 不是 `?? []` ✗）：老 Rust 构建／Web 档**没有**这一格时，
 *    它与「空数组」长得一样、含义相反 —— 前者是**没有结论**，后者是**结论是 0** ✓。
 */
export function countFrom(list: MaybeRead<readonly unknown[]>): ReadoutCount {
  return Array.isArray(list) ? { kind: "ok", n: list.length } : { kind: "unread" };
}

/** 计数格要显示的字：有数就是数字（逐字），读不到就是「未读到」✓。 */
export function countText(c: ReadoutCount): string {
  return c.kind === "ok" ? String(c.n) : READOUT_UNREAD;
}

/** `routeReading()` 的输入 —— **全部**是面板已有的读数，⛔ 不新增命令／字段 ✗。 */
export interface RouteReadings {
  /** 总闸（`SyncMode`）：`"off"` ＝ 这一轮什么都没走 ✓。 */
  syncMode: string;
  /** `lanStatus.kind`（Rust `lan::LinkKind::as_str`：`"lan"` ／ `"configured"` ／ `""`）。 */
  kind: MaybeRead<string>;
  /** `lanStatus.mesh.enabled`（网格那一档开没开）。 */
  meshEnabled: MaybeRead<boolean>;
  /** `lanStatus.mesh.bind`（窗口绑在哪；空串／`null` ＝ 窗口没起）。 */
  bind: MaybeRead<string>;
}

/** 「这一轮走的是 …」那几档的**人话**（⭐ 每一档都能点名一个真读数，见 `routeReading` ✓）。 */
export const ROUTE_OFF = "同步已关";
export const ROUTE_DIRECT = "设备直连";
export const ROUTE_SERVER = "服务器";
export const ROUTE_NOT_OPEN = "还没开通同步";

/**
 * 「这一轮走的是**哪条路**」—— J13 的后半句（状态里**必须**出现走哪条路 ✓）。
 *
 * 判定顺序（= 逐个真读数，⛔ 不猜 ✗）：
 * 1. 总闸关（`syncMode === "off"`）⇒ 「同步已关」（⛔ 不说"正在同步"那种假话 ✗）；
 * 2. 两格读数**都**读不到 ⇒ 「未读到」（**没有结论** ⇒ ⛔ 不挑一个"看起来正常"的档 ✗）；
 * 3. `kind === "lan"` ⇒ 「设备直连」—— 这是 Rust 自己判出来的档（`LinkKind::Lan`）✓；
 * 4. `mesh.enabled === true` ⇒ 「设备直连」—— 个人版的远程路径就是设备直连（owner 裁定：
 *    个人空间不绑服务器 ✓）；`bind` 空只说明窗口还没起，**不改变走的是哪条路** ✓；
 * 5. `kind === "configured"` ⇒ 「服务器」—— 用户配的那个地址（团队档那条路）✓；
 * 6. 其余（`mesh.enabled === false` 且 `kind` 是空串）⇒ 「还没开通同步」✓。
 *
 * ⚠️ **永远不返回空串** ✗：J13 的判据就是「状态里没有路 ⇒ 红」⇒ 任何分支都得有话说 ✓。
 */
export function routeReading(r: RouteReadings): string {
  if (r.syncMode === "off") return ROUTE_OFF;
  const kindUnread = r.kind === null || r.kind === undefined;
  const meshUnread = r.meshEnabled === null || r.meshEnabled === undefined;
  if (kindUnread && meshUnread) return READOUT_UNREAD;
  if (r.kind === "lan") return ROUTE_DIRECT;
  if (r.meshEnabled === true) return ROUTE_DIRECT;
  if (r.kind === "configured") return ROUTE_SERVER;
  return ROUTE_NOT_OPEN;
}

/** 一格读数的「标签 ＋ 值 ＋ 单位」——组件按这个摆，⛔ 不在组件里再判一次档 ✗。 */
export interface ReadoutCell {
  /** 稳定键（判据按它取元素 ✓）。 */
  key: "route" | "served" | "trusted";
  label: string;
  value: string;
  /** 值的单位（`个空间` ／ `台已信任`）；路线那一格没有单位。 */
  unit: string;
}

/** 「服务几个空间」那三格要的**全部**读数（组件只认这三样 ＋ 可空的诊断句）。 */
export interface PersonalSyncReadout {
  route: string;
  served: ReadoutCount;
  trusted: ReadoutCount;
  /** J9 的解释句（不适用 ⇒ `null`，⛔ 不摆空条 ✗）。 */
  diagnosis: string | null;
}

/** 三格读数 —— 顺序固定（走哪条路 → 服务几个空间 → 已信任几台 ✓，与效果图 ⑦ 同一顺序）。 */
export function readoutCells(r: Pick<PersonalSyncReadout, "route" | "served" | "trusted">): ReadoutCell[] {
  return [
    { key: "route", label: "这一轮走的是", value: r.route, unit: "" },
    { key: "served", label: "服务", value: countText(r.served), unit: "个空间" },
    { key: "trusted", label: "本机", value: countText(r.trusted), unit: "台已信任" },
  ];
}

/** `discoveryDiagnosis()` 的输入 —— 全部来自面板已有读数（⛔ 不开新命令 ✗）。 */
export interface DiscoveryDiagnosisInput {
  /** 发现层开着吗（`lanStatus.enabled`）。 */
  discoveryOn: boolean;
  /** 本机**已信任**的台数（`mesh.paired` 的计数；读不到 ⇒ `unread`）。 */
  trusted: ReadoutCount;
  /** 这一轮**附近看见**的台数（`nearby.length`；读不到 ⇒ `null`）。 */
  nearbyCount: number | null;
}

/**
 * ⭐ **J9**：「两端发现参数不一致（端口／网段）⇒ 界面**必须解释原因**」
 *
 * 诚实边界（写下来免得下一个人以为它"能判出两端端口不同"）：**界面判不出**对端端口 ——
 * `NearbyPeer` 里没有对端端口那一格（只有 `addr`，且只是排障用、默认不显示 ✓）。而**端口一旦不同，
 * 两端根本收不到对方的公告** ⇒ 现场表现为「已信任 N 台，但这一轮一台都没出现在附近」✓。
 * ⇒ 这里只在**那个形状**下工作：把那几条**可能的原因**逐条说出来（⭐ 含「端口」与「同一网络」✓），
 *    ⛔ 不许只印一句「连不上」✗（J9 的红线就是这一句）。
 *
 * 返回 `null` 的四种情形（都是"没什么可说"，⛔ 不是"读不到当没有" ✗）：
 * · 发现层关着（此时主视图那句已经在说"没在找"✓）；
 * · 已信任 0 台（没有"该出现却没出现"的期望 ✓）；
 * · 这一轮附近**真看见了**设备（没有不一致的迹象 ✓）；
 * · 读数**读不到**（`trusted` 或 `nearbyCount` 不可知 ⇒ 没有结论 ✓）。
 *
 * ⚠️ 文案纪律：**自己写的 JSX／字符串**里不用 Markdown 的 `**…**`（会在界面上原样显示星号 ✗），
 *    也不引用任何内部标识（⛔ 设备号／暗号／地址都不出现 ✓）。
 * ⚠️ 2026-10-14 owner 删过一条**常显**的同类提示（那句「AP 隔离」长句）⇒ 本条按那个决定收敛：
 *    它**只在上述形状下出现**、且措辞不复用那句（判据 `syncPanelMesh.wiring.test.ts` ⑨b 钉着旧词）。
 */
export function discoveryDiagnosis(i: DiscoveryDiagnosisInput): string | null {
  if (!i.discoveryOn) return null;
  if (i.trusted.kind === "unread") return null;
  if (i.trusted.n === 0) return null;
  if (i.nearbyCount === null || i.nearbyCount === undefined) return null;
  if (i.nearbyCount > 0) return null;
  const n = i.trusted.n;
  return (
    `本机已信任 ${n} 台，但这一轮一台都没出现在附近。` +
    "常见原因：① 两台不在同一个网络；" +
    "② 两端的广播端口不一样（端口已经预置，只在「高级」里能改 —— 两端要一致）；" +
    "③ 这个网络把设备挡在彼此之外。"
  );
}

/** 把上面几件合成一份读数（面板只调这一个入口 ⇒ 口径一处 ✓）。 */
export function personalSyncReadout(args: {
  route: RouteReadings;
  served: MaybeRead<readonly unknown[]>;
  trusted: MaybeRead<readonly unknown[]>;
  discoveryOn: boolean;
  nearbyCount: number | null;
}): PersonalSyncReadout {
  const served = countFrom(args.served);
  const trusted = countFrom(args.trusted);
  return {
    route: routeReading(args.route),
    served,
    trusted,
    diagnosis: discoveryDiagnosis({ discoveryOn: args.discoveryOn, trusted, nearbyCount: args.nearbyCount }),
  };
}

// ── ② 同步密码：自动派生，用户**不用知道**它 ────────────────────────────────────
//
// ⚠️ 为什么**没有**一个「手动填密码」的输入框（如实交代口径，⛔ 不是漏做 ✗）：
//   · 本仓 `sync.rs` 里那条「用户手打 `mesh_token`」的界面已于 **2026-10-13 退役**
//     （`MeshAdvancedForm` 一并删掉，见 `SyncPanel.tsx` 对应注释 ✓）；
//   · owner **2026-10-09 已拍**：「密码不要用户输入」★ 且规格 §8 写死到「连高级里可手动也不要」
//     ✗ —— 理由是**手输长密码 ⇒ 错一位就连不上且无提示**（与今天那个 bug 同形 ✓）；
//   · 而 R176-A（2026-10-28）那行的兜底仍是「**不让用户手输**」✓。
// ⇒ 这一格只**如实显示**"它是自动的"，⛔ 不提供一个会让用户以为"密码保护了内容"的手填入口 ✗
//   （`mesh_token` 已不再是凭证：门只认配对密钥／签名 —— 让用户去填它等于卖一个假的安全感）。

/** 高级里「同步密码」那一行的值（逐字）—— ⛔ 用户看的不是密码本身，是"它自动"这件事 ✓。 */
export const PASSWORD_AUTO_VALUE = "自动生成 · 不用你填";

/** 高级里「同步密码」那一行的解释（短、可核；⛔ 不出现任何密码值／长度／算法细节 ✗）。 */
export const PASSWORD_AUTO_HINT =
  "默认由本机自动生成、配对时自动交换 —— 你不用填，也不用知道它是什么。" +
  "纯离线第一次配对走对码，密码同样自动带过去；填错密码连不上那种事不会发生。";

// ── ③ 端口：预置 ＋ 默认隐藏 ＋ 只在「高级」可改 ────────────────────────────────
//
// ⭐ J12：端口**预置**（Rust `ensure_mesh_defaults` 写 `0.0.0.0:8788` ✓）、首次同步**零手输端口** ⇒
//   默认流程（「高级」外面）**一个端口输入都没有**；这里只管「高级」那一格能改时的校验与拼串 ✓。
// ⚠️ 本文件**不写死任何端口号** ✗（预置值来自 Rust 的 `mesh.bind` ✓ —— 界面写死一个默认值
//   等于跟系统报出来的真实端口打架 ✓，与 `SyncStatusStrip.tsx` 头部那条纪律同源）。

/** 高级里「端口」那一行的解释（⛔ 不含具体数字 —— 数字来自读数 ✓）。 */
export const PORT_ADVANCED_HINT =
  "端口已经预置好，一般不用改。只在「高级」里能改，主界面不出现输入框。" +
  "两台设备改成不同端口之后彼此看不到对方 —— 那时状态里会把这条原因说出来。";

/** 端口填错了的那句人话（可操作：说清范围 ✓，⛔ 不是"无效输入" ✗）。 */
export const PORT_INVALID_TEXT = "端口要填 1–65535 之间的整数（默认预置的那个一般不用改）";

/**
 * 「高级」里改端口时：把地址与端口拼成 Rust 认的 `bind` 串（形如 `0.0.0.0:8788` ✓）。
 *
 * 返回 `null` ＝ **端口不合法**（⛔ 不拼一个必然被后端拒的串 ✗）——
 * 合法范围 1–65535 的十进制整数；前后空白去掉 ✓。
 *
 * ⚠️ 默认值判据（J12）：**地址**来自 `lanStatus.mesh.bind` 的现存地址（用户不改它 ✓），
 *    缺地址时用 Rust 默认的监听写法 `0.0.0.0`（"听所有网卡"那条后端口径 ✓）——
 *    这里写 `0.0.0.0` 是**兜底地址**、不是端口数字，不违反上面那条"不写死端口"纪律 ✓。
 */
export function portTextToBind(addr: string, portText: string): string | null {
  const raw = portText.trim();
  if (!/^\d{1,5}$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
  const host = addr.trim() || "0.0.0.0";
  return `${host}:${n}`;
}

// ── ⑤ 「不再信任」：语义写在按钮旁 ─────────────────────────────────────────────
//
// ⭐ R176-A ⑤：**只停同步、本地数据零字节变化** ⇒ 这句话**必须紧挨着那颗按钮** ✓
//   （owner 最怕的是"取消信任把笔记删了" ✓）。⚠️ 解除 ≠ 删数据：Rust 侧 `device_unpair_at`
//   只删信任表那一行 ＋ 清秘密 ＋ 从在跑的门上摘卡（判据 `syncPanelPersonalTrust.wiring.test.ts` 钉着）✓。

/** 那颗按钮上的字（R176-A ①「随时『不再信任』」—— 这个词是 owner 逐字给的 ✓）。 */
export const UNTRUST_LABEL = "不再信任";

/** 按钮旁那句（⭐ 逐字承担「只停止同步 ＋ 本地数据不动」两个承诺 ✓；同时点出旧词「撤销配对」）。 */
export const UNTRUST_SCOPE_NOTE =
  "「不再信任」（＝撤销配对）只停止同步：本机数据一个字节都不动 —— " +
  "笔记、附件都还在这台机器上，想再同步就再信任一次。";
