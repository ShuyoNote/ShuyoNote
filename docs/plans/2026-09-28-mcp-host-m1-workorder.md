# MCP 宿主 M1 施工单（先把「读」打通）—— 注册表第 10 件生成物 ＋ 应用内宿主面 ＋ stdio 桥

> 状态：⭐ **M1 已开工**（2026-09-30 windows 侧更正 —— 见下）
> · **Task 1 ＋ Task 2 已完成** ✓：生成物第 10 件 `capabilities/mcp-tools.json`（只读 8 条 ✓）＋
>   反向断言「M1 清单里不许出现写能力」（含"塞 `pages.create` ⇒ 红"与"空清单 ⇒ 拒绝给绿"两条自证 ✓）；
>   ⚠️ 两笔都在**分支** `feat/mcp-tools-generated` 上 ✓（`47b1c493`／`c1d371f7`），**尚未推** ✗（产品仓 push 要 owner 点头 ✓）。
> · **Task 3** 在 AMD 的分支 `feat/mcp-bridge-stdout-gate` 上有半件 ✓（本行不替它记账 ✗）；Task 4–7 未开工 ✗。
> · ⚠️ **原文那句「前置 = 总方案 §10 第 1、2 项拍板」已过期** ✗：那几项**早已拍板并收口** ✓
>   （台账 `R85` 补录立项 ✓／`R86` 通道形态 ⇒ **A 回环 TCP＋token** ✓／`R87` 免确认写 ⇒ A 开且必须留痕 ✓／
>   `R89` GUI 开关 ⇒ 必须有 ✓；另 §10⑥ 桥语言 ⇒ **A Node** ✓）⇒ ⇒ **"等拍板"这个前置已经满足** ✓，
>   别再从这一行读成"卡在 owner 那里" ✗（本行为 2026-09-30 更正 ✓）。
> 范围：**本档只做只读** —— 它是「**能读写**」的**前半**；⚠️ **写属 M2 且必做**，不是被排除（目标口径见[总方案](2026-09-28-agent-mcp-integration-plan.md) §1）。不做多空间切换（M3）、**不碰**服务端、不改 wire / schema / 插件契约。
>
> **Goal：** 让四个外部 agent 产品（Claude Code / CodeBuddy / WorkBuddy / DSH）经 **stdio MCP** 读到本机已解锁空间的笔记，且**不新开第二条鉴权、不新造第二份工具清单**。
> **Architecture：** 生成物（注册表 → MCP 工具清单）＋ 应用内宿主面（`src-tauri/src/mcp_host.rs`，逐次调 `dispatch_capability`）＋ 哑桥（`tools/shuyonote-mcp/`，只转发 MCP ⇄ 本机通道）。
> **Tech Stack：** Node（生成物与桥、判据可在本机跑）· Rust/Tauri（宿主面，判据以 WSL2/CI 为准）。
> **执行方式（借 Superpowers `executing-plans`）：** **每批 3 个任务**，一批跑完就报读数并**等反馈**；批内严格按 Step 1→5 走。

---

## 0. 怎么读这份单

**与 Superpowers / OpenSpec 的对应**（逐条，不要当类比）：本单 = Superpowers `writing-plans`（`### Task N` + Files + Step 1–5）＋ OpenSpec `tasks.md` 的**可勾选任务清单**。**先立判据、后改代码**的顺序来自[规格](../specs/2026-09-28-mcp-host-spec.md) §3。

⚠️ **两条不许混的口径**（混了就会把"绿过"当成"验过"）：

1. **TDD 的「红」≠ 变异证据的「红」**。Step 2 的红是"目标还不存在"，只证明**判据能跑**；工作区台账要求的「看过它红」是**控制组 exit 0 ＋ 变异组 exit 1/2/3 的差集**（Task 7 才做）。
2. **判据的真相源是 [`scripts/lib/gates.mjs`](../../scripts/lib/gates.mjs)**，不是这份文档。本文写的是"要立哪条、怎么弄红"，**口径永远回注册表读**。

---

## 1. 任务地图

> **勾选口径（借 OpenSpec `tasks.md` 的那一半）**：**判据绿 **且** 那条判据的「看过它红」证据入了工作区账本**，才把下面的 `[ ]` 改成 `[x]`。⚠️ 进度**不许靠人记**（这是 `tasks.md` 与"散文式施工单"的唯一区别）。

