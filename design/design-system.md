# ShuyoNote 设计系统 v2.0

> 参考 FlowUs（明快蓝 + 中性面 + 圆角卡片）与 Wolai（多彩标签 + emoji + 活泼色块），
> 在现有 v1.0 基础上收敛出一套统一、克制、可落地的设计语言。
> 所有 token 与现有 `src/App.css` 的变量一一对应，可直接替换。

---

## 1. 设计原则

1. **内容优先**：界面退到背景，让笔记内容成为视觉重心；装饰只服务于层级与导航。
2. **本地优先的「安心感」**：保存状态、同步状态、备份状态要可感知、可信任（清晰的成功/失败反馈）。
3. **一致的节奏**：一套间距、圆角、阴影、动效贯穿所有界面，避免「每个组件各写一套」。
4. **克制的色彩**：中性灰负责结构，品牌蓝只用于「焦点/行动」，多彩色只用于「分类/状态」。
5. **可及性内建**：所有交互支持键盘，焦点可见，对比度达到 WCAG AA。

---

## 2. 色彩系统

### 2.1 品牌与中性色（浅色 / 深色）

| Token | 浅色 | 深色 | 用途 |
|---|---|---|---|
| `--accent` | `#3370FF` | `#4D8DFF` | 主行动、焦点、选中、链接 |
| `--accent-strong` | `#2952CC` | `#6BA0FF` | 主行动 hover/active |
| `--accent-soft` | `#EBF1FF` | `#22304A` | 选中背景、软高亮 |
| `--on-accent` | `#FFFFFF` | `#0B1220` | 主行动上的文字 |
| `--bg` | `#FFFFFF` | `#17181A` | 应用背景（编辑区） |
| `--bg-sidebar` | `#F7F8FA` | `#1F2023` | 侧边栏/面板背景 |
| `--surface` | `#FFFFFF` | `#242529` | 卡片、弹层背景 |
| `--border` | `#E5E8EE` | `#2E3034` | 常规分隔线 |
| `--border-strong` | `#D4D8DF` | `#3A3C41` | 强调分隔线、输入框边框 |
| `--text` | `#1F2329` | `#E6E8EB` | 主文字 |
| `--text-dim` | `#646A73` | `#9CA3AF` | 次要文字 |
| `--text-faint` | `#8F959E` | `#6B7280` | 占位、禁用、图标 |
| `--hover` | `#F2F3F5` | `#2A2B2E` | 悬停背景 |
| `--hover-strong` | `#E8EAED` | `#34353A` | 按下/选中 hover |

### 2.2 语义色

| Token | 浅色 | 深色 | 用途 |
|---|---|---|---|
| `--danger` | `#F54A45` | `#FF6B6B` | 删除、错误、危险操作 |
| `--danger-soft` | `#FDECEC` | `#3A2324` | 危险操作的背景 |
| `--success` | `#00B578` | `#2BD49B` | 保存成功、同步完成 |
| `--warning` | `#FF9A2E` | `#FFB04D` | 警告、待处理 |
| `--mark-bg` | `#FFF3CC` | `#4A3F1F` | 高亮/标记背景 |
| `--highlight-bg` | `#FFE08A` | `rgba(255,200,80,.45)` | 搜索高亮 |
| `--highlight-active-bg` | `#FFB347` | `rgba(255,150,40,.6)` | 搜索当前命中 |

### 2.3 分类色（标签 / 看板 / Callout）

借鉴 Wolai 的多彩表达，提供 8 个稳定的分类色。每个色提供「实色 + 浅底」两档，用于标签 chips、看板列头、Callout 左边框：

