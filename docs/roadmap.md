# ShuyoNote 路线图

> 基于三方对比（见 [compare-obsidian-siyuan-shuyonote.md](compare-obsidian-siyuan-shuyonote.md)）梳理的演进路线。按「价值 ÷ 工程量」排序。**✅ = 已实现并合入**；「规划」= 已出 [方案](README.md#方案与规划-plans)，待里程碑落地。设计走向遵循 [设计哲学](design-philosophy.md)。

## 1. 现状（已实现）

- **块编辑器**：Lexical 12 种块类型、表格交互（悬浮工具栏 / 列宽 / 选区）、图片/视频/附件、块拖拽排序、斜杠菜单、Markdown 快捷输入
- **块多选 / 批量删除**：`⋮⋮` 手柄选中（Shift 连续）、**鼠标框选**（拖矩形选多块，任意方向）、右键上下文菜单（复制/删除）、批量操作条、`Delete`/`Esc` 快捷键
- **应用内确认弹窗**：删除 / 彻底删除 / 恢复版本 / 导入备份等二次确认改为窗口居中的 `ConfirmDialog`（主题卡片样式，红色 `!` 徽标 + 主题强调色按钮）
- **块级引用/嵌入/反链**：稳定 `blockId`、`((id))` 块引用、`{{id}}` 块嵌入、块级反链面板、目标缓存刷新
- **属性 + 数据库**：8 类型属性 + **Notion 风格属性面板** + 数据库页（表格/画廊/看板/列表/日历/时间轴/目录/甘特图 八视图）+ 列/选项管理 + 标签互通
- **文件管理视图**：侧边栏点文件夹进入（表格 + 新建/上传/移除），文件夹内批量超大文件流式上传、侧边栏同步显示
- **标签系统**：全局标签库（新建/重命名合并/删除/使用页数），侧边栏按标签筛选，标签管理菜单实时刷新
- **关系图**：力导向图、块级图层、局部/缩放平移/聚焦、标签与属性过滤着色
- **组织与检索**：页面树 / 文件夹、标签、看板、FTS5 全文搜索（含 `prop:` 属性语法）
- **导入健壮性**：Markdown 无损往返 + **HTML/Markdown 混排导入**（`mdToHtml` + 直接 HTML→Lexical），图片去重存储
- **数据安全**：自动保存、版本历史、回收站、整库备份
- **同步**：自建 shuyonote-sync-server（outbox 变更日志 + LWW + 附件内容寻址）
- **体验**：暗色模式、命令面板、多窗口、快捷键、主题/强调色自定义、PDF 导出

**半就绪 / 骨架（已落地）**：
- 模板中心 = **已实现**（M9 里程碑达成：建页填内容 / 保存为模板 / 共享打磨 / 数据库模板，见下）
- 多工作空间 = **已实现**（M10 里程碑达成：隔离 + 切换 + 生命周期 + 每空间内容过滤；**M15 物理隔离**把它升级为「每空间独立 SQLite 库 + 全局内容寻址附件 + 单空间导出/导入」）
- 插件 = **已实现（L1）**（M11 里程碑达成：磁盘加载命令插件 + boa 受限运行时 + 白名单 API + 启停持久化 + 卸载/安装 + `__insert` 可插入内容）。**下一步见 [插件体系进化方案](plans/2026-09-10-plugin-evolution-plan.md)**（M11.5–M11.13：先补时限/资源上限与故障可见性 → 冻结 ABI/权限 → 扩能力并与 AI 工具层合并 → 触发面 → 声明式插件 → 有闸门的 UI/分发；隔离强度 M11.13 已判定必有，为 M11.11 分发硬前置）；**分发与供给侧策略见[插件分发策略](plans/2026-09-10-plugin-distribution-strategy.md)**（协议而非平台 + 贡献阶梯 + 社区上线当天清单）
- 团队版同步（M27 部分）= **已实现**：客户端 **per-workspace `sync_profiles`**（一个客户端持多身份，各空间同步到各服务器）+ **sync-server S1–S8**（认证/角色/同步隔离/空间级附件/审计/Docker）+ 同步 E2E（见 M2）；账户 UI / 个人密钥 / 本地加密 见 [身份与隐私子路线图](identity-privacy-roadmap.md)

## 2. 下一阶段优先级

| 优先级 | 方向 | 对标 | 理由 | 状态 |
|--------|------|------|------|------|
| **P0** | **模板**（结构预设建页 + 保存为模板） | Notion / FlowUs / 思源模板 | 冷启动 + 复用效率；当前点模板是空白页 | ✅ M9（v1.13.0） |
| **P0** | **多工作空间**（隔离 + 切换 + 查询 scope 修正） | Notion workspace / Obsidian vault | 生活/工作/项目分离、独立备份/导出/加密 | ✅ M10（v1.11.0）+ **M15 物理隔离**（v1.41.0） |
| **P0** | 端到端加密 | 思源 / Obsidian Sync | 数据安全最高优先级 | ✅ M2（v1.26.0） |
| **P1** | **插件**（L1 已落地；进化 = 权限模型 + 加密边界 + 统一能力层 + 触发面） | **不对标 Obsidian 的能力面**（那要交出 renderer 全信任、等于放弃红线）；**对标一个目前空着的位置：第一个「有权限模型 + 作用在 E2EE 数据上」的可信插件体系** | L1 能力面太薄 + 无作者文档 + 无分发，生态起不来；而"可信"这条恰是只有 ShuyoNote 凑得齐的零件（M15 每空间隔离 + E1 SQLCipher + M11 受限运行时 + M17 白名单宿主） | ✅ M11 L1（v1.32.0）；进化 [M11.5–M11.13 规划](plans/2026-09-10-plugin-evolution-plan.md)（**做第一不做更大**，含分轴预期刻度；M11.10 UI / M11.11 市场带闸门后置；M11.13 隔离强度已判定必有，为 M11.11 硬前置） |
| **P1** | 主题 / 外观自定义 | Obsidian 主题 | 扩展性雏形 | ✅ M3 |
| **P2** | **文件夹 = 网盘**（文件库增强：拖拽上传 / 在线预览 / 搜索 / 下载 / 每夹统计） | FlowUs / Wolai / 有道 | 文件夹同时承载页面与文件，本地优先+去重+可加密形成差异化私域网盘 | ✅ M12（v1.33.0） |
| **P2** | 数据库贯通：查询型数据库 / 保存视图 / ref 关联属性 / 公式汇总 | Notion / Dataview | 数据库从「表格」升级为「数据工作台」 | ✅ M13（v1.25.0） |
| **P2** | 移动端适配 | 思源 / Obsidian | 多端能力 | M6 移动端（安卓/iOS）**即将推出**；已升级为 **M16 全平台通吃**（[规划](plans/2026-08-24-cross-platform-plan.md)） |
| **P2** | Markdown 无损往返 | Obsidian 存储哲学 | 消除「格式锁定」顾虑 | ✅ M1 |
| **P2** | 属性驱动仪表盘聚合 | 思源数据库 + Dataview | 释放属性数据库价值 | ✅ M4 |
| **P2** | PDF 导出 | 思源 / Obsidian | 导出矩阵补全 | ✅ M5 |
| **P2** | 空间清理 / 存储管理 | FlowUs / 思源 | 存储可统计、可安全回收 | ✅ M14（v1.37.0） |
| **P3** | 新页面引导层 | Wolai / FlowUs | 降低冷启动门槛 | ✅ M8 |
| **P3** | 社区插件市场 | Obsidian 生态 / 思源集市 | 平台级长期目标 | 延后（**M11.11c**，L3 已评估）；**硬闸门**：作者文档 + ≥3 个真实第三方插件。**社区上线不改变闸门**——先做[贡献阶梯（模板/主题/声明式配方）](plans/2026-09-10-plugin-distribution-strategy.md)与一方先行插件，市场做成「索引订阅协议」而非自建平台 |
| **P3** | AI 增强（薄 Agent 接口） | Obsidian AI / 思源 AI | 可选增强 + 本地倾向；不嵌入任意命令运行时 | ✅ M17（v1.59.36） |
| **P3** | **内联 AI 起草**（就地写/扩/改 + 高亮待定块 + 快捷动作） | wolai / FlowUs / Notion AI | 把 M17 底座变成「所见即所得」的文档内创作；与侧边栏分工 | ✅ M18（v1.59.117，[方案](plans/2026-08-24-inline-ai-draft-plan.md)） |
| **P1** | **Wiki 织网增强**（未链接提及 + 双链别名 + 精确块链） | Obsidian 双链 / wiki | 把「双链」做深，让笔记真正织成网 | ✅ M19（v1.59.116） |
| **P1** | **模板变量 + 语义检索（RAG）** | Notion 模板 / 思源 AI | 复用模板中心；搜索从「关键词」升级为「语义」 | ✅ M20（v1.59.119） |
| **P2** | **静态 wiki 导出 + 关系图探索** | 独立 wiki 站点 / FlowUs 图谱 | 「本地优先 + wiki」的终局表达；图谱从能看变能探索 | ✅ M21（v1.59.121） |
| **P3** | **PDF 批注** | 思源 / MarginNote / LiquidText | 知识工作者高频硬需求；「批注即块」能进反链/搜索/关系图；2026 破局点在「AI 帮读」 | ✅ **M24**（v1.59.178 起，[方案](plans/2026-08-27-pdf-annotation-plan.md) + [阅读器/AI 增强](plans/2026-08-30-pdf-reader-ai-plan.md)） |
| **P2** | **帮助系统** | Notion / 思源 | 本地优先/键盘驱动的四层帮助（就地提示+快捷键面板+内置指南页）；帮助页=可编辑笔记，复用命令面板/模板/`shortcuts.ts` | ✅ M25（v1.59.177，[方案](plans/2026-08-27-help-system-plan.md)，P0/P1 落地） |
| **P2** | **公式（数学）** | Notion / FlowUs / wolai | 正文行内 `$…$` + 块级 `$$…$$` 数学公式，KaTeX 渲染（懒加载）；理工科笔记/论文/教程常见需求 | ✅ M26（[方案](plans/2026-08-30-formula-plan.md)，块级 + 行内落地） |
| **P0** | **团队版（自建协作）** | Notion 团队版 / 语雀 / 飞书知识库 | 多用户 + 权限（协同后置）；不接外部通讯 App，全自建；组织空间放弃零知识（个人空间保留 E2E） | 🔶 **M27 部分**（服务端 S1–S8 + 客户端 per-space 同步 + 账户 UI（U1–U4）+ 本地加密（E1）已落地；协同后置，[身份与隐私子路线图](identity-privacy-roadmap.md)） |
| **P0** | **多账户切换 UI**（空间身份标签 / 当前目标 pill / SyncPanel 登录+空间下拉） | 多账号工作流 | 一人多服务器×多空间时看清「我在同步到哪」；低成本 | ✅ M27-UI（U1–U4 落地，[身份与隐私子路线图](identity-privacy-roadmap.md)） |
| **P1** | **本地静置加密**（口令→Argon2id→密钥→加密 DB+附件，默认关） | Notion 本地加密 / 思源 | 个人无服务器也想私密；与同步 E2E（M2）互补 | 🔶 E1 已落地（SQLCipher 空间库 + 附件加密 + 锁定门控，v1.64.16）；E2 忘记口令提醒待 |

## 3. 里程碑规划

### M1 — Markdown 无损往返（P2）✅
`markdownTransformers.ts` 的 `SHUYONOTE_TRANSFORMERS` 已覆盖图片/视频/块嵌入/块引用/分隔线/待办/Callout/表格，补齐 Lexical 0.49 默认缺口。往返一致性待运行验证。**Markdown 批量导出**（v1.31.0）：命令面板「导出工作空间为 Markdown」用 offscreen `createEditor` 把本空间所有页面批量导出为 `.md` 文件（可 git / 任意编辑器可读），强化数据可移植。

### M2 — 端到端加密（P0）✅
本地加密后上传，服务端不可读；`content_json`/`content_text`/附件加密同步；每空间独立密钥（见[多空间方案](plans/2026-08-22-multi-workspace-plan.md#8-同步与加密)）。密钥仅存本机。
- **M2.1 加密原语** ✅（v1.16.0）：Argon2id 密钥派生 + XChaCha20-Poly1305（`nonce||ciphertext`）+ 单元测试。
- **M2.2 同步加密** ✅（v1.17.0，默认关）：`set_encryption`/`encryption_status`/`disable_encryption`（密钥/盐存本机）；`push` 加密 / `pull` 解密（服务端存密文）；未启用纯透传。
- **M2.3 设置 UI + 口令解锁/锁定** ✅（v1.26.0）：主题设置弹层「端到端加密」区块（开启/关闭/状态徽章）；`lock_encryption`/`unlock_encryption` 会话锁定——锁定后同步被拒（`sync_gate`），须口令解锁；口令校验密文（sentinel）验证，密钥仅存本机。**M2 端到端加密里程碑达成**。注：自建服务端端到端往返未在本环境验证（加密路径经单测）。

### M3 — 主题 / 外观自定义 + 插件雏形（P1）✅
主题设置弹层（系统/亮/暗 + 6 色强调色，CSS 变量覆盖）+ 插件启停开关（`registry` 加 enabled，命令面板按启用过滤）。「本地目录扫描安装」归入 [插件方案](plans/2026-08-22-plugin-plan.md)。

### M4 — 属性驱动仪表盘聚合（P2）✅
`DatabaseView` 顶部汇总条——select 列按值着色计数徽标、number 列合计/均值（纯前端聚合，尊重筛选）。

### M5 — PDF 导出（P2）✅
复用 `$generateHtmlFromNodes` + `HTML_TEMPLATE` → 隐藏 iframe → `window.print()` 另存为 PDF。**数据库页 PDF**（v1.30.0）：数据库「⤓ PDF」把当前视图渲染为 HTML 表格并打印——抽取 `src/lib/print.ts` 供页面与数据库共用。

### M6 — 移动端适配（P2，即将推出）
Tauri 移动端（iOS/Android）核心编辑 / 浏览 / 搜索可用。**状态**：移动端（安卓 / iOS）**即将推出**——复用 M16 平台无关核心 + 可插拔平台壳，浏览器 PWA 已作为首个 Web 壳；移动端复用同一套前端与数据模型（见 [跨平台方案](plans/2026-08-24-cross-platform-plan.md)）。

### M7 — 数据库视图扩展（P2）✅
`DatabaseView` 八种视图（表格/画廊/看板/列表/日历/时间轴/目录/甘特图）；日历按 `date` 落格、时间轴按 `date` 排序、目录按页面层级、甘特图用开始/结束(或计划/实际 4 列)渲染网格填色。

### M8 — 新页面引导层（P3）✅
`NewPageGuide` 空状态引导（页面/数据库/模板库/导入 Markdown/AI 预留），输入后自动隐藏。

### M9 — 模板（P0，✅ 达成，[规划](plans/2026-08-22-template-plan.md)）
- **M9.1 建页填内容** ✅
- **M9.2 保存为模板** ✅（`database_json` 数据库模板归 M9.2b）
- **M9.3 共享打磨** ✅
- **M9.2b 数据库模板** ✅（v1.13.0）：`kind='database'` 模板一键建库 + 预设列（`create_attr`/`add_db_column`）。**M9 里程碑达成**。

### M10 — 多工作空间（P0，[规划](plans/2026-08-22-multi-workspace-plan.md)）
- **M10.1 隔离底座** ✅（v1.9.0）：`active_workspace_id`（持久化 `sync_state`）+ `list_workspaces`/`create_workspace`/`get_set_active_workspace_id` + 侧栏空间切换器 + `list_pages`/`create_node` 按活动空间过滤/写入。注：tags/回收站/搜索/关系图的按空间过滤归入 M10.3。
- **M10.2 生命周期** ✅（v1.10.0）：空间切换器中非当前空间可删除（二次确认 → 软删 `workspaces.deleted_at`，内容保留）；删除活动空间时 `get_active_workspace_id` 自动回退到最早未删除空间。注：`export_workspace` / `rename_workspace(id)` 为 M10.2b，暂未实现。
- **M10.2b 空间增删改补全** ✅（v1.35.0，[规划](plans/2026-08-22-workspace-crud-plan.md)）：`create_workspace` 种子默认首页；`rename_workspace(id, name)` 按 id 重命名（切换器逐项 ✎ 改名 + 顶部双击改当前）；删除前导出/备份提醒；软删保留、物理清理归 M14。
- **M10.3 每空间设置** ✅（v1.11.0）：所有内容查询按活动空间过滤——回收站 `list_deleted`、标签 `list_tags`/`pages_by_tag`/`board_data`、全文搜索 `search`、关系图 `get_graph`、反链 `get_backlinks`。**M10 多工作空间里程碑达成**。补记（v1.33.1）：`query_database` 按数据库页所属工作空间收窄作用域（此前遗漏的串空间修复）。
- **M10.3b 空间级设置落地** ✅（v1.35.0，[规划](plans/2026-08-22-workspace-crud-plan.md)）：`WorkspaceMeta` 增 `theme/icon/sort_order`；每空间自动分配主题色（切换器色点 + 顶部高亮）；`set_workspace_settings`；空间按 `sort_order` 排序。**补记（v1.36.0）**：切换器逐空间「颜色按钮」+ 8 色调色板，每空间主题色可自定义。说明：每空间主题（覆盖应用主题）为后续项。
- **M10.4a 全空间搜索** ✅（v1.27.0）：搜索框「本空间 / 全空间」切换——`search` 增 `all_spaces` 参数，忽略活动空间过滤并返回结果所属空间名（`SearchResult.space`）；FTS / LIKE / `prop:` 过滤均支持。
- **M10.4b 跨空间复制页面** ✅（v1.29.0）：侧边栏页面行「复制到其他工作空间」→ `copy_page_to_workspace` 递归复制子树（新 id + 重设空间/父级）+ 属性/标签/附件行（内容寻址共享）+ 重建 FTS/块图/反链 + 记录同步 upsert；保留 blockId，子树内块引用仍解析，跨子树引用不解析（块图空间内红线）。说明：共享模板库（模板默认全局）已满足；插入指定父级为后续项。

### M11 — 插件（P1，[原始方案](plans/2026-08-22-plugin-plan.md) + [**进化方案**](plans/2026-09-10-plugin-evolution-plan.md)）

> **重基线（2026-09-10）**：L1 三档（M11.1 / M11.2 / M11.2b）已达成；后续按[插件体系进化方案](plans/2026-09-10-plugin-evolution-plan.md)重排为 **M11.5–M11.13**，顺序刚性——**先补时限与故障可见性 → 再冻结 ABI 与权限 → 然后才扩能力 → 触发面 → 声明式贡献面 →（闸门）UI →（闸门）分发**；另有 **M11.13 隔离强度（子进程化 + OS 级资源限制）已判定必有**（Boa 无分配预算 API 已核实），但**不阻塞 M11.7**，改为 **M11.11 分发的硬前置**、并在出现 Boa 段错误时升 P0。原 M11.3（UI 型）/ M11.4（市场）的「后置」结论不变，重编号为 **M11.10 / M11.11** 并补上明确启动闸门。
>
> **定位（北极星，2026-09-10）**：**做第一，不做更大**——目标是**第一个「有权限模型的可信插件体系」，且作用在端到端加密、可自托管的本地数据上**。对标三家各缺一块：Figma 有沙箱与域白名单但数据在云上；VS Code 有进程隔离但不在其问题域；**Obsidian 官方承认做不到权限限制**（插件继承应用访问级别、可读本机文件/联网/装程序）。**没人把「插件 + 权限模型 + E2EE + 自托管」凑齐**。因此**不以"能力条数对标 Obsidian"为判据**（那要交出 renderer 全信任，是放弃红线）；判据是「**用户敢装**」与「**插件碰不到加密边界之外**」——见方案 §1.1、§3.9。
>
> **预期刻度（不要读成"全面对齐业界顶级实践"）**：完整实施后在「权限模型 / 沙箱哲学 / 声明式贡献 / 加密边界内的可信性 / ABI 工程」这几轴**对齐或超出**业界；「隔离强度」**分两段闭合**——内存炸弹在 M11.5 闭合（已核实 Boa 无分配预算 API，用"超预算 panic 的限流分配器"），原生崩溃/段错误/OS 级账目等 M11.13 子进程；「开发者体验」**结构性低于顶级**（Boa 无 console/devtools/source map/JIT，选型决定）；「供应链治理与生态规模」**低于顶级**（前者 M11.11 带闸门，后者取决于用户规模而非架构）。见方案 §1.1 分轴结论、§3.11 与 §9。

- **M11.1 插件底座** ✅（v1.14.0）：插件目录扫描 + `manifest.json` 校验 + **boa 受限运行时 + 白名单 API**（`register`/`__get_current_page`/`__pages`/`__toast`）+ 命令并入命令面板 + `enabled` 持久化；内置示例插件 + Rust 单元测试。**补记（2026-09-10，代码核实）**：白名单实为 4 个（`__insert` 见 M11.2b）；`__pages()` 返回**总数**而非页面列表；`__toast()` 只写 stderr、**未接 UI**。**再补记（2026-09-10，探针测试暴露的真 bug）**：所谓「命令并入命令面板」**一直是失效的**——宿主也注册了一个 `register` 全局用于收集元数据，但它被 BOOTSTRAP 里同名的 JS `function register` 覆盖，于是 `discover_commands` **恒返回空数组**：插件能装、能启停，**命令却永远不出现在命令面板里**（等于装上用不了）。已改为由 JS 的 `__describe()` 以 JSON 交回元数据（顺带修好一直是死字段的 `closeOnRun`），并加回归测试 `discovery_actually_finds_registered_commands` 钉住「discovery 必须真的发现命令」。
- **M11.2 管理生命周期** ✅（v1.15.0）：插件管理面板（列表/启用禁用/卸载/从文件夹安装/打开插件目录）+ `uninstall_plugin`/`install_plugin`/`open_plugin_dir` 命令。**补记（2026-09-10，代码核实）**：`open_plugin_dir` 只在 Windows 生效（`#[cfg(target_os = "windows")]`），macOS/Linux 点击无反应；卸载不清理启停状态行、示例插件 `demo` 卸载后每次启动复活。→ 收进 M11.5。
- **M11.2b 插件可插入内容** ✅（v1.32.0）：`__insert(text)` 白名单 API——插件 `run()` 调用即可把文本插入当前页面；`run_plugin_command` 返回 `{message, insert}`；命令面板在光标处插入；示例插件新增「插入文本」。
- **M11.5 前置硬化（时限 · 可见性 · 一致性）** ✅（已落地，[进化方案](plans/2026-09-10-plugin-evolution-plan.md)）：
  - ✅ **时限与资源上限**：两个 Context 都设 `RuntimeLimits`（`run` 循环 1e6 / discovery 1e5 / 递归 256）；**thread-local 限流分配器**（64 MiB 峰值预算，`alloc`/`alloc_zeroed`/`dealloc`/`realloc` 全路径计费，`realloc` 只算增量）——**超预算 panic 让它 unwind**（不返回 null：stable Rust 下那等于 abort 应用），由 `catch_unwind` 转成「插件超出内存预算（64 MiB）」的干净错误，**应用存活且只终结该次调用**。
  - ✅ **不再挂住调用方**：discovery 走带超时工作线程（3s）；`list_plugins` / `install_plugin` / `run_plugin_command` 改 `async`（此前同步命令会占住调用线程最多 5s）。
  - ✅ **生命周期一致性**：卸载清启停状态行（重装不再静默继承旧的「已禁用」）；`demo` 改为 `.demo-seeded` 播种标记，**卸载后不再复活**；安装**先校验后落盘**（含入口文件可加载 + 带超时 discovery）并对半残目录回滚。
  - ✅ **权限强制**：`run_plugin_command` 后端校验 `enabled`（禁用不再只是 UI 假象）。
  - ✅ **校验修正**：`manifest.main` 改判「单一 `Component::Normal`」——此前**误拒** `./main.js`、**放行** `.` 与 `..`；id 白名单另拒「全点 / 结尾点」（Windows 会规范化结尾的点）。
  - ✅ **错误可见**：插件失败全部接 `toast`（保留后端原始错误文本）、命令面板不再谎报「已切换插件状态」、卸载加二次确认；顺带把 `open_plugin_dir` 补齐 macOS / Linux（此前只有 Windows 分支，点了没反应）。
  - ✅ **日志与提示**：`__toast` **接通 UI**（提示随调用结果回传、前端弹 toast——此前只写 stderr，用户完全看不到）；新增作者侧 `__log(level, msg)` + **200 条日志环形缓冲** + 插件面板「日志」查看/清空（插件运行时连 `console` 都没有，这是作者唯一的排错手段）。
  - ✅ **运行态可见 + 可取消**：执行期间命令面板显示「⏳ 正在执行「X」…」+ 取消按钮；取消 = **丢弃结果**（副作用都在返回值里，丢掉即无半途写入），提示文案诚实说明"插件代码可能仍在后台跑完"（Boa 无中断 API，彻底解决归 M11.13）。
  - ✅ **测试与 CI**：新增 19 条 Rust 单测（沙箱逃逸回归 / 循环预算 / discovery 快失败 / with_timeout / id 白名单 / `main` 矩阵 / `read_manifest` 矩阵 / 启停往返 / 卸载清理 / **分配炸弹只终结该次调用** / 分配器自身 5 条 / 日志与 `__toast` 3 条）与 12 条前端单测；**`cargo test --lib` 已进 CI**（`ci.yml` 新增 `rust-tests` job，依赖与工具链照抄 `release.yml`）。
  - **验收状态（全部达成）**：死循环插件不再挂调用方、分配炸弹只终结该次调用（均有测试断言）；失败路径 UI 可见；禁用插件 IPC 不可执行；运行中的插件有可见状态且能取消。
- **M11.6 ABI v1 冻结 + 能力注册表 + 权限模型** ✅（**已落地**，含作者工具链）：
  - ✅ **单一事实源 + 代码生成 + 门禁**：`capabilities/capabilities.json` 是唯一事实源；`scripts/gen-capabilities.mjs` 由它生成 **4 类产物**——`capabilities/plugin-api-shim.js`（插件看到的 `api.*`）、`src-tauri/src/capabilities_gen.rs`（id → 权限/scope/实现函数名）、`packages/plugin-types/index.d.ts`（作者类型包）、**`docs/plugin-api.md`（面向作者，含快速开始/权限/能力/错误码/沙箱边界，不读源码即可写插件）**；`scripts/check-capabilities.mjs` 做门禁（注册表完整性 + 生成物一致 + 每条能力的实现函数真的在 `plugins.rs` 里 + 出现在作者文档与 shim 里 + 无死权限 + `legacyGlobals` 指向存在），**已进 CI 与 `pnpm build`**，并已验证它会真的失败。
  - ✅ **`api.*` 成为唯一 ABI 面**：宿主只注册 `__cap(method, argsJson)` 一个原语 + 老全局别名；老写法（`__toast`/`__insert`/`__pages`/`__get_current_page`/`__log`）内部走**同一套派发**，不构成绕过点。`__cap` 统一返回 JSON 字符串，shim 侧解析。
  - ✅ **权限模型**：manifest `permissions` 为**带 `reason` 的声明**；**后端逐次调用校验**（测试覆盖：未声明 → `permission_denied`，连老全局写法也拒）；未知权限忽略并告警（前向兼容）；没写 `permissions` 的老 manifest 走 **v1 基线授权 + 警告**（避免升级即失效）；没写 `reason` 告警。
  - ✅ **ABI 闸门**：manifest `apiVersion` 主版本不认识**直接拒载**（而不是运行时零碎失败）。
  - ✅ **「用户敢装」的两处落点**：`PluginMeta` 带 `permissions[{id,title,reason,risk}]`，插件面板把「权限 + 理由」摊给用户（标题来自注册表，不是裸 id；基线授权如实标注）；**新装插件默认禁用**——安装≠授权，用户看完权限再自己启用。
  - ✅ **顺带修好**：`closeOnRun` 死字段（现在真布尔值 + 命令面板按它关面板）；示例插件改用 `api.*`（v0.2.0）。
  - ✅ **状态表 + 迁移**：`plugin_install`（安装记录：id/版本/开关/来源/播种位，**不含用户内容**）取代 `plugin_state` 泛 KV，附**幂等迁移**（`plugin_enabled::{id}` → 安装行，且不覆盖用户已做的启停选择）；`plugin_data`（插件私有数据）在 **meta.db（app scope）与各空间库（space scope）两侧建表**——空间级数据必须落空间库才随 SQLCipher 加密、随空间备份搬移（方案 §3.7 的落库约定）。卸载 = 删安装行 + 删该插件私有数据，"残留状态"从结构上消失。
  - ✅ **§3.10 能力调用审计**：每次能力调用记一条**元数据**（插件 / 能力 / scope / 时间 / 成功与否 / 错误码），**只记元数据不记内容**；500 条环形缓冲 + 插件面板「活动」查看/清空。**权限被拒的调用同样留痕**——那恰恰是最该查的一类。
  - ✅ **§6.3 正名**：`src/plugins/registry.ts` → **`builtinCommands.ts`**，类型 `Plugin*` → `Builtin*`（`BuiltinCommandGroup` / `BuiltinCommand` / `registerCommandGroup` / `getBuiltinCommands`）；**删掉已无调用方的死代码**（`usePluginState` 启停机制、`togglePlugin` / `isPluginEnabled` / `getEnabledPlugins` / `usePluginRevision`、以及导出后无人使用的 `PLUGIN_META`），顺带**消除了 `PluginMeta` 同名两义**（与 `types.ts` 的磁盘插件 `PluginMeta` 冲突）；文件头改写为"这是内置命令组、不是插件"，把历史上那次返工的根因写在代码里。
  - ✅ **作者工具链（本次收口）**：
    - **应用内「校验」**（`validate_plugin`）：一次列出全部问题（manifest 字段 / 权限与理由 / **Boa 语法** / 命令注册），并给命令清单与**实际授予**的权限；与加载器**同源**，且有兜底——加载器会拒时报告必然有 error（`loader_rejected`），杜绝「校验说没问题、应用装不上」。
    - **热重载**：面板打开期间轮询插件目录指纹（文件名+大小+mtime，无新依赖），改动即自动重扫，命令面板随之刷新。
    - **`pnpm plugin:validate <目录>`**（`scripts/plugin-cli.mjs`）：编辑器/CI 用的对照检查，权限清单+风险+理由一并打印，`--json` 给 CI；权限与 API 版本取自注册表同一源。
    - **示例插件 3 个**（`examples/plugins/`）：只读 / 写草稿+私有数据 / 先读后写；`cargo test` 用加载器同一路径断言可用，CI 再跑作者 CLI 与 `tsc`。
    - **类型包**：新增 `globals.d.ts`（脚本不是模块，此前 `api`/`register` 在 `// @ts-check` 下不可见），并把 13 条能力的返回类型由 `unknown` 精确化（按 Rust 实现实际字段核对）。
  - ⏳ **两处与方案原文的差异（如实记账）**：
    - **`dev` 热重载做在应用内**（插件面板打开即自动重扫、无需子命令），没有单独做 `dev` 子命令——桌面应用的作者循环本来就在应用里，多一个子命令只是多一条要维护的路径；`validate` 两侧都有（应用内 + `pnpm plugin:validate`）。
    - **类型包只「生成」未「发布」**：`packages/plugin-types` 仍是 `private: true`，作者靠 tsconfig `paths` 指到仓库内路径使用。发布到公开 registry 需要先定 registry 与 npm scope（属分发决策，见[分发策略](plans/2026-09-10-plugin-distribution-strategy.md)），在此之前不放行——半个包名比没有包名更麻烦。
  - ⏳ **仍未触发**：§3.9 的跨空间与 `space_locked`（v1 能力全是 `current-space`/`app`，**暂无跨空间能力所以尚未触发**；表结构与落库约定已按 §3.7 就位，等后续加跨空间能力时生效）。
- **M11.6 原始条目（保留备查）**：建 `capabilities/capabilities.json` **单一事实源**（每条能力必须声明 `scope`）+ 生成（JS shim / Rust 绑定 / 作者文档）+ `check-capabilities` 门禁；Boa 只留 `__cap`/`__log` 两个私有原语，插件只见生成的 `api.*`（**传输无关**，为 M11.10 复用）；`apiVersion` 必填且**语义化**（`"1.0.0"`，对齐 Figma manifest）；manifest `permissions` 为**带 `reason` 的对象数组**，安装界面显示「权限 + 理由」（对齐 Figma `networkAccess.reasoning`）+ 后端逐调用校验；**权限 × 加密边界**落地（能力上下文只含活动空间、**锁定空间返回 `space_locked` 且不隐式解锁**、`plugin_data` 按 scope 落库：space 级进空间库随 SQLCipher 加密、app 级才进 `meta.db`）；`plugin_install`/`plugin_data` 两表替代泛 KV；插件 id 收紧为单段 `[a-z0-9-]`；**生成并发布 `@shuyonote/plugin-types` 类型包**（作者侧 IDE 补全/编译期检查，对齐 `@figma/plugin-typings`/`@types/vscode`）；**审计与可见性落地**（权限使用审计轨迹 + 文档化错误码表）；**作者 CLI 与热重载从 M11.11 前移到本档**（开发循环与 API 同时交付）；新建 `docs/plugin-api.md` 作者文档 + 示例插件。**验收**：只看文档不读源码的人能写出可安装可运行的插件（示例插件在类型包下 `tsc` 零错误）；未声明权限的调用被拒；锁定空间返回 `space_locked`（有测试）；空间级插件数据随空间加密/导出（有测试）；设置页可查插件的权限使用记录。**这是「可信」定位的技术落点**（[方案 §3.9/§3.10](plans/2026-09-10-plugin-evolution-plan.md)）。
- **M11.7 能力扩容：读 + 受控写（与 AI 工具层合并）** ✅（**已落地**，20 条能力 / 11 项权限）：
  - ✅ **读能力 6 条**（注册表条目 + 权限 + 作者文档 + 测试一体生成）：`pages.list` / `pages.get` / `pages.search`（v1 子串匹配，**诚实标注不做相关度排序**）/ `tags.list` / `backlinks.list` / `files.list`（**只给元数据不给字节**）；新增权限 `read:tags` / `read:backlinks` / `read:files`。
  - ✅ **插件线程的数据访问通道**：插件线程没有 `State<Db>`，所以数据能力**在插件线程内惰性开一条到活动空间的读连接**（`db::open_space_conn` 已处理好 E1 `PRAGMA key` / WAL / meta attach / 建表迁移）。**只作用于活动空间**——插件拿不到别的空间的数据，不是靠自觉而是宿主不给（方案 §3.9）。不用数据能力的插件不付这个成本。
  - ✅ **`space_locked` 落地**：加密空间在会话锁定时明确返回 `space_locked`，**不静默返回空、不隐式解锁**——插件调用不能成为绕过启动锁的通路；错误码映射抽成可测函数并有测试钉住。无法确定活动空间时返回 `space_unknown`（而不是装作"没有数据"）。
  - ✅ **`kv.own` 落地（含 scope 路由）**：`kv.get` / `kv.set` / `kv.remove`（权限 `kv:own`）。**默认 scope = `space`**（落空间库，随 SQLCipher 加密、随空间备份搬移）；显式 `app` 才落明文 `meta.db`（只该放非敏感配置）——这条正是方案 §3.7 的落库约定，现在**有测试钉住数据真的落对了库**。app scope 单独开 meta 连接（走 `db::open_meta_conn_at`，不让 meta schema 出现第二份定义），**锁定空间时 app 级数据仍可用**（不被连带）。每 scope 256 KiB 配额，超限报 `quota_exceeded` 而不是静默截断；非法 scope 报 `bad_args`。
  - ✅ **受控写能力（草稿确认）**：`pages.create` / `blocks.append`（权限 `write:pages`）。**写能力不落库**——只产出草稿，随 `PluginRunResult.drafts` 回传，用户在命令面板确认后走**共用的** `applyDraftAndRefresh`（`lib/ai/apply.ts` 的 `applyDraft` + 界面刷新），**不为插件再造第二套确认机制**。注册表新增 `mediate` 字段（`draft` / `immediate`）+ 门禁不变式：写能力必须声明中介方式，非写能力不得声明。顺带把「应用草稿 + 刷新界面」抽成共用路径，AI 的 commit 也改走它（原先两边各写一套刷新逻辑）。
  - ✅ **顺带修掉一个 shim 真 bug**：必填参数缺失时 shim 会 `String(undefined)` → 字符串 `"undefined"`，宿主把"没传参"当成"传了个字符串"（写测试时被抓住：`api.blocks.append("文本")` 的文本被当成 `pageId`、`text` 变成 `"undefined"`）。现在 `undefined` 原样传下去（`JSON.stringify` 会丢掉该键）→ 宿主明确报 `bad_args`；并有回归断言。
  - ✅ **补齐 `properties.list` / `properties.set` / `tags.add`**：属性可按 id 设置（配 `properties.list` 让插件先读到 attrId）、标签按**名字**加（不存在由落库那步新建）；两者同为草稿确认（权限 `write:properties` / `write:tags`）。`applyDraft` 相应加 `set_page_prop` / `add_tag` 两种载荷（写入后回读页面，供既有刷新路径更新当前页）。**至此 M11.7 的能力面完整**（19 条能力 / 11 项权限）。
  - ✅ **AI 工具层与插件合并到同一注册表**：`src/lib/ai/tools.ts` 不再手写工具清单——**元数据**（id / 描述 / 参数 schema / 是否写操作）由注册表生成（`src/lib/capabilities/aiTools.meta.ts`），**实现**集中在 `src/lib/capabilities/frontend.ts`（适配表；"省略 pageId 时用当前页"由宿主 ctx 承接），门禁校验「声明 `ai:true` 就必须有前端实现 + 必须有 LLM 可读的 `desc`」。为不让 AI 丢掉"读块"能力，注册表补了 `blocks.list`（Rust 侧复用 `blocks.rs` 既有的 Lexical 解析，不手写第二份）。**至此能力定义只有一处**：AI 宿主与磁盘插件消费同一份，仓库里不再有第二套语义工具清单。
  - **重构中被 smoke 抓到的两个真回归（tsc 都发现不了）**：① 适配层一度 import UI store 只为取"当前页"，把整条 UI 依赖链（编辑器→公式→katex 字体）拖进 AI 能力层，`smoke-web` 的 esbuild 打包直接报 62 个 "No loader is configured for .woff2/.ttf"，改为只从宿主 ctx 取后恢复——**能力层要薄不只是审美，它有构建后果**；② `scripts/smoke-web.mjs` 里硬编码了旧工具名与旧参数名（`create_page`/`append_block`/`search_pages`/`query`），已同步到能力 id。
- **M11.7 原始条目（保留备查）**：读能力（当前页/列表/搜索/单页/标签/反链/文件元数据）+ 写能力三档（`insertText` 即时；建页/追加块/改属性/加标签**走草稿确认**）；**把 `src/lib/ai/tools.ts` 重构为消费同一注册表**——AI 宿主与插件共用一个能力层，仓库内不留第二份语义工具实现。
- **M11.8 触发面与事件** 🗓（规划）：manifest 声明斜杠菜单/页面右键/文件右键/编辑器菜单入口；事件钩子 v1（`app.started`/`space.switched`/`page.opened`/`page.saved`/`page.deleted`/`import.finished`/`sync.completed`）；命令参数 schema → 宿主渲染参数表单；结构化返回 `{message, toast, insert, open, draft}`；插件设置（manifest schema → `plugin_data`）。
- **M11.9 声明式贡献面（无代码插件）** 🗓（规划）：manifest 即可声明面板/视图（复用数据库透镜 query+columns）、主题 token、导入导出触发、命令参数、菜单与斜杠项。**验收**：一个「阅读统计面板」插件**零 JS** 即可安装并显示。
- **M11.10 沙盒 UI 插件**（原 M11.3，重编号）🗓（规划）：UI 型插件（沙盒 WebView + postMessage 桥）——实现 **Transport B**，复用 M11.6 的同一 shim 与权限模型；可贡献侧栏面板/自定义块/自定义视图。**评估结论不变（收益/风险比不足，后置）**，但补上**启动闸门**：M11.6 + **M11.9 声明式贡献面已穷尽**（多数「我要一个插件面板」应由声明式渲染器满足，否则等于为一个可声明解决的问题引入整套沙盒渲染面）。
- **M11.11 分发与信任**（原 M11.4，重编号；**形态与供给侧策略见[插件分发策略](plans/2026-09-10-plugin-distribution-strategy.md)**）🗓（规划，拆三小档）：**a. 索引协议 + zip/URL 安装**——`plugin-index.json` 静态索引规范（任意位置可托管）+ 索引签名（复用 updater 的 minisign 习惯）+ `install_plugin` 支持 zip/URL 且先校验后落盘，**不做商店 UI**（这是复用既有设施，边际成本≈0）；**b. 治理与信任**——publisher 签名 + 撤回两级（索引侧 + **应用侧离线撤回列表**）+ 自动扫描 + 安全评分卡 + 开发者政策 + 漏洞披露 + `license` 必填；**c. 应用内市场 UI（最后做）**——订阅**多个**索引（自托/社区/企业内网）+ 搜索/兼容提示/更新/撤回。**闸门（硬性）**：作者文档 + ≥3 个真实第三方插件（**c 尤受约束**）；**硬前置：M11.13 进程级隔离须先于 a 完成**；并与「绝不跟踪」对齐——禁下载计数/埋点排行/竞价位，「评价」走社区帖子（`discussionUrl`）。
- **M11.12（可选）插件数据同步** 🗓（规划）：`sync:data` 声明 + 空间级 `plugin_data` 增量同步（E2EE 兼容）。默认不同步。
- **M11.13 隔离强度：插件宿主子进程化 + OS 级资源限制** 🗓（规划，**已判定必有**）：Boa **无分配预算 API**（0.21.1 与最新 0.22.0 均已核实，上游 issue 亦不涉内存）→ 内存炸弹由 M11.5 的限流分配器闭合，但**原生崩溃 / 段错误 / UB / OS OOM-killer / 进程级资源账目**只有 OS 进程边界能兜。交付：宿主挪到独立子进程 + 私有 IPC + **OS 级内存/CPU 限制** + 崩溃只终结该次调用 + 跨进程可中止（顺带彻底解决 M11.5 遗留的"超时只是遗弃线程"）。**排期**：**不阻塞 M11.7**（紧迫性下降），改为 **M11.11 分发的硬前置**——第三方插件进场前必须完成；**保留升级条款**：一旦观察到 Boa 段错误与插件相关，立即升 P0。**不接受降级为不做**（有存量插件后再改宿主 = 重做 `RunState`/命令路由/超时取消）。依据 [方案 §3.11](plans/2026-09-10-plugin-evolution-plan.md)。

### M12 — 文件夹 = 网盘（P2，[规划](plans/2026-08-22-folder-netdisk-plan.md)）
- **M12.1 核心网盘 UX** ✅（v1.18.0）：文件搜索 + 每夹统计 + 在线预览（图片/视频/音频/PDF）+ 下载（`copy_attachment`）。
- **M12.2 拖拽 + 移动** ✅（v1.19.0）：拖拽 OS 文件进打开文件夹上传 + 文件跨夹移动（`move_attachment`）。
- **M12.3a 文件引用到页面** ✅（v1.28.0）：斜杠 `/文件引用` 插入文件引用卡片（名称/大小/类型图标，点击系统默认打开）；文件既属文件夹/网盘资产，也可被页面引用（共享同一条附件 + 内容寻址去重）。
- **M12.3b 文件版本** ✅（v1.33.0）：同名文件分组——重新上传同名（不同内容）文件按内容寻址保留旧内容为「历史版本」；`restore_attachment` 把历史版本克隆为最新当前文件；文件管理器「↻ 版本」弹层逐版本显示大小/hash + 恢复。**M12 文件夹=网盘里程碑达成**（12.1/12.2/12.3a/12.3b）。
- **M12.3c md 应用内打开** ✅（[分析](plans/2026-08-30-md-in-app-open-plan.md)，[实现记录](plans/2026-08-30-md-preview-plan.md)）：点 `.md` 文件名在文件管理器中**应用内只读渲染**（复用 `readTextFile` + `mdToHtml`）+ 「转为笔记」按钮；侧边栏 `.md` 节点同样打开预览；`mermaid` 代码块渲染为图、随主题切换即时刷新；预览铺满主内容区不遮侧边栏、弹窗浮于其上；打开页面自动关闭预览。**不默认自动转页面**，避免破坏「文件=网盘」心智。

### M13 — 数据库 = 透镜（P2，✅ 达成，[规划](plans/2026-08-22-database-lens-plan.md)）
- **M13.1 保存视图** ✅（v1.20.0）：`db_views` 表 + `save/list/delete_db_view` + 数据库工具栏「视图」切换/保存/删除（记录 view_type/filter/sort/board_group_attr）。
- **M13.2 查询型数据库** ✅（v1.21.0）：`pages.db_rule` + `set/get_db_rule`；`query_database` 按规则（属性值/tag，AND）过滤收页；未设规则行为不变。
- **M13.3 ref 关联属性** ✅（v1.22.0）：`ref` 列类型 + `resolve_refs`（`p:<id>`→标题）+ 数据库表格 ref 列可点击跳转。**M13.3b**（v1.23.0）：ref 属性值并入关系图边（kind=`ref`），数据库 ↔ 图谱贯通。
- **M13.4 公式列** ✅（v1.24.0）：「公式」列类型 + 前端受限算术解析（`+ - * / ( )`），按列名引用同行数字列计算。**M13 里程碑达成**。
- **M13.5 跨库统计（rollup）** ✅（v1.25.0）：「统计」列类型——引用另一数据库的行并按 `count/sum/avg` 聚合（JSON 配置 `{ref,db,col,fn}`），跨库实时取数，前端只读聚合。

### M14 — 空间清理 / 存储管理（P2，[规划](plans/2026-08-22-storage-cleanup-plan.md)）
- **M14.1 空间统计面板** ✅（v1.37.0）：`storage_stats`（数据库/附件/回收站/版本/软删空间/临时各分项）+ 侧边栏「▦ 存储」面板展示。
- **M14.2 清空回收站** ✅（v1.37.0）：`clear_trash` 物理删除软删页面树 + 级联属性/标签/版本/反链/块/附件 + 释放零引用字节（事务 + 二次确认 + 释放量提示）。
- **M14.3 清理孤立附件** ✅（v1.37.0）：`cleanup_orphan_attachments` 删除 hash 零引用的磁盘字节（内容寻址差集）。
- **M14.4 清理版本/临时** ✅（v1.37.0）：`cleanup_old_versions`（每页保留 50）+ `cleanup_temp_files`（备份/恢复临时 + `.part` 残留）。**补记（v1.38.0）**：`purge_deleted_workspaces` 物理清理软删工作空间（整棵页树 + 级联引用 + 释放字节）。**M14 空间清理/存储管理里程碑达成**。

### M15 — 每工作空间独立存储（物理隔离，[规划](plans/2026-08-22-per-workspace-storage-plan.md)）
> 把多空间从「单库 + 全局附件（逻辑隔离 workspace_id）」升级为「**每空间独立 SQLite 数据库文件**（物理隔离）+ 附件字节保持**全局内容寻址**（跨空间去重，见[实现落地说明](plans/2026-08-22-per-workspace-storage-plan.md)）」，实现单空间可搬移（经空间级附件子集导出）/单独备份/单独加密/故障隔离。**高成本高风险**，采用「新增+校验+切换指针+原库保留可回滚」的安全分阶段迁移。
- **M15.0 元数据库 + 存储底座** ✅（v1.39.0）：`meta.db`（workspaces/sync_state/templates/plugin_state）+ `spaces/<ws_id>/` 每空间库；附件字节保持**全局内容寻址** `attachments/`（M15.3 实现「空间级附件子集导出」，见下）；`Db.0` 连当前空间库 + `meta` ATTACH；空间命令/active 改读 `meta.*`；创建/切换/删除空间重开主连接（`reopen_space`）；旧库清理、首启重建。
- **M15.1 拆库迁移器** 🗓（用户确认清理旧库、不迁移 → 以「首启重建」代替）。
- **M15.2 命令层改造** ✅（v1.40.0）：内容命令去掉 `workspace_id` 过滤（每库单空间）；`templates`/`plugin_state`/`device`+`server`+`token` 同步状态落 meta（E2EE 密钥与同步游标保持每空间）；`migrate(space_id)` 播种各空间自己的 `workspaces` 行（修复 `create_workspace` 外键 bug）；跨空间复制明确报错待 M15.4。
- **M15.3 单空间备份/导出** ✅（v1.41.0）：`export_workspace`（当前空间 = 空间库快照 + 该空间引用的附件字节 + `workspace.json` 元数据，打成自包含 zip）/`import_workspace`（新建空间，永不覆盖现有空间：抽取空间库到 `spaces/<id>.db`、附件字节复制进全局内容寻址库、注册 meta.workspaces）。说明：附件保持**全局内容寻址存储**（跨空间共享字节，不物理拆分），导出时按该空间引用筛出子集，实现「空间可独立搬移/导入」。
- **M15.4 跨空间适配** ✅（v1.41.0）：全空间搜索跨库合并（`all_spaces` 遍历各空间库聚合）、跨空间复制跨库（`copy_page_to_workspace` 打开目标空间库，插行 + 重映射父级 + 复制属性/标签/附件行 + 重建 FTS/块图，附件字节全局共享不重复）、空间清理按各自空间（`purge_deleted_workspaces` 改为物理删除各软删空间库文件 + 释放跨空间孤儿附件）。
- **M15.5 验收 + 清理** ✅（v1.41.0）：全功能回归（后端 20 项单测 + `tsc` 无错 + Vite 生产构建 + 应用运行验证）；归档原单库 `shuyonote.db`（重命名为 `*.archived`，可回滚恢复）。**M15 每工作空间独立存储（物理隔离）里程碑达成**。
> ⚠️ 取舍（诚实标注，与[规划](plans/2026-08-22-per-workspace-storage-plan.md)一致）：**附件字节保持全局内容寻址**（跨空间相同文件共享一份字节），而非每空间独立附件目录——这是取舍：换取「跨空间附件去重」与「不受每空间附件目录整改爆炸半径影响」，同时用「空间级附件子集导出」实现单空间可搬移；`attr_defs`/标签/模板按每空间库存；E2EE 密钥与同步游标保持每空间。**M15 已达成**。

### M16 — 跨平台适配（全平台通吃，[规划](plans/2026-08-24-cross-platform-plan.md)）
> 从「Tauri 桌面绑定」演进为「**平台无关核心 + 可插拔平台壳**」，同一 bundle 跑 浏览器 PWA / 安卓 / iOS / 鸿蒙 ArkWeb，不再依赖 `window.__TAURI__`。由 [M6 移动端](roadmap.md) 升级为「**全端通吃**」。采用「分层 `pkg/core` + driver 可插拔 + 渐进迁移」策略。**系统分层、存储模型与平台 driver 详见 [系统架构](architecture.md)**。
> **已达成**：M16.0（driver 抽象）+ M16.0b（浏览器 Web 平台）+ M16.1a（真实 SQLite）+ M16.1b 起的 Web 平台能力扩展（属性/数据库/版本/块引用/备份/PWA）+ **M16.6–M16.8（web 能力补齐 / 体验优化 / 数据安全，v1.59.24–35）**。**待做**：`pkg/core` 完整语义、OPFS/wa-sqlite 增量、插件运行时、其余平台壳。**现有 Tauri 桌面形态无回归**（架构隔离：`index.ts` 按环境自动切 tauri/web）。
- **M16.0 存储/能力 driver 抽象** ✅（v1.46.0）：新增 `src/lib/platform/`（`types.ts` 接口 + `tauri.ts` `@tauri-apps/*` 唯一宿主 + `index.ts` `platform` 聚合/`setPlatform`）；`api.ts` ~60 个 `invoke` 改走 `platform.executor`（对外 API 不变）；12+ 组件内联的 dialog/opener/event/asset/webview 调用改消费 `platform`。**零行为变化**。
- **M16.0b 浏览器 Web 平台可跑** ✅（v1.47.0）：`web.ts`（`createWebPlatform`）+ `pnpm dev:web`（独立 5173）。已用 Edge 无头验证 app 真实挂载、渲染种子页。
- **M16.1a Web 平台真实 SQLite 化** ✅（v1.49.0）：`sqliteStore.ts`（sql.js WASM）+ IndexedDB 持久化；`web.ts` 核心 CRUD 改跑真实 SQL；图片字节改存 IndexedDB blob（M16.1c，v1.50.0）；`persist()` 防淘汰（v1.51.0）。
- **M16.1b Web 平台能力扩展（浏览器版完整对齐桌面核心）** ✅：
  - **可安装离线 PWA**（v1.52.0）：`manifest.webmanifest` + `public/sw.js`（install 缓存壳 / fetch 网络优先离线回退）+ SVG 图标；仅 production 注册 SW。
  - **属性 / 数据库透镜**（v1.53.0）：`attr_defs`/`page_props`/`database_columns`/`db_views`/`pages.db_rule` 表；`list_attr_defs`/`create_attr`/`update_attr`/`delete_attr`/`get_page_props`/`set_page_prop`/`remove_page_prop`/`get_db_columns`/`add_db_column`/`remove_db_column`/`query_database`（含 db_rule 会员规则）/`list_db_views`/`save_db_view`/`delete_db_view`/`set_db_rule`/`get_db_rule`/`board_data`/`board_by_attr`/`move_card`/`resolve_refs`。
  - **版本历史**（v1.54.0）：`page_versions` 表 + save_page 快照（去重 + 每页 50 版）+ `list_versions`/`restore_version`/`cleanup_old_versions`。
  - **文件读写 / 导入导出**（v1.55.0）：`fileRegistry` + `pickBrowserFiles`（input 选文件）+ `downloadBytes`/`downloadText`（Blob 下载）；`dialog.open/save`/`write_text_file`/`read_text_file`/`import_attachment_files`/`copy_attachment`。
  - **块级引用 / 反链**（v1.56.0）：解析 `content_json` 的块级命令 `get_page_blocks`/`resolve_block`/`get_backlinks`/`list_block_backlinks`/`search_blocks`。
  - **整库备份 / 恢复**（v1.57.0）：`export_backup`/`import_backup`（自包含 JSON：db 快照 + 附件字节；`blobStore.entries()`、`SqliteStore.snapshot()`/`restore()`）。
  - `scripts/smoke-web.mjs` 已扩到 **64 项**全绿（覆盖 SQLite CRUD/属性/数据库/版本/块引用/备份/persist）。
- **M16.1 核心语义 TS 化** 🗓（规划，部分达成）：Web 平台核心 CRUD 已用真实 SQLite；`pkg/core` 完整语义（迁移/加密/备份格式互操作，先以 rusqlite 驱动跑通）仍待做。**注**：浏览器壳用 sql.js + IndexedDB blob，未用 OPFS/wa-sqlite（见取舍）。
- **M16.2 OPFS/wa-sqlite 增量持久化** 🗓（规划）：**已评估为「需真实浏览器验证」的长期项**——wa-sqlite 异步查询在 Node 报 code 21、OPFS 必须 Worker 且无头无法验证，故维持 sql.js + IndexedDB + persist() 作为当前正解（M16.1b 已覆盖核心能力）。
- **M16.3 插件运行时降级迁移** 🗓（规划）：`boa_engine` 移入 WASM/浏览器——浏览器网页无法跑 Rust `boa_engine`，需重做 JS 沙盒；**根本性限制**，待后续。**注**：[插件进化方案](plans/2026-09-10-plugin-evolution-plan.md) M11.6 的「能力层传输无关（生成的 `api.*` shim + 可替换传输）」会显著降低这一项的成本——届时 web 只需新增一个传输与 JS 沙盒，不必改插件 ABI；「是否把 Boa 换成浏览器引擎」已列入该方案的**可延后决策**。
- **M16.4 各平台壳** 🗓（规划）：安卓 / iOS / 鸿蒙 ArkWeb（各平台 JSBridge 补文件/外链/对话框）。浏览器 PWA（M16.1b）已作为首个 Web 壳。
- **M16.5 验收 + 回归** 🗓（规划）：全功能回归；原 Tauri 桌面形态保留为 driver A。**已验证桌面无回归**（编译 + 进程运行）。
- **M16.6 web 能力补齐（P0）** ✅（[建议清单](plans/2026-08-24-web-polish-backlog-plan.md)）：**附件移动/批量删除/恢复、存储统计精确化、全文搜索（相关度排序）** 已实装（v1.59.24–26）；`scripts/smoke-web.mjs` 对应断言全绿。
- **M16.7 web 体验优化（P1）** ✅（同上）：侧边栏拖拽自动展开/滚动（v1.59.27）、大媒体 50MB 上传上限（v1.59.28）、自动化测试补强 `computeReorder`/`tokenize`（v1.59.30）。
- **M16.8 web 数据安全（P1）** ✅（同上）：写库失败回滚与提示——`persist()` 失败保留内存状态 + `onPersistError` 回调 + `persist-error` 事件（v1.59.29）。
> 追加闭环（web 剩余缺口）：孤儿附件清理 / 跨空间复制 / `get_attachment` / 回收站恢复（v1.59.32–34）。
> ⚠️ 取舍（诚实标注）：浏览器壳（sql.js + IndexedDB + persist()）是**可比 OPFS/wa-sqlite 验证、可落地**的方案；OPFS/wa-sqlite 增量列为需真实浏览器验证的长期项。多文件目录导出受浏览器权限限制（单文件导出/整库备份已可用）；备份格式为 Web 自包含 JSON（与桌面 zip 不互认）。web 的加密/同步/插件归为**平台能力边界**（浏览器无对应原生能力），保留桌面实现、web 维持降级不崩。

### M17 — AI 增强（薄 Agent 接口，[方案](plans/2026-08-24-thin-agent-interface-plan.md)，[实现](plans/2026-08-24-thin-agent-interface-implementation-plan.md)）
> 给 ShuyoNote 加**可选、本地优先、安全**的 AI 能力，而**不是**嵌入能跑任意命令的 Agent 运行时。ShuyoNote 暴露**语义化工具**（`search_pages`/`read_page`/`create_page`/`append_block`/`get_backlinks`…，多为现有命令），配**受限 Agent 宿主**——默认关、倾向本地模型、**写操作经用户审核**，遵守「IPC 最小暴露面 / 插件沙盒」红线。诚实的利弊见方案 §5：收益是「AI 对笔记库多步语义操作」，代价是不支持「AI 运维本地/调外部系统」（刻意取舍）。**实现路径见[实现方案](plans/2026-08-24-thin-agent-interface-implementation-plan.md)**：复用 `registry.ts` 插件宿主 + 语义命令，新增白名单工具/前端 LLM 循环/审核落库。
- **M17.0 语义工具层** ✅：封装搜索/读页/读块/建页/追加块/反链/文件列表；`append_block` 以**前端包装 `save_page`** 实现（重新读取页面 → 追加段落 → 回写），**未新增任何后端命令**。
- **M17.1 受限 Agent 宿主** ✅：本地/可选 LLM（默认 Ollama）；白名单工具 + 草稿确认；读工具直接执行、写工具只返回草稿，绝不自动提交。
- **M17.2 审核落库 UI** ✅：AI 新建/追加先预览确认；右侧 AI 助手浮层 + `apply` 落库。
- **M17.3 隐私开关** ✅：默认关；仅调用配置的本地模型端点、无默认联网、无 shell/任意文件。
> 交互界面（入口 / AI 助手浮层 / 草稿确认 / 设置面板）已在实现方案 `§3.5` 与[实现方案](plans/2026-08-24-thin-agent-interface-implementation-plan.md#35-交互界面)明确。

### M18 — 内联 AI 起草（[方案](plans/2026-08-24-inline-ai-draft-plan.md)）
> 在 M17 薄 Agent 底座上，把 AI 从「右侧聊天面板 + 二段确认」扩展为「**内嵌文档流 + 流式写入 + 高亮待定块 + 快捷动作**」，对标 wolai / FlowUs / Notion AI。**与侧边栏职责划分**：内联＝就地写、侧边栏＝全局问/做，**共用同一套 `src/lib/ai/` 底座**（同一 provider/模型/`config.enabled` 默认关），差异只在交互层。**写操作仍先落「预览高亮待定块」、点「完成」才落库**，不丢确认红线；保持白名单语义工具、无 shell/任意文件/网络。
- **M18.1 内联起草条 + 模板下拉** ✅：空行空格唤起随光标浮层（「告诉 AI 你想写什么…」）+「用 AI 写作」下拉（按当前页上下文自适应：有内容→编辑类/空页→创作类），模型选择 + 发送；选中下拉项填入提示词、光标定位省略号后。
- **M18.2 流式写入 + 待定块高亮** ✅：内容流式写入高亮待定草案卡（不落库）；状态条「AI 正在创作···」+ Esc 停止；光标右侧待定块高亮。
- **M18.3 生成后动作菜单** ✅：完成（落库 + 去高亮）/ 关闭（丢弃）/ 续写 / 重新生成 / **创建新页面并插入内容**（v1.59.117）；附「AI 回复可能有偏差，仅供参考。回顾思考过程」。
- **M18.4 安全与验收** ✅（部分）：预览→完成才写库；`scripts/smoke-web.mjs` 相关断言全绿。
> 状态：**已落地 v1.59.117**（起草条/模板/流式/动作/ESC/上下文自适应/插入到按空格块）；AI 内容「直接流式写进正文块 + ai-pending 高亮」仍为后续增强。

### M19 — Wiki 织网增强（P1，[方案](plans/2026-08-24-wiki-weave-plan.md)）
> 把「双链」从"能链接"做深为"真织网"，对标 Obsidian 双链 / wiki。
- **M19.1 未链接提及（Unlinked Mentions）** ✅（v1.59.113）：扫描正文里出现但**未打 `[[ ]]`** 的页面标题，页面底部（反链区）提示「未链接提及」并一键转链（`findUnlinkedMentions` + `UnlinkedMentionsPanel`）。
- **M19.2 双向链接别名 + 精确块链** ✅（识别层，v1.59.114）：`get_backlinks` 现能识别 `[[标题|别名]]`、`[[标题#块]]`（含 `[[标题|别名#块]]`），这些形式同样形成页面反链；可交互渲染/跳转作为后续增强。
- **M19.3 链接建议增强** ✅（v1.59.116）：输入 `[[` 弹出按匹配度 + 最近编辑排序的候选下拉（Enter/方向键/点击选择），选中即插入 `[[标题]]`；粘贴标题自动识别为后续。

### M20 — 模板变量 + 语义检索（P1，[方案](plans/2026-08-24-template-var-semantic-search-plan.md)）
> 模板复用 + 搜索从「关键词」升级为「语义」。
- **M20.1 模板变量** ✅（v1.59.115）：模板支持 `{{date}}` / `{{title}}` / `{{selected}}`，建页时按上下文自动填充（`{{selected}}` 暂为当前选中文本，后续接入编辑器选区）。
- **M20.2 语义检索（embedding）** ✅（v1.59.118）：搜索在词频（TF）之上叠加基于字符二元组 Jaccard 的语义排序，优先展示语义更贴近的页面；纯函数 `charBigrams`/`semanticScore`/`semanticRank`，语义作为有界加分不破坏 TF 主排序（`web.ts` search 接入）。旧版离线 char-bigram 版已落地；**v1.59.174 接入真实向量 embedding provider**（`src/lib/semanticEmbed.ts`：`cosineSim`/`vectorRank`/`embedText`/`readEmbedConfig`）+ **`page_embeddings` 页嵌入缓存持久化**（内容哈希自动失效、惰性重嵌），搜索命中缓存只发 1 次 query 嵌入。
- **M20.3 语义检索接入 AI** ✅（v1.59.119）：侧边栏 AI 的 `search_pages` 工具描述新增「语义相近」提示，检索结果经 M20.2 语义排序后供模型引用（`search_pages` → `api.search` → 语义重排）。
> ⚠️ **边界（诚实标注）**：M20.2 语义排序/向量重排此前**只在 Web**；**v1.59.175 起桌面活动空间检索（Rust `search.rs`）也接入向量语义**，**v1.59.176 补全到跨空间（`all_spaces`）**（逐空间走 `search_semantic_async`）——前端把 embedding 配置随 `search` 参数传入 Rust，Rust 侧新增 `page_embeddings` 表 + `embed_text`（调 Ollama/OpenAI 嵌入端点）+ `search_semantic_async`（宽候选集 + 余弦加分 + 缓存按内容哈希失效）。嵌入端点不可达时优雅回退关键词排序，搜索永不中断。

### M21 — 静态 wiki 导出 + 关系图探索（P2，[方案](plans/2026-08-24-static-wiki-export-graph-plan.md)）
> 「本地优先 + wiki」的终局：把你的空间导成可独立浏览的 wiki 网站。
- **M21.1 静态 wiki 导出** ✅（v1.59.120）：命令面板新增「导出当前空间为 wiki」，把当前空间导出为可独立浏览的静态 HTML wiki——每页一个 `.html`（`[[标题]]` 双链+反链+标签）+ 含页面树的 `index.html`，打包为 `wiki-export.zip`，适配任意静态托管。纯函数 `buildWikiExport`/`wikiSlug`/`renderWikiBody`。Tauri 后端镜像命令为后续增强。
- **M21.2 关系图探索增强** ✅（v1.59.121）：关系图新增**关键词高亮**（输入关键词高亮匹配节点、弱化其余）、**聚类聚拢**（按标签/属性维度的同类节点互相拉近成簇）、**节点锁定**（双击节点或锁按钮 📌 固定）；保留按维度着色/过滤、点击跳转、局部缩放。

### M22 — 绘图方案（[设计](plans/2026-08-24-drawing-solution-design.md)）
> 「动手画」能力：自由手绘/涂鸦、结构化流程图/思维导图、AI 生成图片。大字节统一走内容寻址附件（节点只存 `hash` 引用），双平台无需新增 Rust 命令。
- **M22.1 绘图块** ✅（v1.59.139）：斜杠 `/绘图` 插入**页面内嵌 Excalidraw 画板**（飞书式，`InlineDrawing`：画布直接嵌在页面流 + 顶部控制条「编辑/保存/下载/导出/复制/全屏」，**默认无网格**、**控制条平时隐藏仅悬停显现**、**底部拖拽手柄可缩放高度**）；「编辑」就地编辑、「保存」落 `.excalidraw` JSON + PNG 内容寻址附件、文字进 `content_text`；内置 0.18.1（React 18 下调 React 19 兼容：0.17.1 读 `ReactCurrentOwner`、0.18.1 内置 Radix Portal 在 React 19 循环；0.18.1 本地字体无 CDN）。曾自研 `DrawCanvas` 为过渡，现被 Excalidraw 内嵌取代。
- **M22.2 mermaid 块** ✅（v1.59.123）：`/流程图/思维导图` 插入 mermaid 块（syntax 可选），离线渲染 SVG，解析失败内联报错 + 可编辑源文本；源文本进 `content_text`（可搜）；mermaid 按需懒加载。
- **M22.3 AI 文生图** ✅（v1.59.124）：`/AI 绘图` 输入描述 → OpenAI 兼容文生图端点 → 图片落内容寻址附件 → 插入 `ImageNode`；provider 未启用/不支持/失败时 toast 降级。纯函数 `buildImageGenUrl`/`buildImageGenBody`/`parseImageGenResponse`/`b64ToBytes`/`bytesToDataUrl`。

### M23 — Excalidraw 绘图高级功能（[方案](plans/2026-08-24-excalidraw-advanced-plan.md)）
> 基于 Excalidraw 0.17.1 深挖：汇可编程、可搜索、可导航、可导出、可联动 AI 的白板。
- **M23.1 编辑/导出体验** ✅（v1.59.129）：编辑器新增**导出 SVG/PNG/复制剪贴板**（`exportToSvg`/`exportToBlob`/`exportToClipboard`）+ **只读⇄编辑切换**（`viewModeEnabled` 预览不改）；`UIOptions` 收敛默认导出。
- **M23.2 元素编程化 + AI/mermaid 注入画布** ✅（v1.59.130）：绘图编辑器新增「🖼 图片 / 🤖 AI 插图 / 📊 mermaid 流程」按钮，用 `excalidrawAPI.addFiles`+`updateScene` 把图片/AI 文生图/mermaid 流程图渲染为画布图元（`makeImageEl` 构造）；AI 未配置 toast 降级。
- **M23.3 自定义侧栏 + 白板导航** ✅（v1.59.131）：绘图编辑器「🔗 链接」把选中图形链接到页面（元素 `link` 存 `shuyonote://page/<id>`）；**只读模式**点击带链接图形即**应用内跳转**（`onPointerDown` 命中检测 + `openPage`），白板节点→页面。
- **M23.4 数据/检索集成** ✅（v1.59.132）：`.excalidraw` JSON 内容寻址 + 版本快照（沿用原链路）；绘图文字经可测纯函数 `excalidrawSceneText`/`excalidrawSceneHasContent` 进 `content_text`（可搜/反链）；元素级命中归 M23.3。
- **M23.5 协同 / 代码生成** 🗓（超范围，诚实标注）：真正多人实时协同需 WebSocket 后端（0.17.1 无 `onCollaboration` 钩子）；图→代码（DiagramToCode/TTDDialog）在 0.18+ 才有。暂缓，先用「分享 .excalidraw / 导入 / 只读嵌入」替代。

### M24 — PDF 批注（P3，[方案](plans/2026-08-27-pdf-annotation-plan.md)，✅ 已落地）
> 知识工作者高频硬需求。竞品天花板：**思源 = 块笔记顶格**（划词/高亮/页边评论 + 摘录成块 + 关联块 + 目录大纲/OCR/卡片）；**MarginNote / LiquidText = 批注即思维工作台**（脑图/卡片/Anki、摘录关联）；**Notion ≈ 无、Obsidian 靠插件**。2026 破局点在「AI 帮读」（AI 摘要高亮 / 生成大纲 / 对 PDF 提问）。
> **差异化**：把批注做成「**批注即块**」——摘录可转正成块，进 `content_text`（可搜/反链/关系图）、可块引用、可打标签。
> **渲染引擎（双引擎）**：桌面用 **Rust 原生渲染**（`pdfium-render` / `mupdf-rs`，扛大型复杂 PDF）+ Web 用 **pdf.js（Worker）** 优雅降级；`pdfRender` 暴露一致接口。**文本层判定/OCR 兜底**作为阶段 1 降级（无文本层 → 仅矩形框选 + 画笔 + 便签）。
> **MVP 切割（阶段 1）**：双引擎分页渲染 + 批注 overlay（高亮/荧光笔/画笔/便签，坐标归一化、不写回源 PDF）+ 内容寻址持久化 + 「摘录成块」进反链/搜索。**阶段 2**：写回 PDF / OCR 精确划词（Tauri 专属、很贵、长尾）。**阶段 3**：AI 帮读（复用 M17/M18 薄 Agent）。
> **明确不做**：写回源 PDF、多人实时协同、全文编辑。
> 状态：**已落地（v1.59.178 起）**——**阶段 1**：`pdfRender` 双引擎接口 + `pdfAnnotation` 纯函数（归一化/Schema/CRUD/摘录成块/文本层降级/`pdfRef`）+ `pdf_annotations` 持久化 + `pdfjs-dist@4` 引擎（`pdfjsEngine`）+ `PdfReader`/`PdfAnnotationCanvas`（高亮/画笔/便签/选择/删除/编辑/复制引用 + **摘录成块**含 `pdf://` 回链 + **文本层精确划词** + **OCR 兜底**）+ 全局批注检索。**桌面 native 引擎（mupdf-sys，v1.59.179）**：`render_pdf_page` + `src/pdf_native.rs`。**阶段 3**：AI 帮读（v1.59.181）+ 对整篇 PDF 提问（v1.59.182）。阅读器重构（v1.59.180 思源式近全屏 + v1.59.187 连续滚动 v1.59.190 顶部单份批注栏）；**阶段 2（写回 PDF）待做**。**阅读器 + OCR/AI 增强**（护眼多档位 / OCR 彻底离线 / AI 视觉识别 / AI 一键目录（视觉优先、带层级、可范围、本地持久化）/ 系统朗读 / 识别弹层）已落地，见 [阅读器/AI 增强](plans/2026-08-30-pdf-reader-ai-plan.md) 与 [连续滚动](plans/2026-08-29-pdf-continuous-scroll-plan.md)。

### M25 — 帮助系统（P2，[方案](plans/2026-08-27-help-system-plan.md)，P0/P1 已落地）
> 本地优先 / 键盘驱动：帮助 = **发现能力 + 一次解决**，不做"客服中心/文档门户"/在线工单。
> **四层**：P0 **就地提示**（命令面板/斜杠/占位符/tooltip，底座已有）+ **快捷键面板**（`?`/`Ctrl+/`，读 `src/lib/shortcuts.ts` 单一来源）；P1 **内置「使用指南」页**（= 可编辑笔记，经模板 built_in，FTS 可搜、可导出/双链）+ 新手清单；P2 外部静态站（可选，复用 M21 导出）。
> **主张：帮助页 = 笔记**——用 ShuyoNote 自己的块表达，同源/同搜索/同导出；复用命令面板/斜杠/模板/`shortcuts.ts`，不新起体系。
> **明确不做**：在线客服/工单、应用内长篇文档、打断式引导弹窗。
> 状态：**P0/P1 已落地（v1.59.177）**——快捷键面板 + 内置「使用指南」页 + 命令面板/斜杠入口；**P1 新手清单（空页引导「一键上手」：点一下即新建页/建库/开快捷键/试 AI）+ P2「关于」对话框（版本/许可/四外链 + 禁用外部导航开关）+ P2 帮助站导出（「导出帮助站点」复用 M21 静态 wiki 导出生成可托管静态站）已落地**，见[项目网站导航方案](plans/2026-08-27-project-website-navigation-plan.md)；**外部托管本身待做（用户自托管生成站点）**。

### M26 — 公式（P2，[方案](plans/2026-08-30-formula-plan.md)，块级 + 行内落地）

> 正文**数学公式**：块级 `$$…$$`（`DecoratorNode` `FormulaNode`，对齐 Mermaid；`/公式` 插入 + markdown `FORMULA` transformer + 就地编辑）+ 行内 `$…$`（`TextNode` 子类 `InlineFormulaNode` + `registerNodeTransform`，保留字面 `$…$` 进 `content_text`）。渲染 **KaTeX@0.16.47**（懒加载，独立 chunk 253KB，不进首屏主包，与 mermaid/excalidraw 一致）。
> 设计：新增 `katex` 到 dependencies（此前是传递依赖）；块级进 `content_text`（可搜）；行内防误判（`$5`/`$100` 不转）；非法 LaTeX `throwOnError:false` 回退源文本不崩。
> 关联：块级范式同[绘图方案](plans/2026-08-24-drawing-solution-design.md)/[Mermaid 块]；行内范式同[双链 PageLink](plans/2026-08-30-pdf-reader-ai-plan.md)/`PageLinkNode`。
> **M26 扩展 — 公式识别**：给公式编辑器弹窗加**「图片识别」**（上传/拖入/粘贴含公式图片 → LaTeX）与**「手写识别」**（canvas 手写板 → LaTeX）。复用 `ocrVision.ts` 的 `ocrWithVision`（视觉大模型，Ollama/OpenAI 兼容，不新增后端）；识别结果自动回填 textarea、可改后提交（保留人工确认）；不接付费识别服务、不做云端限流、依赖用户已配置视觉模型。见[公式识别方案](plans/2026-08-30-formula-recognition-plan.md)（**已实现**：`formulaVision.ts` + `FormulaHandwritePad` 手写板 + `FormulaEditorDialog` 🖼/✎ 入口）。

### M27 — 团队版（自建协作，不接外部通讯 App，[方案](plans/2026-08-30-team-edition-plan.md)）
> 把 ShuyoNote 从「单用户 · 多设备 · 本地优先」演进为「**可自建团队知识库**」——**不接微信/企业微信/钉钉**，账号、通知、讨论、采集全自建。两根柱子：**账号/认证（多用户）、权限模型**；**实时协同后置（P2）**。四项关键决策已拍板——E2E 组织空间放弃零知识、协同后置 P2、部署私有化、暂不建实时聊天。
> **进度**：✅ **服务端 S1–S8** 已落地（认证/空间/成员/角色/同步隔离/**空间级附件分桶+SHA-256 校验+鉴权**/审计日志/Docker 部署）；✅ 客户端 **per-workspace `sync_profiles`**（一个客户端持多个身份，各空间同步到各服务器）+ 按 profile 同步 + SyncPanel 每空间一行；同步 E2E（见 M2）。
> **仍待（身份与隐私，详见 [身份与隐私子路线图](identity-privacy-roadmap.md)）**：个人「密钥」鉴权（服务端签发/作废 device key）；本地静置加密的 E2（忘记口令提醒，口令即密钥别无副本）；可用性加固（备份 + `/health/db` 深探）。
> **明确后置（P2）**：本地多用户档案（一台机器多人、各不相同 vault）；团队实时协同（C4）。

## 4. 竞品差距跟踪

| 维度 | 当前差距 | 计划 |
|------|----------|------|
| 冷启动/复用 | 点模板建空白页、无模板内容 | **M9 模板**（建页填内容 + 保存为模板） |
| 空间隔离 | 只有单空间、`list_pages` 不按空间过滤 | **M10 多工作空间**（隔离 + 切换 + scope 修正） |
| 扩展性 | 仅硬编码命令注册表 | **M11 插件**（磁盘加载 + 受限 API）→ M3 主题/插件雏形已做；**能力面/权限/触发面/分发见 [进化方案](plans/2026-09-10-plugin-evolution-plan.md)** |
| 数据安全 | 无加密同步 | M2 端到端加密 |
| 数据可移植性 | 格式锁定 | M1 Markdown 无损往返（✅） |
| 聚合能力 | 无汇总 | M4 仪表盘聚合（✅） |
| 数据库视图 | 仅表格/画廊/看板 | M7 列表/日历/时间轴/目录（✅） |
| 导出 | 缺 PDF | M5 PDF 导出（✅） |
| 多端 | 仅桌面 | M6 移动端（安卓/iOS）**即将推出** → **M16 全平台通吃**（[规划](plans/2026-08-24-cross-platform-plan.md)） |
| 新页面引导 | 直接空白编辑 | M8 引导层（✅） |
| AI 写作 | 右侧聊天面板 + 草稿确认（M17） | **M18 内联起草**（✅，就地写 + 高亮待定块 + 快捷动作） |
| 双链织网 | 仅普通双链 / 块引用 | **M19 未链接提及 + 双链别名 + 精确块链**（✅） |
| 语义检索 | 仅 FTS 关键词搜索 | **M20 语义检索（char-bigram 版）+ 接入 AI 问答**（✅） |
| wiki 导出 | 无「把你的知识库变成可浏览网站」能力 | **M21 静态 wiki 导出 + 关系图探索**（✅） |
| PDF 阅读/批注 | 仅 PDF 导出，无阅读/批注 | **M24 PDF 批注 + 阅读器 + OCR/AI 增强**（✅，[方案](plans/2026-08-27-pdf-annotation-plan.md) + [阅读器/AI 增强](plans/2026-08-30-pdf-reader-ai-plan.md)：批注/摘录成块/AI 帮读 + 连续滚动/护眼/离线 OCR/AI 识别/目录/朗读） |
| 帮助/上手 | 靠占位符/tooltip/命令面板，无体系化帮助 | **M25 帮助系统**（[方案](plans/2026-08-27-help-system-plan.md)，规划：就地提示 + 快捷键面板 + 内置「使用指南」页） |
| 数学公式 | 无正文公式渲染 | **M26 公式**（[方案](plans/2026-08-30-formula-plan.md)：块级 `$$…$$` + 行内 `$…$`，KaTeX 懒加载；已落地） |
| 团队协作 / 多用户 | 单用户、无账号、无权限、无实时协同 | **M27 团队版**（账号/认证 + 权限，协同后置，全自建，[方案](plans/2026-08-30-team-edition-plan.md)，规划） |
