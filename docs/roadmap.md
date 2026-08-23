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

**半就绪 / 骨架（待里程碑落地）**：
- 模板中心 = 纯 UI 骨架（点模板建**空白页**，无内容填充；「我的模板/保存为模板/从模板中心创建」为占位）
- 多工作空间 = **已实现**（M10 里程碑达成：隔离 + 切换 + 生命周期 + 每空间内容过滤）
- 插件 = 硬编码命令注册表 + 启停开关（`enabled` 存内存、无磁盘加载）

## 2. 下一阶段优先级

| 优先级 | 方向 | 对标 | 理由 | 状态 |
|--------|------|------|------|------|
| **P0** | **模板**（结构预设建页 + 保存为模板） | Notion / FlowUs / 思源模板 | 冷启动 + 复用效率；当前点模板是空白页 | 规划：[template-plan](plans/2026-08-22-template-plan.md) |
| **P0** | **多工作空间**（隔离 + 切换 + 查询 scope 修正） | Notion workspace / Obsidian vault | 生活/工作/项目分离、独立备份/导出/加密 | ✅ M10（v1.11.0） |
| **P0** | 端到端加密 | 思源 / Obsidian Sync | 数据安全最高优先级 | M2 待做 |
| **P1** | **插件**（磁盘加载命令插件 + 受限 API） | Obsidian 社区插件 | 扩展性从「命令注册表」升级为「可安装插件」 | 规划：[plugin-plan](plans/2026-08-22-plugin-plan.md)；M3 雏形已做 |
| **P1** | 主题 / 外观自定义 | Obsidian 主题 | 扩展性雏形 | ✅ M3 |
| **P2** | **文件夹 = 网盘**（文件库增强：拖拽上传 / 在线预览 / 搜索 / 下载 / 每夹统计） | FlowUs / Wolai / 有道 | 文件夹同时承载页面与文件，本地优先+去重+可加密形成差异化私域网盘 | 规划：[folder-netdisk-plan](plans/2026-08-22-folder-netdisk-plan.md) |
| **P2** | 数据库贯通：查询型数据库 / 保存视图 / ref 关联属性 / 公式汇总 | Notion / Dataview | 数据库从「表格」升级为「数据工作台」 | 规划：[database-lens-plan](plans/2026-08-22-database-lens-plan.md) |
| **P2** | 移动端适配 | 思源 / Obsidian | 多端能力 | M6 待做 |
| **P2** | Markdown 无损往返 | Obsidian 存储哲学 | 消除「格式锁定」顾虑 | ✅ M1（往返一致性待运行验证） |
| **P2** | 属性驱动仪表盘聚合 | 思源数据库 + Dataview | 释放属性数据库价值 | ✅ M4 |
| **P2** | PDF 导出 | 思源 / Obsidian | 导出矩阵补全 | ✅ M5 |
| **P3** | 新页面引导层 | Wolai / FlowUs | 降低冷启动门槛 | ✅ M8 |
| **P3** | 社区插件市场 | Obsidian 生态 | 平台级长期目标 | 延后 |

## 3. 里程碑规划

### M1 — Markdown 无损往返（P2）✅
`markdownTransformers.ts` 的 `SHUYONOTE_TRANSFORMERS` 已覆盖图片/视频/块嵌入/块引用/分隔线/待办/Callout/表格，补齐 Lexical 0.49 默认缺口。往返一致性待运行验证。

