# 「薄 Agent 接口」AI 能力 — 实现方案

> 目标：把 [薄 Agent 接口方案](plans/2026-08-24-thin-agent-interface-plan.md) **落到可执行的代码**——给 ShuyoNote 加**可选、本地优先、安全、写操作经审核**的 AI 能力。实现不做全量 Agent 运行时，而是**复用现有前端插件宿主**（`src/plugins/registry.ts`）+ 暴露**语义化工具**（多为现有命令），配一个**受限于白名单工具**的轻量 LLM 循环。
> 前置：已完成 [薄 Agent 接口方案](plans/2026-08-24-thin-agent-interface-plan.md)（路线/取舍）。本方案专注"怎么在现有代码树上实现"。

---

## 1. 现状盘点（决定实现路径）

| 现状 | 对本实现的意义 |
|------|----------------|
| `src/lib/api.ts` 已有语义命令：`search` / `getPage` / `getPageBlocks` / `getBacklinks` / `listPageAttachments` / `createPage` / `savePage` / `saveImage` | 工具层可**直接复用**，零新增任意命令暴露。 |
| `src/plugins/registry.ts` 已有**前端命令插件宿主**（`PluginCommand` + `CommandContext{pages,currentId}`） | 天然宿主：AI 工具可作为**只读命令**注册，走命令面板，UI 无侵入。 |
| 无任何 LLM 接入代码（`blobStore` 只是注释含 "llm"） | 需**新增**一个轻量 LLM 适配器 + 设置存储。 |
| 无"AI 设置"持久化 | 需要 `ai_config` 存储 + 设置面板；建议复用 `meta`/workspace 设置或新增 `plugin_state` 式 KV。 |
| （Rust 侧）`save_page` / `create_page` / `search` 等语义命令已存在 | 写操作（建页/追加）走这些命令，天然受限。 |

> **关键决策**：AI 循环跑在**前端**（非 Rust 后端）。因工具全是前端可调的语义命令，且 LLM 请求走 `fetch`，前端实现即可；后端零改动（写仍走已有命令）。这符合"薄接口、不动存储层"。

## 2. 架构与数据流

```
命令面板 (Ctrl+K) / AI 助手面板
        │ 发起「AI 任务」
        ▼
┌───────────────────────────────┐
│  aiHost (src/lib/ai/host.ts)   │  ← 受限于 tools 白名单
│  · 组装 system prompt          │
│  · 循环: 调 LLM → 解析工具调用   │
│  · 只允许调用 aiTools 白名单     │
│  · 结果送「审核落库」            │
└──────────────┬────────────────┘
               │ 只调用以下工具
┌──────────────▼────────────────┐
│  aiTools (src/lib/ai/tools.ts) │  ← 语义工具定义 + 执行
│  search_pages   → api.search()  │
│  read_page      → api.getPage()  │
│  read_block     → api.getPageBlocks() │
│  get_backlinks  → api.getBacklinks()  │
│  list_files     → api.listPageAttachments() │
│  create_page    → api.createPage()   │ (写)
│  append_block   → (新增语义命令)      │ (写, 限当前页)
└──────────────┬────────────────┘
               │
        SQLite/记录（不变）
```

- **不暴露**：shell / bash / pwsh / 任意文件读写 / 任意网络。
- **写工具**（`create_page`/`append_block`）返回的是**草稿**，需用户点「确认」才真正 `savePage`/`createPage`——即"审核落库"。

## 3. 新增/改动文件清单

