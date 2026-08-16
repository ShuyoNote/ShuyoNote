# ShuyoNote UI/UX 设计交付

> 参考 **FlowUs**（明快蓝 + 中性面 + 圆角卡片）与 **Wolai**（多彩标签 + emoji + 活泼色块），
> 为本地优先的类 Notion 笔记应用 ShuyoNote 设计的一套完整 UI/UX。

## 目录

| 文件 | 内容 |
|---|---|
| [`design-system.md`](./design-system.md) | **① 设计系统**：色彩/字体/间距/圆角/阴影/动效 tokens + 组件规范 + 无障碍 |
| [`ux-flows.md`](./ux-flows.md) | **② UX 流程**：12 条用户旅程 + 空/加载/错误/边界态 |
| [`prototype/index.html`](./prototype/index.html) | **③ 可点击高保真原型**（单文件，双击即开） |
| [`implementation-plan.md`](./implementation-plan.md) | **④ 落地实现计划**：文件级改造清单 + 验收标准 |

## 快速体验原型

直接双击打开 `prototype/index.html`（无需构建、无需联网）。

**可以试**：
- `Ctrl+K` 命令面板 · `Ctrl+F` 查找栏 · `Esc` 关闭
- 底部悬浮栏切换：笔记/看板、回收站、同步设置、版本历史、斜杠菜单、暗色主题
- 悬停编辑器任意块 → 左侧出现 `⋮⋮` 拖拽手柄
- 看板列支持拖拽卡片（演示）
- 侧栏树项点击选中、hover 显示行内操作

## 设计基调一句话

**内容优先、克制的色彩、一致的节奏、可及性内建**——中性灰搭结构，品牌蓝 #3370FF 只做「焦点与行动」，多彩色只做「分类与状态」。
