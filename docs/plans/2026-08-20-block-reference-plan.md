# 块级引用 + 反链升级 实现方案

> 目标：把 ShuyoNote 的「块」升级为一等公民 —— 每个块拥有稳定 ID，可被 `((块ID))` 引用、可被 `{{块ID}}` 嵌入、反链从「页面级」细化到「块级」，并为关系图打基础。

## 1. 背景与现状

| 现状 | 问题 |
|------|------|
| 反链仅页面级：正文 `[[标题]]` 语法，`backlinks(source_id, target_id)` 表 | 只能知道「哪个页面引用了本页」，不知道「引用了哪一段」 |
| 块无稳定 ID：Lexical 节点 `__key` 每次加载都会重新生成 | 无法稳定引用/嵌入某个块 |
| 数据存 `content_json`（整篇 Lexical 文档） | 无法快速定位「某块属于哪页」 |

**目标产物**：
1. 每个顶层块有稳定 UUID（`blockId`），随文档持久化。
2. 块引用 `((blockId))`：点击跳转、悬停预览、反链精确到块。
3. 块嵌入 `{{blockId}}`：在别的页面实时镜像某块内容。
4. 反链面板：展示「页面 X · 块 Y → 引用了本页块 Z」，附内容片段。
5. 数据可支撑后续「关系图」。

## 2. 总体设计

```
┌─────────────────────────────────────────────────────────────┐
│ 编辑层 (Lexical)                                            │
│  每个顶层块节点带 blockId 字段 (UUID)                         │
│  引用 = 自定义内联节点 BlockRefNode                            │
│  嵌入 = 自定义块节点 BlockEmbedNode (decorator)               │
└──────────────────────────┬──────────────────────────────────┘
                           │ 保存: 遍历 root 子块 → 重建索引
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ 存储层 (SQLite)                                              │
│  pages(id, content_json, content_text, ...)                 │
│  blocks(block_id, page_id, ...)        # 块→页 索引          │
│  backlinks(... 升级为含 block 粒度)                           │
└──────────────────────────┬──────────────────────────────────┘
                           │ 引用解析: 正则扫描 ((id)) / {{id}} / [[标题]]
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ 反链面板 / 块跳转 / 块预览                                    │
└─────────────────────────────────────────────────────────────┘
```

## 3. 数据模型（SQLite）

### 3.1 新增 `blocks` 索引表

```sql
CREATE TABLE IF NOT EXISTS blocks (
  block_id    TEXT PRIMARY KEY,          -- 块 UUID
  page_id     TEXT NOT NULL REFERENCES pages(id),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_blocks_page ON blocks(page_id);
```

用途：`block_id → page_id` 反向定位（引用/嵌入/跳转时查「这个块在哪页」）。

### 3.2 升级 `backlinks` 表（块级粒度）

现有表：`backlinks(source_id, target_id)`（都是页面 id）。

升级为：

```sql
-- 迁移：旧表改名 → 新建 → 回填
ALTER TABLE backlinks RENAME TO backlinks_old;

CREATE TABLE backlinks (
  source_page_id  TEXT NOT NULL,
  source_block_id TEXT NOT NULL DEFAULT '',   -- '' = 页面级引用
  target_page_id  TEXT NOT NULL,
  target_block_id TEXT NOT NULL DEFAULT '',   -- '' = 页面级引用
  PRIMARY KEY (source_page_id, source_block_id, target_page_id, target_block_id)
);
CREATE INDEX IF NOT EXISTS idx_backlinks_target ON backlinks(target_page_id, target_block_id);

-- 回填旧数据：把页面级反链搬进来（block 列为空）
INSERT INTO backlinks (source_page_id, source_block_id, target_page_id, target_block_id)
SELECT source_id, '', target_id, '' FROM backlinks_old;
DROP TABLE backlinks_old;
```

语义：
- 页面级 `[[标题]]`：`source_block_id=''`、`target_block_id=''`。
- 块级 `((blockId))`：`source_block_id` = 引用发生的块，`target_block_id` = 被引用块。
- 块嵌入 `{{blockId}}`：同样记入反链（复用同一张表，加个 `kind` 字段区分？见下）。

> 为区分「引用」与「嵌入」，可加一列 `kind TEXT NOT NULL DEFAULT 'link'`（取值 `link` / `embed`）。若不想改表结构，也可仅用 `target_block_id` 判断块级、用 `source_block_id` 判断来源，暂不区分 link/embed。**本方案建议加 `kind` 列**，便于后续反链面板分组展示。

### 3.3 版本/同步联动

- 块 ID 在 `content_json` 内，随页面一起快照/同步，无需额外处理。
- `blocks` 索引表是「派生数据」，同步时**不参与** outbox（重建即可），与 `page_fts`、`backlinks` 同类。

