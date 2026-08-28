# 「帮助系统」方案（M25，规划/建议，未实装）

> 一句话：ShuyoNote 是**本地优先、键盘驱动、面向知识工作者**的笔记工具，帮助不该做成"客服中心/文档门户"，而应是**就地、可分、可搜索、离线可用**的四层；且**最好的帮助是用它自己的笔记体系写出来的**——帮助页 = 一篇可编辑的笔记，能 FTS 检索、能导出、能双链。
> 状态：**规划**（设计稿 + 分层 + MVP 切割），**未实装**。

---

## 1. 背景与判断

- **用户画像**：知识工作者 / 研究者，熟悉 Notion·Obsidian，**键盘驱动**，学习快，讨厌打断。
- **产品特性**：本地优先、离网可用；功能面广（块编辑 / 分栏 / 表格 / 数据库 / 绘图 / AI / 同步 / 加密）。
- **现状已有的"就地帮助"**：命令面板 `Ctrl+K`、斜杠 `/` 菜单、`NewPageGuide` 空库引导、大量 tooltip、占位符「输入 '/' 选择，按 '空格' 打开 AI…」、`/待办`等快捷键。**底座够，缺体系化。**

三个判断：
1. **帮助 = 发现能力 + 一次解决**。能力靠命令面板/斜杠/"+"（已有），"一次解决"靠简短就地提示 + 快捷键表 + 内置指南页。
2. **最好用笔记本身承载帮助**：帮助页是一篇可编辑/可删/可搜索的笔记，而不是硬编码文档——这符合"本地优先"且让帮助内容与用户内容同源、同检索、同导出（连静态 wiki 导出 M21 都能复用）。
3. **别做重帮助中心**（Zendesk/在线工单）——本地工具没这必要，且违背"离网可用"；深度内容走"指南页 + 导出/外部站"。

**结论：四层，先做 P0（快捷键面板 + /帮助命令），再 P1（内置使用指南页），P2（外部静态站，可选）。**

---

## 2. 四层帮助体系（按 ROI 排序）

| 层 | 形式 | 入口 | 优先级 | 状态 |
|----|------|------|--------|------|
| **P0 · 就地提示** | 命令面板 / 斜杠 / `+` / 占位符 / tooltip / 空态 | `Ctrl+K`、`/`、空库引导 | **最高** | 底座已有，补全 |
| **P0 · 快捷键面板** | 全量快捷键浮层，按分组、可搜 | `?` / `Ctrl+/` | **最高** | 未做 |
| **P1 · 内置「使用指南」页** | 一篇可编辑笔记（功能/快捷键/示例），FTS 可搜 | `Ctrl+K`/`/帮助`/空库引导 | 高 | 未做 |
| **P1 · 首次体验清单** | 新手 checklist（建页/编排库/建数据库/AI） | 空库引导 | 中 | 未做 |
| **P2 · 外部帮助站点** | 静态文档站（复用 M21 静态 wiki 导出） | 站外 | 可选 | 未做 |

> **不做**：在线工单/客服、应用内长篇文档、打断式引导弹窗。

---

## 3. 范围与 MVP 切割

### P0（本轮建议优先）
1. **快捷键面板**：`?`（或 `Ctrl+/`）呼出浮层，读集中定义的快捷键表（分组：基础 / 列表 / 格式 / 导航 / AI），可按名称搜索；不复用插件里零散的 `INSERT_SHORTCUTS`，而是**抽一张 `src/lib/shortcuts.ts` 单一来源**，供面板 + tooltip + 文档共用。
2. **`/帮助` 命令**：斜杠/命令面板里「帮助」——打开内置「使用指南」页（不存在则一键创建）。

### P1（下一批）
3. **内置「使用指南」页**：用模板中心 `built_in` 模板做一篇指南页（功能清单 / 快捷键表 / 示例块：分栏、表格、绘图、数据库视图、AI）。可编辑、可删。
4. **新手指南清单**：空库引导补一份可勾掉的 checklist。

