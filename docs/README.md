# ShuyoNote 文档体系

> 本地优先 · 类 Notion 的知识管理桌面应用（Tauri 2 + Lexical + SQLite）。
> 本目录是项目文档的**统一入口**，按主题组织全部设计、方案、规划与对比文档。

## 快速导航

| 我想了解… | 从这里开始 |
|---|---|
| 产品是什么、定位与目标用户 | [产品定位](positioning.md) |
| 功能怎么用、有哪些能力 | [README](../README.md) 功能清单 |
| **系统怎么搭起来的、分层与存储模型** | [系统架构](architecture.md) |
| 下一步做什么 | [路线图](roadmap.md) |
| 某功能的技术方案 | [方案与规划](#方案与规划-plans) |
| 与竞品相比如何 | [竞品对比](#竞品对比) |
| UI/UX 设计交付 | [设计交付](#设计交付-design) |
| 怎么构建 / 测试 / 提版 | [开发指南](development.md) |
| 版本演进 | [变更记录](#变更记录-changelog) |

## 目录结构

```
docs/
├── README.md            # 本文档：统一入口 / 导航 / 索引
├── development.md       # 开发指南：运行、测试、验证、提版规则
├── architecture.md      # 系统架构与存储模型
├── positioning.md       # 产品定位
├── design-philosophy.md # 设计哲学
├── roadmap.md           # 演进路线图（M1–M17 里程碑）
├── compare-*.md         # 竞品对比
└── plans/               # 各功能技术方案（按日期）
design/                  # UI/UX 设计交付（设计系统 / UX 流程 / 实现计划）
CHANGELOG.md             # 版本变更日志
```

## 产品与定位

| 文档 | 内容 |
|---|---|
| [architecture.md](architecture.md) | **系统架构**：前端 / 平台 driver（桌面 Tauri + 浏览器 Web）/ Rust 后端 / SQLite & 存储布局 / 同步服务端分层；数据模型、一致性边界与 ADR |
| [design-philosophy.md](design-philosophy.md) | **设计哲学**：page 本源 / 属性语义 / 数据库=透镜 / 文件夹=容器；从需求、定位、竞品对比、各功能方案与设计系统提炼的完整信条、取舍与边界 |
| [positioning.md](positioning.md) | **产品定位**：一句话定位、目标用户、差异化 |
| [roadmap.md](roadmap.md) | **演进路线图**：现状盘点、下一阶段优先级、M1–M15 里程碑规划（M1–M5、M7–M15 已达，M6/移动与 M11.3/M11.4 已评估未做）、竞品差距跟踪 |

## 方案与规划（plans）

| 文档 | 内容 |
|---|---|
| [plans/2026-08-15-local-first-note-app-plan.md](plans/2026-08-15-local-first-note-app-plan.md) | **本地优先笔记应用开发方案**：需求分析、数据模型、ADR、同步协议与路线图 |
| [plans/2026-08-20-block-reference-plan.md](plans/2026-08-20-block-reference-plan.md) | **块级引用 + 反链升级 + 关系图方案**（M1–M5 已实现） |
| [plans/2026-08-21-properties-database-plan.md](plans/2026-08-21-properties-database-plan.md) | **属性系统 + 数据库视图统一方案**（合并思源数据库 + Obsidian Properties） |
| [plans/2026-08-22-multi-workspace-plan.md](plans/2026-08-22-multi-workspace-plan.md) | **多工作空间方案**：隔离语义 + 查询 scope 修正 + 切换 UX（M10 已实现：隔离/切换/生命周期/每空间过滤；并演进为 M15 物理隔离） |
| [plans/2026-08-22-template-plan.md](plans/2026-08-22-template-plan.md) | **模板功能方案**：模板 = 结构预设，一键建带内容的页面/数据库 + 保存为模板（M9 已实现：建页填内容/保存为模板/共享打磨/数据库模板） |
| [plans/2026-08-22-plugin-plan.md](plans/2026-08-22-plugin-plan.md) | **插件功能方案**：磁盘加载的命令插件 + 受限白名单 API + 沙盒运行时 + 启停持久化（M11 已实现：插件底座/管理生命周期/可插入内容；L2 UI 型与 L3 市场已评估延后） |
| [plans/2026-08-22-folder-netdisk-plan.md](plans/2026-08-22-folder-netdisk-plan.md) | **「文件夹 = 网盘」方案**：文件夹同时承载页面与文件，拖拽上传 / 在线预览 / 搜索 / 下载 / 统计（M12 已实现：核心网盘 UX/拖拽移动/文件引用/文件版本，本地优先+去重+可加密） |
| [plans/2026-08-22-database-lens-plan.md](plans/2026-08-22-database-lens-plan.md) | **「数据库 = 透镜」贯通方案**：查询型数据库 / 多视图保存 / ref 关联属性 / 公式（M13 已实现：保存视图/查询型/ref 关联/公式列/跨库 rollup） |
| [plans/2026-08-22-storage-cleanup-plan.md](plans/2026-08-22-storage-cleanup-plan.md) | **空间清理 / 存储管理方案**：空间可归因统计 + 安全可控清理（M14 已实现：存储面板/清空回收站/清理孤立附件/版本/临时/软删空间） |
| [plans/2026-08-22-workspace-crud-plan.md](plans/2026-08-22-workspace-crud-plan.md) | **工作空间增删改补全方案**：种子默认首页 / 按 id 重命名 / 空间级设置（图标·主题·排序）/ 删除前导出提醒（M10.2b 已并入 M10；物理清理归 M14） |
| [plans/2026-08-22-per-workspace-storage-plan.md](plans/2026-08-22-per-workspace-storage-plan.md) | **每工作空间独立存储（物理隔离）方案**：`meta.db` + `spaces/<ws_id>/` 每空间库；单空间可搬移/单独备份/单独加密；安全分阶段拆库迁移（**M15 已达成**：M15.0–M15.5） |
| [plans/2026-08-24-cross-platform-plan.md](plans/2026-08-24-cross-platform-plan.md) | **跨平台适配（全平台通吃）方案**：从「Tauri 桌面绑定」演进为「平台无关核心 + 可插拔平台壳」，同一 bundle 跑浏览器/安卓/iOS/鸿蒙 ArkWeb；分层 `pkg/core` + driver 可插拔 + 渐进迁移（**已落地 M16.0–M16.1b**：浏览器 Web 平台可跑/真实 SQLite/属性数据库/版本/块引用/备份/PWA，见 [M16 里程碑](roadmap.md)） |
| [plans/2026-08-24-web-polish-backlog-plan.md](plans/2026-08-24-web-polish-backlog-plan.md) | **Web 功能补齐与体验优化（建议清单）方案**：web 端空桩命令让桌面/web 不对称——附件移动/批量删除、存储统计精确化、全文搜索（P0），拖拽体验/大媒体内存/测试补强（P1），写库失败回滚（P1）；加密/同步/插件归平台能力边界（**规划，标记 M16.6–M16.8**，未实装） |
| [plans/2026-08-24-thin-agent-interface-plan.md](plans/2026-08-24-thin-agent-interface-plan.md) | **「薄 Agent 接口」AI 能力方案**：不嵌入能跑任意命令的 Agent 运行时（如全量 dsh），而是 ShuyoNote 暴露**语义化工具**（search/read/create/append/get_backlinks）+ **受限 Agent 宿主**（默认关、倾向本地模型、写操作经审核）；对比两条路线、标注利弊与安全红线（**规划，建议**） |
| [plans/2026-08-24-thin-agent-interface-implementation-plan.md](plans/2026-08-24-thin-agent-interface-implementation-plan.md) | **「薄 Agent 接口」实现方案**：复用现有插件宿主(`registry.ts`)+ 语义命令，新增白名单工具/前端 LLM 循环/审核落库；唯一新后端命令为受限的 `append_block`；含文件清单、验收与 M17 里程碑（**规划，可执行**） |
| [plans/2026-08-24-inline-ai-draft-plan.md](plans/2026-08-24-inline-ai-draft-plan.md) | **「内联 AI 起草」方案**：把 AI 从「右侧聊天面板 + 二段确认」扩展为「**内嵌文档流 + 流式写入 + 高亮待定块 + 一组快捷动作**」（完成/新建页/续写/扩写/重新生成/关闭 + R/ESC），对标 wolai / FlowUs / Notion AI；**含「嵌入式 vs 侧边栏」职责划分**（内联＝就地写、侧边栏＝全局问/做），写操作仍先落「预览高亮待定块」、点「完成」才落库，不丢确认红线（**规划，建议**） |
| [plans/2026-08-24-wiki-weave-plan.md](plans/2026-08-24-wiki-weave-plan.md) | **「Wiki 织网增强」方案（M19）**：未链接提及（Unlinked Mentions）/ 双链别名 `[[标题|别名]]` / 精确块链 `[[页面#块]]` / 链接建议增强（**规划**） |
| [plans/2026-08-24-template-var-semantic-search-plan.md](plans/2026-08-24-template-var-semantic-search-plan.md) | **「模板变量 + 语义检索」方案（M20）**：模板变量 `{{date}}/{{title}}/{{selected}}` 自动填充；embedding 语义检索（保留 FTS 兜底）+ 接入 AI 问答（**规划**） |
| [plans/2026-08-24-static-wiki-export-graph-plan.md](plans/2026-08-24-static-wiki-export-graph-plan.md) | **「静态 wiki 导出 + 关系图探索」方案（M21）**：把当前空间导成可浏览的静态 HTML wiki（双链跳转/反链/标签/索引页）；关系图按标签/属性着色分组、关键词高亮、聚类（**规划**） |
| [plans/2026-08-24-drawing-solution-design.md](plans/2026-08-24-drawing-solution-design.md) | **「绘图方案」设计**：Excalidraw（手绘/自由画图，MIT）+ mermaid（流程图/思维导图，文本→SVG）+ AI 文生图；大字节走内容寻址附件，节点只存引用，双平台无需新增 Rust 命令（**设计，建议**） |

## 竞品对比

| 文档 | 内容 |
|---|---|
| [compare-obsidian-siyuan-shuyonote.md](compare-obsidian-siyuan-shuyonote.md) | **Obsidian / 思源笔记 / ShuyoNote** 三方对比与定位 |
| [compare-flowus-wolai-notion-shuyonote.md](compare-flowus-wolai-notion-shuyonote.md) | **FlowUs / Wolai / Notion / ShuyoNote** 四方对比与定位 |

## 设计交付（design）

> 完整的 UI/UX 设计交付索引见 [design/README.md](../design/README.md)。

| 文档 | 内容 |
|---|---|
| [../design/design-system.md](../design/design-system.md) | **设计系统 v2**：色彩/字体/间距/圆角/阴影/动效 tokens + 组件规范 + 无障碍 |
| [../design/ux-flows.md](../design/ux-flows.md) | **UX 流程**：12 条用户旅程 + 空/加载/错误/边界态 |
| [../design/implementation-plan.md](../design/implementation-plan.md) | **落地实现计划**：文件级改造清单 + 验收标准 |
| [../design/README.md](../design/README.md) | UI/UX 设计交付总索引（设计系统 / UX 流程 / 高保真原型 / 实现计划） |
| [../design/logo/README.md](../design/logo/README.md) | **应用 Logo**：应用图标 / 单色图形 / 字标 / 主图 |

## 工程开发（development）

| 文档 | 内容 |
|---|---|
| [development.md](development.md) | **开发指南**：技术栈与目录 / 环境准备 / 运行（web·桌面·构建）/ 测试与验证权威循环（`scripts/smoke-web.mjs` + `tsc` + `vite build` + `cargo check`）/ **版本号提升规则** / CHANGELOG 与文档约定 / 常见坑（UTF-8、autocrlf、强刷、pwsh 退出码、缓存） |

## 变更记录（changelog）

- [CHANGELOG.md](../CHANGELOG.md) —— **版本变更日志**（Keep a Changelog 格式，`v1.6.0` 起，当前 `v1.59.128`）。

## 约定

- 功能规划、竞品分析、产品定位归 `docs/`；像素级 UI/UX 设计交付归 `design/`。
- 里程碑完成的规划会标注 ✅ 并补充「实现」要点，对应到具体文件/命令。
- 版本演进以 `CHANGELOG.md` 为准，`docs/` 文档聚焦"是什么 / 为什么 / 怎么做"。