| 完成 | # | 任务 | 组 | 依赖 | 会红证据 |
|---|---|---|---|---|---|
| [ ] | 1 | 生成物第 10 件 `capabilities/mcp-tools.json` | contract | — | 手改生成物一行 ⇒ 红 |
| [ ] | 2 | 反向断言：M1 清单里不许有写能力 | contract | 1 | 塞 `pages.create` ⇒ 红 |
| [ ] | 3 | 桥的 stdout **协议纯净**判据（Node，判据先行） | plugin | — | 插一句 `console.log` ⇒ 红 |
| [ ] | 4 | 通道鉴权（token + `Origin`/`Host` + 默认关） | plugin / rust | **拍板项 2** | 删 `Origin` 校验 ⇒ 红 |
| [ ] | 5 | 宿主面 `mcp_host.rs` ＋ 权限判定抽成一处 | rust | 1 | 自建权限判定 ⇒ 红 |
| [ ] | 6 | 注册与生命周期（`lib.rs`） | rust | 5 | 关开关后旧 token 仍可连 ⇒ 红 |
| [ ] | 7 | 门禁三处登记 ＋ 账本证据（D2，**不在本仓**） | — | 1–6 | 缺证据 ⇒ 工作区 `check-all` 红 |
| [ ] | W | （**M2 预留**）写能力 ＋ `INV-MCP-write-requires-confirm` | — | M1 | 绕草稿落库 ⇒ 红 |

---

### Task 1: 生成物第 10 件 —— `capabilities/mcp-tools.json`

**Files:**
- Modify: `scripts/gen-capabilities.mjs:28`（`OUTPUTS`）、`:1070`（`reg.capabilities.filter((c) => c.ai)` 那一支的近邻）、`:1135-1143`（文件映射表）
- Create（**生成物，不许手改**）: `capabilities/mcp-tools.json`
- Test: `scripts/check-capabilities.mjs`（本任务只跑它，不改）

**Step 1 · 先写判据（让它红）**
在 `OUTPUTS` 加 `mcpTools: "capabilities/mcp-tools.json"`，**先不生成**。

**Step 2 · 跑它，确认红**
Run: `node scripts/check-capabilities.mjs`
Expected: **exit 1**，逐字含 `生成物与 capabilities/capabilities.json 不一致`（`check-capabilities.mjs:137` 那句）。

**Step 3 · 最小实现**
加 `genMcpTools(reg)`：只取 `ai: true` **且 `kind === "read"`**；每条产 `{ name, capabilityId, description, inputSchema, permission }`，其中
- `capabilityId` = 注册表 id（如 `pages.get`）—— **桥回传时用它**；
- `name` = id 里的 `.` 换成 `_`（如 `pages_get`）—— MCP 工具名不许带点；⚠️ DSH 侧会把不合规字符换掉**并追加 12 位哈希**，所以**别在任何提示词里写死工具名**。

**Step 4 · 跑通**
Run: `node scripts/gen-capabilities.mjs && node scripts/check-capabilities.mjs`
Expected: **exit 0**；生成器逐行打印 `✓ <路径>`，以 `能力注册表已生成：10 个文件` 收尾 —— ⚠️ **2026-09-28 本机实测今天是 9 个**（逐字读数：`能力注册表已生成：9 个文件`，且**不弄脏工作树**）；本任务后应为 **10**。校验器应打印 `能力注册表一致：25 条能力 … 生成物 10 个文件；TS 适配器 10 个 …`。

**Step 5 · 提交**
`git add capabilities/mcp-tools.json scripts/gen-capabilities.mjs`
`git commit -m "feat(capabilities): 生成 MCP 工具清单 —— 注册表第 10 件产物（只读 8 条）"`

---

> ⚠️ **2026-09-28 windows 侧评审补（Task 1 内的一句断言）**：上文「DSH 侧会把不合规字符换掉**并追加 12 位哈希**」
> 是**关于外部系统的硬断言** ✓ ⇒ 建议**附上当时的读数**，或明确标"**未复核**" ✓
> （本工作区有 `notes/2026-09-27-dsh-skill-discovery.md` 可引；⚠️ 但若那条读数讲的**不是工具名** ⇒ 请标"未复核"，
>  别让它读起来像已核实 ✗。判据：**外部系统的断言要么有读数、要么标未复核** ✓）

### Task 2: 反向断言 —— M1 清单里不许有写能力

