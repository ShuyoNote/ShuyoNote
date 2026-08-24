<p align="center">
  <img src="design/logo/app-icon.png" alt="ShuyoNote Logo" width="128" height="128" />
</p>

<h1 align="center">ShuyoNote 数友笔记</h1>

<p align="center">
  <strong>本地优先 · �?Notion 的知识管理桌面应�?/strong><br>
  基于 Tauri 2 + Lexical + SQLite，数据完全存储在本机，离线可用，支持多设备同步�?</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-1.59.35-blue" alt="version">
  <img src="https://img.shields.io/badge/Tauri-2.x-24c8db" alt="tauri">
  <img src="https://img.shields.io/badge/Lexical-0.49-3370ff" alt="lexical">
  <img src="https://img.shields.io/badge/Rust-1.94+-orange" alt="rust">
  <img src="https://img.shields.io/badge/React-19-61dafb" alt="react">
  <img src="https://img.shields.io/badge/Vite-8-646cff" alt="vite">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="license">
</p>

---

## 📖 简�?
ShuyoNote 是一�?*本地优先（local-first�?*的知识管理应用。它借鉴�?Notion 的块编辑器体验，但将全部数据保存在本�?SQLite 数据库中——无需注册、无云端依赖、离线即可使用。需要多设备协作时，可自建轻量同步服务，通过变更日志实现增量同步与冲突合并�?
- **本地优先**：数据即文件，存储在本机，离线可用�?- **内容寻址去重**：附件按 SHA-256 哈希存储，跨�?�?空间去重，省空间�?- **可自建同�?*：无云锁定，可选自�?sync-server（outbox + LWW + 附件增量）�?- **可扩�?*：磁盘加载命令插件（受限白名�?API�? 主题/外观自定义�?
## 📑 目录

- **特�?* �?编辑体验 / 知识组织 / 数据安全 / 多设备同�?/ 体验优化
- **架构** �?前端 / Rust 后端 / SQLite / 同步服务端分�?- **技术栈** �?各层技术一�?- **开发环境要�?* �?Node / Rust / 平台
- **快速开�?* �?安装与启�?- **构建发布** �?产物
- **多设备同�?* �?sync-server + 配置
- **项目结构** �?目录说明
- **文档体系** �?文档索引
- **路线�?* �?里程�?- **License**

## �?特�?
### 编辑体验
- **块编辑器**：基�?Lexical，支持标题、引用、Callout、代码块、列表、待办、表格、分隔线�?12 种块类型
- **斜杠菜单**：输�?`/` 快速插入任意块（含 `/引用块`、`/嵌入块`�?- **块拖拽排�?*：悬停块左侧出现 `⋮⋮` 手柄，拖拽实时显示插入指示线，松手重�?- **块多�?*：点�?`⋮⋮` 手柄选中块（Shift 选连续范围），批量操作条「复�?/ 删除」，`Delete`/`Esc` 快捷键，选中块高�?- **表格交互**：悬浮工具栏（增删行�?/ 表头行·列切换 / 对齐 / 背景色）+ 列宽拖拽调整 + 单元格选区高亮
- **图片粘贴**：截�?复制图片直接粘贴，内容寻址（SHA-256）去重存�?- **网址书签**：`/wzsq` �?`/bookmark` 插入 URL 为书签卡片（自动�?Open Graph 标题/摘要/预览图）；粘贴纯网址可一键「转换为网址书签」；预览图复用附件内容寻址存储
- **文件附件**：通用文件附件（多选导入、超大文件流式存取、打开 / 定位 / 移除�?- **Markdown**：快捷键输入、一键导�?导出、导�?HTML

