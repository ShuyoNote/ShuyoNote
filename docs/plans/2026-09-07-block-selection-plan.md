# 块操作 / 块多选体系（A 手柄 · B 多选模式 · C 空白框选）

> 2026-09-07 · 落地于 v1.84.0。目标：**多块选择不干扰正常文字选择**——块操作只认**独立、与文字手势不重叠**的触发，文本区永远是标准文字选择。

## 设计原则

> 块多选只能由**独立控制区 / 显式模式**触发，绝不把手势启发式放在文本/正文画布上默认接管。

- 文字选中永远最优先：在**文本字上按下 → 标准文字选择**（浏览器原生）。
- 块操作只认：手柄（沟槽里）、多选模式（显式开关）、页面空白/空块框选。
- 此前冲突的根源：**用和文本重叠的手势**（右键菜单、正文拖拽橡皮筋）触发块选，必然会劫持文本选中。

## 三个入口

**A. 沟槽手柄 + Shift（默认，零冲突）**
块左侧悬停出现 `⋮⋮`（在沟槽、不覆盖正文）。**单击**弹出「块操作」菜单（复制/删除/清空选择）；**Shift+点**连续多选；**按住拖动**排序；**多选模式下隐藏手柄**（改为点块选块）。命中区经 `::before` 只向左/上下扩，**右侧留 4px 缝隙**，绝不伸进正文；拖选文字时自动隐藏手柄。

**B. 显式「多选模式」**
底部条「多选模式」按钮或 `Mod/Ctrl+Shift+M` 切换。开启后**点任何块=加入/移出选择**，文本编辑暂时让位；底部「已选 N 块」条提供复制/删除/清空/退出。语义与文本手势彻底分开，大范围多选好用。

**C. 空白处框选（橡皮筋，仅安全区触发）**
只有在**页面空白 / 内容根 / 边距 / 无文字空块**（`e.target` 非文本节点、且不在**含文字**的块内）按下才武装 marquee；拖拽画蓝色框并选中覆盖的块；单击（<6px）把光标放到最近块。**落在文字上是标准文字选择**，绝不劫持。

## 判别标准（文字优先）

`isSafeMarqueeTarget(target)`：
- `e.target` 是**文本节点** → 文字选择（不武装）。
- `e.target` 在**含可见文字**的块（`p/h/li/blockquote/td…` 且 `textContent.trim()` 非空）内 → 文字选择。
- 其余（内容根/外壳/边距、无文字空块）→ 武装框选。

## 文件

- `src/store/blockSelection.ts`：`keys` / `anchor` / `selectMode` + `setKeys`/`toggleKey`/`setSelectMode`/`clear`。
- `src/editor/plugins/BlockDragPlugin.tsx`：A 手柄（菜单/Shift/拖拽）+ 多选模式隐藏手柄 + 拖选隐藏手柄。
- `src/editor/plugins/BlockSelectionPlugin.tsx`：B 多选模式 + 底部批处理条 + 高亮 + 键盘（Del 删块 / Esc 清出 / Mod+Shift+M）。
- `src/editor/plugins/ClickToEditPlugin.tsx`：C 空白框选 + 空白单击放光标；`isSafeMarqueeTarget` 判别。
- `src/editor/blockUtils.ts`：`$deepCloneBlock`（递归深拷贝 + 新 key，修复 `$cloneWithProperties` 保留同 key 导致的「重复 key」复制报错）。
- `src/App.css`：`.block-handle` / `.block-grip-menu` / `.block-selection-bar` / `.block-box-select` 样式。

## 已移除 / 修复

- **块选右键菜单**（block-context-menu）：与系统右键/文本选中冲突，移除。
- **正文拖拽橡皮筋**：改为仅页面空白/空块触发（C），避免劫持文本选中。
- **文本格式工具条（B/I/U/S/<>）点击失效**：`.selection-toolbar` 纳入 mousedown 排除，点击不再被框选/清选劫持、不折叠选区。
- **块复制报错**：`$cloneWithProperties` → `$deepCloneBlock`。

## 边界

- 表格 / 分栏等复杂块在 `$deepCloneBlock` 下可插入但结构复制可能不完整（不报错）；后续按需加固。
- 多选模式下点击块即选，无法同时输入文字；`Esc` 退出恢复编辑。
