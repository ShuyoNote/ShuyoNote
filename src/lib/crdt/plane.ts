// Slice B 的**平面开关**：把"保存/加载要不要经过 ydoc 平面"收成一个默认关闭的开关
// （施工单 `docs/plans/2026-09-23-crdt-slice-b-workorder.md` §2/§3）。
//
// 本文件**只做一件事**：提供开关 ＋ 一个"关着时**逐字节原样返回**"的薄壳；实现由**界面侧注入**。
//
// ★★ 为什么实现必须是注入的（2026-09-23 修；`b49c9ed2` 的接线就是这么炸的）
//
// 静态 import 那一层的实现会造出一个**模块初始化环**：
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
//   没注册而开关开着 ⇒ **如实报错**，不静默退化成恒等（那会让"开了但没生效"变成静默丢数据）。

/** 平面实现：把一个**落盘形态**的字符串往返一次（返回同一形态）。 */
export type CrdtPlaneImpl = (stored: string) => string;

/** 已注册的实现；`null` ＝ 还没注册（默认关的时候永远用不到它）。 */
let impl: CrdtPlaneImpl | null = null;

/** 界面侧在启动时注册实现（生产：`src/main.tsx`；判据：直接喂桩或喂真实现）。 */
export function setCrdtPlaneImpl(fn: CrdtPlaneImpl): void {
  impl = fn;
}

/**
 * 默认**关闭**。
 *
 * ⚠️ 语义只有一条，判据也只看这一条：**关着的时候，任何输入都必须原样出来**
 * （不是"内容等价"，是**逐字节**）。迁移不许改未开启用户的行为。
 */
let enabled = (() => {
  try {
    return String(import.meta.env?.VITE_CRDT_PLANE ?? "") === "1";
  } catch {
    return false;
  }
})();

export function isCrdtPlaneEnabled(): boolean {
  return enabled;
}

/** 只给判据/将来的设置项用：显式开关这个平面（默认值就是 false）。 */
export function setCrdtPlaneEnabled(next: boolean): void {
  enabled = !!next;
}

/**
 * 让一份**落盘形态**的正文 JSON 过一遍（或不经过）CRDT 平面。
 *
 * - 关着：**原样返回同一个字符串**（同一引用 —— 判据据此断言"逐字节"而不是"内容等价"）；
 * - 开着：调**注册进来的**那一层实现往返一次；没注册 ⇒ 抛（见文件头：不静默退化成恒等）。
 */
export function throughCrdtPlane(stored: string): string {
  if (!enabled) return stored;
  if (!impl) {
    throw new Error(
      "CRDT 平面已开启但没有注册实现：界面侧应在启动时调 setCrdtPlaneImpl(...)（见 src/main.tsx）。" +
        "这一层不许自己去 import 实现 —— 那会造出模块初始化环（见 crdt/plane.ts 文件头）。",
    );
  }
  return impl(stored);
}
