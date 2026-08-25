# ShuyoNote 路线图

> 基于三方对比（见 [compare-obsidian-siyuan-shuyonote.md](compare-obsidian-siyuan-shuyonote.md)）梳理的演进路线。按「价值 ÷ 工程量」排序。**✅ = 已实现并合入**；「规划」= 已出 [方案](README.md#方案与规划-plans)，待里程碑落地。设计走向遵循 [设计哲学](design-philosophy.md)。

## 1. 现状（已实现）

- **块编辑器**：Lexical 12 种块类型、表格交互（悬浮工具栏 / 列宽 / 选区）、图片/视频/附件、块拖拽排序、斜杠菜单、Markdown 快捷输入
- **块多选 / 批量删除**：`⋮⋮` 手柄选中（Shift 连续）、**鼠标框选**（拖矩形选多块，任意方向）、右键上下文菜单（复制/删除）、批量操作条、`Delete`/`Esc` 快捷键
- **应用内确认弹窗**：删除 / 彻底删除 / 恢复版本 / 导入备份等二次确认改为窗口居中的 `ConfirmDialog`（主题卡片样式，红色 `!` 徽标 + 主题强调色按钮）
- **块级引用/嵌入/反链**：稳定 `blockId`、`((id))` 块引用、`{{id}}` 块嵌入、块级反链面板、目标缓存刷新
- **属性 + 数据库**：8 类型属性 + **Notion 风格属性面板** + 数据库页（表格/画廊/看板/列表/日历/时间轴/目录 七视图）+ 列/选项管理 + 标签互通
- **文件管理视图**：侧边栏点文件夹进入（表格 + 新建/上传/移除），文件夹内批量超大文件流式上传、侧边栏同步显示
- **标签系统**：全局标签库（新建/重命名合并/删除/使用页数），侧边栏按标签筛选，标签管理菜单实时刷新
- **关系图**：力导向图、块级图层、局部/缩放平移/聚焦、标签与属性过滤着色
- **组织与检索**：页面树 / 文件夹、标签、看板、FTS5 全文搜索（含 `prop:` 属性语法）
- **导入健壮性**：Markdown 无损往返 + **HTML/Markdown 混排导入**（`mdToHtml` + 直接 HTML→Lexical），图片去重存储
- **数据安全**：自动保存、版本历史、回收站、整库备份
- **同步**：自建 sync-server（outbox 变更日志 + LWW + 附件内容寻址）
- **体验**：暗色模式、命令面板、多窗口、快捷键、主题/强调色自定义、PDF 导出

**半就绪 / 骨架（已落地）**：
- 模板中心 = **已实现**（M9 里程碑达成：建页填内容 / 保存为模板 / 共享打磨 / 数据库模板，见下）
- 多工作空间 = **已实现**（M10 里程碑达成：隔离 + 切换 + 生命周期 + 每空间内容过滤；**M15 物理隔离**把它升级为「每空间独立 SQLite 库 + 全局内容寻址附件 + 单空间导出/导入」）
- 插件 = **已实现**（M11 里程碑达成：磁盘加载命令插件 + boa 受限运行时 + 白名单 API + 启停持久化 + 卸载/安装 + `__insert` 可插入内容）

## 2. 下一阶段优先级

| 优先级 | 方向 | 对标 | 理由 | 状态 |
|--------|------|------|------|------|
| **P0** | **模板**（结构预设建页 + 保存为模板） | Notion / FlowUs / 思源模板 | 冷启动 + 复用效率；当前点模板是空白页 | ✅ M9（v1.13.0） |
| **P0** | **多工作空间**（隔离 + 切换 + 查询 scope 修正） | Notion workspace / Obsidian vault | 生活/工作/项目分离、独立备份/导出/加密 | ✅ M10（v1.11.0）+ **M15 物理隔离**（v1.41.0） |
| **P0** | 端到端加密 | 思源 / Obsidian Sync | 数据安全最高优先级 | ✅ M2（v1.26.0） |
| **P1** | **插件**（磁盘加载命令插件 + 受限 API） | Obsidian 社区插件 | 扩展性从「命令注册表」升级为「可安装插件」 | ✅ M11（v1.32.0，可插入内容）；L2 UI 型/L3 市场已评估延后 |
| **P1** | 主题 / 外观自定义 | Obsidian 主题 | 扩展性雏形 | ✅ M3 |
| **P2** | **文件夹 = 网盘**（文件库增强：拖拽上传 / 在线预览 / 搜索 / 下载 / 每夹统计） | FlowUs / Wolai / 有道 | 文件夹同时承载页面与文件，本地优先+去重+可加密形成差异化私域网盘 | ✅ M12（v1.33.0） |
| **P2** | 数据库贯通：查询型数据库 / 保存视图 / ref 关联属性 / 公式汇总 | Notion / Dataview | 数据库从「表格」升级为「数据工作台」 | ✅ M13（v1.25.0） |
| **P2** | 移动端适配 | 思源 / Obsidian | 多端能力 | M6 已评估（环境受限）；已升级为 **M16 全平台通吃**（[规划](plans/2026-08-24-cross-platform-plan.md)） |
| **P2** | Markdown 无损往返 | Obsidian 存储哲学 | 消除「格式锁定」顾虑 | ✅ M1 |
| **P2** | 属性驱动仪表盘聚合 | 思源数据库 + Dataview | 释放属性数据库价值 | ✅ M4 |
| **P2** | PDF 导出 | 思源 / Obsidian | 导出矩阵补全 | ✅ M5 |
| **P2** | 空间清理 / 存储管理 | FlowUs / 思源 | 存储可统计、可安全回收 | ✅ M14（v1.37.0） |
| **P3** | 新页面引导层 | Wolai / FlowUs | 降低冷启动门槛 | ✅ M8 |
| **P3** | 社区插件市场 | Obsidian 生态 | 平台级长期目标 | 延后（L3，已评估） |
| **P3** | AI 增强（薄 Agent 接口） | Obsidian AI / 思源 AI | 可选增强 + 本地倾向；不嵌入任意命令运行时 | ✅ M17（v1.59.36） |
| **P3** | **内联 AI 起草**（就地写/扩/改 + 高亮待定块 + 快捷动作） | wolai / FlowUs / Notion AI | 把 M17 底座变成「所见即所得」的文档内创作；与侧边栏分工 | ✅ M18（v1.59.117，[方案](plans/2026-08-24-inline-ai-draft-plan.md)） |
| **P1** | **Wiki 织网增强**（未链接提及 + 双链别名 + 精确块链） | Obsidian 双链 / wiki | 把「双链」做深，让笔记真正织成网 | ✅ M19（v1.59.116） |
| **P1** | **模板变量 + 语义检索（RAG）** | Notion 模板 / 思源 AI | 复用模板中心；搜索从「关键词」升级为「语义」 | ✅ M20（v1.59.119） |
| **P2** | **静态 wiki 导出 + 关系图探索** | 独立 wiki 站点 / FlowUs 图谱 | 「本地优先 + wiki」的终局表达；图谱从能看变能探索 | ✅ M21（v1.59.121） |

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

### M6 — 移动端适配（P2，长周期，已评估未做）
Tauri 移动端（iOS/Android）核心编辑 / 浏览 / 搜索可用。**评估**：本环境（Windows 桌面）缺少 iOS/Android 工具链 + 真机/模拟器，无法构建/验证 Tauri 移动目标；属**环境受限**，按「长周期」保留在路线图，非当前可交付范围。

### M7 — 数据库视图扩展（P2）✅
`DatabaseView` 七种视图（表格/画廊/看板/列表/日历/时间轴/目录）；日历按 `date` 落格、时间轴按 `date` 排序、目录按页面层级。

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

### M11 — 插件（P1，[规划](plans/2026-08-22-plugin-plan.md)）
- **M11.1 插件底座** ✅（v1.14.0）：插件目录扫描 + `manifest.json` 校验 + **boa 受限运行时 + 白名单 API**（`register`/`__get_current_page`/`__pages`/`__toast`）+ 命令并入命令面板 + `enabled` 持久化；内置示例插件 + Rust 单元测试。
- **M11.2 管理生命周期** ✅（v1.15.0）：插件管理面板（列表/启用禁用/卸载/从文件夹安装/打开插件目录）+ `uninstall_plugin`/`install_plugin`/`open_plugin_dir` 命令。
- **M11.2b 插件可插入内容** ✅（v1.32.0）：`__insert(text)` 白名单 API——插件 `run()` 调用即可把文本插入当前页面；`run_plugin_command` 返回 `{message, insert}`；命令面板在光标处插入；示例插件新增「插入文本」。
- **M11.3（可选 L2，已评估未做）**：UI 型插件（沙盒 WebView + postMessage 桥）。**评估**：工程量高、需引入 WebView 沙盒 + 双向消息桥 + 冲突/白名单审计；当前 boa 受限运行时 + 白名单 API（M11.1）已满足「命令插件」扩展性，UI 插件属高阶增强，收益/风险比不足，**按可选延后**。
- **M11.4（可选 L3，已评估未做）**：插件市场 / 签名 / 信任评分。**评估**：依赖公网市场 + 签名体系 + 信任评分模型，属平台级长期目标且**规模受限**（无用户基数/市场基础设施），路线图列为「延后」，**不在本环境范围**。

### M12 — 文件夹 = 网盘（P2，[规划](plans/2026-08-22-folder-netdisk-plan.md)）
- **M12.1 核心网盘 UX** ✅（v1.18.0）：文件搜索 + 每夹统计 + 在线预览（图片/视频/音频/PDF）+ 下载（`copy_attachment`）。
- **M12.2 拖拽 + 移动** ✅（v1.19.0）：拖拽 OS 文件进打开文件夹上传 + 文件跨夹移动（`move_attachment`）。
- **M12.3a 文件引用到页面** ✅（v1.28.0）：斜杠 `/文件引用` 插入文件引用卡片（名称/大小/类型图标，点击系统默认打开）；文件既属文件夹/网盘资产，也可被页面引用（共享同一条附件 + 内容寻址去重）。
- **M12.3b 文件版本** ✅（v1.33.0）：同名文件分组——重新上传同名（不同内容）文件按内容寻址保留旧内容为「历史版本」；`restore_attachment` 把历史版本克隆为最新当前文件；文件管理器「↻ 版本」弹层逐版本显示大小/hash + 恢复。**M12 文件夹=网盘里程碑达成**（12.1/12.2/12.3a/12.3b）。

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
- **M16.3 插件运行时降级迁移** 🗓（规划）：`boa_engine` 移入 WASM/浏览器——浏览器网页无法跑 Rust `boa_engine`，需重做 JS 沙盒；**根本性限制**，待后续。
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
- **M20.2 语义检索（embedding）** ✅（v1.59.118）：搜索在词频（TF）之上叠加基于字符二元组 Jaccard 的语义排序，优先展示语义更贴近的页面；纯函数 `charBigrams`/`semanticScore`/`semanticRank`，语义作为有界加分不破坏 TF 主排序（`web.ts` search 接入）。真实向量 embedding 作为未来 provider 钩子，离线 char-bigram 版已落地。
- **M20.3 语义检索接入 AI** ✅（v1.59.119）：侧边栏 AI 的 `search_pages` 工具描述新增「语义相近」提示，检索结果经 M20.2 语义排序后供模型引用（`search_pages` → `api.search` → 语义重排）。

### M21 — 静态 wiki 导出 + 关系图探索（P2，[方案](plans/2026-08-24-static-wiki-export-graph-plan.md)）
> 「本地优先 + wiki」的终局：把你的空间导成可独立浏览的 wiki 网站。
- **M21.1 静态 wiki 导出** ✅（v1.59.120）：命令面板新增「导出当前空间为 wiki」，把当前空间导出为可独立浏览的静态 HTML wiki——每页一个 `.html`（`[[标题]]` 双链+反链+标签）+ 含页面树的 `index.html`，打包为 `wiki-export.zip`，适配任意静态托管。纯函数 `buildWikiExport`/`wikiSlug`/`renderWikiBody`。Tauri 后端镜像命令为后续增强。
- **M21.2 关系图探索增强** ✅（v1.59.121）：关系图新增**关键词高亮**（输入关键词高亮匹配节点、弱化其余）、**聚类聚拢**（按标签/属性维度的同类节点互相拉近成簇）、**节点锁定**（双击节点或锁按钮 📌 固定）；保留按维度着色/过滤、点击跳转、局部缩放。

### M22 — 绘图方案（[设计](plans/2026-08-24-drawing-solution-design.md)）
> 「动手画」能力：自由手绘/涂鸦、结构化流程图/思维导图、AI 生成图片。大字节统一走内容寻址附件（节点只存 `hash` 引用），双平台无需新增 Rust 命令。
- **M22.1 绘图块（Excalidraw）** ✅（v1.59.122）：斜杠 `/绘图` 插入绘图块，点击打开全屏 Excalidraw 编辑器（笔/形状/箭头/文字/便签）；保存时把场景 JSON + 导出 PNG 落为内容寻址附件，节点只存 `hash` 引用，幂等去重；文字元素抽取进 `content_text`（可搜/反链）；Excalidraw 按需懒加载（独立大 chunk）。
- **M22.2 mermaid 块** ✅（v1.59.123）：`/流程图/思维导图` 插入 mermaid 块（syntax 可选），离线渲染 SVG，解析失败内联报错 + 可编辑源文本；源文本进 `content_text`（可搜）；mermaid 按需懒加载。
- **M22.3 AI 文生图** 🗓：`/AI 绘图` 调 provider 生成图 → 附件落库 → 插入 `ImageNode`；provider 失败降级。

## 4. 竞品差距跟踪

| 维度 | 当前差距 | 计划 |
|------|----------|------|
| 冷启动/复用 | 点模板建空白页、无模板内容 | **M9 模板**（建页填内容 + 保存为模板） |
| 空间隔离 | 只有单空间、`list_pages` 不按空间过滤 | **M10 多工作空间**（隔离 + 切换 + scope 修正） |
| 扩展性 | 仅硬编码命令注册表 | **M11 插件**（磁盘加载 + 受限 API）→ M3 主题/插件雏形已做 |
| 数据安全 | 无加密同步 | M2 端到端加密 |
| 数据可移植性 | 格式锁定 | M1 Markdown 无损往返（✅） |
| 聚合能力 | 无汇总 | M4 仪表盘聚合（✅） |
| 数据库视图 | 仅表格/画廊/看板 | M7 列表/日历/时间轴/目录（✅） |
| 导出 | 缺 PDF | M5 PDF 导出（✅） |
| 多端 | 仅桌面 | M6 移动端（已评估：环境受限）→ **M16 全平台通吃**（[规划](plans/2026-08-24-cross-platform-plan.md)） |
| 新页面引导 | 直接空白编辑 | M8 引导层（✅） |
| AI 写作 | 右侧聊天面板 + 草稿确认（M17） | **M18 内联起草**（✅，就地写 + 高亮待定块 + 快捷动作） |
| 双链织网 | 仅普通双链 / 块引用 | **M19 未链接提及 + 双链别名 + 精确块链**（✅） |
| 语义检索 | 仅 FTS 关键词搜索 | **M20 语义检索（char-bigram 版）+ 接入 AI 问答**（✅） |
| wiki 导出 | 无「把你的知识库变成可浏览网站」能力 | **M21 静态 wiki 导出 + 关系图探索**（✅） |