**Files:**
- Modify: `scripts/check-capabilities.mjs:124-137`（生成物一致那一段之后）
- Test: 同文件（这条判据本身就是它）

**Step 1 · 先写判据（让它红）**
读 `capabilities/mcp-tools.json`，断言**没有任何一条的注册表 `kind` 是 `write`**；并断言清单**非空**（⚠️ 见 §2 边界：**扫到 0 条时必须拒绝给绿**，这是本工作区 `AI-NATIVE-DEV.md` §12.2 那一族）。

**Step 2 · 跑它，确认红**
Run: `node scripts/check-capabilities.mjs`
Expected: **exit 1**（此刻判据还不存在 ⇒ 必然红；红在哪一行要能看出来）。

**Step 3 · 最小实现**
把断言写成与既有风格一致的 `fail(...)`；**并补一条自证**：把 `pages.create` 塞进清单时它必须报红（这条自证放 `--self-test`，或由 Task 7 的变异证据承担）。

**Step 4 · 跑通**
Run: `node scripts/check-capabilities.mjs`
Expected: **exit 0**，汇总行形如 `能力注册表一致：25 条能力 / 12 项权限 / …；另有 4 个默认值是非字面量读法，未自动比对（请人工看一眼）` —— ⚠️ 末句是**如实边界**，**不要**顺手删掉。

**Step 5 · 提交**
`git commit -m "test(capabilities): M1 的 MCP 清单里不许出现写能力（反向断言）"`

---

### Task 3: 桥的 stdout **协议纯净**（Node，判据先行）

**Files:**
- Create: `tools/shuyonote-mcp/judge-protocol.mjs`（判据；**先写它**）
- Create: `tools/shuyonote-mcp/index.mjs`（桥本体，Step 3 才写）
- Test: 同 `judge-protocol.mjs`

**Step 1 · 先写判据（让它红）**
判据做三件事：① 起桥子进程，喂 `initialize` / `tools/list` / `tools/call` 三条，**逐行**尝试 `JSON.parse`；② 断言 stdout 里**没有**非协议行；③ 断言 **stderr 可以有内容**（日志归 stderr）。
⚠️ **空扫必须拒绝给绿**：桥文件不存在 ⇒ 判据 **exit 2**（"环境不具备"），**不许 exit 0**。

**Step 2 · 跑它，确认红**
Run: `node tools/shuyonote-mcp/judge-protocol.mjs`
Expected: **exit 2**，逐字含"桥不存在 / 无可检查对象"——**不是 0**。

**Step 3 · 最小实现**
`index.mjs`：手写行分隔 JSON-RPC（`initialize` → `notifications/initialized` → `tools/list` → `tools/call`）；**版本协商**：server 支持请求里的 `protocolVersion` 就回同一个，否则回自己支持的一个；**stdout 只许协议消息**，任何日志走 `stderr`。

**Step 4 · 跑通**
Run: `node tools/shuyonote-mcp/judge-protocol.mjs`
Expected: **exit 0**，且断言行数 ≥ 3（三条请求都答了）。

**Step 5 · 提交**
`git commit -m "feat(mcp): stdio 桥的协议面 —— 行分隔 JSON-RPC，stdout 只出协议消息"`

---

### Task 4: 通道鉴权（token ＋ `Origin`/`Host` ＋ 默认关）

> ⚠️ **依赖拍板项 2**（回环 TCP vs 命名管道）。选命名管道 ⇒ 本任务的 ② 换成"管道 ACL 只有当前用户"，其余不变。

**Files:**
- Create: `tools/shuyonote-mcp/judge-channel.mjs`（判据；**先写**）
- Modify: `tools/shuyonote-mcp/index.mjs`（连接那一层）
- Test: 同 `judge-channel.mjs`

**Step 1 · 先写判据（让它红）**
四条：① **默认关**时连接必须被拒；② 坏 `Origin`（例如 `http://127.0.0.1.evil.com`）必须被拒 —— 这条直接对着本仓已知问题 `docs/SECURITY.md:117` 写；③ 过期/错误 token 必须被拒；④ 关掉开关后**旧 token 立刻**失效。
同样**空扫 ⇒ exit 2**。

**Step 2 · 跑它，确认红**
Run: `node tools/shuyonote-mcp/judge-channel.mjs`
Expected: **exit 2 或 exit 1**（桥还没有通道 ⇒ 不许是 0）。

