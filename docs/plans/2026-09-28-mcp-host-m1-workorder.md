# MCP 宿主 M1 施工单（只读）—— 注册表第 10 件生成物 ＋ 应用内宿主面 ＋ stdio 桥

> 状态：施工单（**未开工**；前置 = [总方案](2026-09-28-agent-mcp-integration-plan.md) §10 第 1、2 项拍板）
> 范围：**只做只读**。不做写回（M2）、不做多空间切换（M3）、**不碰**服务端、不改 wire / schema / 插件契约。

---

## 1. 目标

让四个外部 agent 产品（Claude Code / CodeBuddy / WorkBuddy / DSH）通过 **stdio MCP** 读到本机已解锁空间的笔记，且：

- 工具清单**不是手写的**（从 `capabilities/capabilities.json` 生成，与插件、应用内 AI 宿主同一份源）；
- 权限**复用唯一校验点**（`plugins.rs::dispatch_capability`），不新开第二条鉴权；
- 未解锁**明确报** `space_locked`（不静默给空结果）；
- 关掉开关 ⇒ 桥**立刻**失效。

**不做**：写能力（`pages.create` / `blocks.append` 一律不出现在 M1 的工具清单里）、附件字节下载、跨空间切换、SSE、把任何笔记内容写进日志。

## 2. 为什么必须落在应用进程内（不是偏好）

| 事实 | 证据 | 后果 |
|---|---|---|
| 钥匙只在应用进程内存（主密钥「用完即散，不落盘」），且**没有接任何 OS keyring** | `src-tauri/src/space_crypto.rs`；`Cargo.toml` 里 `keyring`/`wincred`/`secret-service` 零命中 | 独立进程读不到加密空间 ⇒ 桥**不能自己开库** |
| `--plugin-host` 那条路**碰不到数据**（纯解释器：不碰库、不拿密钥、没有路径） | `src-tauri/src/plugin_host.rs` 头注；`src-tauri/src/lib.rs` 的分流 | 「照抄 `--plugin-host` 就能读库」是错的；那条路只能当**帧协议**的参考 |
| 权限与审计**只有一个校验点** | `src-tauri/src/plugins.rs::dispatch_capability`（注释原文：「所有能力调用都走这里……不存在绕过路径」） | 任何绕开它的外部面都等于第二套鉴权 |

⇒ 桥是**哑的**（只转发），解密与鉴权都留在应用进程里。

## 3. 改动清单（逐文件）

| # | 文件 | 动作 | 为什么 |
|---|---|---|---|
| 1 | `scripts/gen-capabilities.mjs` | 新增第 10 件输出 `capabilities/mcp-tools.json`（`name` / `description` / `inputSchema` / `permission` / `isWrite`），并在脚本头 OUTPUTS 登记 | 单一事实源；**不许**手写第二份工具清单 |
| 2 | `scripts/check-capabilities.mjs` | 「生成物一致」那一段加上这一件；并加一条：**`isWrite: true` 的能力不许出现在 M1 的清单里**（M1 只读） | 生成物与注册表漂移不报错是这类事的典型坏法 |
| 3 | `src-tauri/src/plugins.rs` | 把权限判定从 thread-local `RUN_STATE` 里**抽成一处**（纯函数：`(cap_id, &permissions) → Result<(), ErrCode>`），插件路径与外部宿主路径共用；**逐字保持** `permission_denied` / `unknown_capability` / `bad_args` 语义 | 复用唯一校验点是本单的承重前提；这一步是唯一会碰到现有插件路径的改动 |
| 4 | `src-tauri/src/mcp_host.rs`（新） | 外部宿主面：一条**长度前缀 JSON 帧**（形状照 `plugin_host.rs`，不新造协议）＋ 逐次调用 `dispatch_capability` ＋ 审计 | 应用侧改动面最小；MCP 协议演进不碰 Rust |
| 5 | `src-tauri/src/lib.rs` | 登记开关与生命周期（**在 Tauri 起来之后**，与 `--plugin-host` 那条相反） | 它需要 Db 与密钥 |
| 6 | `tools/shuyonote-mcp/`（新） | stdio ↔ 本机通道的桥：**MCP 协议实现放这里**（`initialize` / `tools/list` / `tools/call`，行分隔 JSON-RPC），工具清单读第 1 件生成物 | 协议在 Node 侧，Rust 侧只认能力 id |
| 7 | `src/lib/platform/commands.ts` | 若新增了 Rust 命令，同步 `CommandMap` | `check-web-commands` 判据 |
| 8 | 文档 | `docs/plugin-api.md` 是**生成物**（勿手改）；用户向的「怎么接 MCP」文档**等 M1 真跑通再写** | 不让文档先于功能（本仓踩过"文档说已支持"的坑） |

**通道与 token（拍板项 2 决定后填死）**：建议回环 TCP + **per-session 随机 token**，token 落在只有当前用户可读的文件里；**默认关**；**必须**校验 `Origin` / `Host`（防 DNS rebinding），理由见总方案 §11（本仓已有 `Access-Control-Allow-Origin: *` 那类已知问题）。

## 4. 判据（每条都要能红 —— 写不出"怎么让它红"的判据不许上工）

