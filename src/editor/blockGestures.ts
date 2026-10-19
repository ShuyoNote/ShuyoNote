// 「块手势」的**共用排除清单** —— 唯一出处 ✓。
//
// 什么是"块手势"：块选（点块加入/移出）、框选（空白区拖出选择框）、拖块、点块进入编辑。
// 这些手势都在 **document 的捕获阶段**监听 mousedown ✓（比 React 的合成事件早 ✓）⇒
// 谁的手柄/浮层没被排除，按下它就等于"开始块手势" ✗。
//
// ⛔ **为什么必须有这一份共享清单**（两次真事故，同形）：
//  ① **2026-10-01**（owner 实测）：拖表格列宽 ⇒ 弹出「已选 1 块 ｜ 多选模式 ｜ 复制 ｜ 删除 ｜ 清空」。
//     当时给 `BlockSelectionPlugin` 的 mousedown 排除清单补了 `.table-resize-handle` ✓。
//  ② **2026-10-06**（owner 又实测，同一张截图形状：count「已选 1 块」＋ 按钮「多选模式」）：
//     **还是**复现 ✗ —— 因为同样的清单在仓里有**三份**（`BlockSelectionPlugin` /
//     `ClickToEditPlugin` 的框选 / `BlockDragPlugin` 的"点别处关菜单"），10-01 只补了其中**一份** ✓。
//     ⚠️ 第三处（关菜单）语义**不同**（那里问的是"要不要关菜单"，不是"能不能开始手势"）⇒ 故意没并进来 ✓，
//        但它同样是"清单副本"这个形状，将来若再往手柄上添东西，记得三处都过一遍 ✓。
//     这次真凶是 **`ClickToEditPlugin` 的框选**：`.table-resize-handle` 落在一个**空单元格**里
//     ⇒ `isSafeMarqueeTarget` 判它"空白安全区" ⇒ **拖列宽变成了拉选框** ✓（拖多远、选中几块）。
//   ⇒ 结论：这类清单**只许有一份**，加一处必须同时生效于所有块手势 ✓。
//
// ⚠️ 判定用 `closest` ✓ —— 命中的常常是手柄里的子元素（比如手柄上的一层 `::after` 命中区、
//    或包一层的 `<span>`）⇒ 必须往上找祖先 ✓，不能比 target 自己 ✓。
// ⚠️ `target` 可能是 **Text 节点**（点在文字上）⇒ 先取 `parentElement` 再 `closest` ✓；
//    取不到元素就**不算排除**（交回原逻辑 ✓，与旧行为一致 ✓）。
export const BLOCK_GESTURE_EXCLUDED_SELECTOR = [
  ".block-handle", // 块左侧的 ⋮⋮ 拖拽/菜单手柄
  ".block-grip-menu", // 手柄点开的那张"块操作"菜单
  ".block-selection-bar", // 底部那条「已选 N 块 ｜ 复制 ｜ 删除 ｜ 清空」
  ".block-select-mode-btn", // 上面那条里的「多选模式」按钮
  ".selection-toolbar", // 文字选中后的浮动工具条
  ".tag-picker", // 标签选择浮层
  ".slash-menu", // 斜杠菜单
  ".table-resize-handle", // ⭐ 表格列宽手柄（两次事故的主角 ✓）
  // ⭐⭐ 2026-10-12（owner：「表格工具栏功能失效了」）：**表格浮动工具栏 ＋ 它的调色板** ✗ ——
  //   少这两条 ⇒ 按按钮那一下被判成"空白安全区" ⇒ 起**框选** ⇒ 那条挂在 document 捕获上的
  //   `mouseup` **比 `click` 先跑** ⇒ 光标被挪出表格 ⇒ `TableMenuPlugin` 里 `if (ctx)` 整段跳过
  //   ＝ ⭐ **按钮点了没反应** ✓（就是用户看到的那一幕 ✓）。
  //   ⭐ 判据：`src/editor/tableMenu.test.tsx` 第②条（**先红过**：行数 2≠3、光标＝表格外 ✓）；
  //   A/B 实测：摘掉 `ClickToEditPlugin` ⇒ 那条转绿 ✓ ⇒ 真因是"这层没进清单"✓，⛔ 不是命令坏了 ✗。
  ".table-menu",
  ".table-palette",
  // ⭐⭐ **2026-10-19（owner：「多栏点不进去、没有光标」）**：**分栏那一格的编辑器** ✗ ——
  //   真因（CDP 实测，不是猜）：mousedown 目标是 `div.editor-column-editable` ⇒
  //   `ClickToEditPlugin` 的 `isSafeMarqueeTarget` 判它「空白安全区」（空格子里的 `<p>` 没文字
  //   ⇒ 按既有规则"空块仍算空白"）⇒ 它调 `preventDefault()` 起框选 ⇒ **浏览器默认聚焦被吃掉**
  //   ⇒ 光标进不了那一格 ✓（逐字堆栈：`at HTMLDivElement.onMouseDown (ClickToEditPlugin.tsx:80)`）
  //   ⇒ 分栏的编辑器是**要接受输入的地方**，⛔ 不是"空白背景" ⇒ 必须进这份清单 ✓
  //   ⚠️ `.editor-column-body` 一并兜住：格子内边距/空行的命中目标可能是它 ✓
  ".editor-column-editable",
  ".editor-column-body",
].join(", ");

/** 这个按下目标是不是"块手势该放行"的浮层/手柄（`true` ⇒ 谁都不许把它当成开始块选/框选）✓。 */
export function isBlockGestureExcluded(target: EventTarget | null): boolean {
  const el = target instanceof Element ? target : ((target as Node | null)?.parentElement ?? null);
  return !!el?.closest(BLOCK_GESTURE_EXCLUDED_SELECTOR);
}