**Step 3 · 最小实现**
token 落在一个**只有当前用户可读**的文件里；连接时校验 token ＋ `Host`/`Origin` 白名单（只认回环）；开关默认 **off**。

**Step 4 · 跑通**
Run: `node tools/shuyonote-mcp/judge-channel.mjs`
Expected: **exit 0**，四条断言逐一 pass。

**Step 5 · 提交**
`git commit -m "feat(mcp): 桥的本机通道 —— 默认关 + token + Origin/Host 校验"`

---

### Task 5: 宿主面 `mcp_host.rs` ＋ 权限判定抽成一处（Rust）

**Files:**
- Create: `src-tauri/src/mcp_host.rs`
- Modify: `src-tauri/src/plugins.rs:2039`（`dispatch_capability` —— **把权限判定抽成一处**）、`:312`/`:316`（`RUN_STATE` / `RunState`）、`:1385`（`map_open_error`）、`:1400`（`with_read_conn`）、`:491`（`push_audit`）
- Create: `scripts/check-mcp-host-authz.mjs`（**静态判据，本机可跑**）
- Test: `src-tauri/src/mcp_host.rs` 的 `#[cfg(test)]`

**Step 1 · 先写静态判据（让它红）**
`check-mcp-host-authz.mjs` 扫 `src-tauri/src/mcp_host.rs`：出现**自建权限判定**、**直接 `db::open_space_conn*`**、或**直连 SQLCipher** ⇒ 红。**文件不存在 ⇒ exit 2**（不是 0）。

**Step 2 · 跑它，确认红**
Run: `node scripts/check-mcp-host-authz.mjs`
Expected: **exit 2**（宿主面还不存在）。

**Step 3 · 最小实现**
① `plugins.rs`：把"能力 id + 一份 permissions ⇒ `Result<(), ErrCode>`"抽成**纯函数**，插件路径与外部宿主路径共用；**逐字保持** `permission_denied` / `unknown_capability` / `bad_args` 三者的语义（`:2052`、`:2060-2062`、`:2157`）。
② `mcp_host.rs`：长度前缀 JSON 帧（形状照 `plugin_host.rs:434` / `:447`，**不新造协议**）＋ 逐次调 `dispatch_capability` ＋ 写审计（`:491`）。

**Step 4 · 跑通（**分两处**，不许在本机假装）**
Run（本机可跑）: `node scripts/check-mcp-host-authz.mjs` → Expected **exit 0**
Run（⚠️ **只能在 WSL2 / CI**）: `cargo test`（含插件的 34 条 `plugins::`）
Expected: `failed === 0`；**本机 Windows 跑不了 rust 组**（`AGENTS.md` §7：测试 exe 缺 v6 清单）⇒ 本机只能说"未实查"，**不许说通过**。

**Step 5 · 提交**
`git commit -m "feat(mcp): 应用内宿主面 —— 复用唯一权限校验点，不新开第二条鉴权"`

---

### Task 6: 注册与生命周期（`lib.rs`）

**Files:**
- Modify: `src-tauri/src/lib.rs:203`（`--plugin-host` 分流**之后**登记；⚠️ 与它相反，**这一条要在 Tauri 起来之后**）、`:524`（`invoke_handler` 一带）
- Modify（若新增了 Rust 命令）: `src/lib/platform/commands.ts:445`（`CommandMap`）
- Test: `node scripts/check-web-commands.mjs`

**Step 1 · 先写判据（让它红）**
Run: `node scripts/check-web-commands.mjs`
Expected: 新增命令只改了 `lib.rs` 而没改 `CommandMap` ⇒ **exit 1**（逐字含"Web 平台缺失 N 个桌面命令"）。

**Step 2 · 跑它，确认红** ← 同上，先跑一次留读数

**Step 3 · 最小实现**
登记开关与生命周期：关闭 ⇒ 通道监听停、**已发 token 立即作废**。

**Step 4 · 跑通**
Run: `node scripts/check-web-commands.mjs` → **exit 0**
Run（WSL2/CI）: `cargo test` → `failed === 0`

**Step 5 · 提交**
`git commit -m "feat(mcp): 外部接入开关与生命周期 —— 关掉即失效"`

---

### Task 7: 门禁三处登记 ＋ 账本证据（**第三条不在本仓**）