| 判据 | 怎么让它红（变异组） | 组 |
|---|---|---|
| 生成物与注册表一致 | 手改 `capabilities/mcp-tools.json` 一行 ⇒ 红 | contract |
| M1 清单里没有写能力 | 把 `pages.create` 塞进清单 ⇒ 红 | contract |
| 未解锁 ⇒ `space_locked` | 在锁定态调 `pages.search` ⇒ 必须报错，**不是**空数组 | rust |
| 不在权限表里的能力 ⇒ 拒绝 | 用一份不含 `read:files` 的合成 RunState 调 `files.read` ⇒ `permission_denied` | rust |
| 关开关 ⇒ 桥立刻失效 | 断开后旧 token 再连一次 ⇒ 必须被拒 | rust |
| 每次外部调用进审计 | 调一次 `pages.get` ⇒ 审计轨迹多一行 | rust |
| 桥的 stdout **只有**合法 MCP 消息 | 往桥里插一句 `console.log` ⇒ 客户端解析失败（照 MCP 规范：日志只许走 stderr） | plugin（Node） |
| 插件路径语义未变 | 现有插件判据全量跑（逐字保持错误码） | rust / plugin |

⚠️ **"看过它红"是入库条件**：新增门禁要在工作区台账里留下变异证据（见 §5 第 3 条），否则门禁只在"它绿过"这一侧有记录。

## 5. 门禁要登记的三处（**漏一处 = 看着加了门禁、其实没人跑**）

| # | 位置 | 判据 / 为什么 |
|---|---|---|
| 1 | `scripts/lib/gates.mjs` | **唯一出处**。本地 `pnpm verify` 与两侧 CI 都消费它；只挂 `package.json` 的 build 链 = 在 verify 与 CI 上**隐形**（这条踩过两次：`mobile-views`、`check-hook-order`）。每条要写 `incident` 字段 |
| 2 | `docs/TESTING.md` 的门禁表 | `check-doc-facts` 判据 A：**注册表里每条门禁都要在表里出现**（上线当天抓到 7 条漏写） |
| 3 | `_workspace/mutation-evidence.json` 的 `_repo_mutations` | ⚠️ **不在本仓里**，最容易漏：工作区门禁 `check-gate-manifest.mjs` 的**判据 D2** 要求每个 `repos/*/scripts/check-*.mjs` 有「看过它红」的证据（`exit` 记 `0` 判红、判据改过会自动过期），否则必须写带**理由**的 `_repo_grandfathered` |

另：若新门禁要参与 `tests/baseline.json` 的断言数下限（`baseline: true`），**由人决定**，不自行改读数。

## 6. 验收清单

- [ ] 四家里**至少两家真连过**（建议 DSH + Claude Code，理由：DSH 是本机可自验的、Claude Code 是标准形）。
- [ ] DSH 侧用**配置型 bundle** 或 `cordis.patch.yml` 的 **`insert:` 列表**接入（裸写新 id 是"覆盖不存在的 id"，不报错也不生效）。
- [ ] 未解锁、关开关、越权三种失败各留一条读数（**不是**"应该会报错"）。
- [ ] 工具清单与注册表逐条对账（`node scripts/check-capabilities.mjs`）。
- [ ] 应用**零监听**回滚验证：删掉开关后 `netstat` 不再有那个端点。

## 7. 顺序、分工与本机边界

1. 先做 #1 + #2（生成物 + 对账）—— 纯 Node、本机可自验。
2. 再做 #3（权限判定抽取）—— **与现有插件判据成对跑**，不许顺手改语义。
3. 然后 #4 + #5（宿主面）与 #6（桥）—— Rust 与 Node 两侧可并行，但**两处不得同时改同一文件**。
4. 最后 #7 / 文档与验收。

⚠️ **本机边界（AGENTS.md §7，不许假装通过）**：Windows 上 `cargo test` 的测试 exe 没有应用清单 ⇒ `0xC0000139`；`plugins::` 那 34 条**本机跑不了**。⇒ **Rust 侧判据以 WSL2 / CI 为准**，本机只能跑 `scripts/win-cargo-test.ps1` 那一档并**如实标注"未实查"**。

## 8. 风险与回滚

| 风险 | 处置 |
|---|---|
| 权限判定重构动了插件路径 | 现有插件判据全量跑；错误码逐字保持；重构与 MCP 宿主面**分两笔提交** |
| 桥被当成"第二个入口"长出新语义 | 桥只做转发；**任何**笔记语义都只能出现在 `dispatch_capability` 那一侧 |
| 回环端点被网页碰到 | token + `Origin`/`Host` 校验 + 默认关；判据里加一条"坏 Origin 必须被拒" |
| 回滚 | 删开关与桥 ⇒ 应用回到**零监听**。⚠️ 不许留下「配置撤掉了、代码还在两个地方」那种状态（工作区文档记过这个先例：`dsh-coordination-board`） |
| 上下文成本超预期（§7 总方案） | 生成物里带**精简 desc** 开关；必要时拆只读/写两个 server |

## 9. 变更记录

- **2026-09-28** 建档（施工单，未开工）。同批落[总方案](2026-09-28-agent-mcp-integration-plan.md)。
