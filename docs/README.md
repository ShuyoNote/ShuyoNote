# ShuyoNote 文档体系

> 本地优先 · 类 Notion 的知识管理桌面应用（Tauri 2 + Lexical + SQLite）。
> 本目录是项目文档的**统一入口**，按主题组织全部设计、方案、规划与对比文档。

## 快速导航

| 我想了解… | 从这里开始 |
|---|---|
| 产品是什么、定位与目标用户 | [产品定位](positioning.md) |
| 功能怎么用、有哪些能力 | [README](../README.md) 功能清单 |
| **系统怎么搭起来的、分层与存储模型** | [系统架构](architecture.md) |
| **身份 / 鉴权 / 加密模型（密钥 vs 账户、多空间、本地私密）** | [身份与隐私模型](identity-privacy-model.md) |
| **身份 / 隐私落地节奏** | [身份与隐私子路线图](identity-privacy-roadmap.md) |
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
├── identity-privacy-model.md # 身份/鉴权/加密模型（密钥 vs 账户、多空间、本地私密）
├── identity-privacy-roadmap.md # 身份/隐私落地子路线图
├── positioning.md       # 产品定位
├── design-philosophy.md # 设计哲学
├── roadmap.md           # 演进路线图（M1–M25 里程碑）
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
| [roadmap.md](roadmap.md) | **演进路线图**：现状盘点、下一阶段优先级、M1–M25 里程碑规划（M1–M5、M7–M23 已达；**M24 PDF 批注**为规划/建议，暂排 M20 后；**M25 帮助系统**为规划；M6/移动与 M11.3/M11.4 已评估未做）、竞品差距跟踪 |

## 演进路线（里程碑总览）

> 详细逐里程碑实现要点与版本号见 [docs/roadmap.md](roadmap.md)。状态：**✅ 已实现**；**🗓 部分/规划**；**未做** = 已评估延后。括号内为对应方案文档。

| 里程碑 | 主题 | 状态 | 方案文档 |
|--------|------|------|----------|
| **M1** | Markdown 无损往返 | ✅ | [本地优先方案](plans/2026-08-15-local-first-note-app-plan.md) |
| **M2** | 端到端加密 | ✅ | [多工作空间方案 §8](plans/2026-08-22-multi-workspace-plan.md) |
| **M3** | 主题 / 外观自定义 + 插件雏形 | ✅ | [插件方案](plans/2026-08-22-plugin-plan.md) |
| **M4** | 属性驱动仪表盘聚合 | ✅ | [属性 + 数据库方案](plans/2026-08-21-properties-database-plan.md) |
| **M5** | PDF 导出 | ✅ | [块引用方案](plans/2026-08-20-block-reference-plan.md) |
| **M6** | 移动端适配 | 未做（环境受限） | [跨平台方案](plans/2026-08-24-cross-platform-plan.md)（升级为 M16 全平台通吃） |
| **M7** | 数据库视图扩展 | ✅ | [属性 + 数据库方案](plans/2026-08-21-properties-database-plan.md) |
| **M8** | 新页面引导层 | ✅ | — |
| **M9** | 模板 | ✅ | [模板方案](plans/2026-08-22-template-plan.md) |
| **M10** | 多工作空间 | ✅ | [多工作空间方案](plans/2026-08-22-multi-workspace-plan.md) + [工作空间 CRUD](plans/2026-08-22-workspace-crud-plan.md) |
| **M11** | 插件 | ✅ | [插件方案](plans/2026-08-22-plugin-plan.md)（M11.3 UI 型 / M11.4 市场已评估未做） |
| **M12** | 文件夹 = 网盘 | ✅ | [文件夹网盘方案](plans/2026-08-22-folder-netdisk-plan.md) |
| **M13** | 数据库 = 透镜 | ✅ | [数据库透镜方案](plans/2026-08-22-database-lens-plan.md) |
| **M14** | 空间清理 / 存储管理 | ✅ | [存储清理方案](plans/2026-08-22-storage-cleanup-plan.md) |
| **M15** | 每空间独立存储（物理隔离） | ✅ | [每空间独立存储方案](plans/2026-08-22-per-workspace-storage-plan.md) |
| **M16** | 跨平台适配（全平台通吃） | ✅（部分） | [跨平台方案](plans/2026-08-24-cross-platform-plan.md) + [web 补齐清单](plans/2026-08-24-web-polish-backlog-plan.md) |
| **M17** | AI 薄 Agent | ✅ | [薄 Agent 方案](plans/2026-08-24-thin-agent-interface-plan.md) + [实现方案](plans/2026-08-24-thin-agent-interface-implementation-plan.md) |
| **M18** | 内联 AI 起草 | ✅ | [内联起草方案](plans/2026-08-24-inline-ai-draft-plan.md) |
| **M19** | Wiki 织网增强 | ✅ | [织网方案](plans/2026-08-24-wiki-weave-plan.md) |
| **M20** | 模板变量 + 语义检索 | ✅ | [模板变量 + 语义检索方案](plans/2026-08-24-template-var-semantic-search-plan.md) |
| **M21** | 静态 wiki 导出 + 关系图探索 | ✅ | [静态 wiki 导出方案](plans/2026-08-24-static-wiki-export-graph-plan.md) |
| **M22** | 绘图（Excalidraw / mermaid / AI 文生图） | ✅ | [绘图方案](plans/2026-08-24-drawing-solution-design.md) |
| **M23** | Excalidraw 绘图高级功能 | ✅（M23.5 协同/代码生成未做） | [Excalidraw 高级方案](plans/2026-08-24-excalidraw-advanced-plan.md) |
| **M24** | **PDF 批注** | ✅（阶段1/3 + 阅读器 + OCR/AI 增强已落地；阶段2 写回待做） | [PDF 批注方案](plans/2026-08-27-pdf-annotation-plan.md) + [PDF 阅读器/AI 增强](plans/2026-08-30-pdf-reader-ai-plan.md) |
| **M25** | **帮助系统** | ✅（P0/P1） | [帮助系统方案](plans/2026-08-27-help-system-plan.md) |
| **M26** | **公式（数学）** | ✅（块级+行内） | [公式方案](plans/2026-08-30-formula-plan.md) |
| **M27** | **团队版（自建协作）** | 规划 | [团队版方案](plans/2026-08-30-team-edition-plan.md) |

