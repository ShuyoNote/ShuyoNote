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
import type { ReactNode } from "react";
import { inlineMd } from "../lib/inlineMd";

export interface SyncStatusStripProps {
  /** 圆点那枚 class 的后缀（`" is-ok"` ／ `" is-busy"` ／ `""`）——由调用方按真读数算 ✓。 */
  dotClass: string;
  /** 主句（⭐ 调用方拼 ✓ —— 现在是「已配对 · 在线 · 自动同步中」那三件真事 ✓）。 */
  state: string;
  /**
   * ⭐ **2026-10-27（owner：「关闭局域网同步按钮布局太丑，优化一下」）**：
   * 状态行**右上角**的那枚动作（`关闭局域网同步`／`开启局域网同步`）——
   * ⚠️ 由调用方给（这里只摆位置 ＋ 一个 `margin-left:auto`，⛔ 不自己判开没开 ✗）。
   */
  action?: ReactNode;
  /** `lanStatus.mesh.bind` 拆出来的地址；空串 ⇒ 显示「未读到」。 */
  addr: string;
  /** 同上拆出来的端口；空串 ⇒ 显示「未读到」。 */
  port: string;
  /**
   * ⭐ **2026-10-14（照桌面版高保真效果图）**：⭐ 小字要**一行**说完 ✓ ——
   * （调用方从 `lanStatus.mesh.window` 取 `.hostname` ✓ —— ⛔ 不是解析后端人话 ✗）。
   * 为空 ⇒ 退回下面那句 Rust 原文 ✓（那种情况正是「别人拉不到」✓，判语要看后端原话 ✓）。
   */
  /**
   * Rust 侧那句「**别人拉不拉得到**」原文（`lanStatus.mesh.reach` ✓）；空串 ⇒ 显示「报出去的是 未读到」。
   * ⚠️ ⭐ 它是一句**后端来的整句** ✓（自己就写着「能被别人拉到 —— 报出去的是枚举到的 http://…」✓）⇒
   *    ⭐ 这一格**不再**在它前面加一次「报出去的是」✗（会读成"报出去的是 …报出去的是…"✓）。
   *
   * ⭐ **2026-10-14（owner：顶上那条太长 ⇒ 拆两行）**：⭐ 它现在是**单独的第二行** ✓
   * （`lanStatus.mesh.note` 那句"开没开／窗口在哪"没有再摆 ✗ —— 第一行那两格已经把同一件事说短了 ✓）。
   */
  reach: string;
  /**
   * ⭐ **2026-10-14（owner 给了参照图）**：⭐ 「报出去的是 <host>」里那个 host ✓ ——
   * 调用方从**结构化字段** `mesh.announced`（枚举到的可达 base ✓）取 `.hostname` ✓
   * （⛔ 不是解析后端人话 ✗，⛔ 也不是 `mesh.window` —— 那是**绑定**地址、绑通配时是 `0.0.0.0` ✗）。
   * 为空 ⇒ 退回下面 `reach` 那句后端原文 ✓（那种情况正是"别人拉不到"✓）。
   */
  announced: string;
}

/** ⭐ 「读不到」那句话**只有一处**（⛔ 不在调用方再判一次 ✗ —— 两份写法迟早漂开 ✓）。 */
const NOT_READ = "未读到";

export function SyncStatusStrip({ dotClass, state, action, addr, port, reach, announced }: SyncStatusStripProps) {
  const shown = (v: string) => v || NOT_READ;
  // ⭐ **2026-10-14（owner：「美化酷炫一下」）**：外面包一层 \`sync-hero-card\` ✓ —— 让这一块成为
  //   **一张卡**（底色/描边/圆角/浮起 都在 \`App.css\` 的 \`.sync-popover.is-inline\` 那一档里 ✓）。
  //   ⚠️ 用**新类名**而不是既有的 \`.sync-hero\` ✗ —— 后者在面板里**根本没有**（只有 \`.sync-hero-state\`
  //   与 \`.sync-hero-sub\` ✓）⇒ 写它会是一条死规则 ✓；而且既有的 \`.sync-hero\` 会**居中文字** ✗。
  return (
    <div className="sync-hero-card">
      <div className="sync-hero-state">
        <span className={`sync-hero-dot${dotClass}`} aria-hidden />
        <span>{state}</span>
        {/* ⭐ 2026-10-27：右上角那枚动作（`关闭局域网同步`）—— `margin-left:auto` 把它顶到右边 ✓ */}
        {action && <span className="sync-hero-action">{action}</span>}
      </div>
      {/* ⭐⭐ **2026-10-14（照桌面版高保真效果图）** ✗：图上状态卡里是**两行** ✓ ——
          加粗的状态行 ＋ **一行**小灰字 ✓（「监听地址 …（自动）· 端口 …（默认）· …」✓）
          ⇒ ⭐ 上一版那三行并回两行 ✓（⛔ 内容没删 ✗）。
          ⚠️ 图上那半句是**裸地址**（`报出去的是 192.168.43.206` ✓）—— ⭐ 那要**后端多给一格**才会精确
          （`mesh.window` 是**绑定**地址：绑通配时它是 `0.0.0.0` ✗ ⇒ 拿它当"报出去的"是错的 ✓，
          ⛔ 我不这么干 ✗）。⇒ ⭐ 这一格摆**后端那句原文** ✓（它自己就写着"报出去的是枚举到的 …" ✓）；
          取不到 ⇒ 如实说「报出去的是 未读到」✓（⛔ 不拿前两格凑一个地址 ✗）。
          ⚠️ ⭐ **必须过 `inlineMd`** ✗（见文件头那条纪律 ✓：不过就会原样显示星号 ✓）。 */}
      {/* ⭐ **2026-10-26（owner：「界面不美观，优化一下」）**：⭐ 这一行拆成**三枚读数胶囊** ✓ ——
          文字内容与"取不到就说未读到"的口径**一个字没改** ✓，只是把它们**各成一格**：
          长句摊成一行时在宽屏上很难扫读（owner 截图里那一行 12px 小字横跨整屏 ✓）。
          ⚠️ 仍然**不许**在界面这一层写死任何地址／端口默认值 ✓（值只来自 props ✓）。 */}
      <div className="sync-hero-sub">
        <span className="sync-hero-meta">
          <span className="sync-hero-meta-k">监听地址</span>
          <span className="sync-hero-meta-v">{shown(addr)}</span>
          <span className="sync-hero-meta-tag">自动</span>
        </span>
        <span className="sync-hero-meta">
          <span className="sync-hero-meta-k">端口</span>
          <span className="sync-hero-meta-v">{shown(port)}</span>
          <span className="sync-hero-meta-tag">默认</span>
        </span>
        {announced ? (
          <span className="sync-hero-meta is-wide">
            <span className="sync-hero-meta-k">报出去的是</span>
            <span className="sync-hero-meta-v is-strong">{announced}</span>
          </span>
        ) : reach ? (
          <span className="sync-hero-meta is-wide">{inlineMd(reach)}</span>
        ) : (
          <span className="sync-hero-meta is-wide">
            <span className="sync-hero-meta-k">报出去的是</span>
            <span className="sync-hero-meta-v">{NOT_READ}</span>
          </span>
        )}
      </div>
    </div>
  );
}
