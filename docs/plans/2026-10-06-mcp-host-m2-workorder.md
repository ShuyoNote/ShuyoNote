# MCP 宿主 M2 施工单（把「写」接上，但**用户确认之前一个字都不许落库**）

> 状态：**W1 ＋ W2 ＋ W3 已落地；W4（免确认留痕）／W5（登记入账）未开工**（2026-10-06 windows 侧 ✓）。
> 证据：`../../capabilities/mcp-tools-write.json`（第 11 件生成物：写面 2 条 ✓）· `../../scripts/gen-capabilities.mjs`（`genMcpTools(reg, kind)` ✓）· `../../scripts/check-capabilities.mjs`（写面必须**正好等于**注册表 ✓）· `../../src-tauri/src/mcp_host.rs`（内嵌写面清单 ＋ `tools_list_json(include_write)` ＋ 判据 ✓）· `../../src-tauri/src/mcp_channel.rs`（`allow_write` 默认 false ✓）· `../../src/components/McpAccessPane.tsx`（开关 ✓）✓。
> 前置：**M1 已收口** ✓（读那条路通了：注册表生成物 ＋ 应用内宿主面 ＋ 哑桥 ＋ GUI 开关 ✓，
> 见 [M1 施工单](2026-09-28-mcp-host-m1-workorder.md)）；
> 前置拍板：**R87 ＝ A（免确认写**可以**开，但必须留痕 ✓）** —— owner 2026-09-29 裁定、2026-10-06 白话复核确认 ✓；
> R86/R89 ＝ A（通道＋开关）✓。
>
> **Goal：** 让外部 agent 能**新建页面 / 追加内容**，且：
> ① 默认**不落库**（用户的笔记在被确认之前**逐字节不变** ✓）；
> ② 免确认通道如果开着，**每一次写都必须留下审计行** ——「没有留痕的免确认写」**不算实现** ✗。
>
> **不变量**（规格 [`INV-MCP-write-requires-confirm`](../specs/2026-09-28-mcp-host-spec.md) 逐字口径）：
> *外部 agent 的写请求在用户确认之前不许落库（落库仍只在 `src/lib/ai/apply.ts` 一处；
> `--allow-write` 若开，必须是显式开关且每次写留审计）。*
> 本档不许改这条口径的字（改口径要回规格 ✓），也不许新开第二条落库路径 ✗。

---

## 0. 现成的机器**必须复用**（不许重造 ✗ —— 逐条都是 `file:line` 查出来的）

| 件 | 在哪 | 它已经保证什么 |
|---|---|---|
| 唯一落库处 | `src/lib/ai/apply.ts:1-3` | 「draft → confirm → commit」的边界**只有**这一处；注释原话：*applying a confirmed draft is the ONLY place a write reaches the semantic command layer* ✓ |
| 用户确认 | `src/lib/pluginDrafts.ts:19` | 先摊开"具体要做什么"（`summary` 由**后端**生成 ✓，不是插件随便写的文案 ✓）⇒ 点确定才落 ✓；**拒绝 ⇒ 什么都不写**（不是写一半 ✓） |
| 落库＋刷新 | `src/lib/applyDraftAndRefresh.ts:9` | AI 与插件**同一条**链路 ✓（刷新也只有一处 ✓） |
| 事件钩子那条入口 | `src/store/plugins.ts:579-583` | 有草稿就**必须**走 `confirmAndApplyDrafts` ✓（"用户当时没在看确认框"也要确认 ✓） |
| 命令那条入口 | `src/lib/pluginRun.ts:101` | 同上 ✓ |
| 写能力的**草稿拦截** | `src-tauri/src/plugins.rs:1936-1937`（`st.drafts.push(PluginDraft{key,summary,payload})` ✓）、`PluginDraft` 定义在 `:420` | `mediate == "draft"` 的能力被**收集**起来，而不是直接落库 ✓ |
| 两个写能力本体 | `src-tauri/src/plugins.rs:1946`（`cap_pages_create`）、`:1963`（`cap_blocks_append`） | 它们是**插件**那条直连路径的落点 ✓ —— ⚠️ M2 的宿主面**不许**直接调它们 ✗（Task W3 的变异就是这条 ✓） |
| 注册表口径 | `capabilities_gen::lookup("pages.create").mediate == "draft"`（由 `src-tauri/src/plugins.rs:7887` 断言 ✓） | 写能力的"要确认"是**注册表里写着的** ✓，不是宿主面自己记得 ✗ |