### 新增
| 文件 | 职责 |
|------|------|
| `src/lib/ai/types.ts` | `AiTool`（`{name, description, inputSchema?, run(args)=>promise<string|object>}`）、`AiMessage`、`AiToolCall`、`AiRunResult` 类型。 |
| `src/lib/ai/tools.ts` | 定义 `aiTools`：7 个语义工具（`search_pages`/`read_page`/`read_block`/`get_backlinks`/`list_files`/`create_page`/`append_block`）——每个 `run` 调用对应 `api.*`。 |
| `src/lib/ai/llm.ts` | **LLM 适配器**：`chat(messages, {baseUrl,model,apiKey,stream?})`，走 `fetch`。默认倾向本地 `http://localhost:11434/api/chat`（Ollama）；接口抽象便于接 OpenAI 兼容端点。 |
| `src/lib/ai/host.ts` | `runAiTask(tools, messages, {maxSteps})`：组装 system prompt（列出工具 + 限定「只读分析、写操作返回草稿」），循环解析工具调用，白名单校验，超步数/危险调用直接拒绝。 |
| `src/lib/ai/apply.ts` | `applyAiResult(plan)`：把「草稿写操作」转为可确认的 proposal（新建页/追加块），供 UI 预览。 |
| `src/store/ai.ts` | Zustand：`config`（enabled/model/baseUrl/apiKey）、`pending`（待确认草稿）、`running`、`history`；`run(query)` / `confirm()` / `discard()`。 |
| `src/components/AiAssistantPanel.tsx` | 侧边栏/命令面板的 AI 助手入口：输入 → 运行 → 展示只读结果/写草稿待确认。 |
| `src/components/AiSettingsDialog.tsx` | AI 设置：开关、模型地址/名、API Key；说明"默认本地、Off 不用"。 |

### 改动
| 文件 | 改动 |
|------|------|
| `src/plugins/registry.ts` | 新增 `registerPlugin({id:"ai", ...})`，加一条「AI 助手」命令（复用命令面板入口）；`CommandContext` 暂不扩，AI 用独立面板。 |
| `src/lib/api.ts` | 新增 `appendBlock(pageId, text)` 命令（Rust 侧加 `append_block`，见 §5）。 |
| `src/App.tsx` / 侧边栏 | 挂载 `AiAssistantPanel` 与 `AiSettingsDialog`（条件渲染，按 `ai.enabled`）。 |
| `src-tauri/src/commands.rs` + `lib.rs` | 新增 `append_block(pageId, text)` 命令（页尾追加一个文本块），走 `save_page` 同路径（保持事务/版本一致）。 |

> 说明：`append_block` 是唯一的**新后端命令**，且只允许"往指定页追加文本块"——不是任意 SQL/文件写入，符合"最小暴露面"。

## 4. 关键实现细节

### 4.1 工具白名单（`tools.ts`）
```ts
export const aiTools: AiTool[] = [
  { name: "search_pages", desc: "按关键词搜索页面", run: (a) => api.search(String(a.query||""), Number(a.limit||10)) },
  { name: "read_page",   desc: "读取页面正文", run: (a) => api.getPage(String(a.id)) },
  { name: "read_block",  desc: "读取页面块列表", run: (a) => api.getPageBlocks(String(a.pageId)) },
  { name: "get_backlinks", desc: "查引用该页的页面", run: (a) => api.getBacklinks(String(a.id)) },
  { name: "list_files",  desc: "列出页面/文件夹文件", run: (a) => api.listPageAttachments(String(a.pageId)) },
  { name: "create_page", desc: "新建页面（返回草稿，需确认）", run: (a) => ({ draft: true, title: a.title, content: a.content }) },
  { name: "append_block", desc: "向页面追加文本块（返回草稿，需确认）", run: (a) => ({ draft: true, pageId: a.pageId, text: a.text }) },
];
```
- **只读**工具直接执行返回；**写**工具返回 `{draft:true}` 草稿，不落库。
- 危险工具根本**不在列表**里（无 shell/文件/网络），从源头杜绝。

### 4.2 LLM 循环（`host.ts`）
- `fetch` 本地模型（默认 `http://localhost:11434/api/chat`，Ollama），或 OpenAI 兼容端点。
- system prompt 强调：**只用给定工具；只读分析；写操作只能返回 `create_page`/`append_block` 草稿**。
- 解析 `tool_calls`，**校验工具名 ∈ 白名单**，不在白名单 → 拒绝并把错误回给模型。
- 限制 `maxSteps`（如 8）防失控；超步即止。
- 全程**不向模型暴露**文件系统/网络/任意命令。