### P2（可选，看是否需要公开）
5. **帮助站点**：把「使用指南」页经 M21 静态 wiki 导出成网页；纯发现渠道，不是主形态。

---

## 4. 技术方案（复用底座，不新起体系）

- **命令面板 / 斜杠**：现有 `BlockInsertPlugin.makeOptions` + 命令面板已注册 AI/插件命令；加「帮助」入口即可（`openPage(指南页id)`）。
- **模板中心 built_in**：现有 `templates` 表 + `built_in` 模板（M9）。指南页作为一个 `built_in` 模板（`kind='page'`），可一键创建/恢复。
- **快捷键单一来源**：新增 `src/lib/shortcuts.ts`（`SHORTCUTS: { key, label, group, keys }[]`），供命令面板、`Ctrl+K`、tooltip、快捷键面板、文档共用。**这是把现在散落的快捷键统一定义**（如 `INSERT_CHECKKLIST_COMMAND` 的 `Ctrl+Alt+T`、`Ctrl+N`、`Ctrl+K` 等）。
- **帮助页 = 笔记**：用 `create_page`（或模板）建「使用指南」页，内容用现有块（heading/list/table/callout）表达；进 `content_text`（可搜）、可打标签、可双链。
- **浮层面板**：复用现有 `Popover`/`Modal`（命令面板、设置弹层的样式体系）做快捷键浮层。

### 数据/存储
- 快捷键表：纯 TS 常量（无后端改动）。
- 指南页：走现有 `pages` + `templates.built_in`（无新表，无新 Rust 命令，除可能新增 `open_guide` 到已有 `create_page`/模板拉取）。

---

## 5. 文件级改造清单（落地参考）

| 文件 | 改动 |
|------|------|
| `src/lib/shortcuts.ts`（新） | 快捷键单一来源：`SHORTCUTS`（key/label/group/keys），导出 `shortcutGroups()`/`shortcutSearch(q)` 纯函数 |
| `src/components/ShortcutsPanel.tsx`（新） | 快捷键浮层：分组展示 + 搜索，`?`/`Ctrl+/` 呼出 |
| `src/editor/Editor.tsx` 或全局 | 注册 `?` / `Ctrl+/` 快捷键 → 打开 `ShortcutsPanel`（`useEditorStore` 加 `shortcutsOpen`） |
| `src/editor/plugins/SlashMenuPlugin.tsx` | `makeOptions` 加 `help` 项（打开指南页）；工具提示引用 `shortcuts.ts` |
| `src/templates/index.ts` （或 `built_in` 数据） | 新增内置「使用指南」模板（`kind='page'`，含功能/快捷键/示例） |
| `src/components/NewPageGuide.tsx` | 空库引导加「打开使用指南 / 快捷键」入口 + 新手清单（可选） |
| `src/store/editor.ts` | 加 `shortcutsOpen`/`openShortcuts`/`openGuide` 状态与动作 |
| `scripts/smoke-web.mjs` | 新增 `shortcutGroups`/`shortcutSearch` 纯函数断言（键盘/分组），及指南页模板可创建断言 |

---

## 6. 验收标准（P0）

- 按 `?` 或 `Ctrl+/` 弹出快捷键浮层：分组正确、可按 key/value 搜索、上下键 + Enter 可聚焦；再按关闭。
- `Ctrl+K` / `/` 里出现「帮助」，点开能在当前空间打开「使用指南」页；若无则一键创建（built_in 模板）。
- 「使用指南」页内容正确、可编辑，`content_text` 进全文检索，可双链/打标签。
- 快捷键表单一来源：改 `shortcuts.ts` 一处，命令面板/浮层/文档同步。
- `npx tsc --noEmit` / `node scripts/smoke-web.mjs`（`.` 纯函数断言基础上只增不减全绿）/ `pnpm build` / `cargo check`（无新 Rust 命令则不变）。

---

## 7. 边界与诚实标注