---

## 1. 任务地图

> **勾选口径**（同 M1 施工单 ✓）：**判据绿 且 那条判据的「看过它红」证据入了工作区账本**，才把 `[ ]` 改成 `[x]` ✓。

| 完成 | # | 任务 | 组 | 依赖 | 会红证据 |
|---|---|---|---|---|---|
| [x] | W1 | 生成物第 11 件：**写面**清单 `capabilities/mcp-tools-write.json` | contract | M1 | 手删一条写能力 ⇒ 红 |
| [x] | W2 | 免确认开关（显式、默认关）＋ `__tools_list` 只在允许时列写面 | contract / plugin | W1 | 开关关着却列出写工具 ⇒ 红 |
| [x] | W3 | ⭐ **草稿路**：外部写请求 ⇒ 进待确认队列（**库逐字节不变** ✓） | rust / plugin | W1 | 宿主面直连 `cap_page_create` ⇒ 红 |
| [ ] | W4 | ⭐ **免确认路**：开了才直落，且**每次写必须留审计行** | rust / plugin | W3 | 免确认写**不写审计** ⇒ 红 |

**W1／W2 的读数**（2026-10-06 实测 ✓）：

| # | 判据（现在绿 ✓） | 怎么红的 ✓ |
|---|---|---|
| W1 | `scripts/check-capabilities.mjs` ✓（`生成物 11 个文件` ✓） | ① 从写面清单删一条 ⇒ `✗ M2 写面缺 1 条（…应为 2 条）：blocks.append` ✓；② 把读能力塞进写面 ⇒ `✗ M2 写面多了 1 条：pages.get` ✓；两次都 `gen-capabilities` 还原 ⇒ exit 0 ✓。**读面清单字节不变** ✓（`git diff` 空 ✓ —— M1 的硬判据没被搅动 ✓） |
| W2 | `src-tauri/src/mcp_host.rs` 的 `tools_list_tests`（真跑 ✓ 3/3 ✓）＋ `check-web-commands` ✓（`Rust 271 个命令 … CommandMap 272` ✓） | 把 `tools_list_json` 里的过滤改成 `if false`（＝永远带写面）⇒ **判据红** ✓，逐字 `开关关着时清单里出现了写工具 pages_create ✗ —— 「面 = 此刻真能调的能力」（M1 在 coverage.report 上踩过 ✓）` ✓；还原 ⇒ 0 ✓ |
| W3 | `src-tauri/src/mcp_host.rs` 的 `w3_draft_tests::external_write_is_drafted_not_landed`（真跑 ✓ 1/1 ✓） | ① 让 `with_fresh_drafts` **把草稿丢掉**（不回交）⇒ 判据红，逐字 `草稿必须交出去一次（拿到 0 条）✗` ✓；② 在外部调用里**偷偷写一个库文件**（`spaces/mut.db`）⇒ 判据红，逐字 `外部写请求在用户确认之前**不许落库** ✗：数据目录变了` ✓；两次还原 ⇒ 0 ✓ |

| [ ] | W5 | 登记（`gates.mjs` ＋ `docs/TESTING.md`）＋ 工作区账本证据 ＋ 设置面板文案 | — | W1–W4 | 缺证据 ⇒ 工作区 `check-all` 红 |

---

### Task W1: 写面清单（**生成物**，不是手写的第二份 ✗）

**Files:** Modify `scripts/gen-capabilities.mjs`（`OUTPUTS` ＋ 生成函数 ✓）；Create（生成物）`capabilities/mcp-tools-write.json`；
Test `scripts/check-capabilities.mjs`（加两条断言 ✓）。

