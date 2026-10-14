// 「设备直连」主视图的**绿色状态条**（刀二十，2026-10-14）—— 副标题之后、三段设备之前那一格。
//
// ## 为什么单独一个文件
// 主视图重写时它被单列出来（`SyncPanel.tsx` 原本把它内联在 `<header>` 里）✓；拆出来只为让
// 「状态条长什么样」与「那些读数从哪来」分成两件事 ✓ —— ⛔ 不新增任何读数、⛔ 不改任何判定语义 ✗。
//
// ## ⛔ 三条纪律（都写在这里，免得下一个人拆了它）
// · ⭐ **值全由 props 传** ✗ —— 这里⛔ 一个地址／端口默认值都不写死 ✗（本文件里**不出现**任何
//   形如 IP 或端口的具体数字 ✓）：那些值只许来自 Rust 的 `lan_status`（经 `splitMeshBind` 拆开 ✓）——
//   在界面这一层写死一个默认值，就等于**跟系统报出来的真实地址打架** ✓。
// · ⭐ **取不到就说「未读到」** ✗ —— 与那几格读数同一把尺：⛔ 「读不到」不许被当成 0／默认值 ✗
//   （`INV-UI-copy-no-internal-ids` 同族口径，见本仓 `trustDevicePanelReadings` ✓）。
// · ⭐⭐ **后端来的那句必须过 `inlineMd`** ✗（`note` ＝ Rust 的 `mesh.note` ✓）——
//   它按**行内 Markdown** 写（`**能被别人拉到**` ✓）⇒ ⛔ 不过就会在界面上**原样显示星号** ✗。
//   ⚠️ **2026-10-14 真机截图实测踩到过**：这一格当时是 `{shown(note)}` **裸渲染** ⇒
//   屏上真的出现了 `窗口**听所有网卡**` 与 `**能被别人拉到**` ✓（那一屏是 owner 点名要清的那一行 ✓）。
//   ⭐ 契约出处：`src/lib/inlineMd.tsx`（toast 与 `SpacePrivacySection` 已在用 ✓）；
//   ⛔ 不新增任何读数／⛔ 不自己解析那句话 ✗（"界面不按读数再判一次档"是同一条纪律 ✓）。
//
// ## 为什么类名逐字沿用 `.sync-hero-state` / `.sync-hero-sub`
// 它们与 `App.css` 里那两条规则（`:1756` 起）是**一对** ✓；而判据
// `SyncPanel.trustDevicePanel.wiring.test.tsx` 的「不变量」那条**就查 `.sync-hero-sub`** ✓
// ⇒ ⛔ 改名会在不新增任何信息的情况下把那条判据弄红 ✗（本笔不碰样式表 ✓）。
import { inlineMd } from "../lib/inlineMd";

export interface SyncStatusStripProps {
  /** 圆点那枚 class 的后缀（`" is-ok"` ／ `" is-busy"` ／ `""`）——由调用方按真读数算 ✓。 */
  dotClass: string;
  /** 主句（⭐ 调用方拼 ✓ —— 现在是「已配对 · 在线 · 自动同步中」那三件真事 ✓）。 */
  state: string;
  /** `lanStatus.mesh.bind` 拆出来的地址；空串 ⇒ 显示「未读到」。 */
  addr: string;
  /** 同上拆出来的端口；空串 ⇒ 显示「未读到」。 */
  port: string;
  /**
   * Rust 侧那句「**别人拉不拉得到**」原文（`lanStatus.mesh.reach` ✓）；空串 ⇒ 显示「报出去的是 未读到」。
   * ⚠️ ⭐ 它是一句**后端来的整句** ✓（自己就写着「能被别人拉到 —— 报出去的是枚举到的 http://…」✓）⇒
   *    ⭐ 这一格**不再**在它前面加一次「报出去的是」✗（会读成"报出去的是 …报出去的是…"✓）。
   *
   * ⭐ **2026-10-14（owner：顶上那条太长 ⇒ 拆两行）**：⭐ 它现在是**单独的第二行** ✓
   * （`lanStatus.mesh.note` 那句"开没开／窗口在哪"没有再摆 ✗ —— 第一行那两格已经把同一件事说短了 ✓）。
   */
  reach: string;
}

/** ⭐ 「读不到」那句话**只有一处**（⛔ 不在调用方再判一次 ✗ —— 两份写法迟早漂开 ✓）。 */
const NOT_READ = "未读到";

export function SyncStatusStrip({ dotClass, state, addr, port, reach }: SyncStatusStripProps) {
  const shown = (v: string) => v || NOT_READ;
  return (
    <>
      <div className="sync-hero-state">
        <span className={`sync-hero-dot${dotClass}`} aria-hidden />
        <span>{state}</span>
      </div>
      {/* ⭐ 第一行：**只有**监听地址与端口（owner 2026-10-14：那一行原来把三件事挤在一起 ✓）。 */}
      <div className="sync-hero-sub">
        监听地址 {shown(addr)}（自动）· 端口 {shown(port)}（默认）
      </div>
      {/* ⭐ 第二行：⭐ 后端那句「别人拉不拉得到」✓（⭐ 原样摆 ✓，自己就写着「报出去的是…」✓；
          ⛔ 读不到就如实说「报出去的是 未读到」✗ —— ⛔ 不拿前两格凑一个地址 ✗）。
          ⚠️ ⭐ **必须过 `inlineMd`** ✗（见文件头那条纪律 ✓：不过就会在界面上原样显示星号 ✓）。 */}
      <div className="sync-hero-sub">
        {reach ? inlineMd(reach) : <>报出去的是 {NOT_READ}</>}
      </div>
    </>
  );
}