### M2 — 端到端加密（P0）
本地加密后上传，服务端不可读；`content_json`/`content_text`/附件加密同步；每空间独立密钥（见[多空间方案](plans/2026-08-22-multi-workspace-plan.md#8-同步与加密)）。密钥仅存本机。
- **M2.1 加密原语** ✅（v1.16.0）：Argon2id 密钥派生 + XChaCha20-Poly1305（`nonce||ciphertext`）+ 单元测试。
- **M2.2 同步加密** ✅（v1.17.0，默认关）：`set_encryption`/`encryption_status`/`disable_encryption`（密钥/盐存本机）；`push` 加密 / `pull` 解密（服务端存密文）；未启用纯透传。
- **M2.3 设置 UI + 口令解锁/锁定** ✅（v1.26.0）：主题设置弹层「端到端加密」区块（开启/关闭/状态徽章）；`lock_encryption`/`unlock_encryption` 会话锁定——锁定后同步被拒（`sync_gate`），须口令解锁；口令校验密文（sentinel）验证，密钥仅存本机。注：自建服务端端到端往返未在本环境验证（加密路径经单测）。

### M3 — 主题 / 外观自定义 + 插件雏形（P1）✅
主题设置弹层（系统/亮/暗 + 6 色强调色，CSS 变量覆盖）+ 插件启停开关（`registry` 加 enabled，命令面板按启用过滤）。「本地目录扫描安装」归入 [插件方案](plans/2026-08-22-plugin-plan.md)。

### M4 — 属性驱动仪表盘聚合（P2）✅
`DatabaseView` 顶部汇总条——select 列按值着色计数徽标、number 列合计/均值（纯前端聚合，尊重筛选）。

### M5 — PDF 导出（P2）✅
复用 `$generateHtmlFromNodes` + `HTML_TEMPLATE` → 隐藏 iframe → `window.print()` 另存为 PDF。数据库页 PDF 为后续项。

### M6 — 移动端适配（P2，长周期）
Tauri 移动端（iOS/Android）核心编辑 / 浏览 / 搜索可用。

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
- **M10.3 每空间设置** ✅（v1.11.0）：所有内容查询按活动空间过滤——回收站 `list_deleted`、标签 `list_tags`/`pages_by_tag`/`board_data`、全文搜索 `search`、关系图 `get_graph`、反链 `get_backlinks`。**M10 多工作空间里程碑达成**。
- **M10.4a 全空间搜索** ✅（v1.27.0）：搜索框「本空间 / 全空间」切换——`search` 增 `all_spaces` 参数，忽略活动空间过滤并返回结果所属空间名（`SearchResult.space`）；FTS / LIKE / `prop:` 过滤均支持。说明：共享模板库、跨空间复制页面为 M10.4b 可选后续项。

### M11 — 插件（P1，[规划](plans/2026-08-22-plugin-plan.md)）
- **M11.1 插件底座** ✅（v1.14.0）：插件目录扫描 + `manifest.json` 校验 + **boa 受限运行时 + 白名单 API**（`register`/`__get_current_page`/`__pages`/`__toast`）+ 命令并入命令面板 + `enabled` 持久化；内置示例插件 + Rust 单元测试。
- **M11.2 管理生命周期** ✅（v1.15.0）：插件管理面板（列表/启用禁用/卸载/从文件夹安装/打开插件目录）+ `uninstall_plugin`/`install_plugin`/`open_plugin_dir` 命令。
- **M11.3（可选 L2）**：UI 型插件（沙盒 WebView + postMessage 桥）。
- **M11.4（可选 L3）**：插件市场 / 签名 / 信任评分。

### M12 — 文件夹 = 网盘（P2，[规划](plans/2026-08-22-folder-netdisk-plan.md)）
- **M12.1 核心网盘 UX** ✅（v1.18.0）：文件搜索 + 每夹统计 + 在线预览（图片/视频/音频/PDF）+ 下载（`copy_attachment`）。
- **M12.2 拖拽 + 移动** ✅（v1.19.0）：拖拽 OS 文件进打开文件夹上传 + 文件跨夹移动（`move_attachment`）。
- **M12.3a 文件引用到页面** ✅（v1.28.0）：斜杠 `/文件引用` 插入文件引用卡片（名称/大小/类型图标，点击系统默认打开）；文件既属文件夹/网盘资产，也可被页面引用（共享同一条附件 + 内容寻址去重）。说明：文件版本为 M12.3b 可选后续项。

### M13 — 数据库 = 透镜（P2，✅ 达成，[规划](plans/2026-08-22-database-lens-plan.md)）
- **M13.1 保存视图** ✅（v1.20.0）：`db_views` 表 + `save/list/delete_db_view` + 数据库工具栏「视图」切换/保存/删除（记录 view_type/filter/sort/board_group_attr）。
- **M13.2 查询型数据库** ✅（v1.21.0）：`pages.db_rule` + `set/get_db_rule`；`query_database` 按规则（属性值/tag，AND）过滤收页；未设规则行为不变。
- **M13.3 ref 关联属性** ✅（v1.22.0）：`ref` 列类型 + `resolve_refs`（`p:<id>`→标题）+ 数据库表格 ref 列可点击跳转。**M13.3b**（v1.23.0）：ref 属性值并入关系图边（kind=`ref`），数据库 ↔ 图谱贯通。
- **M13.4 公式列** ✅（v1.24.0）：「公式」列类型 + 前端受限算术解析（`+ - * / ( )`），按列名引用同行数字列计算。**M13 里程碑达成**。
- **M13.5 跨库统计（rollup）** ✅（v1.25.0）：「统计」列类型——引用另一数据库的行并按 `count/sum/avg` 聚合（JSON 配置 `{ref,db,col,fn}`），跨库实时取数，前端只读聚合。

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
| 多端 | 仅桌面 | M6 移动端 |
| 新页面引导 | 直接空白编辑 | M8 引导层（✅） |