**Step 1 · 先写判据（让它红）**
`check-capabilities.mjs` 里加：
* 写面清单必须**正好等于**注册表里 `ai: true && kind === "write" && host !== "frontend"` 的那几条（今天＝`pages.create`、`blocks.append` ✓）；
* 写面清单**不许**混进 `kind === "read"` 的（那条读面清单已经管着 ✓，这里是反方向 ✓）。

**Step 2 · 跑它，确认红**（生成物还不存在 ⇒ 逐字"[存在性] 写面清单不在" ✓）。

**Step 3 · 生成**（复用 M1 的 `genMcpTools`：同一套 `name`／`capabilityId`／`inputSchema`／`permission` 口径 ✓，
`kind` 标 `write` ✓；⛔ 读面清单 `capabilities/mcp-tools.json` **一个字都不许动** ✗ —— M1 的
`INV-MCP-readonly-first`（"清单里 0 条写能力"）是**硬判据** ✓）。

**Step 4 · 跑通** ⇒ 两条清单都在、各自完整 ✓。
**变异（会红证据）**：从写面清单里手删一条 ⇒ 红 ✓（`check-capabilities` 的"完整等于注册表"那条 ✓）。

---

### Task W2: 免确认开关（**显式**、默认关 ✓）＋ 列清单时按它过滤

**Files:** `src-tauri/src/mcp_channel.rs`（`FileConfig` 加 `allow_write: bool`，默认 `false` ✓ ＋ `McpStatus` 读数 ✓）；
`src-tauri/src/mcp_channel.rs` 的 `__tools_list` 应答（把写面拼上去 **仅当** `allow_write` ✓）；
`src/components/McpAccessPane.tsx`（开关 ＋ 说清后果 ✓）＋ i18n ✓。

**口径（三条，都要写进界面 ✓）**：
* 默认**关** ✓；
* 关着时：外部 agent **看不到**写工具 ✓（不是"看得到但一调就拒" ✗ —— 那正是 M1 修过的
  "面里有个用不了的工具" ✗）；
* 开着时：**每一次写都留审计** ✓（W4 判据 ✓），且面板上有一句"这笔风险由你承担" ✓。

**变异**：把过滤去掉（开关关着也列写工具）⇒ 红 ✓（判据：`__tools_list` 的输出必须 ⊆ 当时真能调的能力 ✓）。

---

### Task W3: ⭐ 草稿路 —— 外部写请求**默认不落库**

**Files:** `src-tauri/src/mcp_host.rs`（对 `mediate == "draft"` 的能力走**收集**而不是直落 ✓）；
`src-tauri/src/mcp_channel.rs`（把待确认项回给桥 ✓）；前端一处监听（把待确认项交给
`confirmAndApplyDrafts` ✓）；Test：Rust 判据 ＋ Node 判据。

**Step 1 · 先写判据（让它红）**——判据要照规格**逐字**那条口径来：
> **外部写请求在用户确认之前不许落库 ⇒ 库文件逐字节不变 ✓。**

做法（**真读数**，不是读源码猜 ✗）：起一个**隔离的数据目录**（仓内已有 `db::ensure_test_app_data_dir()` ✓，
见 `src-tauri/src/db.rs:41`），记下全部 `.db` 文件的 sha256 ⇒ 通过宿主面发一次 `pages.create` ⇒
**再算一遍 sha256 ⇒ 必须完全相同** ✓，且返回值里必须**明说**"已放进待确认" ✓。

**Step 2 · 最小实现**：复用 `plugins.rs:1936` 那套草稿收集 ✓（同一形状 `PluginDraft{key,summary,payload}` ✓
—— ⛔ 不新造第二种草稿格式 ✗），把草稿回给调用方 ＋ 推一个事件给前端（照 `email` poller 那条
"Rust 推事件给前端"的路子 ✓），前端收到就走 `confirmAndApplyDrafts` ✓。

**变异（会红证据）**：把宿主面的 `pages.create` 直接接到 `cap_page_create`（`plugins.rs:1946` ✓）
⇒ **库 sha256 变了** ⇒ 红 ✓ —— 这就是施工单 Task W 要求的"绕草稿落库 ⇒ 红" ✓（逐字口径在规格 §2 ✓）。