### 知识组织
- **页面�?*：无限层级嵌套，页面与文件夹（`kind`）区分，拖拽精确排序
- **文件管理 / 网盘**：从侧边栏点文件夹进入文件管理页——文�?文件�?文件列表（类型、大小、时间），文件夹内批量上传超大文件（流式）、侧边栏同步展示；文件引用到页面（文件卡�?+ 系统打开）；同名文件历史版本（保�?恢复�?- **标签系统**：页面打标签，侧边栏按标签筛选；标签管理（全局标签库，重命�?合并/删除/使用页数�?- **双向链接**：`[[标题]]` 页面双链 + `((块ID))` 块引�?+ `{{块ID}}` 块嵌�?- **块级反链**：页面底部反链面板分「页面引�?/ 块级引用」两组，精确到「谁引用了本页哪一块�?- **关系�?*：力导向关系图，页面/块节点、按引用类型着色、块级图层开关、拖拽与点击跳转
- **数据库视�?*：表�?/ 画廊 / 看板 / 列表 / 日历 / 时间�?/ 目录 七种视图；查询型数据库（规则收页�? 保存视图 + `ref` 关联属�?+ 公式�?+ 跨库 rollup 聚合
- **看板视图**：按标签分列，卡片拖拽跨列切�?- **全文搜索**：SQLite FTS5 + trigram 分词，支持中文子串检索、命中高亮与定位
- **多工作空间（物理隔离�?*：每空间独立 SQLite 库（`meta.db` 管理空间清单，`spaces/<ws_id>/` 每空间库）；空间切换器（新建 / 重命�?/ 主题�?/ 排序 / 删除）；全空间搜索跨库合并；跨空间复制页面；单空间导�?导入（自包含 zip�?
### 数据安全
- **自动保存**：防抖写�?SQLite，无「保存」按�?- **版本历史**：每次保存前自动快照，可一键回滚（每页保留 50 份，自动去重�?- **回收�?*：软删除 + 恢复 + 彻底删除
- **端到端加�?*：Argon2id 密钥派生 + XChaCha20-Poly1305；同步加�?+ 设置 UI + 口令解锁/锁定，每空间独立密钥
- **整库备份**：导�?导入 zip（数据库一致性快�?+ 附件目录；流�?+ 进度�?- **单空间备�?导出**：`export_workspace` 把当前空间打成自包含 zip（空间库 + 该空间引用附�?+ 元数据）；`import_workspace` 导入为新空间
- **空间清理 / 存储管理**：占用统计（数据�?附件/回收�?版本/临时�? 清空回收�?/ 清理孤立附件 / 清理版本历史 / 清理临时文件 / 清理软删工作空间

### 多设备同�?- **Outbox 变更日志**：本地每次写入记录变更，离线排队
- **LWW 冲突合并**：页面级 last-write-wins + 墓碑
- **附件同步**：内容寻址去重，双向增�?- **自动定时同步**：启动即同步，之后每 5 分钟周期同步

### 体验优化
- **设计系统 v2**：品牌蓝 + 中性面 + 多彩分类色的统一 token 体系，参�?FlowUs / Wolai
- **暗色模式**：亮�?/ 暗色 / 跟随系统三�?- **命令面板**：`Ctrl+K` 搜索页面与命令，分组展示、键盘导�?- **顶部工具�?*：页面顶部图标工具栏（查�?/ 导入 / 导出 Markdown / 导出 HTML / 版本历史 / PDF�?- **模板中心**：结构预设建页（页面/数据库）+ 保存为模�?+ 共享打磨
- **Toast 反馈**：保�?/ 同步 / 备份 / 删除 / 恢复等操作底部提示，替代系统弹窗
- **编辑器查�?*：`Ctrl+F` 高亮全部命中并逐个导航
- **多窗�?*：页面可弹出到独立窗口编�?
## ⌨️ 快捷�?
| 快捷�?| 功能 |
|--------|------|
| `Ctrl+N` | 新建页面 |
| `Ctrl+Shift+F` | 聚焦搜索 |
| `Ctrl+E` | 循环笔记 / 看板 / 关系图视�?|
| `Ctrl+K` | 打开命令面板 |
| `Ctrl+F` | 编辑器内查找（`Enter` / `Shift+Enter` 导航�?|
| `Esc` | 关闭查找�?/ 命令面板 / 弹层 |
| `/` | 打开斜杠菜单 |

## 🏗�?架构

