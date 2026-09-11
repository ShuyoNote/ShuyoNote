# ShuyoNote 文档体系

> 本地优先 · 类 Notion 的知识管理桌面应用（Tauri 2 + Lexical + SQLite）。
> 本目录是项目文档的**统一入口**，按主题组织全部设计、方案、规划与对比文档。

## 快速导航

| 我想了解… | 从这里开始 |
|---|---|
| **当前做到哪一步了、新会话从这里续** | [项目现状·SHUYONOTE_STATE](SHUYONOTE_STATE.md) |
| 产品是什么、定位与目标用户 | [产品定位](positioning.md) |
| 功能怎么用、有哪些能力 | [README](../README.md) 功能清单 |
| **系统怎么搭起来的、分层与存储模型** | [系统架构](architecture.md) |
| **身份 / 鉴权 / 加密模型（密钥 vs 账户、多空间、本地私密）** | [身份与隐私模型](identity-privacy-model.md) |
| **身份 / 隐私落地节奏** | [身份与隐私子路线图](identity-privacy-roadmap.md) |
| **Web 版为什么不能多设备同步** | [Web 同步能力边界](web-sync-boundary.md) |
| **移动端怎么适配（安卓/iOS/鸿蒙壳）** | [移动端适配](MOBILE.md) |
| 下一步做什么 | [路线图](roadmap.md) |
| 免费客户出口怎么做 | [免费客户出口·网站/帮助站指南](free-site-export-guide.md) |
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
├── MOBILE.md            # 移动端适配（WebView 壳 + MobileBridge）
├── web-sync-boundary.md # Web 版同步能力边界（为什么不支持多设备同步 + 若要做的路线）
├── identity-privacy-model.md # 身份/鉴权/加密模型（密钥 vs 账户、多空间、本地私密）
├── identity-privacy-roadmap.md # 身份/隐私落地子路线图
├── positioning.md       # 产品定位
├── design-philosophy.md # 设计哲学
├── free-site-export-guide.md     # 免费客户出口·网站/帮助站指南（公开向；付费客户沟通材料见私有 shuyonote-sync-server 仓库）
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
| [web-sync-boundary.md](web-sync-boundary.md) | **Web 同步能力边界**：Web 版为何不支持多设备同步的四层原因（服务端不挂 CORS / 同步引擎在 Rust / 存储模型不匹配 / 凭证信任边界）、用户可见表现与代码出处、桌面 vs Web 能力对照、若要开启的前置条件与 W1–W4 分阶段路线 |
| [design-philosophy.md](design-philosophy.md) | **设计哲学**：page 本源 / 属性语义 / 数据库=透镜 / 文件夹=容器；从需求、定位、竞品对比、各功能方案与设计系统提炼的完整信条、取舍与边界 |
| [realtime-collab-analysis.md](realtime-collab-analysis.md) | **实时协同（多人同页协作编辑）利弊分析**：区分「近实时」vs「块级 CRDT」两档成本；好处（对齐竞品 / 不丢内容 / 实时感知）与代价（富块难合并 / 服务端 WebSocket / 离线×实时并存 / E2E 冲突 / 非购买点核心）；分阶段建议（近期近实时、长期最小 CRDT、个人空间保留 E2E）与决策记录 |
| [SYNC.md](SYNC.md) | **同步机制详解**：本地优先 + 增量 changes（push/pull by seq）+ 近实时轮询 + LWW + 空间隔离/认证 + 客户端侧排错（错误码）。服务端自托管部署 / 配置 / 排错见私有仓库 `docs/deploy.md` |
| [multi-platform-ci.md](multi-platform-ci.md) | **多平台自动构建发布（CI）**：`v*` tag 自动打 Win/mac/Linux 安装包。GitCode 流水线只有 Linux runner；GitHub Actions 有全平台。给出 `.github/workflows/release.yml`（三平台 + secrets）与 `.gitcode/workflows/build-linux.yml`（Linux），及方案 A/B/C 取舍 |
| [macos-updater.md](macos-updater.md) | **macOS 构建 · 签名 · 公证 · 自动更新**：mac 机器一次性准备（Xcode/rust/node）、Apple Developer ID 证书 + notarization 凭据、`tauri.conf.json` updater/endpoints/pubkey 配置、mac 上打签名+公证 dmg、`release.mjs` 发布与 mac `latest.json`、CI secrets、边界（未签名无法自动更新）、Mac 到手当天清单 |
| [free-site-export-guide.md](free-site-export-guide.md) | **免费客户出口 · 网站/帮助站导出与发布指南**：免费/开源社区的**被动出口**——三层出口（就地提示/内置指南/外部静态站）、导出三种方式（M21 静态 wiki 导出建帮助站 / 仓库 Pages 建主页 / 应用内「关于」对话框）、干净链接策略（无 utm/埋点）、发布路径、与付费侧对照、发布核对清单与红线。**付费客户沟通/商务运营材料见私有 shuyonote-sync-server 仓库** |
| [positioning.md](positioning.md) | **产品定位**：一句话定位、目标用户、差异化 |
| [plugin-api.md](plugin-api.md) | **插件 API（面向作者，生成物）**：只读这一份就能写出可安装可运行的插件——最小插件、能力表、权限与写中介、命令参数、事件钩子、更新时新增权限要用户重新确认、触发面、设置、零代码插件（声明式视图 / 视图参数化 / 主题）、导入导出、执行预算与错误码。由 `capabilities/capabilities.json` 生成（跑 `node scripts/gen-capabilities.mjs`） |
| [plugin-recipes.md](plugin-recipes.md) | **插件配方（第一批可发布清单）**：可直接贴到社区的插件清单——每个插件的一句话定位、要哪些权限、怎么装，以及打包 / sha256 / minisign 签名 / 发布索引的完整流程 |
| [plugin-policy.md](plugin-policy.md) | **插件开发者政策**：发布前该读的底线（不许做什么、必须写什么、撤回与换密钥的规矩），以及应用会替用户摆出哪些**事实**、又刻意不给什么结论 |
| [plugin-first-plugin.md](plugin-first-plugin.md) | **20 行写第一个插件**：从 `pnpm plugin:new` 生成起点 → 看懂 manifest 与权限三种写法 → 写第一个命令 → 装进应用跑一遍 → 出问题看哪里 → 发布给别人。目标是"只看文档不读源码" |
| [plugin-index-spec.md](plugin-index-spec.md) | **`plugin-index.json` 公开规范（一页纸）**：最小可用索引、字段表与限制、应用会强制的规则、两级签名（索引 / 发布者）、两级撤回（版本 / 密钥）、发布三步。照着写就能托管一份索引 |
| [plugin-hosting.md](plugin-hosting.md) | **第一方插件索引的托管运维**：社区索引的实际落地点与 URL、**为什么单开 `/plugins/` 而不复用 `/static/`**（后者统一长缓存、索引被长缓存 = 新插件永远看不到）、nginx 配置与那次 BOM 事故、发布新版本的完整命令与**上传顺序**、以及每次发布后的验收命令 |
| [roadmap.md](roadmap.md) | **演进路线图**：现状盘点、下一阶段优先级、M1–M25 里程碑规划（M1–M5、M7–M23 已达；**M24 PDF 批注**为规划/建议，暂排 M20 后；**M25 帮助系统**为规划；M6/移动与 M11.10 UI 插件/M11.11 市场已评估未做（带启动闸门，见 [插件体系进化方案](plans/2026-09-10-plugin-evolution-plan.md)））、竞品差距跟踪 |
| [harmony-web-ceiling.md](harmony-web-ceiling.md) | **基于 Web 版开发鸿蒙桌面应用的能力边界（天花板）分析**：ArkWeb 壳不改变浏览器内核；能力矩阵（DB/文件系统/原生引擎/加密/系统集成/同步/插件）；路线 A（纯套壳≈PWA）vs 路线 B（加 ArkTS 原生桥）；对 ShuyoNote 的建议与取舍 |

