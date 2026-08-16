# ShuyoNote UI/UX 落地实现计划

> 将 `design-system.md` 中的 token 与组件规范，逐文件落地到现有 React + CSS 代码。
> 原则：**先 token 后组件**、**纯 CSS 优先（不动组件结构）**、**破坏性交互保持二次确认**。

---

## 阶段 0：Token 替换（`src/App.css`）

### 0.1 `:root` 变量替换

| 现有变量 | 现值 | 新值 |
|---|---|---|
| `--accent` | `#2383e2` | `#3370FF` |
| `--bg-sidebar` | `#f7f7f5` | `#F7F8FA` |
| `--border` | `#e6e6e4` | `#E5E8EE` |
| `--text` | `#37352f` | `#1F2329` |
| `--text-dim` | `#9b9a97` | `#646A73` |
| `--text-faint` | `#c0bfbc` | `#8F959E` |
| `--hover` | `#efefed` | `#F2F3F5` |
| `--hover-strong` | `#e6e6e4` | `#E8EAED` |
| `--danger` | `#e03e3e` | `#F54A45` |
| `--code-bg` | `#f1f1ef` | `#F2F3F5` |
| `--codeblock-bg` | `#f7f7f5` | `#F7F8FA` |
| `--callout-bg` | `#f1f8fe` | `#EBF1FF` |
| `--callout-border` | `#d3e5f7` | `#C4D6FF` |
| `--block-hover` | `#f7f7f5` | `#F7F8FA` |

### 0.2 新增变量

```css
:root {
  --accent-strong: #2952CC;
  --accent-soft: #EBF1FF;
  --border-strong: #D4D8DF;
  --surface: #FFFFFF;
  --danger-soft: #FDECEC;
  --success: #00B578;
  --warning: #FF9A2E;
  --radius-full: 999px;
  --shadow-xs: 0 1px 2px rgba(16,24,40,.06);
  /* 8 个分类色 */
  --cat-blue: #3370FF;   --cat-blue-soft: #EBF1FF;
  --cat-green: #00B578;  --cat-green-soft: #E7F8F1;
  --cat-orange: #FF8A1E; --cat-orange-soft: #FFF1E5;
  --cat-red: #F54A45;    --cat-red-soft: #FDECEC;
  --cat-purple: #7B61FF; --cat-purple-soft: #F0EDFF;
  --cat-cyan: #00A9C7;   --cat-cyan-soft: #E5F8FB;
  --cat-yellow: #D9A300; --cat-yellow-soft: #FBF3D9;
  --cat-gray: #646A73;   --cat-gray-soft: #EFF1F4;
}
```

### 0.3 `[data-theme="dark"]` 同步替换

对应更新 `--accent: #4D8DFF`、`--bg: #17181A`、`--bg-sidebar: #1F2023`、`--text: #E6E8EB`、`--border: #2E3034` 等（详见 `design-system.md` §2）。

### 0.4 全局新增

```css
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
```

---

## 阶段 1：组件样式改造（`src/App.css`，纯 CSS）

| 组件 | 改动 | 关键点 |
|---|---|---|
| 按钮 `.btn-new/.pill-btn/…` | 统一 32px 高、圆角 `--radius-sm`，primary 用 `--accent` | 新增 `.btn-primary/.btn-ghost/.btn-danger` 变体类 |
| 输入框 `.search-input/.title-input` | 聚焦态 `box-shadow: 0 0 0 3px var(--accent-soft)` | 复用统一 focus 规则 |
| 树项 `.tree-row` | 高 32px、圆角 `--radius-sm`；active 用 `--accent-soft`+`--accent` 文字 | 行内操作 hover 才显示 |
| 标签 `.tag-chip` | pill 形、分类色浅底 + 实色文字 | 需要给 tag 分配分类色（见阶段 3） |
| 看板 `.board-column/.board-card` | 列 `--bg-sidebar`、圆角 `--radius-lg`；卡片 `--surface`+`--shadow-xs` | 拖拽高亮用 `--accent-soft` |
| 命令面板 `.palette` | 圆角 `--radius-lg`、阴影 `--shadow-lg`、分组标题 + 底部快捷键 | 选中项 `--accent-soft` |
| slash 菜单 `.slash-menu` | 同面板风格、图标 badge | 选中项高亮 |
| 查找栏 `.find-bar` | 圆角 `--radius-md`、阴影 `--shadow-md` | 保持右上角 |
| popover（历史/回收站/同步） | 圆角 `--radius-lg`、阴影 `--shadow-md` | 统一入场动画 |
| 编辑器块（h1/h2/h3/quote/callout/code/table/todo） | 新配色 + 圆角 + 间距 | callout 用 `--callout-bg` |