**Files:**
- Modify: `scripts/lib/gates.mjs:21`（`GATES` 数组；新条目 **必须带 `incident`**）、`:523`（`GROUP_ORDER`，**纯 Node 的进 `contract`/`plugin`；`DEFAULT_GROUPS` 只许纯 Node**）
- Modify: `docs/TESTING.md`（门禁表；`check-doc-facts` 判据 A 要求每条门禁在表里出现一次）
- Modify（⚠️ **不在本仓**）: `C:\Users\cnzen\zhai\_workspace\mutation-evidence.json` 的 `_repo_mutations`

**Step 1 · 登记**
三条判据（Task 2 / 3 / 5）各自进 `GATES`；写 `incident`（挡的是哪次事故）。

**Step 2 · 跑一致性，确认它挡得住**
Run: `node scripts/check-doc-facts.mjs` → 表格漏写 ⇒ **exit 1**
Run: `node scripts/test-report.mjs --only <新 id>` → 逐条能跑

**Step 3 · 做变异证据（控制组 ＋ 变异组）**
每条判据：**控制组**（干净树 ⇒ exit 0）＋ **变异组**（注入 ⇒ exit 1/2/3，**期望退出码非 0**）＋ **逐字判语**，写进 `_repo_mutations`（按脚本 sha 绑定）。

**Step 4 · 跑全量**
Run: `node scripts/test-report.mjs` 与 `node C:\Users\cnzen\zhai\_workspace\bin\check-all.mjs`
Expected: 两者 **exit 0**；`check-all` 的 gate-manifest 不再报"仓内门禁缺证据"。

**Step 5 · 提交**
`git commit -m "chore(gates): 登记 MCP 三条判据 + 补变异证据（含工作区台账）"`

---

### Task W（**M2 预留**，本档不做）：写能力 ＋ `INV-MCP-write-requires-confirm`

`pages.create` / `blocks.append` 进清单；判据＝**外部写请求在用户确认之前不许落库**（`src/lib/ai/apply.ts:1-3,16`）—— 库逐字节不变。**变异**：把宿主面的写能力直接接到 `create_page` ⇒ 红。⚠️ 这条**不在 M1**：读那一档里写能力根本不在清单上，无从验起（[规格](../specs/2026-09-28-mcp-host-spec.md) §3 第 3 步）。

---

## 2. 本机边界（不许假装通过）

- **rust 组本机跑不了**：`cargo test` 的测试 exe 没有应用清单 ⇒ `0xC0000139`；`plugins::` 那 34 条要真宿主进程（`AGENTS.md` §7）。⇒ Task 5 / 6 的**行为判据以 WSL2 / CI 为准**，本机只能跑静态那条并**如实标注"未实查"**。
- **每条"扫目录/扫文件"的判据都要回答"扫到 0 个时它说什么"**：本题一律 **exit 2**，**绝不给绿**（`AI-NATIVE-DEV.md` §12.2 那一族）。

## 3. 风险与回滚

| 风险 | 处置 |
|---|---|
| 权限判定重构动了插件路径 | 与现有插件判据**成对跑**；错误码逐字保持；重构与宿主面**分两笔提交** |
| 桥长出自己的语义 | 桥只转发；**任何**笔记语义只能出现在 `dispatch_capability` 那一侧（Task 5 的静态判据钉它） |
| 回环端点被网页碰到 | token ＋ `Origin`/`Host` ＋ 默认关（Task 4）；判据里含坏 Origin 一例 |
| 回滚 | 删开关与桥 ⇒ 应用回到**零监听**。⚠️ 不许留"配置撤掉了、代码还在两个地方"（工作区文档记过先例） |

## 4. 变更记录

- **2026-09-28** 建档（施工单，未开工）。
- **2026-09-28（同日）**：目标口径订正为「能读写」⇒ 范围句与 Task W 一并写明（写属 M2 且必做）。
- **2026-09-28（同日）**：**改写为 Superpowers plan 形状**（每任务 Files ＋ Step 1–5 ＋ 期望输出；三条一批），并补 §0 的两条"不许混"口径（TDD 红 ≠ 变异证据红；判据真相源在 `gates.mjs`）。映射依据：Superpowers `writing-plans` ／ `executing-plans`（本机在 `~/.agents/skills/<名>-0.1.0/SKILL.md`）＋ OpenSpec `openspec-propose` / `openspec-apply-change`（本机包在 `_tmp/scratch/pkginspect/dsh-openspec/package/skills/`）。行号取自本机实测。