## 4. 块 ID 分配（Lexical）

### 4.1 推荐方案：子类化核心块节点

ShuyoNote 已有自定义节点（CalloutNode/ImageNode/VideoNode），沿用同一模式，给**所有顶层块类型**加 `blockId` 字段：

需要子类化的节点：
- `ParagraphNode`、`HeadingNode`、`QuoteNode`
- `CodeNode`、`HorizontalRuleNode`
- `ListNode`（列表作为整体一个块）
- 现有 `CalloutNode`、`ImageNode`、`VideoNode`、`TableNode`（补加 `blockId`）

每个子类新增：
```ts
__blockId: string;                       // UUID
exportJSON() { return { ...super.exportJSON(), blockId: this.__blockId }; }
importJSON(json) { /* 恢复 blockId，缺省则新分配 */ }
createDOM/updateDOM 不变；
```

新建块时（`$createParagraphNode()` 等）自动分配 `blockId = uuid()`。

### 4.2 备选方案：JSON 后处理（更轻，但较 hacky）

不动节点类，在「保存」时把 `root.children[i].blockId` 注入 JSON（按 `getChildren()` 顺序与 JSON 顺序一一对应），「加载」时先剥离并缓存。缺点：块 ID 不是 Lexical 节点真实字段，容易在复制/粘贴/块移动时丢失。

> **结论：采用 4.1 子类化**（健壮、与现有自定义节点一致），一次性铺开。

### 4.3 块 ID 的维护

- 编辑器初始化：`parseEditorState` 后无需额外处理（importJSON 已恢复）。
- 块被复制/粘贴：复制时**重新分配**新 blockId（避免重复 ID）。用 `$cloneWithProperties` 后重写 `blockId`。
- 块被删除：无需立即清理（`blocks` 索引在下次保存时重建，自动剔除）。

## 5. 块引用与嵌入（编辑器层）

### 5.1 块引用 `((blockId))` —— 自定义内联节点 `BlockRefNode`

- 类型：内联节点（`TextNode` 子类，或 `DecoratorNode` inline）。
- 序列化：`{ type: 'blockref', blockId, text }`（`text` 为引用目标的展示文案，随目标块内容更新）。
- 渲染：显示为目标块标题/首行文本，带下划线样式（区别于普通文字），可 `:hover` 高亮。
- 交互：
  - 点击 → 跳转到目标块所在页并滚动定位（`openPage(targetPageId)` + 块级锚点）。
  - 悬停 → 弹出预览卡片（目标块内容片段，见 §8 后端预览接口）。
- 目标块被删除：渲染为「已失效引用」灰色样式。

### 5.2 块嵌入 `{{blockId}}` —— 自定义块节点 `BlockEmbedNode`

- 类型：块级装饰器（`DecoratorNode`，非 inline）。
- 渲染：实时镜像目标块内容（只读）。目标更新后，通过「引用目标缓存」刷新。
- 序列化：`{ type: 'blockembed', blockId }`（只存 ID，内容运行时取）。
- 交互：点击跳转到原块；顶部小字标注「嵌入自：页面名」。

### 5.3 斜杠菜单入口

- `/引用块` → 弹块选择器（搜索页面/块）→ 插入 `((blockId))`。
- `/嵌入块` → 同上 → 插入 `{{blockId}}`。

### 5.4 块选择器（前端组件）

- 输入关键词 → 搜索页面标题 + 块内容（复用 FTS）。
- 结果列表：块内容片段 + 所属页面。
- 选中 → 返回 `blockId`。

## 6. 引用解析与索引重建（后端）

### 6.1 解析规则（在 `save_page` / `sync apply` 时执行）

对 `content_json`（或 `content_text`）扫描三种语法：

| 语法 | 解析结果 |
|------|----------|
| `[[标题]]` | 页面级引用 → `target_page_id = 按标题解析`，`target_block_id=''` |
| `((blockId))` | 块级引用 → `target_block_id = blockId`，`target_page_id = blocks 表反查` |
| `{{blockId}}` | 块嵌入 → 同上，`kind='embed'` |

> 建议从**结构化 JSON**解析（遍历节点，遇到 `BlockRefNode`/`BlockEmbedNode`/文本 `[[...]]` 时提取），比纯文本正则更可靠（避免匹配到代码块内的 `[[`）。

### 6.2 重建流程（`rebuild_block_graph`）

```
save_page → 
  1. 遍历 root 顶层块 → upsert blocks(block_id, page_id)
  2. 遍历节点，收集所有引用 → 重建 backlinks
  3. 维护 block_refs 目标缓存（block_id → 展示文本）
```