```
┌─────────────────────────────────────────────────────�?�?                   前端 (React)                       �?�? ┌───────────────�? ┌────────────────────────────�? �?�? �?  Lexical     �? �? Zustand (notes / theme)    �? �?�? �?  编辑�?      �? �? 侧边�?/ 看板 / 各面�?      �? �?�? └──────┬────────�? └─────────────┬──────────────�? �?�?        �?          Tauri IPC      �?                 �?└─────────┼──────────────────────────┼──────────────────�?          �?                         �?┌─────────────────────────────────────────────────────�?�?                 Rust 后端 (src-tauri)                �?�? commands · search · sync · attachments · backlinks  �?�? blocks · graph · tags · trash · versions · backup   �?�? workspace_io · storage · security · plugins          �?�? workspaces · templates · crypto · database · props  �?�?                   �?                                �?�?    ┌──────────────┴──────────────�?                 �?�?    �?                            �?                 �?�? SQLite (WAL + FTS5)        附件目录 (SHA-256)       �?�? meta.db(应用�? + spaces/<id>.db(每空�?              �?└─────────────────────────────────────────────────────�?          �?          �?HTTP (push / pull)
┌─────────┴───────────────────────────────────────────�?�?       同步服务�?(sync-server, 独立二进�?           �?�?       Axum + SQLite（变更日�?/ 附件元数据）         �?└─────────────────────────────────────────────────────�?```

**数据模型**：一�?= 一�?Lexical 文档。块映射�?Lexical 根级节点（每个顶层块带稳�?`blockId`），页面层级�?`parent_id` 树表达；`blocks` 表维护「块 �?页」反向索引，`backlinks` 表记录页面级 + 块级引用关系�?*物理隔离**：每个工作空间一个独�?SQLite 库（`spaces/<ws_id>/`），应用级共享状态（workspaces / 模板 / 插件状�?/ 同步配置）放 `meta.db`；附件字节全局内容寻址（跨空间去重），单空间可搬移经空间级附件子集导出实现�?
## 🧰 技术栈

| �?| 技�?|
|----|------|
| 桌面�?| Tauri 2.x（Rust 后端 + 系统 WebView�?|
| 编辑�?| Lexical 0.49（`@lexical/react`�?|
| 前端 | React 19 · TypeScript · Vite 8 |
| 状态管�?| Zustand |
| 本地存储 | SQLite（rusqlite 0.40, bundled）�?FTS5 全文检�?|
| 加密 | Argon2id + XChaCha20-Poly1305（RustCrypto�?|
| 同步 | outbox 变更日志 + LWW · reqwest · 自建 Axum 服务�?|
| 备份/导出 | rusqlite 在线 backup API + zip |
| 插件 | boa_engine（受�?JS 运行时）+ 白名�?API |

## 🛠�?开发环境要�?
- **Node.js** �?20 �?**pnpm**
- **Rust** stable�?.94+）与 cargo
- Windows / macOS / Linux

## 🚀 快速开�?
```bash
# 1. 安装依赖
pnpm install

# 2. 启动开发模�?pnpm tauri dev
```

> **Windows 提示**：若 cargo 使用镜像源且遇到 SSL 撤销错误（如 USTC），先执�?> `$env:CARGO_HTTP_CHECK_REVOKE="false"` 再运行�?
首次启动会在系统应用数据目录（Windows：`%APPDATA%\cn.shuyo.shuyonote\`）创建数据（WAL 模式）：`meta.db`（应用级：空�?同步/模板/插件状态）+ `spaces/<ws_id>/`（每空间独立 SQLite 库）+ `attachments/`（全局内容寻址附件）�?
## 📦 构建发布

```bash
pnpm tauri build
```

产物位于 `src-tauri/target/release/`�?
## 🔄 多设备同�?
### 1. 启动同步服务�?
```bash
cd sync-server
cargo run -- --port 8787 --db <数据目录>/shuyonote-sync.db
```

参数�?
| 参数 | 说明 | 默认�?|
|------|------|--------|
| `--port` | 监听端口 | `8787` |
| `--db` | SQLite 数据库路�?| 系统临时目录 |

### 2. 在应用中配置

1. 侧边栏点击「同步�?2. 填写服务地址（如 `http://localhost:8787`，跨设备填局域网 IP 或公网地址�?3. 可选填写访问令�?4. 点击「立即同步�?
**同步机制**：本地每次写操作�?`changes` 表记�?outbox 变更；同步时�?push 本地增量，再 pull 服务端增量，按页面级 `updated_at` �?last-write-wins 合并。删除走墓碑，附件按内容寻址去重传输。若开启端到端加密，push 前加密、pull 后解密（服务端仅存密文），锁定会话时同步被拒�?
## 📁 项目结构

