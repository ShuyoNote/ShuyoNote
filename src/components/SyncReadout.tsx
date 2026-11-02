// ⭐ **R176-A（owner 2026-10-28 拍 A）④「能读的状态」** —— 「设备直连」主视图里那三格读数：
//     · 这一轮走的是：**设备直连**（哪条路 ✓ —— J13 的后半句）
//     · 服务 **N** 个空间
//     · 本机：已信任 **N** 台
//   外加一条**只在异常形状下出现**的诊断句（**J9**：两端发现参数不一致 ⇒ 必须解释原因 ✓）。
//
// ## 为什么单独一个组件
// 主视图的「绿色状态条」（`SyncStatusStrip.tsx`）装的是**监听地址／端口／报出去的是**那三格；
// 本组件装的是**这一轮走哪条路 ＋ 规模**那三格 —— 两件事各有各的读数来源，混在一个组件里
// 迟早会有人拿状态条的值去凑规模 ✓。⛔ 这里**不读任何东西**：值全由 props 传（判据好测 ✓）。
//
// ## ⛔ 三条纪律（与 `SyncStatusStrip.tsx` 同源）
// · ⭐ **值全由 props 传** ✗ —— 本文件里**不出现**任何地址／端口／台数默认值；
// · ⭐ **取不到就说「未读到」** ✗ —— 那句只在 `personalSyncReadout.ts` 里有一处（`READOUT_UNREAD`），
//   本组件一律经 `countText()`／`routeReading()` 的产物显示，⛔ 不自己判档 ✗；
// · ⭐ **诊断句是纯文本** ✗（自己写的文案，⛔ 不用 Markdown 的 `**…**` —— 会在界面上原样显示星号 ✓；
//   那条契约只管 Rust 来的话，见 `SyncPanel.tsx` 里那条既有判据 ⑨c ✓）。
//
// ## 不新增样式表规则
// 三格读数复用**已经存在**的胶囊零件 `.sync-hero-meta*`（`App.css` 里那几条是**全局**的 ✓）；
// 外层只用 `.sync-readout` 这一条新类名（`App.css` 里与它成对的那一小块写明来由 ✓）。
import { readoutCells, type PersonalSyncReadout } from "../lib/personalSyncReadout";

export interface SyncReadoutProps extends PersonalSyncReadout {}

export function SyncReadout({ route, served, trusted, diagnosis }: SyncReadoutProps) {
  const cells = readoutCells({ route, served, trusted });
  return (
    <div className="sync-readout" data-testid="personal-readout">
      {cells.map((c) => (
        <span className="sync-hero-meta" data-testid={`readout-${c.key}`} key={c.key}>
          <span className="sync-hero-meta-k">{c.label}</span>
          <span className="sync-hero-meta-v">{c.value}</span>
          {c.unit && <span className="sync-hero-meta-tag">{c.unit}</span>}
        </span>
      ))}
      {diagnosis && (
        // ⭐ **2026-10-29（owner：「同步面板感觉乱糟糟」）**：那句「本机已信任 N 台，但这一轮一台都
        //   没出现在附近。常见原因 ①②③…」原来**整段摊在主视图里**（三行长文），把下面的设备名/分组
        //   全压下去了。现在收进 `<details>`：默认只留一行「为什么？」；点开仍是**原文**（⛔ 一个字没删 ✗）。
        //   ⚠️ `data-testid` 仍在**正文**那个 div 上（判据读的是它的 textContent，等于原文 ✓）。
        <details className="sync-readout-why">
          <summary>为什么这一轮附近没有已配对设备？</summary>
          <div className="sync-nearby-note is-warn" role="note" data-testid="discovery-diagnosis">
            {diagnosis}
          </div>
        </details>
      )}
    </div>
  );
}