> 另：非里程碑功能——**分栏**（`/分栏`，见 [分栏方案](plans/2026-08-26-columns-plan.md)）、绘图块（归 M22）、内联「+」插入块等。完整现状与里程碑细节见 [roadmap.md](roadmap.md)。

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
| [plans/2026-08-26-columns-plan.md](plans/2026-08-26-columns-plan.md) | **「分栏」功能方案（飞书式 Columns Block）**：N 列并排/每列独立输入 + 选择栏数（2/3/4）面板；对比两条路线（ElementNode 单编辑器 vs DecoratorNode+嵌套编辑器）。**路线 B（每列独立子编辑器）已落地**：`ColumnsBlockNode`（DecoratorNode，每列一个 EditorState）+ 列内 `/` 插标题/列表/表格/Callout/代码块/分隔线 + 列增删 + 列宽拖拽 + 列内撤销/跨列输入 + `content_text` 并入 + Markdown 导出保留列文本。诚实标注边界：列内块级拖拽/跨列复制、旧 `columns`(ElementNode) → `columnsBlock` 自动迁移**均不做**（风险/成本高、收益低），旧文档保留 `columns`/`column` 注册可读兼容。含数据结构、入口、样式、验收与边界 |
| [plans/2026-08-24-excalidraw-advanced-plan.md](plans/2026-08-24-excalidraw-advanced-plan.md) | **「Excalidraw 绘图高级功能」方案（M23）**：挖掘 Excalidraw 0.17.1 能力（命令式 API/元素编程化/只读/自定义侧栏/命中检测/Frames/导出），规划接入 ShuyoNote——只读嵌入、AI·mermaid 联动、白板导航、检索集成；协同/代码生成诚实标注需后端或 0.18+（**规划，建议**） |
| [plans/2026-08-27-pdf-annotation-plan.md](plans/2026-08-27-pdf-annotation-plan.md) | **「PDF 批注」方案（M24）**：竞品天花板对标（思源=块笔记顶格、MarginNote/LiquidText=思维工作台、Notion=无/Obsidian=靠插件）+ 2026 AI 帮读前沿；差异化定位「批注即块」；按 MVP 切（阶段 1：**双引擎渲染** + 批注 overlay + 内容寻址存储 + 摘录成块进反链/搜索 + 文本层判定/OCR 兜底；阶段 2：写回 PDF/OCR 精确划词；阶段 3：AI 帮读）。**阶段 1（Web v1.59.178 + 桌面 native v1.59.179 + 阅读器重构 v1.59.180）与阶段 3「AI 帮读」（v1.59.181）+「对整篇 PDF 提问」（v1.59.182）已落地**：`pdfRender` + `pdfAnnotation` + `pdf_annotations` 持久化 + `pdfjs-dist@4` 引擎 + `PdfReader`/`PdfAnnotationCanvas`（高亮/画笔/便签/摘录成块含可点击 `pdf://` 回链/文本层精确划词/OCR 兜底）+ 全局批注检索；**桌面 native 引擎（mupdf-sys）已落地（v1.59.179）**；**思源式阅读器（近全屏+左侧目录树+右侧批注侧栏+键盘导航+适配页宽）已落地（v1.59.180）**；**AI 帮读（划选→AI 总结→生成 pdf:// 回链块）已落地（v1.59.181）**；**对整篇 PDF 提问（相关页检索）已落地（v1.59.182）**。阶段 2 待做 |
| [plans/2026-08-28-pdf-render-engine-mupdfjs-vs-pdfjs.md](plans/2026-08-28-pdf-render-engine-mupdfjs-vs-pdfjs.md) | **「Web PDF 渲染引擎：MuPDF.js vs pdf.js」落地文档（M24，方案/待拍板）**：结论=默认保持现状（桌面 native MuPDF + Web pdf.js）；若换只换光栅化，文本层/元数据/注释仍 pdf.js，且**必须先确认 AGPL 合规**（pdf.js=Apache-2.0 宽松 vs MuPDF.js=AGPL-3.0 传染，桌面 `mupdf-sys` 同源也有 AGPL 约束）。结构上 pdf.js 只承担 4 件事且集中于 `pdfjsEngine.ts` 唯一入口（接口已隔离，改一个文件即可）；坐标归一化/文本层/划词/OCR 连带影响 + 性能体积对比 + 回退灰度（三态引擎）+ 迁移步骤（7 步）+ 验收清单（10 项）。**方案，未实装；不触发代码改动** |
| [plans/2026-08-29-pdf-ask-document.md](plans/2026-08-29-pdf-ask-document.md) | **「对整篇 PDF 提问」（M24 阶段 3 延伸）落地文档（已实现，待发布）**：方案 B 相关页检索——提问时段提取整篇文本（`getPageText`，仅字符串）＋ char-bigram Jaccard（`rankRelevantPages`，离线/无向量端点）只挑最相关 ≤5 页喂模型，流式回答＋「依据 N、M 页」，可存成 `pdf://` 回链块。数据流/改动清单/边界（提取缓存、命中近似、长上下文上限、不做跨 PDF/持久 RAG、需 AI 配置）/验收（9 项）。**v1.59.182 已落地** |
| [plans/2026-08-29-pdf-continuous-scroll-plan.md](plans/2026-08-29-pdf-continuous-scroll-plan.md) | **「PDF 连续滚动（虚拟化）」落地文档（方案 B / 已实现，待发布）**：把阅读器从「单页翻页」升级为「整篇纵向连续滚动」——所有页块纵向堆叠，一次可自由滚过整篇；只挂载视口 ± 1 页缓冲的页块（其余页占位不渲染，内存可控）。**批注随页块**（每页仍是自包含 `PdfAnnotationCanvas`，工具条/撤销/选中/批注都在块内）；导航升级（侧栏/目录跳页滚到目标页顶；←/→/↑/↓ 逐页滚动取代「滚动边缘自动翻页」；F 适配页宽）；布局数学抽成纯函数 `pdfLayout.ts`（前缀和 + 视口挂载范围），首屏预取全部页尺寸使滚动轴稳定；修复暗色下透明底 PDF 不可读。**v1.59.187 已落地**；**v1.59.188** 增量：修复缩放迟钝/抖动（页块宽随 `scale` 真实放大 + 缩放后重光栅化）+ 缩放下拉 + 点击 PDF 附件/文件树节点直达阅读器；**v1.59.189** 增量：缩放下拉重构为桌面阅读器式；**v1.59.190** 增量：批注工具栏改为顶部单份固定（工具跨页共享 + 页句柄注册 + 状态条跟当前页） |
| [plans/2026-08-30-pdf-reader-ai-plan.md](plans/2026-08-30-pdf-reader-ai-plan.md) | **「PDF 阅读器 + OCR/AI 增强」落地文档（叠加于 v1.59.190，已落地）**：阅读体验（光标修正/便签钉+内容气泡/按住即拖/双击编辑/控制条陈旧闭包修复）+ 侧栏与定位（标注后右栏刷新/批注定位到视口中央/跳转闪烁框贴合）+ **护眼模式（多档位）** + **OCR 彻底离线**（`copy-tesseract-assets.mjs` 本地打包 worker/core/双语完整模型；修复 `is-url` 相对路径误判走 readCache；`4.0.0_best_int`→完整 `4.0.0`）+ **AI 视觉识别**（`ocrVision.ts`，页图直发多模态模型）+ **AI 一键生成目录（视觉大模型优先）**（`generateOutlineFromVision`）+ **系统朗读**（`speech.ts`，Web Speech）+ 识别结果居中可缩放弹层（朗读/复制/写入便签） |
| [plans/2026-08-30-formula-plan.md](plans/2026-08-30-formula-plan.md) | **「公式」方案（M26）**：正文块级 `$$…$$` + 行内 `$…$` 数学公式，渲染为 KaTeX（懒加载，独立 chunk 不进首屏）。块级 `FormulaNode`（`DecoratorNode`，对齐 Mermaid，`/公式` 插入 + markdown `FORMULA` transformer + 就地编辑）；行内 `InlineFormulaNode`（`TextNode` 子类 + `registerNodeTransform`，保留字面 `$…$` 进 `content_text`）。**阶段 1 块级 + 阶段 2 行内已落地**；边界：`$5`/`$100` 类误判控制、块级/行内 `$$`/`$` 区分、KaTeX `throwOnError:false` 回退源文本 |
| [plans/2026-08-30-formula-recognition-plan.md](plans/2026-08-30-formula-recognition-plan.md) | **「公式图片 / 手写识别」方案（M26 扩展）**：给公式编辑器弹窗加「图片识别」（上传/拖入/粘贴含公式图片 → LaTeX）与「手写识别」（canvas 手写板 → LaTeX）。**复用 `ocrVision.ts` 的 `ocrWithVision`**（视觉大模型，Ollama/OpenAI 兼容，已是独立视觉通道，不新增后端）；识别结果自动回填 textarea、用户可改后再提交（保留人工确认）；付费识别服务（Mathpix/MyScript）不接、不做云端限流；依赖用户已配置视觉模型，未配置/弱模型优雅降级。**已实现**（`formulaVision.ts` + `FormulaHandwritePad`（DPR 跟手手写板）+ `FormulaEditorDialog` 🖼/✎ 入口） |
| [plans/2026-08-27-help-system-plan.md](plans/2026-08-27-help-system-plan.md) | **「帮助系统」方案（M25）**：本地优先/键盘驱动的四层帮助（P0 就地提示+快捷键面板；P1 内置「使用指南」页+新手清单；P2 外部静态站可选）；主张帮助页=可编辑笔记（同源/可搜/可导出）；复用命令面板/斜杠/模板/`shortcuts.ts` 单一来源。**§9 已细化**：`shortcuts.ts` 数据结构 + 权威快捷键清单 + `ShortcutsPanel` 交互细则 + 「使用指南」页块级大纲 + 入口/状态 + 实现顺序（P0→P1）。**P0/P1 已落地（v1.59.177）+ P1 新手清单/P2「关于」/外链入口已落地**（见[项目网站导航方案](plans/2026-08-27-project-website-navigation-plan.md)） |
| [plans/2026-08-27-project-website-navigation-plan.md](plans/2026-08-27-project-website-navigation-plan.md) | **「项目网站导航」方案（M25 P2 细化）**：让用户方便导航到外部项目网站的**利弊权衡 + 决策 + 入口设计**。结论=做成「可发现但克制、绝不阻塞、绝不跟踪」的被动出口；拆分三类外部站点（项目主页/文档站/营销落地页），只承接前两类；落地=「关于」对话框（版本/AGPL-3.0 许可/四干净链接）+「检查更新」+ 帮助页脚注 + **「禁用外部导航」隐私开关**；链接走 `src/lib/links.ts` 单一来源、无 `utm`/埋点；站点自控（仓库 Pages）优先、主页偏透明+文档+下载。**「关于」对话框 + 四链接 + 隐私开关已实装**（外部静态站本身待做） |
| [plans/2026-08-27-auto-update-plan.md](plans/2026-08-27-auto-update-plan.md) | **「自动升级」方案（规划，建议）**：本地优先/离线/自托管/AGPL 下的升级边界——**半自动**（后台 `check()` + 用户点「下载并安装」），**绝不静默强制重启**，离线优雅降级、Web 端禁用。技术走 Tauri 2 官方 `tauri-plugin-updater`（签名 `tauri signer` + 更新清单 `latest.json` + `createUpdaterArtifacts` `.sig` + 稳定 HTTPS 端点）。**真正的成本在签名 + 更新清单的发布管线**（手工，接入现有提版流程）；分阶段：阶段 1 先做「检查更新」检测入口（不依赖完整签名）、阶段 2 完整应用内下载安装、阶段 3 增量/通道/自托管。**规划，未实装** |
| [plans/2026-08-27-pdf-annotation-acceptance.md](plans/2026-08-27-pdf-annotation-acceptance.md) | **PDF 批注 · 手动验收清单（M24 阶段 1）**：入口/渲染/批注（高亮·画笔·便签·选择/删除/编辑/复制引用）/文本层降级/持久化/批注即块（摘录成块→当前页/新页 + 回链跳转）/异常边界 + 自动化门禁（`tsc`/`smoke` 283/`build`/`cargo test` 32）。**真机在浏览器/桌面上逐条勾选** |
| [plans/2026-08-27-update-ocr-acceptance.md](plans/2026-08-27-update-ocr-acceptance.md) | **自动升级 / OCR · 手动验收清单（v1.59.178）**：自动升级（About 检查更新：离线降级/已是最新/有新版本 + 桌面更新器接线 + 发布管线前置）+ OCR 兜底（无文本层扫描件「OCR 识别本页」→ 识别结果面板）+ 精确划词 + 已知边界（签名发布/离线 langPath/OCR 文本未接划词）。**真机逐条勾选** |
| [plans/2026-08-30-md-in-app-open-plan.md](plans/2026-08-30-md-in-app-open-plan.md) | **「文件夹内 MD 文档直接应用内打开」利弊分析**：现状（`.md` 走 text/ 分支提示外部打开）+ 利（闭环/一致/可进知识体系/成本低）+ 弊（看 vs 转的角色歧义/文件页面界限/编辑语义/md 多样性/大文件）+ 建议（**应用内只读渲染 + 明显「转为笔记」按钮**，不默认自动转页面）+ 待拍板 + 结论（**已按建议实现**，见[md 预览实现](plans/2026-08-30-md-preview-plan.md)） |
| [plans/2026-08-30-md-preview-plan.md](plans/2026-08-30-md-preview-plan.md) | **「MD 应用内预览」实现记录（已实现，叠加于 v1.63.0）**：点侧边栏/文件夹内 `.md` 文件名 → 应用内只读预览（铺满主内容区、不遮侧边栏）+「转为笔记」；`mermaid` 代码块渲染为图、随明/暗主题自适应、切换主题即时刷新；弹窗层级提升、打开页面自动关闭预览。含共享 store / App 级弹窗（body portal）/ offscreen md→JSON / mdToHtml mermaid 块 / mermaid 主题响应式 / 请求端接入 / 关键坑（flex 子项、属性转义、源码保留、z-index）与验收 |
| [plans/2026-08-30-team-edition-plan.md](plans/2026-08-30-team-edition-plan.md) | **「团队版（自建协作，不接外部通讯 App）」方案**：账号/认证、权限两根柱子 + 协同后置（P2）；团队空间放弃零知识（个人空间保留 E2E）；服务端见 shuyonote-sync-server 仓库（已实现 S5）；客户端聚焦登录/空间绑定/成员 UI（**规划**） |
| [plans/2026-08-30-team-edition-account-space-plan.md](plans/2026-08-30-team-edition-account-space-plan.md) | **「团队版 M27.1 账号/空间绑定 · 客户端侧」落地方案**：登录态 + 登录/注册 UI + 空间绑定 + 成员/权限 UI；命令对齐 shuyonote-sync-server `/auth/*` `/spaces/*`；服务端设计见 shuyonote-sync-server 仓库（**规划**） |

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

- [CHANGELOG.md](../CHANGELOG.md) —— **版本变更日志**（Keep a Changelog 格式，`v1.6.0` 起，当前 `v1.64.8`）。

## 约定

- 功能规划、竞品分析、产品定位归 `docs/`；像素级 UI/UX 设计交付归 `design/`。
- 里程碑完成的规划会标注 ✅ 并补充「实现」要点，对应到具体文件/命令。
- 版本演进以 `CHANGELOG.md` 为准，`docs/` 文档聚焦"是什么 / 为什么 / 怎么做"。