## 演进路线（里程碑总览）

> 详细逐里程碑实现要点与版本号见 [docs/roadmap.md](roadmap.md)。状态：**[x] 已实现**；**[ ] 部分/规划**；**未做** = 已评估延后。括号内为对应方案文档。

| 里程碑 | 主题 | 状态 | 方案文档 |
|--------|------|------|----------|
| **M1** | Markdown 无损往返 | [x] | [本地优先方案](plans/2026-08-15-local-first-note-app-plan.md) |
| **M2** | 端到端加密 | [x] | [多工作空间方案 §8](plans/2026-08-22-multi-workspace-plan.md) |
| **M3** | 主题 / 外观自定义 + 插件雏形 | [x] | [插件方案](plans/2026-08-22-plugin-plan.md) |
| **M4** | 属性驱动仪表盘聚合 | [x] | [属性 + 数据库方案](plans/2026-08-21-properties-database-plan.md) |
| **M5** | PDF 导出 | [x] | [块引用方案](plans/2026-08-20-block-reference-plan.md) |
| **M6** | 移动端适配 | [规划]（WebView 壳进行中） | [跨平台方案](plans/2026-08-24-cross-platform-plan.md)（升级为 M16 全平台通吃）+ [移动端适配](MOBILE.md) |
| **M7** | 数据库视图扩展 | [x] | [属性 + 数据库方案](plans/2026-08-21-properties-database-plan.md) |
| **M8** | 新页面引导层 | [x] | — |
| **M9** | 模板 | [x] | [模板方案](plans/2026-08-22-template-plan.md) |
| **M10** | 多工作空间 | [x] | [多工作空间方案](plans/2026-08-22-multi-workspace-plan.md) + [工作空间 CRUD](plans/2026-08-22-workspace-crud-plan.md) |
| **M11** | 插件 | [x]（L1；**M11.5/M11.6/M11.7 已落地**——时限与资源上限、ABI v1 + 能力注册表 + 权限与写中介、20 条能力 + 与 AI 工具层合并，含**作者工具链**：应用内校验/热重载/`pnpm plugin:validate`/[示例插件](../examples/plugins/README.md)；**M11.8 触发面与事件、M11.9 五档（声明式视图 / 主题 token / 视图参数化 / 导入触发 / 导出）亦已落地**） | [插件方案](plans/2026-08-22-plugin-plan.md)（L1 已落地）+ [插件体系进化方案](plans/2026-09-10-plugin-evolution-plan.md)（M11.5–M11.13，规划；**定位=做第一不做更大：第一个「有权限模型 + 作用在 E2EE 数据上」的可信插件体系**，并给出**分轴预期刻度**（哪几轴对齐/超出、哪几轴低于顶级、哪一条结构性不可达）；原 M11.3 UI 型 → M11.10、原 M11.4 市场 → M11.11，均带启动闸门；新增 M11.13 隔离强度（**已判定必有**；内存炸弹由 M11.5 的"超预算 panic 限流分配器"闭合，进程级隔离为 M11.11 分发硬前置）；**分发形态见[插件分发策略](plans/2026-09-10-plugin-distribution-strategy.md)**（协议而非平台 + 贡献阶梯 + M11.11a/b/c） |
| **M12** | 文件夹 = 网盘 | [x] | [文件夹网盘方案](plans/2026-08-22-folder-netdisk-plan.md) |
| **M13** | 数据库 = 透镜 | [x] | [数据库透镜方案](plans/2026-08-22-database-lens-plan.md) |
| **M14** | 空间清理 / 存储管理 | [x] | [存储清理方案](plans/2026-08-22-storage-cleanup-plan.md) |
| **M15** | 每空间独立存储（物理隔离） | [x] | [每空间独立存储方案](plans/2026-08-22-per-workspace-storage-plan.md) |
| **M16** | 跨平台适配（全平台通吃） | [x]（部分） | [跨平台方案](plans/2026-08-24-cross-platform-plan.md) + [web 补齐清单](plans/2026-08-24-web-polish-backlog-plan.md) |
| **M17** | AI 薄 Agent | [x] | [薄 Agent 方案](plans/2026-08-24-thin-agent-interface-plan.md) + [实现方案](plans/2026-08-24-thin-agent-interface-implementation-plan.md) |
| **M18** | 内联 AI 起草 | [x] | [内联起草方案](plans/2026-08-24-inline-ai-draft-plan.md) |
| **M19** | Wiki 织网增强 | [x] | [织网方案](plans/2026-08-24-wiki-weave-plan.md) |
| **M20** | 模板变量 + 语义检索 | [x] | [模板变量 + 语义检索方案](plans/2026-08-24-template-var-semantic-search-plan.md) |
| **M21** | 静态 wiki 导出 + 关系图探索 | [x] | [静态 wiki 导出方案](plans/2026-08-24-static-wiki-export-graph-plan.md) |
| **M22** | 绘图（Excalidraw / mermaid / AI 文生图） | [x] | [绘图方案](plans/2026-08-24-drawing-solution-design.md) |
| **M23** | Excalidraw 绘图高级功能 | [x]（M23.5 协同/代码生成未做） | [Excalidraw 高级方案](plans/2026-08-24-excalidraw-advanced-plan.md) |
| **M24** | **PDF 批注** | [x]（阶段1/3 + 阅读器 + OCR/AI 增强已落地；阶段2 写回待做） | [PDF 批注方案](plans/2026-08-27-pdf-annotation-plan.md) + [PDF 阅读器/AI 增强](plans/2026-08-30-pdf-reader-ai-plan.md) |
| **M25** | **帮助系统** | [x]（P0/P1） | [帮助系统方案](plans/2026-08-27-help-system-plan.md) |
| **M26** | **公式（数学）** | [x]（块级+行内） | [公式方案](plans/2026-08-30-formula-plan.md) |
| **M27** | **团队版（自建协作）** | 规划 | [团队版方案](plans/2026-08-30-team-edition-plan.md) |

