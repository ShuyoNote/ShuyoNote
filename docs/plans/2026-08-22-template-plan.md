# 模板（Template）功能实现方案

> 目标：把 ShuyoNote 现在的「模板中心骨架」升级为**真正可用的模板系统**——模板不只是「封面 + 标题」，而是一个**可复用的页面/数据库预设**；从模板一键建出**带真实内容**的页面或数据库，并支持「保存为模板」「导入共享」。核心缺口是「**点模板建页要填充内容**」，其余是数据落地与入口补齐。

## 1. 背景与竞品对照

| 竞品 | 模板能力 | 关键点 |
|------|----------|--------|
| Notion | Template gallery + 模板库 | 内置大量模板，点模板新建带内容的页面/数据库；可保存为模板；模板市场 |
| 思源笔记 | 文档模板 | 保存当前文档为模板，新建时套用结构 |
| Obsidian | Templates 插件 | 用模板占位符变量（`{{date}}`、`{{title}}`）生成内容 |
| FlowUs / Wolai | 模板中心 + 模板市场 | 分类模板库，机构/个人模板 |
| ShuyoNote 现状 | 硬编码骨架 | 9 个 `{name,category,icon,cover}`；点卡片建**空白页**；「我的模板」「从模板中心创建」「设置个人模板」全是占位 |

**结论**：竞品都指向「**结构预设 + 一键生成内容**」。ShuyoNote 现在的骨架缺三件事：**① 真正的模板数据（结构/属性/数据库定义）② 建页时把结构填充进内容 ③ 用户自建模板**。

## 2. 现状盘点（代码已核实）

| 文件 | 现状 | 问题 |
|------|------|------|
| `src/templates/index.ts` | 硬编码 `TemplateItem{id,name,category,icon,cover}` | 无结构/内容；`fitness` 分类「健康」不在 `TEMPLATE_CATEGORIES`（个人/工作/教育/我的模板）→ 被过滤不可见 |
| `src/store/templateCenter.ts` | 仅 `{open,setOpen}` | 只做开合 |
| `src/components/TemplateCenterView.tsx` | 读硬编码 `TEMPLATES`，点卡片 `createPage(null)` | 建**空白页**，不填内容 |
| `src/components/NewPageGuide.tsx` | 「从模板中心创建」= `toast("模板中心即将推出")` | 入口没接真功能 |
| `src-tauri/src/commands.rs::create_node` | `INSERT ... VALUES(..., '{}', '', ...)` | 新页 `content_json='{}'`（空白），需支持从模板注入内容 |

## 3. 核心概念

- **模板 = 结构预设**：它定义「从头建一个页面/数据库长什么样」，而非内容本体。
- **两类模板**：
  - **页面模板**（`kind='page'`）：一套 Lexical 块序列（`content_json`）+ 属性预设 + 标签。
  - **数据库模板**（`kind='database'`）：一组列（属性）/ 视图 / 分组 + 初始行（可选）。
- **建页即填充**：从模板建页时把模板结构**深拷贝**进新页面的 `content_json` / 属性 / 标签；建好后模板与新页**解耦**（改模板不影响已建页）。
- **元数据**：名称 / 分类 / 图标（建议统一 SVG 线稿，不用 emoji）/ 封面 / 一句话描述。
- **来源分层**：内置（应用级全局）→ 我的模板（每空间一份）→ 导入共享（文件 / GitHub / 他人分享）。

## 4. 数据模型（SQLite）

### 4.1 `templates` 表

```sql
CREATE TABLE IF NOT EXISTS templates (
  id            TEXT PRIMARY KEY,                -- UUID
  name          TEXT NOT NULL,
  category      TEXT NOT NULL,                   -- 个人/工作/教育/健康/我的模板 …
  kind          TEXT NOT NULL DEFAULT 'page',    -- page | database
  icon          TEXT NOT NULL DEFAULT '',        -- SVG 名或单字符
  cover         TEXT NOT NULL DEFAULT '',        -- 封面（CSS 渐变或图片引用）
  summary       TEXT NOT NULL DEFAULT '',        -- 一句话描述
  content_json  TEXT NOT NULL DEFAULT '{}',      -- 页面模板：Lexical 块序列
  props_json    TEXT NOT NULL DEFAULT '{}',      -- 页面模板：属性预设
  database_json TEXT NOT NULL DEFAULT '{}',      -- 数据库模板：列/视图/分组/初始行
  tags          TEXT NOT NULL DEFAULT '[]',      -- 预置标签
  built_in      INTEGER NOT NULL DEFAULT 0,      -- 1=内置（不可删）
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_templates_category ON templates(category);
```

> 幂等 seed：首次建库时插入内置模板（`built_in=1`）；「我的模板」由用户保存产生（`built_in=0`，带 `space_id` 归属）。

### 4.2 归属与隔离
- 内置模板：`built_in=1`，全局可见，不分空间。
- 我的模板：`built_in=0`，**按 `templates.space_id` 归属**（跟随多空间），切换空间只能看到本空间的「我的模板」。