- **不做在线客服 / 工单 / 分析**：本地优先，站外帮助仅作发现渠道。
- **指南页是"活"笔记**：用户可改可删；若删了，`/帮助` 重新创建（built_in 模板兜底），不会破坏应用。
- **帮助内容 ≠ `docs/`**：`docs/` 是工程/贡献者文档；用户帮助独立，不混用。开发贡献文档仍在 `docs/`。
- **不打断**：帮助走命令面板/浮层/页面，不做强引导弹窗。
- **多语言**：P0 用中文（当前用户）；i18n 不在本阶段。

---

## 8. 下一步（若立项）

1. 先 `src/lib/shortcuts.ts`（单一来源）+ `ShortcutsPanel`（P0，纯前端）。
2. `/帮助` + 内置「使用指南」模板（P1）。
3. 空库引导 + 新手清单。
4. （可选）M21 静态 wiki 导出做站外帮助。

---

## 9. 细化设计（可直接照做）

### 9.1 `src/lib/shortcuts.ts` 数据结构（单一来源）
```ts
export type ShortcutGroup = "基础" | "编辑器" | "列表" | "导航" | "AI";
export interface Shortcut {
  key: string;                 // 稳定 id，如 "new-page"
  label: string;               // 中文，如 "新建页面"
  group: ShortcutGroup;
  keys: string[];              // 展示用组合，如 ["Ctrl", "N"]
  macKeys?: string[];          // 可选 mac 组合
  when?: string;               // 可选作用域说明，如 "在编辑器中 / 全局"
}
export const SHORTCUTS: Shortcut[] = [...];
export function shortcutGroups(): ShortcutGroup[];              // 按固定顺序去重
export function shortcutSearch(q: string): Shortcut[];          // 匹配 label/key/keys，忽略大小写
export function shortcutLabel(s: Shortcut): string;             // "⌘/Ctrl + N" 格式化
```

> 纯函数，`smoke-web.mjs` 直接断言（分组完整、去重、搜索命中/空）。

### 9.2 快捷键清单（权威列表，来自现有实现）
**基础**
| 键 | 动作 | 来源 |
|----|------|------|
| `Ctrl+N` | 新建页面 | 全局 |
| `Ctrl+K` | 命令面板 | 全局 |
| `Ctrl+Shift+F` | 聚焦搜索 | 全局 |
| `Ctrl+E` | 循环 笔记/看板/关系图 视图 | 全局 |
| `Ctrl+F` | 编辑器内查找 | 编辑器 |
| `Esc` | 关闭查找/命令面板/浮层 | 全局 |
| `/` | 斜杠菜单 | 编辑器 |
| `?` / `Ctrl+/` | 快捷键面板（本次新增） | 全局 |

**编辑器（Ctrl+Alt）** `InsertShortcutPlugin`
| 键 | 动作 | 键 | 动作 |
|----|------|----|------|
| `Ctrl+Alt+1/2/3` | 标题 1/2/3 | `Ctrl+Alt+U` | 无序列表 |
| `Ctrl+Alt+O` | 有序列表 | `Ctrl+Alt+T` | 待办 |
| `Ctrl+Alt+Q` | 引用 | `Ctrl+Alt+C` | 代码块 |
| `Ctrl+Alt+L` | 链接 | `Ctrl+Alt+M` | 分隔线 |

