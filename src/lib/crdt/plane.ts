// **CRDT 平面在客户端的两处"注入点"**。
//
// ## 这个文件现在只剩什么（第 47 轮之后）
//
// 只剩**一件**：`setCrdtRemoteApplier` / `applyRemoteCrdtState` —— **远端载荷里带来的状态怎么落地**。
// 同步路径（`src/lib/platform/web.ts` 的 `applyChange`）只认这个函数签名，实现在启动时注册
// （生产：`src/main.tsx` ⇒ `mergeRemotePageState`）。
//
// ## 撤出去的那半（记在这里，免得有人把它加回来）
//
// 本文件**曾经**还有另一半：**磁盘边界的平面开关**（`CrdtPlaneImpl` / `setCrdtPlaneImpl` /
// `isCrdtPlaneEnabled` / `setCrdtPlaneEnabled` / `throughCrdtPlane`，由**构建期**环境变量
// `VITE_CRDT_PLANE=1` 打开），被 `docContent.ts` 的**两读一写**三处包着。
// 它在 [边界决策](docs/plans/2026-09-23-crdt-plane-boundary-decision.md) §6.2 就被判了"**应当撤出**"：
//   · 存盘这一步**只有一个版本** ⇒ 开着也**合并不了任何东西**，只是把已落盘 JSON **归一化改写一次**
//     （写得回去的字节与编辑器产出的不同）；
//   · 决策已改走**服务端合并**，而真正的合并路径是「每页 `page_crdt` 状态 ＋ 载荷里的 `crdt_state`」
//     —— 与本开关**没有任何关系**（这就是它最容易被人误会的地方：两套东西同住一个文件）。
// ⇒ 2026-09-23 第 47 轮撤出。撤出的**判据替换**写在 `crdt/plane.withdrawn.test.ts`：
// 原来那 9 条路径级判据里，随开关作废的（②③⑥）换成"**这一层一个字都不许改**"＋"**开关三件不许回来**"；
// 与新边界无关的（引用完整性/派生有痕/补算器收口）**留在各自的既有判据里**（`docContent.test.ts` 等）。
// ⚠️ 路径与文件名**刻意没改**：`scripts/doc-content-access-baseline.json` 是按**文件路径**记基线的
//    （"基线只许减"），改名会被门禁读成"新增文件"。
//
// ## 为什么实现必须是注入的（这一段仍然有效，两处注入同一理由）
//
// ★★ 静态 import 那一层的实现会造出一个**模块初始化环**（2026-09-23 修；`b49c9ed2` 的接线就是这么炸的）：
//
//     src/lib/docContent.ts（那一层）
//       → src/lib/crdt/plane.ts（本文件）→ src/lib/crdt/yDocBridge.ts
//         → src/editor/config.ts → 各节点模块 →（回到）那一层
//
// 环一旦闭合，`editor/config` 会在"还没轮到它自己求值完"时被求值 ⇒ `EDITOR_NODES` 里的节点类是
// undefined ⇒ 初始化期就抛 `TypeError: Cannot read properties of undefined (reading 'getType')`
// ⇒ **任何 import 到那一层的套件整文件 FAIL**（当时 vitest 9 个文件、`smoke-web`、`two-device-sync` 同时红，
// 而且看起来像"环境坏了"，不是断言红）。
//
// 而且这条依赖本身就违反本仓既有纪律：**那一层不许把整张编辑器节点表拖进自己的依赖图**
// （`contentText.ts` 那条老坑，见 `docs/development.md`：它会进 node 侧与 AI 核心包）。
//
// ⇒ 口径与另外两处同源（`derivedStores` 注入 AI 宿主、正文修复由编辑器侧算完再交回）：
//   **那一层只认一个函数签名，实现由"有编辑器的那一侧"在启动时注册**（`src/main.tsx`）。
//
// ⚠️ 另一个理由（这条**只对下面这一半**成立）：`src/lib/platform/web.ts`（收载荷的那一端）会被
//   **Node 侧脚本**加载（`verify-two-device-sync` 这类）⇒ 它一旦 import `crdt/pageBinding`
//   （→ `yDocBridge` → 整张编辑器节点表），那些脚本就会把编辑器节点表一起拖进 Node 进程。
import type { ContentSql } from "../docContent";

// =====================================================================================
// S4b-1b（2026-09-23）：**远端来的状态怎么落地** —— 注入，理由见文件头。
// =====================================================================================

/** 远端状态落地：由"有编辑器的那一侧"注册（生产 `src/main.tsx` ⇒ `mergeRemotePageState`）。 */
export type CrdtRemoteApplier = (db: ContentSql, pageId: string, state: Uint8Array) => void;

let remoteApplier: CrdtRemoteApplier | null = null;

/** 界面侧在启动时注册。 */
export function setCrdtRemoteApplier(fn: CrdtRemoteApplier): void {
  remoteApplier = fn;
}

/**
 * 把**远端载荷里带来的**状态落到本机这一页。
 *
 * ⚠️ 没注册 ⇒ **如实抛**（不静默吞掉那一版 —— 吞掉就是丢更新）。
 * ⚠️ 只该由**同步路径**调用（`web.ts::applyChange` 的页面分支）。
 */
export function applyRemoteCrdtState(db: ContentSql, pageId: string, state: Uint8Array): void {
  if (!remoteApplier) {
    throw new Error(
      "远端 CRDT 状态没有注册落地实现：界面侧应在启动时调 setCrdtRemoteApplier(...)（见 src/main.tsx）。" +
        "同步路径不许自己去 import 实现 —— 那会把编辑器节点表拖进 Node 侧脚本的依赖图。",
    );
  }
  remoteApplier(db, pageId, state);
}
