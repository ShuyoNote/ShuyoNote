# 规格：外部 Agent 接入（MCP 宿主）

> 起草：Windows 侧（本机）｜**2026-09-28**｜需求见 [`2026-09-28-knowledge-and-agent-access-requirements.md`](2026-09-28-knowledge-and-agent-access-requirements.md)
> 依据：`_workspace/AI-NATIVE-DEV.md` §5.1（规格层）＋ 本仓 [`docs/specs/README.md`](README.md)（这一层的三条"不是什么"）
>
> ⚠️ **本层的第一优先级不是"多一份文档"，是"每条不变式都得有一条会红的判据"。**
> 本文件 §2 的不变式，第四列**全部是 `❌ 无`** ⇒ **按 `README.md` 的铁律，它们【现在都不在 `INVARIANTS.md` 里】**。
> 本文件的作用是把"要立哪条判据、怎么证明它会红"写成 **M1（读）与 M2（写）** 的**可执行前置条件**，而不是让读者以为它们已经被守住了。**§3 给落地顺序。**

---

## 0. 字段口径（与 `INVARIANTS.md` 同形，便于将来机器迁移）

```text
id          INV-MCP-<短名>              稳定标识；改口径不许改 id（改 id = 删除 + 新增）
口径        一句话；从判据的真源逐字引用，不在此重写
判据        scripts/check-<名>.mjs [--root/--self-test] ／ Rust 判据走 `_workspace/mutation-evidence.json` 的 `_repo_mutations`（⚠️ 产品仓没有 `criteria-mutations.json`，2026-09-29 订正）
会红证据    ✅ 有（证明命令 + 期望非 0 退出码 + 账本 sha）／❌ 无（⇒ 按 README 铁律，该条还不该进 INVARIANTS.md）
```

**承重证明通道**（与 `README.md` §每条不变式的四个字段一致，不另发明）：

- **静态 / 纯 Node 判据** ⇒ 脚本自己的 `--self-test`，或假根配方（`--root`）；
- **跑 cargo 的判据** ⇒ `_workspace/mutation-evidence.json` 的 `_repo_mutations`（改坏源码 ⇒ 用例变红）（⚠️ 2026-09-29 订正：**产品仓没有** `scripts/criteria-mutations.json`，原文在指一个不存在的通道）；
- **两条都要**：工作区台账 `_workspace/mutation-evidence.json` 的 `_repo_mutations` 里留一条
  「看过它红」的证据（`exit` / `gateSha256` / `finding`；**判据代码一改就自动过期**）。

---

## 1. 本规格要解决的**一个口径问题**（比下面七条不变式更根本）

```text
今天："谁能读写笔记库" 只有一个入口 —— WebView IPC（lib.rs 的 invoke_handler）
MCP 面："同一个能力" 会多出第二个入口 —— 外部 agent 经过桥进来
```

⇒ **规格层要钉的第一件事不是"工具好不好用"，而是「第二个入口不许长出第二套鉴权、第二套语义」。**
两条推论直接成了 §2 的第 1、2 条不变式：**校验点仍只有一处**（`dispatch_capability`），
**工具清单仍是注册表的生成物**（不是为 MCP 手写一份）。

⚠️ 而这两条**今天都还没有判据** —— 所以本文件存在的意义是：**先立判据，再让 M1 写代码**。
（这就是需求 §3 第 3 条与 §4"不新开第二条鉴权"的可执行形式。）

---

## 2. 不变式（`❌ 无` ＝ 按 `README.md` 铁律，**暂不进 `INVARIANTS.md`**）