---


> **2026-10-06 实测补充**：`cap_pages_create` / `cap_blocks_append` **本来就只产出草稿、不落库** ✓
> （`cap_pages_create` 头注逐字：「`pages.create`：**不建页**，只产出草稿」✓）；真正缺的是——草稿塞进**线程局**的
> `RUN_STATE` 而**外部那条路没人取** ⇒ 被**静默丢掉** ✗。修法是 `plugins::with_fresh_drafts`（这一次调用开一份干净状态、
> 跑完把草稿交出来 ✓）＋ `mcp_host` 的**草稿出口**（App 启动时装成 Tauri `emit("mcp:external-drafts")` ✓；判据里换成自己的出口 ✓）。
> ⛔ 宿主面**依然不建页** ✗：落库只有 `src/lib/ai/apply.ts` 一处 ✓（免确认那条路也一样，只是前端不再弹确认框 ✓ —— Task W4 ✓）。

### Task W4: ⭐ 免确认路 —— 开了才直落，且**每次写必须留痕**

**Files:** `src-tauri/src/mcp_host.rs`（`allow_write` 为真时才直落 ✓；无论成败都 `push_audit` ✓）；
判据里加**反向断言**：审计账本里必须能找出这一笔 ✓。

**判据（两条，缺一不算实现 ✓）**：
1. `allow_write = true` 时：写**真的落库**了（库 sha256 变了 ✓）**且**审计里**有**这一笔 ✓；
2. 「没有留痕的免确认写」⇒ **红** ✓ —— 变异：把 `push_audit` 那一行去掉 ⇒ 判据必须红 ✓
   （**这条就是 R87 那句"没有留痕的免确认写不算实现"的机械形态** ✓）。

**审计行的口径**（沿用现成的，不新增字段 ✗）：`plugin_id: "external"` ＋ `source: "external:mcp-<会话号>"`
＋ `capability` ＋ `scope` ＋ `ok` ＋ `error_code` ✓（真机已经见过这种行 ✓；
⚠️ 待确认那一笔的 `error_code` 用 `awaiting_confirm` ✓ —— 它**没落库**，如实记 `ok: false` ✓，
⛔ 不许为了让账本好看而记成成功 ✗）。

---

### Task W5: 登记 ＋ 账本证据 ＋ 面板文案

* `scripts/lib/gates.mjs`：新判据登记（`incident` 必填 ✓，写清它挡的是哪一次真事故 ✓）＋
  有 `baseline: true` 就必须同时有 `counters` ✓（M1 那次漏了、被 `scripts/test-report.test.mjs` 当场抓到 ✓）；
* `docs/TESTING.md`：加行 ＋ 「机器事实」块按门禁算出来的数字改 ✓（它会自己打印"算出来是" ✓）；
* 工作区账本 `_workspace/mutation-evidence.json`：每条新判据写 `control`（控制组绿 ✓）＋ 变异读数 ＋
  逐字判语 ✓（口径同 M1 ✓）；
* 设置面板那一节补三句话：默认不落库／确认在哪里点／免确认的风险与留痕 ✓。

---

## 2. 我不打算做的事（照实 ✗）

* ⛔ 不改 `src/lib/ai/apply.ts` 的落库口径（它是唯一的落点 ✓）；
* ⛔ 不给 MCP 单开一条"能落库"的 Rust 路径（Task W3 的变异就是钉这个 ✗）；
* ⛔ 不动插件的权限模型／`capabilities.json` 的 `mediate` 语义（写能力"要确认"注册表里早写着 ✓）；
* ⛔ 不在"免确认"上做默认开 ✗（默认关 ✓，R87 的原话是"可以开"，不是"默认开" ✓）。

## 3. 待 owner 拍板（⚠️ 只有一条，且**不挡开工**）

* **版本号**：M1 的一整套（读 ＋ 开关）与 M2（写）可以合进**同一个版本**发 ✓；
  发版前需要你点名 `1.91.32` 还是 `1.92` ✓（M1 已完成、M2 待做）。