| 名称 | 实色 | 浅底 |
|---|---|---|
| 蓝 Blue | `#3370FF` | `#EBF1FF` |
| 绿 Green | `#00B578` | `#E7F8F1` |
| 橙 Orange | `#FF8A1E` | `#FFF1E5` |
| 红 Red | `#F54A45` | `#FDECEC` |
| 紫 Purple | `#7B61FF` | `#F0EDFF` |
| 青 Cyan | `#00A9C7` | `#E5F8FB` |
| 黄 Yellow | `#D9A300` | `#FBF3D9` |
| 灰 Gray | `#646A73` | `#EFF1F4` |

> 实现建议：标签/看板列用「实色圆点 + 文字」表达，避免大面积高饱和色块造成的视觉噪音；选中态才铺「浅底」。

---

## 3. 字体系统

### 3.1 字体族

| 角色 | 字体 |
|---|---|
| UI / 正文 | `-apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Helvetica Neue", sans-serif` |
| 等宽（代码） | `"SF Mono", "JetBrains Mono", Consolas, "Liberation Mono", monospace` |

> 可选增强：中文标题用 `"HarmonyOS Sans SC"` / `"MiSans"`（若系统已装），回退到系统字体。

### 3.2 字号 / 行高阶梯

| Token | 字号 | 行高 | 用途 |
|---|---|---|---|
| `--fs-caption` | 12px | 16px | 辅助说明、计数、kbd |
| `--fs-sm` | 13px | 20px | 侧栏项、标签、按钮次要 |
| `--fs-ui` | 14px | 22px | 常规 UI 文字 |
| `--fs-body` | 16px | 1.7 | 编辑器正文 |
| `--fs-h3` | 20px | 1.4 | 标题 3 |
| `--fs-h2` | 24px | 1.35 | 标题 2 |
| `--fs-h1` | 30px | 1.3 | 标题 1 |
| `--fs-title` | 36px | 1.2 | 页面标题（编辑区顶部） |

### 3.3 字重

- 常规 `400`、中等 `500`、加粗 `600`、强 `700`。
- 标题用 600–700，正文 400，强调用 500。

---

## 4. 间距

以 4px 为基数：

| Token | 值 | 用途 |
|---|---|---|
| `--space-1` | 4px | 紧凑内边距、图标与文字间距 |
| `--space-2` | 8px | 常规内边距、组内间距 |
| `--space-3` | 12px | 卡片内边距、相邻块间距 |
| `--space-4` | 16px | 面板内边距、区块间距 |
| `--space-5` | 24px | 大区块、弹层内边距 |
| `--space-6` | 32px | 页面级留白 |
| `--space-7` | 40px | 标题区上下留白 |
| `--space-8` | 64px | 空状态/大幅留白 |

---

## 5. 圆角

| Token | 值 | 用途 |
|---|---|---|
| `--radius-xs` | 4px | 行内元素（kbd、代码片段） |
| `--radius-sm` | 6px | 按钮、输入框、chips |
| `--radius-md` | 8px | 卡片、菜单、弹层 |
| `--radius-lg` | 12px | 大卡片、看板列、面板 |
| `--radius-full` | 999px | 圆形图标按钮、pill |

---

## 6. 阴影

| Token | 值 | 用途 |
|---|---|---|
| `--shadow-xs` | `0 1px 2px rgba(16,24,40,.06)` | 轻微浮起（按钮 hover） |
| `--shadow-sm` | `0 1px 3px rgba(16,24,40,.08), 0 1px 2px rgba(16,24,40,.04)` | 下拉、小弹层 |
| `--shadow-md` | `0 4px 16px rgba(16,24,40,.12)` | 命令面板、popover、slash 菜单 |
| `--shadow-lg` | `0 12px 32px rgba(16,24,40,.16)` | 模态、大浮层 |
| `--shadow-xl` | `0 24px 60px rgba(16,24,40,.22)` | 全屏遮罩上的核心弹层 |

> 深色模式下阴影加强（用更深的黑、更低的透明度），并给弹层加 `--border` 描边以在暗背景下形成边界。

---

## 7. 动效