```
ShuyoNote/
├── src/                      # 前端（React + Lexical�?�?  ├── editor/               # 编辑器、自定义节点（Callout/Image/BlockRef/BlockEmbed）、Markdown 转换
�?  ├── components/           # 侧边栏、页面树、搜索、看板、关系图、各面板�?7+ 组件�?�?  ├── store/                # Zustand（notes / theme / sidebar / toast / view / space / blockCache / ...�?�?  ├── hooks/                # 自动同步 / 全局快捷�?/ Popover
�?  ├── plugins/              # 插件命令注册表（命令面板扩展点）
�?  ├── lib/                  # Tauri IPC 封装 / 标签分类�?/ Markdown 导出 / PDF 打印
�?  ├── App.tsx               # 根组�?�?  ├── App.css               # 设计系统 token 与全局样式
�?  └── types.ts              # 共享类型
├── src-tauri/                # Tauri 后端（Rust�?�?  └── src/
�?      ├── db.rs             # SQLite 连接/迁移；meta.db + spaces/<id>.db 每空间库
�?      ├── commands.rs       # 页面 CRUD
�?      ├── search.rs         # FTS5 检索（含全空间跨库合并�?�?      ├── sync.rs           # outbox / LWW / push-pull / 附件同步
�?      ├── attachments.rs    # 图片 / 附件（内容寻址�?�?      ├── backlinks.rs      # 反向链接
�?      ├── blocks.rs         # 块索�?/ 块级引用 / 块级反链
�?      ├── graph.rs          # 关系图数�?�?      ├── tags.rs           # 标签 / 看板
�?      ├── trash.rs          # 回收�?�?      ├── versions.rs       # 版本历史
�?      ├── backup.rs         # 整库备份导出 / 导入
�?      ├── workspace_io.rs   # 单空间导�?/ 导入（自包含 zip�?�?      ├── storage.rs        # 存储统计 / 清理（回收站/孤立附件/版本/临时/软删空间�?�?      ├── workspaces.rs     # 工作空间命令 + 跨空间复�?�?      ├── templates.rs      # 模板（meta.templates�?�?      ├── plugins.rs        # 插件加载（boa 运行�?+ 白名�?API�?�?      ├── security.rs       # 端到端加密（口令加解�?/ 同步门）
�?      ├── crypto.rs         # Argon2id + XChaCha20-Poly1305 原语
�?      ├── database.rs       # 数据库视�?/ 查询�?/ 公式
�?      ├── properties.rs     # 属性系�?�?      └── windows.rs        # 多窗�?├── sync-server/              # 同步服务端（独立 Rust 二进制，Axum + SQLite�?├── design/                   # UI/UX 设计体系（设计系�?/ UX 流程 / 原型 / 实现计划�?├── docs/                     # 产品/方案/对比文档（见 docs/README.md 索引�?└── CHANGELOG.md              # 版本变更日志
```

## 📚 文档体系