### 4.3 建页注入内容
- 扩展 `create_node`（或新增 `create_page_from_template`）：插入时用模板的 `content_json` 替换 `'{}'`，并写入 `props_json` / `tags`。
- 数据库模板：`create_node(kind='database')` 后，把 `database_json` 写入数据库页的视图/列配置（落地到 `content_json` 或专门配置表，视 `DatabaseView` 现有存储而定）。

## 5. 前端设计

### 5.1 入口补齐
- `NewPageGuide`「从模板中心创建」→ 改为 `useTemplateCenterStore.setOpen(true)`（替换 toast）。
- 侧边栏「模板中心」入口保留。
- 命令面板新增「打开模板中心」「新建空间（模板作用域）」。

### 5.2 模板画廊（TemplateCenterView 升级为读库）
- 读 `list_templates`（按分类过滤）替代硬编码 `TEMPLATES`。
- 分类 tab 与模板分类**对齐**（补「健康」等，或把模板归入现有 tab，消除筛选漏洞）。
- 卡片：封面 + 名称 + 描述；点击 → `create_page_from_template(template_id)` → 建真实内容页并跳转。
- MockPreview 缩略图可保留（模拟封面），但卡片点击行为要真建页。

### 5.3 保存为模板（“设置个人模板”）
- 工具栏 / 命令「保存为模板」：把当前页结构（`content_json` + 属性 + 标签）存成 `built_in=0` 模板，落到当前空间（或全局，看后续取舍）。
- 保存时可填名称 / 分类 / 图标 / 封面。

### 5.4 模板管理
- 「我的模板」tab 支持重命名 / 删除 / 导出。
- 内置模板不可删。

## 6. 后端命令（新增/改造）

| 命令 | 说明 |
|------|------|
| `list_templates`（`{category?}`） | 列出模板（先内置，后按空间并入“我的模板”） |
| `create_template` / `update_template` / `delete_template` | 我的模板 CRUD |
| `create_page_from_template`（`{template_id, parent_id?}`） | 读模板 → `create_node` 注入 `content_json`/属性/标签 → 返回新页 |
| `save_as_template`（`{page_id, name, category, icon?, cover?}`） | 把页面存为模板 |
| `export_template` / `import_template` | 模板导入导出（文件 / JSON） |

> `templates` 建表/迁移加入 `src-tauri/src/db.rs`；命令放 `src-tauri/src/templates.rs`，注册进 `lib.rs`。

## 7. 实施顺序（里程碑）

- **M1（真正可用，价值最大）**：`templates` 表 + 内置模板 seed + `create_page_from_template`（建页填内容）+ `list_templates` + 模板中心读库 + 修入口（NPG「从模板中心创建」）+ 修分类 tab。验收：点模板能建出**带真实内容**的页面/数据库，分类筛选正确。
- **M2（用户自建）**：`save_as_template` + 「我的模板」tab（CRUD + 每空间归属）+ 数据库模板（`database_json` 建数据库预设列/视图）。
- **M3（共享与打磨）**：模板导入/导出、内置模板内容丰富化、图标/封面去 emoji 规范化、属性占位符变量（`{{date}}`/`{{title}}`）。
- **推迟**：跨空间模板同步、模板市场。

## 8. 测试与验收标准

- [ ] 从模板中心点一个模板 → 新建页面并**带模板的块内容**（不是空白页），跳转到该页。
- [ ] 数据库模板建出的页面是 `kind='database'`，列/视图/分组符合模板定义。
- [ ] 建页后修改模板，不影响已建页（深拷贝解耦）。
- [ ] 分类 tab 与模板分类一致，「健康」等模板不再被过滤隐藏。
- [ ] 「保存为模板」后，新模板出现在「我的模板」，切换空间只看到本空间模板。
- [ ] 内置模板不可删；「我的模板」可重命名/删除/导出。
- [ ] 从模板建页后，标签 / 属性预设写入正确。
- [ ] 同步 / 版本历史 / 回收站不受影响（模板只是建页的种子，建成后即普通页面）。

## 9. 风险与取舍

- **填充内容要深拷贝解耦**：避免模板建页后改动模板影响到已建页面（复制 `content_json` 而非引用）。
- **数据库模板的落地机制**：取决于 `DatabaseView` 现有列/视图存储方式（`content_json` 或其他配置表），M2 需先核对再落地 `database_json`。
- **分类与图标规范化**：`icon` 建议统一 SVG 线稿（对齐 anti-AI-slop 的「别用 emoji 当功能图标」），`cover` 用渐变/图片资源。
- **作用域**：内置全局、我的模板每空间，避免「我的模板」跨空间打架；跨空间共享放 Phase 3。
- **别做成大而全**：先 M1「建页填内容」，把「真的能用」做到，再谈导入/市场。

## 10. 结论

模板对 ShuyoNote 是「**冷启动 + 复用效率**」的抓手（对标 FlowUs/Wolai/Notion 的模板中心）。当前骨架缺的核心是「**建页填内容**」和「**用户自建模板**」，这也是价值最大、性价比最高的两件事。按 M1 → M2 → M3 收紧推进，共享/市场延后。