**列表/格式（编辑器内 Markdown 快捷）**：`- ` 无序、`1. ` 有序、`[] ` 待办、`# ` 标题、`> ` 引用、``` ``` ` 代码块（由 `MarkdownShortcutPlugin` 处理，可作提示项）。

**导航/AI**
| 键 | 动作 | 来源 |
|----|------|------|
| `Ctrl+K` | 命令面板 | 全局 |
| `Ctrl+Shift+P`? |（若后续加） | — |
|（AI 起草 `空格`/`Ctrl+Alt+…`） | 见 `InlineAiDraftBar` | 待补 |

> 最终以代码为准；本表是 `shortcuts.ts` 的初始内容，后续新增/改统一在这里。

### 9.3 `ShortcutsPanel` 交互细则
- **呼出**：`?` 或 `Ctrl+/`（全局，非输入框内时）。`useEditorStore` 加 `shortcutsOpen`；`openShortcuts/closeShortcuts`。
- **布局**：复用 `dialog`/`modal` 覆盖层（同 `CommandPalette`/`AiSettingsDialog` 的 `.modal` 体系）。
  - 顶部：标题「快捷键」+ 搜索框（聚焦）。
  - 主体：**左侧分组导航**（基础/编辑器/列表/导航/AI，点击或方向键切换），**右侧当前组快捷键列表**（`keys` 徽章（kbd 样式）+ label）。或简化：**单一列表按分组折叠**。
  - 空态：搜不到 → 「未找到匹配的快捷键」。
- **键盘**：`Esc`/再按 `?` 关闭；`↑/↓` 在列表移动焦点；`Enter` 无操作（纯展示）；`/` 聚焦搜索。
- **触达**：不打断；点背景关闭。
- **样式**：`App.css` 新增 `.shortcuts-*`（kbd 胶囊、分组标题、hover 高亮、深浅主题）。

### 9.4 内置「使用指南」页内容大纲（块级，`built_in` 模板）
- `H1` **ShuyoNote 使用指南**
- `引用` 一句话定位（本地优先 · 类 Notion · 离线可用）。
- `H2` **快速开始**：新建页面 / 用 `/` 或 `+` 插入块 / 分栏 `/分栏` / 保存（自动）。
- `H2` **快捷键**（表格：分组 + 键 + 动作，内容同 `shortcuts.ts`，手动同步一段）。
- `H2` **核心能力**（每个一块 + 一句示例）：
  - 页面树 / 文件夹 / 标签 / 双向链接 `[[标题]]` / 块引用 `((id))` / 块嵌入 `{{id}}`。
  - 属性 + 数据库视图（表格/画廊/看板/日历/时间轴/目录）；看板拖拽。
  - 表格交互；图片/附件/书签；绘图 `/绘图`；mermaid `/流程图`；AI 文生图。
  - 搜索（FTS + 语义，`Ctrl+K`/`Ctrl+Shift+F`）；反链；关系图。
  - 数据安全：自动保存 / 版本历史 / 回收站 / 备份 / 端到端加密；同步（自建 sync-server）。
- `H2` **进阶**：多工作空间；命令面板 `Ctrl+K`；AI 助手（`✦`，可选/本地模型）；模板 `/模板`；主题/暗色；导出 Markdown / HTML / PDF / wiki。
- `Callout` **提示**：数据全在本机；可用 `导入 Markdown` 迁移；`Esc` 关闭弹层。

> 指南页本身可编辑/删除；`/帮助` 若缺失则用 `built_in` 模板重建。

### 9.5 入口与状态（store）细则
- `useEditorStore` 增：`shortcutsOpen: boolean`、`openShortcuts/closeShortcuts`、`openGuide: () => Promise<void>`（`openPage(指南页id)`，无则 `create_page` 用模板内容）。
- 入口注册：
  - 命令面板：加「快捷键」「打开使用指南」两个命令（复用 `CommandPalette` 的 `useCommandPalette`/`makeOptions`）。
  - 斜杠 `/`：加 `help` 项（打开指南页）。
  - 全局键 `?`/`Ctrl+/`。
  - `NewPageGuide`（空库）：加「快捷键」「打开使用指南」按钮。
- 指南页 id 持久化：存 `localStorage`（`shuyonote.guide.pageId`）或每次按标题查找；模板 `built_in` 兜底。

### 9.6 实现顺序（P0 → P1）
1. `src/lib/shortcuts.ts`（SHORTCUTS + 纯函数）+ smoke 断言。
2. `ShortcutsPanel` + 全局 `?`/`Ctrl+/` + `useEditorStore.shortcutsOpen`。
3. `useCommandPalette`/`makeOptions` 加「帮助」「快捷键」入口。
4. 内置「使用指南」`built_in` 模板 + `/帮助` + `openGuide`。
5. `NewPageGuide` 空库入口 + 新手清单（可勾选）。
6. （可选）M21 导出指南页为站外帮助。

> 关联：命令面板/插件（M11）、模板（M9）、静态 wiki 导出（M21）、NewPageGuide（M8）。