---

## 阶段 2：新增 Toast 反馈系统

**现状**：大量 `alert()`/`confirm()` 直接弹窗，体验生硬。

**改动**：
1. 新建 `src/components/Toast.tsx`：底部居中、3 秒自动消失、成功/失败两种样式（`--success`/`--danger`）。
2. 新建 `src/store/toast.ts`（Zustand）：`show(msg, kind)`。
3. 在 `App.tsx` 挂载 `<Toaster />`。
4. 替换以下 `alert()`/`confirm()`：
   - `BackupButton.tsx`：备份/恢复结果 → toast（破坏性确认保留 `confirm` 或换成内联确认）。
   - `SyncPanel.tsx`：同步结果 → toast。
   - `TrashPanel.tsx`/`HistoryPanel.tsx`：操作结果 → toast（删除/恢复版本仍保留二次确认）。
   - `PageTree.tsx`：删除确认保留 `confirm`。

---

## 阶段 3：标签/看板分类色

1. `src/types.ts` 或 `TagBar.tsx`：给 tag 增加可选 `color` 字段（默认按名称 hash 到 8 个分类色）。
2. `TagBar.tsx`：chip 用 `--cat-*-soft` 底 + `--cat-*` 圆点。
3. `BoardView.tsx`：列头圆点用分类色。
4. `PageTree.tsx` 侧栏标签区：同步分类色。

> 若后端 tags 表无 color 字段，可在前端按 `name` 稳定 hash 分配，避免改 schema（v2 阶段再落库）。

---

## 阶段 4：命令面板增强

`CommandPalette.tsx`：
1. 支持 `↑/↓` 键盘导航、`Enter` 执行、`Esc` 关闭（当前只支持 Ctrl+K/Esc）。
2. 分组渲染：页面 / 命令（当前 `getAllCommands()` 平铺）。
3. 底部快捷键提示条（`↑↓ 导航 · Enter 确认 · Esc 关闭`）。
4. 空结果态、加载态。

---

## 阶段 5：空态 / 骨架屏

| 界面 | 现状 | 改动 |
|---|---|---|
| 空工作区 | 已有 CTA | 视觉对齐新 token |
| 搜索下拉 | 有「搜索中/无结果」 | 结果项加卡片样式 + hover 高亮 |
| 看板列空 | 有提示 | 虚线边框占位 |
| 页面树加载 | 无骨架 | 加 3 行浅灰骨架（CSS 动画） |
| 版本/回收站空 | 有文案 | 加图标居中空态 |

---

## 验收标准（Definition of Done）

1. **视觉一致**：所有界面使用同一套 token，无硬编码旧色值（`grep` 无 `#2383e2`/`#f7f7f5`/`#37352f`）。
2. **主题**：亮/暗两套 token 完整，切换即时、无残留旧色。
3. **键盘可达**：`Ctrl+K`/`Ctrl+F`/`Esc` 正常，面板内 `↑↓` 导航可用，`Tab` 焦点环可见。
4. **反馈闭环**：保存/同步/备份/导入/删除/恢复均有 toast；破坏性操作有二次确认。
5. **空/加载/错误态**：5 类界面均有对应状态，无白屏。
6. **回归**：`pnpm build`（tsc+vite）通过；编辑器拖拽块、树拖拽、看板拖卡、搜索高亮、查找、导出均正常。
7. **无障碍**：正文对比度 ≥ 7:1、次要文字 ≥ 4.5:1；支持 `prefers-reduced-motion`。

---

## 落地顺序建议

1. 阶段 0（token）→ 全量视觉一次到位。
2. 阶段 1（CSS 组件）→ 与 token 同批提交。
3. 阶段 2（Toast）→ 独立提交，替换 alert。
4. 阶段 3（分类色）→ 独立提交。
5. 阶段 4/5（命令面板 + 空态）→ 收尾提交。

每阶段一个 commit，便于回滚与 review。