| id | 口径（一句话） | 判据（要立的那条） | 会红证据 |
|---|---|---|---|
| **INV-MCP-single-authz** | **外部宿主的每次能力调用都经同一处权限校验（`dispatch_capability`），不存在第二条鉴权路径；宿主面不许自己开库、不许自己判权限** | 新增 `scripts/check-mcp-host-authz.mjs`（只读静态扫 `src-tauri/src/mcp_host.rs`：出现自建权限判定 / 直接 `db::open_space_conn*` / 直连 SQLCipher 即红） | **❌ 无**（要立。**怎么证明它会红**：在 `mcp_host.rs` 里加一句自己写的 `permissions.contains(...)`，或在宿主面里直接开空间库 ⇒ 必须报红） |
| **INV-MCP-tools-generated** | **MCP 工具清单是 `capabilities/capabilities.json` 的生成物，不许手写第二份语义工具清单** | `scripts/check-capabilities.mjs` 现有的「生成物一致」那一段**加上这一件**（不新开门禁：它已在注册表里、`--self-test` 已在） | **❌ 无**（要立。**怎么证明它会红**：手改 `capabilities/mcp-tools.json` 一行（如把某条 desc 改掉）⇒ 必须报红） |
| **INV-MCP-readonly-first** | **M1 的工具清单里不许出现写能力**（`isWrite: true` 的 `pages.create` / `blocks.append` 一律不出现在清单里） | 同上那一条判据（`check-capabilities.mjs` 扩一条反向断言） | **❌ 无**（要立。**怎么证明它会红**：把 `pages.create` 塞进清单 ⇒ 必须报红） |
| **INV-MCP-write-requires-confirm** | **外部 agent 的写请求在用户确认之前不许落库**（落库仍只在 `src/lib/ai/apply.ts` 一处；`--allow-write` 若开，必须是显式开关且每次写留审计） | Rust/TS 判据（外部走一次 `pages.create` ⇒ 只拿到草稿；**库逐字节不变**） | **❌ 无**（要立。**怎么证明它会红**：把宿主面里的写能力直接接到 `create_page` 落库、绕过草稿 ⇒ 必须报红） |
| **INV-MCP-locked-fails-loud** | **未解锁 / 锁定空间 ⇒ 明确报 `space_locked`，不许返回空结果**（"读不到"不等于"库里没有"） | Rust 判据（承重通道＝`scripts/criteria-mutations.json`；⚠️ **本机跑不了 rust 组**，见 §3 末） | **❌ 无**（要立。**怎么证明它会红**：把那条路径从"报错"改成"返回空数组" ⇒ 必须报红） |
| **INV-MCP-bridge-dumb** | **桥不碰库、不碰密钥；它的 stdout 只许出现合法 MCP 消息**（日志/调试一律走 stderr） | 桥自己的判据（Node，本机可跑）：喂一条请求 ⇒ 逐行可解析为 JSON-RPC；`stderr` 可有内容、`stdout` 不可有非协议行 | **❌ 无**（要立。**怎么证明它会红**：往桥里插一句 `console.log("hi")` ⇒ 客户端侧解析必须失败 ⇒ 判据报红） |
| **INV-MCP-channel-guarded** | **通道默认关；开启时 per-session token ＋ `Origin`/`Host` 校验；坏 Origin / 过期 token 必须被拒**（关掉开关后旧 token 立刻失效） | 桥与宿主面各一条（Node + Rust）；⚠️ 若最终选的是**命名管道**而不是回环，本条的注入方式要跟着换（拍板项 2） | **❌ 无**（要立。**怎么证明它会红**：① 删掉 `Origin` 校验 ⇒ 坏 Origin 也放行 ⇒ 必须报红；② 关开关后拿旧 token 再连一次 ⇒ 必须被拒） |

---

> 🔎 **2026-09-28 windows 侧评审补（两条）**
>
> **（1）条的数目口径**：本节标题上方那句写的是"比下面**七条**不变式更根本" ✓，表里**也是 7 行** ✓
> —— 而落地顺序（§3）只排了 **6 条** ⇒ 请写明"**七条：M1 立六条，`INV-MCP-write-requires-confirm` 随 M2**" ✓
> （免得日后有人拿"六条/七条"当矛盾；本工作区那条规矩同样适用：**能漂的数字别手写在散文里** ✓）
>
> **（2）建议补一条 `INV-MCP-audited`**（需求 §3.6 已经要求了，本表却没钉）：
>
> | id | 口径（一句话） | 判据（要立的那条） | 会红证据 |
> |---|---|---|---|
> | **INV-MCP-audited** | **外部会话的每次能力调用与插件调用进同一审计轨迹**（"谁读过我的库"可查） | 外部路径也调用 `plugins.rs` 的 `push_audit`（今天在 `plugins.rs:491` 定义、`:2051`/`:2060` 调用 ✓） | 再注入＝**删掉外部路径那一处调用** ⇒ 判据红 |
>
> ⚠️ **但立这条之前必须先定一个小口径**：`push_audit` 的第一个参数是 **`plugin_id`** ✗ ——
> 外部会话在这条**为插件设计**的轨迹里**怎么标识**（复用 `plugin_id` 填什么？还是加一列 `source`？）✓
> 这条不定，`INV-MCP-audited` 的判据写不出来 ✓（建议与 `INV-MCP-write-requires-confirm` 一起列进待定）