> 全量文档统一入口�?[docs/README.md](docs/README.md)（按主题组织的索引）�?
| 文档 | 内容 |
|------|------|
| [docs/README.md](docs/README.md) | **文档体系总索�?*：定�?/ 方案 / 对比 / 设计交付 / 变更记录 |
| [docs/design-philosophy.md](docs/design-philosophy.md) | **设计哲学**：page 本源 / 属性语�?/ 数据�?透镜 / 文件�?容器 / 空间=隔离容器 |
| [docs/roadmap.md](docs/roadmap.md) | 演进路线图与里程碑规划（M1–M15 已达；M6/移动�?M11.3/M11.4 已评估未做） |
| [docs/positioning.md](docs/positioning.md) | 产品定位陈述、目标用户与差异�?|
| [docs/compare-obsidian-siyuan-shuyonote.md](docs/compare-obsidian-siyuan-shuyonote.md) | Obsidian / 思源笔记 / ShuyoNote 三方对比与定�?|
| [docs/compare-flowus-wolai-notion-shuyonote.md](docs/compare-flowus-wolai-notion-shuyonote.md) | FlowUs / Wolai / Notion / ShuyoNote 四方对比与定�?|
| [docs/plans/*](docs/plans/) | 各功能方案：块引�?/ 属性数据库 / 多空�?/ 模板 / 插件 / 网盘 / 数据库透镜 / 存储清理 / 工作�?CRUD / 物理隔离 |
| [design/README.md](design/README.md) | UI/UX 设计交付索引（设计系�?/ UX 流程 / 高保真原�?/ 实现计划�?|
| [CHANGELOG.md](CHANGELOG.md) | 版本变更日志 |

## 🗺�?路线�?
- [x] MVP：页面树 + 富文�?+ 自动保存
- [x] 块系统：斜杠菜单 / 待办 / 表格 / Callout
- [x] 全文检索：FTS5 + trigram 中文搜索
- [x] 多设备同步：outbox + LWW + 附件同步
- [x] 标签 / 反链 / 文件�?/ 看板
- [x] 回收�?/ 版本历史 / 整库备份
- [x] 暗色模式 / 命令面板 / 多窗�?- [x] 块拖拽排�?/ 编辑器查�?- [x] UI/UX 设计系统 v2（token / Toast / 分类�?/ 命令面板增强 / 骨架屏）
- [x] 表格交互（悬浮工具栏 / 列宽拖拽 / 选区高亮�?- [x] 块级引用 / 块嵌�?/ 块级反链
- [x] 关系图（页面 / 块级图层�?- [x] 属性系�?+ 数据库视图（表格 / 画廊 / 看板�?- [x] 属�?Notion 风格统一（标签属性行 + 底部「＋ 添加标签 / �?添加属性」双按钮�?- [x] 文件管理视图（文件夹 / 批量超大文件上传 / 侧边栏文件）
- [x] 文件引用到页面（正文插入文件卡片 / 系统默认打开�?- [x] 文件历史版本（同名文件保�?恢复�?- [x] 全局标签管理（新�?/ 重命名合�?/ 删除 / 使用页数�?- [x] 跨空间复制页面（把页面树复制到其他工作空间）
- [x] 工作空间管理（新建种子首�?/ �?id 重命�?/ 空间主题色与排序�?- [x] 全空间搜索（本空�?/ 全空间切换，跨工作空间全文检索）
- [x] 块多�?+ 批量删除
- [x] HTML/Markdown 混排导入（保�?`align` 居中 / 徽章成排 / 图片尺寸�?- [x] Markdown 无损往�?- [x] 导出工作空间�?Markdown（批�?.md，可 git / 可移植）
- [x] 属性驱动仪表盘聚合
- [x] 端到端加密（Argon2id 派生 + XChaCha20-Poly1305；同步加�?+ 设置 UI + 口令解锁/锁定，每空间独立密钥�?- [x] 主题自定�?+ 插件启停
- [x] 插件（磁盘加载命�?+ 受限白名�?API，可插入内容�?- [x] 数据库视图扩展（列表 / 日历 / 时间�?/ 目录�?- [x] 跨库统计（rollup：数据库列引用另一库的行并聚合 count / sum / avg�?- [x] 新页面引导层（页�?/ 数据�?/ 模板 / 导入 / AI 入口�?- [x] 导出 PDF（页�?+ 数据库视图）
- [x] 每工作空间独立存储（物理隔离：`meta.db` + `spaces/<ws_id>/` 每空间库；全空间搜索跨库合并 / 跨空间复�?/ 单空间导出导入）
- [ ] 移动端适配（环境受限：�?iOS/Android 工具链，已评估）

> 详细演进路线与里程碑�?[docs/roadmap.md](docs/roadmap.md)�?
## 📄 License

MIT

> 注：仓库暂未附带 `LICENSE` 文件，正式发布前建议补充�?