| Token | 值 | 用途 |
|---|---|---|
| `--transition-fast` | `120ms cubic-bezier(.2,0,0,1)` | hover 颜色、图标 |
| `--transition` | `200ms cubic-bezier(.2,0,0,1)` | 展开/折叠、面板 |
| `--transition-slow` | `280ms cubic-bezier(.2,0,0,1)` | 弹层入场、抽屉 |

- 弹层入场：淡入 + 轻微上移（`opacity 0→1`、`translateY(4px)→0`）。
- 尊重 `prefers-reduced-motion`：关闭位移动画，保留淡入淡出。

---

## 8. 组件规范

### 8.1 按钮

| 变体 | 规格 |
|---|---|
| Primary | 背景 `--accent`，文字 `--on-accent`，圆角 `--radius-sm`，高 32px，内边距 `8px 14px`；hover `--accent-strong`；disabled `opacity:.45` |
| Secondary | 背景 `--hover`，文字 `--text`，边框 `--border`；hover `--hover-strong` |
| Ghost | 无背景无边框，文字 `--text-dim`；hover 背景 `--hover` 文字 `--text` |
| Icon | 28×28 圆角 `--radius-sm`，居中；hover 背景 `--hover` |

- 焦点态统一：`outline: 2px solid var(--accent); outline-offset: 2px`。

### 8.2 输入框

- 高 32px，圆角 `--radius-sm`，边框 `1px solid var(--border-strong)`，背景 `--surface`。
- 聚焦：边框 `--accent` + `box-shadow: 0 0 0 3px var(--accent-soft)`。
- 占位文字 `--text-faint`。

### 8.3 标签 Chip

- 高 24px，圆角 `--radius-full`，浅底分类色，文字实色；带移除按钮（hover 显示）。
- 添加标签用虚线边框的输入 chip，聚焦转实线。

### 8.4 卡片（看板 / 搜索结果）

- 背景 `--surface`，边框 `1px solid var(--border)`，圆角 `--radius-md`。
- 悬停：`box-shadow: var(--shadow-xs)` + 边框 `--border-strong`。
- 拖拽中：`opacity:.6` + 虚线边框。

### 8.5 弹层（popover / 菜单 / 命令面板 / slash 菜单）

- 背景 `--surface`，边框 `1px solid var(--border)`，圆角 `--radius-lg`，阴影 `--shadow-md`。
- 列表项高 36px，内边距 `8px 12px`，悬停/选中背景 `--accent-soft`（或 `--hover`）。
- 命令面板固定宽度 560px，顶部搜索框 + 分组列表，底部快捷键提示。

### 8.6 侧边栏树项

- 高 32px，圆角 `--radius-sm`，缩进 `depth × 16px + 8px`。
- 图标：文件 `📄` / 文件夹 `📁`，展开箭头 `▾/▸`。
- 当前项：背景 `--accent-soft` + 文字 `--accent`；hover 显示行内操作（打开新窗口 / 新建子页 / 删除）。

### 8.7 状态反馈（Toast）

- 底部居中，背景 `--text`（浅色）/ `--surface`（深色），文字反色，圆角 `--radius-md`，阴影 `--shadow-md`。
- 成功带 `--success` 图标，失败带 `--danger`；3 秒自动消失。

---

## 9. 无障碍（WCAG AA）

1. **对比度**：正文 `--text` 对 `--bg` ≥ 7:1；次要文字 ≥ 4.5:1。
2. **焦点可见**：所有可交互元素有 2px `--accent` 焦点环，永不 `outline:none`（除非有等价替代）。
3. **键盘**：`Ctrl+K` 命令面板、`Ctrl+F` 查找、`Ctrl+N` 新建、菜单内 `↑/↓` 导航、`Enter` 确认、`Esc` 关闭。
4. **状态不只靠颜色**：删除用图标+文字，选中用背景+文字共同表达。
5. **动效**：支持 `prefers-reduced-motion`；弹层不纯靠位移动画传达信息。