新增 Rust 模块 `src-tauri/src/blocks.rs`，函数：
```rust
pub fn rebuild_block_graph(c: &Connection, page_id: &str, content_json: &str) -> Result<(), String>
pub fn resolve_block(c: &Connection, block_id: &str) -> Result<BlockInfo, String>  // block_id → (page_id, 片段)
pub fn list_block_backlinks(c: &Connection, block_id: &str) -> Result<Vec<BlockBacklink>, String>
```

## 7. 后端命令（commands.rs 新增）

| 命令 | 入参 | 出参 |
|------|------|------|
| `resolve_block` | `blockId` | `{ pageId, title, snippet, contentJson? }` |
| `search_blocks` | `query` | `[{ blockId, pageId, pageTitle, snippet }]` |
| `list_block_backlinks` | `blockId`（空=页面级） | 反链列表（含来源块片段） |
| `get_page_blocks` | `pageId` | 该页所有块 `[{ blockId, text }]`（供块选择器/跳转定位） |

> 这些命令都是只读查询，直接查 `blocks` / `backlinks` / `pages` 表。

## 8. 块跳转与预览

- **块跳转**：前端 `openPage(pageId, { focusBlockId })` —— 切页后编辑器内 `element.focus()` 并滚动到 `blockId` 对应 DOM。
  - DOM 定位：Lexical `editor.getElementByKey` 需要节点 key。给 `BlockRefNode` 跳转时，先用 `resolve_block` 拿到 pageId + 片段，切页后由编辑器「按 blockId 找节点 key」——为此给顶层块 DOM 加 `data-block-id` 属性（`createDOM` 里 `setAttribute('data-block-id', blockId)`），跳转时 `document.querySelector([data-block-id="..."])` 即可。
- **块预览**：悬停 `((blockId))` → `resolve_block(blockId)` 返回片段 → 弹卡片。

## 9. 反链面板升级（前端）

`BacklinksPanel` 当前只列页面。升级后分两组：

1. **页面反链**（现有）：`source_block_id=''` 的记录。
2. **块级反链**（新）：
   - 每条：`来源页标题 · 引用块片段` → `本页块片段`。
   - 点击来源 → 跳到来源页并定位到该块。
   - 点击目标 → 定位到本页被引用块。

数据来自 `list_block_backlinks(pageId)`（聚合该页所有块的入链）。

## 10. 关系图（Phase 2，可选）

- 数据已具备：`backlinks`（页/块粒度）+ `blocks` 索引。
- 前端用轻量图库（React Flow / Cytoscape.js）渲染：节点=页面/块，边=引用关系。
- 命令面板新增「关系图」视图。

## 11. 迁移与兼容

1. 首次启动迁移：
   - 新建 `blocks` 表。
   - `backlinks` 表升级（§3.2 的 rename → create → backfill → drop）。
2. 存量文档的块 ID 回填：**惰性回填** —— 第一次打开页面时，若顶层块缺 `blockId`，`importJSON` 自动分配并保存（无需一次性全库迁移）。
3. 兼容旧 `[[标题]]` 语法：不变，仍按页面级反链处理。

## 12. 实施顺序（里程碑）

- **M1（块身份）**：子类化块节点 + `blocks` 表 + 保存时重建索引。验收：每个块有稳定 ID，`get_page_blocks` 能列出。
- **M2（块引用）**：`BlockRefNode` + `((blockId))` 解析 + `resolve_block` + 点击跳转 + 悬停预览。验收：引用可跳转、反链记录块级入链。
- **M3（反链面板升级）**：`list_block_backlinks` + 面板分「页面/块」两组展示。验收：面板能看到「谁引用了本页哪块」。
- **M4（块嵌入）**：`BlockEmbedNode` + `{{blockId}}` + 只读镜像渲染。验收：嵌入块实时反映原块内容。
- **M5（关系图，可选）**：图视图。

## 13. 测试与验收标准

- [ ] 新建/编辑/保存后，块 ID 稳定不变（多次重载后 `((blockId))` 仍有效）。
- [ ] 复制粘贴块 → 新块 ID 不同，引用不串。
- [ ] `[[标题]]` 页面级反链行为与旧版一致（回归）。
- [ ] `((blockId))` 点击跳转、悬停预览、目标删除后显示「失效」。
- [ ] 反链面板正确分组，块级反链带内容片段。
- [ ] `{{blockId}}` 嵌入实时刷新，双向不互相污染（嵌入是只读镜像）。
- [ ] 全文搜索仍能搜到引用语法内的文本（FTS 索引 `content_text` 需包含引用目标展示文案）。
- [ ] 同步/版本历史/回收站不受影响（块 ID 随 `content_json` 走）。
