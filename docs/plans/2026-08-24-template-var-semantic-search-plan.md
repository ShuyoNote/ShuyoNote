# 「模板变量 + 语义检索」方案（M20）

> 目标版本：v1.60.x（提议）。关联：[路线图 M20 里程碑](../roadmap.md)、[模板方案](./2026-08-22-template-plan.md)、[薄 Agent 方案](./2026-08-24-thin-agent-interface-plan.md)。
> 状态：**规划（建议）**。模板复用 + 搜索从「关键词」升级为「语义」。

## 1. 背景与目标

- **模板**：现有[模板中心](./2026-08-22-template-plan.md)支持"结构预设建页"，但保存的是固定内容——建页时想带上日期/当前页标题/选中文本只能手动改。
- **搜索**：现有全文检索是 **FTS5 + trigram 关键词匹配**（`search`）。想"找意思相近的"（例如搜"行动力"想命中"把想法落地"）做不到。
- 目标：① 模板支持**变量**自动填充；② 检索升级为**语义检索（向量/embedding）**，保留 FTS 兜底。

## 2. 目标体验

### M20.1 模板变量
- 模板正文/元数据支持 `{{date}}`、`{{title}}`、`{{selected}}`。
- 用模板建页时按当前上下文自动填充（`{{date}}`→今天、`{{title}}`→目标页标题、`{{selected}}`→选中文本）。

### M20.2 语义检索（embedding）
- 本地/云端 embedding 模型把页面正文向量化（`page_embeddings` 表 / 内存索引）。
- 搜索：先关键词 FTS 命中；再接"语义相近"（余弦相似度 top-k），结果给出相关度与命中片段。
- 保留 FTS 作兜底（无 embedding 模型时降级关键词）。

### M20.3 语义检索接入 AI
- 侧边栏 AI 的 `search_pages` 可用语义结果，"问知识库"能回答"意思相关"的内容。

## 3. 技术要点

- **embedding 提供方**：走 `src/lib/ai/llm.ts` 的 provider（Ollama embedding / OpenAI 兼容 `/embeddings`），复用 `config.enabled`（默认关）。
- **向量化时机**：页面保存时增量 embedding（`save_page` 钩子），失败可重试；空间/全库索引可重建。
- **相似度**：余弦；本地小库内存计算，全库大则落 `page_embeddings` SQLite 表。
- **模板填充**：模板解析宏（`{{...}}`）在建页命令处替换为上下文值。

## 4. 验收 / 里程碑

- [ ] `{{date}}/{{title}}/{{selected}}` 建页时自动填充
- [ ] 语义检索返回"意思相近"结果 + 命中片段；无模型时降级 FTS
- [ ] AI 问答可引用语义检索结果
- [ ] `scripts/smoke-web.mjs` 新增断言且原断言无回归；`tsc`/`vite build`/`cargo check` 通过

## 5. 相关文档

- [模板方案](./2026-08-22-template-plan.md)
- [薄 Agent 方案](./2026-08-24-thin-agent-interface-plan.md)
- [路线图 M20](../roadmap.md)
