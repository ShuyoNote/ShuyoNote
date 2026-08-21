# 属性 + 数据库 统一实现方案

> 目标：把「标签」这一扁平属性，升级为一套**带类型的属性系统（Properties）+ 多视图数据库（Database）**，统一吸收思源笔记的「数据库」与 Obsidian 的「Properties」两大方向，让 ShuyoNote 从「笔记 + 看板」演进为「结构化知识工作台」。

## 1. 背景与竞品对照

| 竞品 | 能力 | 关键点 |
|------|------|--------|
| 思源笔记 | 数据库块 | 块即数据库行，属性即列，表格 / 看板 / 画廊多视图；[数据库介绍](https://siyuannote.com/article/1725202844) |
| Obsidian | Properties | YAML frontmatter 属性（带类型、内联编辑）；[Properties](https://obsidian.md/help/properties) |
| ShuyoNote 现状 | 标签 + 看板 | 只有「标签」一种扁平属性；看板 = 按标签分列 |

**结论**：两大竞品共同指向「属性驱动的结构化视图」，这是 ShuyoNote 当前最大天花板。本方案把两者合并为**一套属性系统 + 数据库视图**：属性既可内联编辑（Obsidian 式），又可作为列构成数据库（思源式）。

## 2. 核心概念

- **属性（Property）**：页面上的 `名称 → 值`，带类型。分两类：
  - **内置属性**：标签（已有）、别名（aliases）、备注（memo）、创建/更新时间。
  - **自定义属性**：用户新建，如「状态 / 优先级 / 截止日期 / 负责人」。
- **数据库（Database）**：一组页面 + 一组属性列 + 一个视图（表格 / 看板 / 画廊）。
- **视图（View）**：同一批数据的不同呈现，可切换、可独立配置排序/过滤/分组。

## 3. 数据模型（SQLite）

### 3.1 属性定义表 `attr_defs`

```sql
CREATE TABLE IF NOT EXISTS attr_defs (
    id        TEXT PRIMARY KEY,          -- UUID
    name      TEXT NOT NULL UNIQUE,      -- 属性名（如「状态」）
    type      TEXT NOT NULL DEFAULT 'text',  -- text|number|date|select|multi|checkbox|tag|ref|formula
    options   TEXT NOT NULL DEFAULT '[]',    -- select/multi 的选项 JSON 数组
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
```

> 名称全局唯一（跨页面共享同一个属性定义，保证「状态」列在所有数据库里语义一致）。

### 3.2 属性值表 `page_props`

```sql
CREATE TABLE IF NOT EXISTS page_props (
    page_id    TEXT NOT NULL REFERENCES pages(id),
    attr_id    TEXT NOT NULL REFERENCES attr_defs(id),
    value      TEXT NOT NULL DEFAULT '',   -- 按 type 序列化（见下）
    PRIMARY KEY (page_id, attr_id)
);
CREATE INDEX IF NOT EXISTS idx_page_props_attr ON page_props(attr_id);
```

### 3.3 值序列化约定（`value` 存 TEXT）

| type | 存储形式 |
|------|----------|
| text | 原文 |
| number | 十进制字符串（排序时 `CAST` 数值） |
| date | ISO 8601（`2026-08-21`） |
| checkbox | `"true"` / `"false"` |
| select | 选项名（单个） |
| multi | JSON 数组 `["a","b"]` |
| tag | JSON 数组（标签名） |
| ref | 目标 page_id / block_id（前缀 `p:` / `b:`） |

> 用 `page_props` 的 `value` 统一存 TEXT，牺牲少量查询性能换「无 schema 迁移成本」；排序/过滤时按 type 解释。

### 3.4 内置属性与现有 `tags` 的关系

- **标签 = 内置属性**：`tags` / `page_tags` 表继续作为「标签」这一内置属性的物理存储，**不迁移**（避免破坏现有看板/标签面板/关系图）。
- 别名/备注等新内置属性，统一走 `page_props`（`attr_defs` 预置一条 `alias`、`memo` 定义）。
- 看板视图读取逻辑从「按标签」平滑升级为「按任意 select 属性分组」，标签仍是默认分组。

## 4. 属性类型（MVP 范围）

| 类型 | 说明 | 备注 |
|------|------|------|
| `text` | 单行文本 | 默认 |
| `number` | 数值 | 可排序 |
| `date` | 日期 | 日历选择 |
| `checkbox` | 布尔 | |
| `select` | 单选 | 颜色 tag 显示 |
| `multi` | 多选 | 颜色 tag 显示 |
| `tag` | 标签 | 与现有标签互通 |
| `ref` | 引用页面/块 | 可点击跳转 |

> `formula`（公式/汇总）留到 Phase 2。

## 5. 前端设计

### 5.1 属性面板（页面级，Obsidian 式）

- 位置：页面标题下方 / 侧栏，仿 Obsidian Properties 的键值行编辑器。
- 交互：`+ 添加属性` → 选择类型 → 输入值；支持删除、重命名（改 `attr_defs.name`）。
- 数据流：编辑即防抖保存（复用现有 `save_page` 或新增 `set_page_prop` 命令）。

### 5.2 数据库视图（思源式）

- 斜杠菜单 `/数据库`（或页面树「新建数据库」）→ 创建一个「数据库页面」。
- 数据库 = 一组页面（初始为空，可手动添加 / 按过滤规则自动收集）。
- 视图类型：
  - **表格（table）**：行 = 页面，列 = 属性，单元格内联编辑。
  - **看板（kanban）**：按某个 `select` 属性分列（现有 BoardView 的泛化）。
  - **画廊（gallery）**：卡片式（Phase 2）。
- 列管理：加列（选已有属性或新建）/ 删列 / 拖拽排序 / 列宽调整（复用表格交互）。

### 5.3 单元格编辑

- 文本：行内输入。
- select/multi/tag：点击弹出选项菜单（复用现有标签分类色）。
- date：日期选择器。
- checkbox：单击切换。
- ref：块选择器（复用 M2 的 `BlockSelectorPlugin`）+ 页面搜索。

## 6. 后端命令（新增）

| 命令 | 入参 | 出参 |
|------|------|------|
| `list_attr_defs` | — | `[{id,name,type,options}]` |
| `create_attr` | `{name,type,options?}` | 定义 |
| `rename_attr` / `delete_attr` | `id` / `{id,name}` | — |
| `set_page_prop` | `{page_id, attr_id, value}` | — |
| `get_page_props` | `page_id` | `[{attr_id,name,type,value}]` |
| `query_database` | `{attr_ids?, filter?, sort?, group_by?}` | 页面列表 + 属性值 |

> 新增 `src-tauri/src/properties.rs`，命令注册进 `lib.rs`；`attr_defs` / `page_props` 建表加入 `db.rs` 迁移。

## 7. 与现有功能的整合

| 现有 | 升级后 |
|------|--------|
| 标签面板 | 标签仍是内置属性，语义不变 |
| 看板 BoardView | 泛化为「数据库看板视图」，分组字段可选任意 `select` 属性 |
| 关系图 GraphView | 过滤/着色可改用任意 `select`/`tag` 属性（当前已支持标签） |
| 搜索 FTS | 增加属性过滤语法（如 `prop:状态=进行中`） |
| 命令面板 | 新增「新建数据库 / 打开属性面板」 |

## 8. 实施顺序（里程碑）

- **M1（属性系统底座）**：`attr_defs` / `page_props` 建表 + 迁移 + `properties.rs`（增删改查属性/值）+ 属性面板（页面级键值编辑）。验收：能给页面加「状态=进行中」并持久化。
- **M2（数据库表格视图）**：`query_database` + 表格视图（列=属性、单元格内联编辑、排序/过滤）。验收：一个数据库页能按属性列展示一组页面。
- **M3（数据库看板视图 + 看板泛化）**：现有 BoardView 泛化为数据库看板（分组字段可选）；画廊视图可选。验收：看板能按任意 select 属性分列。
- **M4（整合收尾）**：关系图按属性过滤/着色、搜索属性语法、命令面板入口。验收：跨视图属性语义一致。

## 9. 测试与验收标准

- [ ] 给页面添加/编辑/删除自定义属性后，重载仍保持。
- [ ] 属性类型正确渲染与校验（数字/日期/多选/复选框/引用）。
- [ ] 数据库表格能加列、删列、拖拽列、排序、过滤、单元格内联编辑。
- [ ] 看板能按任意 select 属性分列，且与旧「按标签分列」行为一致（回归）。
- [ ] 标签作为内置属性，在属性面板 / 看板 / 关系图中语义一致。
- [ ] 关系图能按属性过滤与着色。
- [ ] 同步 / 版本历史 / 回收站不受影响（属性随页面走，或作为派生数据重建）。

## 10. 风险与取舍

- **值统一存 TEXT**：查询需按 type 解释，复杂过滤（数值区间）需在 Rust 侧解析——MVP 够用，后续可加类型列优化。
- **属性名全局唯一**：便于跨数据库复用，但改名需级联——MVP 用 `attr_defs.name UNIQUE` + 重命名只改定义。
- **数据库页与普通页关系**：建议「数据库」是一种 `kind='database'` 的页面类型（复用 `pages.kind`），其「行」通过 `page_props` + 过滤规则动态收集，不引入独立的「数据库成员」表，降低复杂度。