> 另：非里程碑功能——**分栏**（`/分栏`，见 [分栏方案](plans/2026-08-26-columns-plan.md)）、绘图块（归 M22）、内联「+」插入块等。**邮箱聚合（邮件即笔记，v1.83.0 功能版）** 见 [多账号聚合收件流](plans/2026-09-07-email-multi-account-aggregation.md)；**块操作 / 块多选体系（文字选中优先，v1.84.0）** 见 [块选择方案](plans/2026-09-07-block-selection-plan.md)。完整现状与里程碑细节见 [roadmap.md](roadmap.md)。

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
| [plans/2026-08-30-formula-recognition-plan.md](plans/2026-08-30-formula-recognition-plan.md) | **「公式图片 / 手写识别」方案（M26 扩展）**：给公式编辑器弹窗加「图片识别」（上传/拖入/粘贴含公式图片 → LaTeX）与「手写识别」（canvas 手写板 → LaTeX）。**复用 `ocrVision.ts` 的 `ocrWithVision`**（视觉大模型，Ollama/OpenAI 兼容，已是独立视觉通道，不新增后端）；识别结果自动回填 textarea、用户可改后再提交（保留人工确认）；付费识别服务（Mathpix/MyScript）不接、不做云端限流；依赖用户已配置视觉模型，未配置/弱模型优雅降级。**已实现**（`formulaVision.ts` + `FormulaHandwritePad`（DPR 跟手手写板）+ `FormulaEditorDialog` (图)/(笔) 入口） |
| [plans/2026-08-27-help-system-plan.md](plans/2026-08-27-help-system-plan.md) | **「帮助系统」方案（M25）**：本地优先/键盘驱动的四层帮助（P0 就地提示+快捷键面板；P1 内置「使用指南」页+新手清单；P2 外部静态站可选）；主张帮助页=可编辑笔记（同源/可搜/可导出）；复用命令面板/斜杠/模板/`shortcuts.ts` 单一来源。**§9 已细化**：`shortcuts.ts` 数据结构 + 权威快捷键清单 + `ShortcutsPanel` 交互细则 + 「使用指南」页块级大纲 + 入口/状态 + 实现顺序（P0→P1）。**P0/P1 已落地（v1.59.177）+ P1 新手清单/P2「关于」/外链入口已落地**（见[项目网站导航方案](plans/2026-08-27-project-website-navigation-plan.md)） |
| [plans/2026-08-27-project-website-navigation-plan.md](plans/2026-08-27-project-website-navigation-plan.md) | **「项目网站导航」方案（M25 P2 细化）**：让用户方便导航到外部项目网站的**利弊权衡 + 决策 + 入口设计**。结论=做成「可发现但克制、绝不阻塞、绝不跟踪」的被动出口；拆分三类外部站点（项目主页/文档站/营销落地页），只承接前两类；落地=「关于」对话框（版本/AGPL-3.0 许可/四干净链接）+「检查更新」+ 帮助页脚注 + **「禁用外部导航」隐私开关**；链接走 `src/lib/links.ts` 单一来源、无 `utm`/埋点；站点自控（仓库 Pages）优先、主页偏透明+文档+下载。**「关于」对话框 + 四链接 + 隐私开关已实装**（外部静态站本身待做） |
| [plans/2026-08-27-auto-update-plan.md](plans/2026-08-27-auto-update-plan.md) | **「自动升级」方案（规划，建议）**：本地优先/离线/自托管/AGPL 下的升级边界——**半自动**（后台 `check()` + 用户点「下载并安装」），**绝不静默强制重启**，离线优雅降级、Web 端禁用。技术走 Tauri 2 官方 `tauri-plugin-updater`（签名 `tauri signer` + 更新清单 `latest.json` + `createUpdaterArtifacts` `.sig` + 稳定 HTTPS 端点）。**真正的成本在签名 + 更新清单的发布管线**（手工，接入现有提版流程）；分阶段：阶段 1 先做「检查更新」检测入口（不依赖完整签名）、阶段 2 完整应用内下载安装、阶段 3 增量/通道/自托管。**规划，未实装** |
| [plans/2026-08-27-pdf-annotation-acceptance.md](plans/2026-08-27-pdf-annotation-acceptance.md) | **PDF 批注 · 手动验收清单（M24 阶段 1）**：入口/渲染/批注（高亮·画笔·便签·选择/删除/编辑/复制引用）/文本层降级/持久化/批注即块（摘录成块→当前页/新页 + 回链跳转）/异常边界 + 自动化门禁（`tsc`/`smoke` 283/`build`/`cargo test` 32）。**真机在浏览器/桌面上逐条勾选** |
| [plans/2026-08-27-update-ocr-acceptance.md](plans/2026-08-27-update-ocr-acceptance.md) | **自动升级 / OCR · 手动验收清单（v1.59.178）**：自动升级（About 检查更新：离线降级/已是最新/有新版本 + 桌面更新器接线 + 发布管线前置）+ OCR 兜底（无文本层扫描件「OCR 识别本页」→ 识别结果面板）+ 精确划词 + 已知边界（签名发布/离线 langPath/OCR 文本未接划词）。**真机逐条勾选** |
| [plans/2026-08-30-md-in-app-open-plan.md](plans/2026-08-30-md-in-app-open-plan.md) | **「文件夹内 MD 文档直接应用内打开」利弊分析**：现状（`.md` 走 text/ 分支提示外部打开）+ 利（闭环/一致/可进知识体系/成本低）+ 弊（看 vs 转的角色歧义/文件页面界限/编辑语义/md 多样性/大文件）+ 建议（**应用内只读渲染 + 明显「转为笔记」按钮**，不默认自动转页面）+ 待拍板 + 结论（**已按建议实现**，见[md 预览实现](plans/2026-08-30-md-preview-plan.md)） |
| [plans/2026-08-30-md-preview-plan.md](plans/2026-08-30-md-preview-plan.md) | **「MD 应用内预览」实现记录（已实现，叠加于 v1.63.0）**：点侧边栏/文件夹内 `.md` 文件名 → 应用内只读预览（铺满主内容区、不遮侧边栏）+「转为笔记」；`mermaid` 代码块渲染为图、随明/暗主题自适应、切换主题即时刷新；弹窗层级提升、打开页面自动关闭预览。含共享 store / App 级弹窗（body portal）/ offscreen md→JSON / mdToHtml mermaid 块 / mermaid 主题响应式 / 请求端接入 / 关键坑（flex 子项、属性转义、源码保留、z-index）与验收 |
| [plans/2026-08-30-team-edition-plan.md](plans/2026-08-30-team-edition-plan.md) | **「团队版（自建协作，不接外部通讯 App）」方案**：账号/认证、权限两根柱子 + 协同后置（P2）；组织空间放弃零知识（个人空间保留 E2E）；服务端见 shuyonote-sync-server 仓库（已实现 S5）；客户端聚焦登录/空间绑定/成员 UI（**规划**） |
| [plans/2026-08-30-team-edition-account-space-plan.md](plans/2026-08-30-team-edition-account-space-plan.md) | **「团队版 M27.1 账号/空间绑定 · 客户端侧」落地方案**：登录态 + 登录/注册 UI + 空间绑定 + 成员/权限 UI；命令对齐 shuyonote-sync-server `/auth/*` `/spaces/*`；服务端设计见 shuyonote-sync-server 仓库（**规划**） |
| [plans/2026-09-01-structural-backlog-plan.md](plans/2026-09-01-structural-backlog-plan.md) | **「安全加固后的结构性改进」立项**（2026-09-01，**三项均达成**）：(1) markdown round-trip 单测（Lexical 无头测试，88 断言全绿）；(2) web.ts 命令契约层（`CommandMap` 类型 + api.ts invoke 编译期校验 + check-web-commands 纳入 build）；(3) 服务端单 Mutex 并发瓶颈（push 单事务 + 读写分离 + 只读连接池，见 shuyonote-sync-server）。 |
| [plans/2026-09-04-near-realtime-plan.md](plans/2026-09-04-near-realtime-plan.md) | **「团队版近实时协作」落地实现方案（规划）**：在页级 LWW + 轮询之上加**协作感知层**——P0 同页冲突提示 + 在线/谁在编辑（presence 心跳）、P1 评论/@/通知中心、P1.5 可选 SSE/WebSocket 推送；含数据模型（`presence`/`comments`/`notifications`）、新接口清单、客户端组件、里程碑与验收；**明确不做块级 CRDT**、个人空间保留 E2E（依据 [实时协同利弊分析](realtime-collab-analysis.md)） |
| [plans/2026-09-05-desktop-product-polish-plan.md](plans/2026-09-05-desktop-product-polish-plan.md) | **「桌面端产品打磨计划」（规划）**：依据内部产品评价（**已移出公开仓库**，见私有 shuyonote-sync-server），**桌面是主线**。四根柱子——(1) 同步地基（一致性整改 + 跨设备回归脚本 + 自托管 SYNC 文档）、(2) 数据安全（一键备份/恢复 + 回收站兜底 + 整空间导出）、(3) 桌面体验打磨（z-index 统一 + 空/加载/错误态 + 编辑器/数据库打磨）、(4) 交付/产品化（自动升级 + 关于/许可证 + 发布节奏收紧）；含优先级 P0–P3、验收与交付物；**最小可交付三件事 = 同步一致性 + 备份/恢复 + 自动升级** |
| [plans/2026-09-05-sync-consistency-remediation-plan.md](plans/2026-09-05-sync-consistency-remediation-plan.md) | **「同步一致性整改 + 跨设备回归脚本」可执行方案（P0 地基）**：现状盘点（device_seq 全 0 / FNV vs SHA-256 / `.part` / 增量指针 / 幂等）；按文件/接口的具体整改（桌面 sync.rs、web web.ts、服务端 sync.rs）；`scripts/sync-regression.mjs` 两设备互改收敛 + 无 400/413 + 哈希一致 + 幂等 + 增量的回归断言；新增/改动文件清单、验收清单、最小交付物（整改 + 回归脚本 + docs/SYNC.md） |
| [plans/2026-09-06-email-aggregate-plan.md](plans/2026-09-06-email-aggregate-plan.md) | **「聚合邮箱（邮件即笔记）」落地文档（[x] 已实现 v1.83.0）**：多账号 IMAP 聚合收件箱 + 一键转笔记/任务（capture-first）；范围界定（做/不做）、技术可行性、P0–P2 里程碑、验收清单、风险与决策点（OAuth 门槛/凭据安全/性能/范围失控）、文件级改动清单。**进展与实装详见 [多账号聚合收件流](plans/2026-09-07-email-multi-account-aggregation.md)；商业化/OAuth 凭据/服务端设想等敏感部分见私有 shuyonote-sync-server 仓库 `docs/email-aggregate-monetization.md`** |
| [plans/2026-09-07-email-multi-account-aggregation.md](plans/2026-09-07-email-multi-account-aggregation.md) | **「多账号聚合收件流」实现与交接（[x] 已落地 v1.83.0，方案 B 后端聚合）**：`email_fetch_all`（多账号合并/时间降序/分页/`date_from`+`date_to` 日期区间/`accounts` 筛选）+ `email_fetch_all_months`（聚合各账号含邮件月份）+ `email_test_connection`（IMAP 登录+选 INBOX+可选 SMTP 认证，不发信）；`smtp.rs` 抽 `connect_and_auth`/`verify`。前端：`EmailPanel` 账号「多选下拉」筛选、独立账号列、三级工具栏收纳、AI 总结弹窗、存为笔记先写属性再跳转、转发收件人聚焦修复、邮件 `Date` 解析兼容 QQ 等格式、按月直达（全量拉取后按邮件自身时区年月后端过滤）。**含第 1–4 步交付 commit、聚合视图按 `meta.account` 的 `accountFor` 账号定位、`emailKey` 防 uid 相撞、未读汇总与聚合月份直达等关键点** |
| [plans/2026-09-07-block-selection-plan.md](plans/2026-09-07-block-selection-plan.md) | **「块操作 / 块多选体系」（[x] 已落地 v1.84.0）**：设计原则=**文字选中优先**，块操作只认独立触发区——**A** 沟槽 `⋮⋮` 手柄（单击弹「块操作」菜单/Shift 连续多选/拖动排序）、**B** 显式多选模式（`Mod+Shift+M` 逐个点块加入/移出）、**C** 页面空白/空块框选；判别标准 `isSafeMarqueeTarget`（文本节点或含文字块→文字选择，否则框选）；记录与文本手势冲突的右键菜单/正文橡皮筋的移除、格式工具条修复、`$deepCloneBlock` 修复块复制；含文件清单与边界 |
| [plans/2026-09-10-plugin-distribution-strategy.md](plans/2026-09-10-plugin-distribution-strategy.md) | **插件分发策略（M11.11 前置细化，规划）**：把「插件市场」从**平台工程**降级为**协议 + 索引**——结论=**市场解决「发现」，我们缺「供给」**，所以**先做供给、市场最后做，空商店比没有商店更伤**。「依托社区」的正确姿势=**社区当索引宿主（托一份 `plugin-index.json` + 开一个讨论分类），不当市场后端**（省得下身份/讨论，省不下代码审查/元数据/文件托管与滥用处置）。含：`plugin-index.json` 字段规范（`apiVersion`/`minAppVersion`/`permissions[].reason`/`sha256`/`size`/`runtime`/`license`/`discussionUrl`）+ **分级信任**（索引签名→publisher 签名→审查评分）+ 多源订阅与**撤回两级（含离线撤回列表）** + **与既有 `latest.json` + minisign 设施对照（复用而非新造，边际成本≈0）**；**贡献阶梯**（模板→主题→**声明式配方**→逻辑插件→UI 插件，前三级是惰性数据、**今天就能安全开放**，把社区贡献与 M11.13 安全闸门解耦）；**一方先行**（官方先写 3–5 个「只有用插件 API 才做得出来」的插件，兼作 API 实测/示例/模板/招募样板，并撬开「≥3 真实第三方插件」闸门）；**与「绝不跟踪」对齐**（允许/禁止清单：禁下载计数、埋点热门、应用内评分、竞价推荐位；评价走社区帖子）；**社区上线当天可执行清单**；M11.11 细分为 **a 索引协议+zip/URL 安装 → b 治理与信任 → c 应用内市场 UI（最后做）**；红线=**官方插件无特权旁路**（同一 manifest/权限/API） |
| [plans/2026-09-10-plugin-host-isolation-plan.md](plans/2026-09-10-plugin-host-isolation-plan.md) | **插件宿主子进程化 + OS 级资源限制（M11.13）方案（规划，待拍板）**：把 Boa 挪进独立子进程，宿主成为**纯解释器**——不碰数据库、不拿解密密钥、没有任何路径（**今天插件的密钥与不可信代码同进程**，这是本文最要紧的发现，它决定了「能力全部 RPC 回父进程」这条边界）；超时与取消从「放弃等待」变成**真的杀进程**（顺带关掉 M11.5 遗留的线程空转）；OS 级内存/CPU 上限（Linux rlimit / Windows Job Object / 三平台统一 RSS 看门狗 + 峰值进审计）；IPC 用同二进制 re-exec（不新增二进制，打包签名不用改）；一次性执行不变式、写中介、权限逐次校验、审计全部保号；含 4 阶段迁移（约 9–10 天）、三条验收的自动化测法、现有 165 个测试怎么重排、6 个待拍板问题 |
| [plans/2026-09-10-plugin-evolution-plan.md](plans/2026-09-10-plugin-evolution-plan.md) | **插件体系进化方案（M11 重基线，规划）**：把 M11 的「磁盘命令插件」从能跑推进到能长生态。**定位=做第一不做更大**——做**第一个「有权限模型 + 作用在端到端加密、可自托管数据上」的可信插件体系**（Figma 有权限但数据在云、VS Code 不在其问题域、**Obsidian 官方承认做不到权限限制**；没人把「插件+权限+E2EE+自托管」凑齐）。含：判据（用户敢装 / 碰不到加密边界之外 / 有人愿意写 / 不返工）与**分轴预期刻度**（权限/沙箱/声明式/加密边界/ABI 对齐或超出；隔离强度分两段闭合；DX 结构性低于顶级；治理与生态规模低于顶级）；**资源与故障隔离矩阵（§3.11，已核实源码）**——Boa 无分配预算 API（0.21.1 与最新 0.22.0 皆无，上游 issue 不涉内存）、`handle_alloc_error` 在 stable Rust 下是 abort 且可定制钩子为 nightly-only → **进程内正解是"超预算就 panic 让它 unwind"**（返回 null 反而确定性弄死应用），段错误/UB/OS 级账目留 M11.13；**权限 × 加密边界**（空间级能力只作用于活动空间、锁定空间返回 `space_locked` 且不隐式解锁、插件数据按 scope 落库——space 级进空间库随 SQLCipher 加密）；**审计与可见性**（权限使用审计轨迹 + 错误码表）；里程碑（M11.5 时限/资源上限/故障可见性 → M11.6 ABI v1 + 能力注册表单一事实源 + 带 `reason` 的权限声明 + **类型包** + **CLI/热重载前移** → M11.7 能力扩容并与 AI 语义工具层合并 → M11.8 触发面/事件 → M11.9 声明式无代码插件 →（闸门）M11.10 沙盒 UI / M11.11 分发治理；**M11.13 隔离强度（宿主子进程化 + OS 级资源限制）已判定必有，为 M11.11 分发硬前置**）；9 项**不可逆决策**与可延后决策清单；**弯路清单**（语言特性黑名单、插件进 renderer、能力广度军备竞赛、插件数据出加密边界、双重能力实现、常驻实例、用"对齐顶级实践"当验收标准、把内存缺口含糊掉等） |

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

## 社区互动（社区接入）

| 文档 | 内容 |
|---|---|
| [community-integration-status.md](community-integration-status.md) | **验收记录与现状**：深链 / 拿回内容 / 导入产物 / 插件分发四块——哪些已验过、用什么验的（含真机与线上证据）、还差什么，以及七条踩过的坑（每条都对应一个门禁）。交接时看这一份，不必翻聊天记录 |
| [plugin-hosting.md](plugin-hosting.md) | **托管方怎么发**：索引与签名怎么签、缓存头规矩、**先传包后传索引**的上传顺序 |

## 变更记录（changelog）

- [CHANGELOG.md](../CHANGELOG.md) —— **版本变更日志**（Keep a Changelog 格式，`v1.6.0` 起，当前 `v1.90.0`）。

## 约定

- 功能规划、竞品分析、产品定位归 `docs/`；像素级 UI/UX 设计交付归 `design/`。
- 里程碑完成的规划会标注 [x] 并补充「实现」要点，对应到具体文件/命令。
- 版本演进以 `CHANGELOG.md` 为准，`docs/` 文档聚焦"是什么 / 为什么 / 怎么做"。