### 4.3 审核落库（`apply.ts` + `store/ai.ts`）
- `create_page`/`append_block` 草稿进入 `pending` 数组。
- 用户点「确认」→ 真正调 `api.createPage` / `api.appendBlock`；「丢弃」→ 仅清 pending。
- 这样 AI 的**写操作100%经用户**，不直接改库（符合方案 §6 红线）。

### 4.4 设置与隐私（`ai.ts` + `AiSettingsDialog`）
- `enabled` 默认 false；开启时提示"可能将笔记子集发送到你填写的模型端点"。
- `baseUrl`/`model`/`apiKey` 存 `src/store/ai.ts`（zustand，配 `persist`），或复用 workspace 设置。
- 命令面板/侧边栏入口仅在 `enabled` 时显示。

## 5. Rust 侧（`append_block`）

在 `commands.rs` 加：
```rust
#[tauri::command]
pub fn append_block(db: State<Db>, page_id: String, text: String) -> Result<(), String> {
    // 读当前页 content_json → 追加一个 paragraph 块（text）→ save_page 同路径
    // 保持事务/版本历史/块索引重建一致
}
```
`lib.rs` 注册 `append_block`。**只允许追加文本块**，不暴露任意内容改写。

## 6. 验收标准

- [ ] `aiTools` 只读工具逐个可用；写工具**不直接落库**（返回草稿）。
- [ ] LLM 循环只在白名单工具内运行，调未知工具即拒绝并有明确失败信息。
- [ ] AI 新建页/追加块经「确认」才落库；「丢弃」不落库；`enabled=false` 时无入口。
- [ ] 默认接本地模型；跨出网时设置面板有明确隐私提示。
- [ ] Rust `append_block` 保持与 `save_page` 一致（版本历史/块索引）。
- [ ] 现有 `scripts/smoke-web.mjs` 无回归；新增工具层/审核逻辑的断言。

## 7. 里程碑（对齐 [M17](roadmap.md)）

- **M17.0** 语义工具层：`src/lib/ai/{types,tools}` + `append_block`（后端）。
- **M17.1** LLM 适配器 + 宿主循环：`llm.ts` + `host.ts`（白名单 + 步数限制）。
- **M17.2** 审核落库 UI：`apply.ts` + `store/ai.ts` + `AiAssistantPanel`（只读结果 + 草稿确认）。
- **M17.3** 隐私开关 + 设置：`AiSettingsDialog`，默认关、出网提示。

## 8. 风险与取舍（诚实标注）

- **AI 价值有限（刻意）**：只做语义工具，不支持"AI 运维本地/调外部系统"。这是安全取舍，不是实现缺陷。
- **依赖本地模型**：若用户无本地模型，需接云端（出网 + 隐私提示）；工具描述已限定笔记子集。
- **LLM 幻觉**：只读分析结果标注"由 AI 生成，仅供参考"；写操作必经确认；不把 AI 输出当事实源。
- **前端循环性能**：多步工具调用在前端循环，长任务有 `maxSteps` 上限；无流式也可先做（后续优化）。
- **不动存储层**：本实现零改动存储核心，符合"薄接口"。

## 9. 结论

本方案把「薄 Agent 接口」落到现有代码树：**复用 `registry.ts` 插件宿主 + `api.*` 语义命令**，新增**白名单工具 + 前端 LLM 循环 + 审核落库**，唯一新后端命令是受限于“页尾追加文本块”的 `append_block`。这样拿到「AI 对笔记库多步语义操作」的核心价值，同时守住「IPC 最小暴露面 / 插件沙盒 / 本地优先 / 写操作经审核」的红线，工程量可控、不重构存储层。开工时按 M17.0 → M17.3 依次推进即可。