## 3. 落地顺序（**先让判据可跑，再进 `INVARIANTS.md`**）

> 这是 `README.md` 的收录条件：① 能指到会红的判据 ② 有"看过它红"的证据 ③ 证据能原地重做。

```text
第 1 步  M1 的生成物 + 对账（纯 Node，本机可跑）
         ⇒ 立 INV-MCP-tools-generated ｜ INV-MCP-readonly-first
         ⇒ 它们的"再注入"口子就是【手改生成物一行】/【塞一个写能力进清单】

第 2 步  桥 + 它的判据（Node，本机可跑）
         ⇒ 立 INV-MCP-bridge-dumb ｜ INV-MCP-channel-guarded（Node 那一半）
         ⇒ 再注入：插一句 console.log ／ 删掉 Origin 校验

第 3 步  宿主面 + Rust 判据（承重通道＝CI / WSL2）
         ⇒ 立 INV-MCP-single-authz ｜ INV-MCP-locked-fails-loud
         ⇒ ⚠️ INV-MCP-write-requires-confirm 随 **M2 的写能力**一起立
            （读那一档里写能力根本不在清单上，这条无从验起）
         ⚠️ AGENTS.md §7：Windows 本机跑不了 rust 组（测试 exe 缺 v6 清单，
            `plugins::` 那 34 条本机跑不了）⇒ 这两条的"看过它红"**必须在 WSL2 / CI 上做**，
            本机只能如实标注"未实查"

第 4 步  七条都拿到"看过它红"的证据，写进 `_workspace/mutation-evidence.json` 的 `_repo_mutations`
         ⚠️ **这一步不在本仓里** —— 漏了就是"看着立了不变式、其实没有证据"
         （工作区判据 D2 会按脚本 sha 校验；判据一改，证据自动过期）

第 5 步  才把 §2 那六行搬进 `docs/specs/INVARIANTS.md`
```

⚠️ **顺序理由**：M1 的**代码改动**（施工单 §3）排在第 1–3 步**之后**是这个层级的铁律 ——
**先有断言，再有改动**；否则改完之后没人能证明它没退回去（同形先例：sync-panel-density 规格把"改动"放在第 5 步）。

---

## 4. 与需求/方案的分工（防止三份互相抄）

| 文件 | 放什么 | 不放什么 |
|---|---|---|
| [`../plans/2026-09-28-agent-mcp-integration-plan.md`](../plans/2026-09-28-agent-mcp-integration-plan.md) | **方案**：现状取证全表、三条路线取舍、推荐架构、四家配置、里程碑、待拍板 | 判据与不变式 |
| [`../plans/2026-09-28-mcp-host-m1-workorder.md`](../plans/2026-09-28-mcp-host-m1-workorder.md) | **施工单**：逐文件改动、判据清单、门禁登记三处、回滚 | —— |
| [`2026-09-28-knowledge-and-agent-access-requirements.md`](2026-09-28-knowledge-and-agent-access-requirements.md) | **需求**：要什么/不要什么/边界、决定形状的那几条读数 | 判据与不变式 |
| **本文件** | **规格**：不变式 ＋ 判据指针 ＋ 会红证据现状 ＋ 落地顺序 | 配置片段（引用方案 §8）、逐文件改动（引用施工单 §3） |

---

## 5. 本文件**故意不含**的

- ❌ **工具清单的逐条 `desc`**（那是生成物，且长口径的取舍属方案 §7；本层不复制内容）。
- ❌ **四家客户端的配置片段**（在方案 §8；本层只钉"对外面是 stdio"这条口径）。
- ❌ **通道的具体形态**（回环 vs 命名管道）—— 它还是**待拍板项 2**；本层只钉"默认关 + token + `Origin`/`Host`"这条**与形态无关**的要求。
- ❌ **token 的存放路径与权限位**（实现细节，属施工单；且它会随平台不同）。
- ❌ **写的落地方式（草稿确认 vs `--allow-write`）** —— 它是[方案 §10](../plans/2026-09-28-agent-mcp-integration-plan.md) 第 3 项拍板；本层只钉「**用户确认之前不许落库**」这条**与形态无关**的要求（`INV-MCP-write-requires-confirm`）。
