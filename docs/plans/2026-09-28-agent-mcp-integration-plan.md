# 外部 Agent 接入（MCP / CLI）总方案 —— 让 Claude Code / CodeBuddy / WorkBuddy / DSH 用上 ShuyoNote

> 状态：规划（**未实装**；待拍板 6 项见 §10）
> 目标版本：M28（提议，**未排期** —— 真要排期时补一篇 `../roadmap.md` 的 M28 小节）
> 关联：[薄 Agent 接口方案](2026-08-24-thin-agent-interface-plan.md)（M17，应用内 AI 宿主工具层的由来）· [插件体系进化方案](2026-09-10-plugin-evolution-plan.md)（能力注册表与权限模型）· [插件宿主子进程化](2026-09-10-plugin-host-isolation-plan.md)（同二进制 argv 分流的先例）· [全库 AI 覆盖方案](2026-09-17-knowledge-base-ai-coverage-plan.md)（`host: "frontend"` 那类能力的由来）

---

## 1. 一句话结论

四个目标产品**都原生支持 MCP**（§8 逐个附官方文档并标注核实程度），而 **ShuyoNote 这一侧今天一条 MCP、一条面向外部进程的通道都没有**（§3 第 2、7 条）。

⇒ 「让它们用上 ShuyoNote」= **在客户端加一个 MCP 面**，不在四个产品侧做适配。

而且成本分层已经查清：真正贵的那一层（应用内「外部宿主面」＋ 应用↔外部进程的通道 ＋ 解锁与写确认语义）**MCP 与 CLI 共用**，两个适配器各自都只是薄壳（§5、§6）。

## 2. 背景：谁要用、今天缺什么

| 谁 | 想干什么 | 今天缺什么 |
|---|---|---|
| Claude Code / CodeBuddy（IDE 与 CLI）/ WorkBuddy | 把笔记当上下文源（读），把结论写回（写） | 没有可连的 MCP server |
| DSH | 同上 | 同左（本机**已装** MCP 客户端插件，但**没有启用任何 server**，也没有 `dsh mcp` 子命令） |
| ShuyoNote 自己的 AI 宿主 | —— | 它**已有 10 条工具**，但只在应用内可用，外部进程拿不到（§3 第 1、4、7 条） |

## 3. 现状取证

> 判据是命令，不是这张表 —— 表里只是**写这一篇时**的读数（快照，会过期）。

| # | 结论 | 证据 / 判据 |
|---|---|---|
| 1 | 能力注册表**已经是「工具清单」的形状**：25 条能力，其中 `ai: true` **10 条**（8 读 / 2 写），每条带 `permission`、`scope`、参数、**LLM 可读 `desc`** | `capabilities/capabilities.json`；判据：`node -e "const c=require('./capabilities/capabilities.json');console.log(c.capabilities.length, c.capabilities.filter(x=>x.ai).length)"` |
| 2 | 全仓 **MCP 零命中**（`src/`、`src-tauri/`、`scripts/`、`package.json`，大小写不敏感） | `node` 侧用 ripgrep：`\bmcp\b` ⇒ 0；本方案本身就是本仓第一次提 MCP |
| 3 | 工具清单**生成自同一份注册表**，不手写第二份 | `scripts/gen-capabilities.mjs`（`filter(c => c.ai)` → `src/lib/capabilities/aiTools.meta.ts`） |
| 4 | 前端工具层消费它，**实现是前端适配表**（元数据可移植、实现绑死前端） | `src/lib/ai/tools.ts` → `src/lib/capabilities/frontend.ts` |
| 5 | 权限与审计**只有一个校验点** | `src-tauri/src/plugins.rs` 的 `dispatch_capability`（注释原文：「所有能力调用都走这里……不存在绕过路径」） |
| 6 | 写操作**一律草稿、用户确认才落库** | `src/lib/ai/host.ts`（写工具只攒草稿）＋ `src/lib/ai/apply.ts`（唯一落库处，文件头即写「ONLY place」） |
| 7 | **没有面向外部进程的通道**：无命名管道 / `UnixListener` / `axum` / `warp` / `tiny_http`；命令只挂在 WebView IPC 上 | `src-tauri/src/lib.rs` 的 `invoke_handler`；`src-tauri/tauri.conf.json` 无 server/socket 配置 |
| 8 | **钥匙只在应用进程内存里**，且**没有接任何 OS keyring** | `src-tauri/src/space_crypto.rs`（主密钥「用完即散，不落盘」）；`Cargo.toml` 里 `keyring` / `wincred` / `secret-service` 零命中 |
| 9 | 同二进制 argv 分流**可以不起 GUI**，但那条路**碰不到数据**（纯解释器：不碰库、不拿密钥、没有路径） | `src-tauri/src/lib.rs` 的 `--plugin-host` 分流（在任何 Tauri / 单实例初始化之前）＋ `src-tauri/src/plugin_host.rs` 的头注 |
| 10 | 唯一在跑的监听是 mesh 网格窗口，**默认关闭**、只有 2 条 GET 路由 | `src-tauri/src/mesh.rs`（路由只有 `/mesh/pull` 与 `/mesh/attachment`；`bind` 为 `None` 时整档不开） |

**由 8 与 9 直接得到的一条硬结论**：一个**不带 GUI 的独立进程，即使应用已经解锁，也读不到加密空间的笔记** —— 那把钥匙只存在于 GUI 进程内存里。它只有两条路：① 该空间**没开**磁盘加密（就是明文 SQLite）；② 自己从 `meta.db` 读公开的钥匙袋（盐＋参数）＋ **向用户要主口令**重新派生。⇒ **唯一的秘密是主口令本身。**

## 4. 为什么「服务端路线」不通

个人空间是端到端加密，同步服务端**只做透明中继、不解析 payload**；团队空间虽然放弃零知识，但那是一条同步 API，**不是笔记读取面**。⇒ 任何「让远端/服务端提供笔记 API」的想法，在**个人空间**上从根上不成立。口径以[同步服务端数据可见边界](../sync-server-data-boundary.md)为准。

## 5. MCP / CLI / API：**不是三选一**

这三个词不在同一层：

- **MCP** = 给 agent 的**发现 + 调用协议**：客户端自己拉工具清单，模型原生看见工具名/描述/schema。
- **CLI** = 复用 agent **已有的 shell 工具**调我们的命令：客户端零适配，但**没有发现**，要靠 `AGENTS.md` / skill 把用法教给它。
- **API** = **底座**：外部进程 ↔ 应用之间的那条通道（回环 / 命名管道 + token）。**agent 不该直接吃它**。

| 维度 | MCP | CLI | API（回环，仅内层） |
|---|---|---|---|
| 四家客户端可用性 | ✅ 全部原生 | ✅ 全部有 shell 工具 | ❌ 不该直连 |
| 工具发现 | ✅ 自动、零提示词 | ❌ 要写文档教它 | — |
| 参数校验 | ✅ 按 schema | ❌ 字符串拼参数（引号/换行/编码） | — |
| 权限与审计 | 复用 `dispatch_capability` | 同左 | 同左 |
| 写操作 | 草稿 → 应用内确认 | **同一条**（不因叫 CLI 就静默落库） | 同左 |
| 锁屏 / 未解锁 | `space_locked` 明确报错 | 同左；且**每次调用是新进程** | 同左 |
| 上下文成本 | ⚠️ **每个会话每次请求**都背工具描述（§7） | 只在真正调用的那一轮花 | 0 |
| 人也能用 | 一般 | ✅ 这正是它的强项 | ❌ |
| 生态 | ✅ 事实标准 | 弱（要 per-app 适配） | ✅ 但**攻击面最大** |
| 攻击面 | 中（stdio 子进程，无端口） | 低（无端口） | ⚠️ 高（见 §11） |
| 实现量 | 中（协议 + 生成物 + 权限重构） | 小（外壳） | 中（通道本身） |

**结论**：底座做一次，外面挂两个薄适配器。**选 MCP 还是 CLI 不改变 §3 那三条硬约束** —— CLI 一点都不比 MCP 省（它撞的是同一堵墙：钥匙在应用内存、摸真库要 GUI 在线）。

## 6. 推荐架构

```
Claude Code / CodeBuddy / WorkBuddy / DSH
        │  stdio（JSON-RPC，MCP）
        ▼
  shuyonote-mcp        ← 薄桥：只转发，不碰库、不碰密钥
        │  本机通道（命名管道 / 回环）+ per-session token（文件权限保护）
        ▼
  ShuyoNote 应用进程（GUI 在线 + 空间已解锁）
        │  新增「外部宿主面」：合成一次 RunState（plugin_id / permissions / 活动空间）
        ▼
  plugins.rs::dispatch_capability   ← 逐次权限校验 + 审计，唯一一处
        ▼
  rusqlite / SQLCipher 空间库
```

四条理由，逐条对应上面的取证：

1. **必须落在应用进程内** —— 否则拿不到钥匙（§3 第 8 条），也复用不到唯一的权限校验点（第 5 条）。
2. **通道必须新开** —— 今天没有任何面向外部进程的面（第 7 条）；不要去改造 mesh 窗口（默认关闭 + 弱 token 语义 + 手写 HTTP，会造出第二套鉴权）。
3. **桥必须是哑的** —— 它只做 stdio ↔ 本机通道的转发，**不解析笔记、不缓存内容**：这样"数据只在本机、只在应用进程里解密"这条口径不被新面破掉。
4. **写回走草稿** —— 应用内 AI 宿主的写确认链（`ai/host.ts` → `apply.ts`）是现成的，外部 agent 复用它，不新开一条静默写路径（第 6 条）。

## 7. 工具面与它的上下文成本

- **工具集 = 那 10 条 `ai: true`**（`pages.get` / `pages.search` / `blocks.list` / `backlinks.list` / `files.list` / `files.search` / `files.read` / `coverage.report` / `pages.create` / `blocks.append`）。
- **M1 只放只读 8 条**；写回留 M2。
- ⚠️ **成本容易被低估**：10 条 `desc` 合计 **1631 字符**（`coverage.report` 535、`files.read` 367、`files.search` 133、`pages.get` 127 …），按「中文约 1 字 1 token」粗估 ≈ **1.6k tokens**，而 MCP 的工具描述是**每个会话、每次请求**都要背的（这些 desc 本来就是写给**应用内** AI 宿主的长中文段落，含「别把没抽到读成文件里没有」这类口径）。

三条对策（按推荐序）：

1. **MCP 投影用生成器从同一份注册表产出「精简 desc」** —— 不是手写第二份（那正是本仓最反对的事）；长口径留在应用内那一版。
2. **拆两个 server**：只读常开、写按需开。
3. 依赖客户端的工具延迟加载（Claude Code 有 MCP tool search；CodeBuddy CLI 文档里有「工具延迟加载覆盖」页，⚠️ 该页正文**未读**，只确认页面存在）。

## 8. 四家客户端怎么接

| 产品 | 配置落点 | 核实程度 |
|---|---|---|
| **Claude Code** | `claude mcp add --transport stdio <名> -- <命令>`；或 `<项目>/.mcp.json`、`~/.claude.json` | 官方文档逐条读过 |
| **CodeBuddy IDE** | Settings → MCP → Add MCP，粘 `mcpServers` JSON（`type: "stdio"`） | 官方文档逐条读过 |
| **CodeBuddy Code（CLI）** | `codebuddy mcp add`；推荐 `~/.codebuddy/.mcp.json`、项目级 `<项目>/.mcp.json`（支持 JSONC） | 二手转述 + 官方文档页；⚠️ 两个官方页对全局文件名**自相矛盾**（`mcp.json` vs `.mcp.json`）⇒ **让 CLI 自己决定** |
| **WorkBuddy** | `~/.workbuddy/mcp.json` 或 `<项目>/.workbuddy/mcp.json`（UI 入口：插件 → MCP 服务器） | 官方文档逐条读过；⚠️ **只文档了 stdio**，远程传输无官方说明 |
| **DSH** | profile 的 `cordis.patch.yml` 里写 **`insert:` 列表**（新 id 必须走 insert，不是 id 覆盖），或做一个「只含配置的 bundle」用 `plugin_manager` 装 | 本机包里解出的一手证据（模板 + 插件源码 + Config schema）；**端到端未实测** |

DSH 那段（**注意 `insert:` 这一层不能省** —— 裸写一个新 id 是「覆盖一个不存在的 id」，大概率什么都不发生，而且不报错）：

```yaml
- insert:
    - id: mcp-shuyonote
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: shuyonote
        transport: stdio
        command: '<shuyonote-mcp 的绝对路径>'
        args: []
        failOnStartupError: true
```

⚠️ DSH 侧两个已知行为：**子进程环境会被清洗**（名字含 `KEY|PASSWORD|SECRET|TOKEN` 的变量与全部 `DSH_*` 都删）⇒ 令牌要在配置的 `env:` 里显式给；`mcp-resources` 已在当前 profile 激活 ⇒ 配上任一 server 后会**多出**三个共享工具（不是配坏了）。

## 9. 里程碑与验收

| 档 | 内容 | 验收（每条都要能红） |
|---|---|---|
| **M1 只读** | 注册表第 10 件生成物（MCP 工具清单）＋ 应用内只读宿主面 ＋ stdio 桥（token） | ① 未解锁 ⇒ `space_locked`（不是空结果）② 不在权限表里的能力 ⇒ 拒绝（复用 `permission_denied`）③ 应用退出/关开关 ⇒ 桥**立刻**失效 ④ 逐次调用进审计轨迹 |
| **M2 写回** | `pages.create` / `blocks.append` → 应用内草稿确认；可选 `--allow-write` + 审计 | ① 默认路径下 agent 只能拿到草稿 ② 用户不确认则库不变（可逐字节比对）③ `--allow-write` 下每次写有审计行 |
| **M3 多空间与治理** | 按空间开关、按工具授权、GUI 里的可见状态 | ① 关掉后桥的连接被拒 ② 状态行如实显示"几个外部会话在用" ③ 锁定空间不因开关被隐式解锁 |

施工细节见[配套施工单](2026-09-28-mcp-host-m1-workorder.md)（M1 精确到文件与判据）。

## 10. 待拍板（6 项）

1. **是否立项 M28**（本方案的前提；不立项则只保留零代码过渡那条路）。
2. **应用↔桥的通道形态**：命名管道 / 回环 TCP + token。建议**回环 + token**（跨平台与 Android 面代价最小），但必须按 §11 加校验。
3. **写回是否允许「免确认」**：建议 M2 默认仍要确认，`--allow-write` 另开一条显式通道（学既有的「写中介」口径）。
4. **工具描述用精简投影还是原样**（差价 ≈1.6k tokens/会话·请求，见 §7）。
5. **GUI 里要不要「外部接入」开关 + 可见状态**：建议**必须有**（否则用户不知道谁在读写自己的库）。
6. **桥的实现语言**（Node 单文件 vs Rust bin）：影响进哪个 CI 组与要不要新依赖。

## 11. 安全与边界（这一节不是客套）

- **回环端点三件套**：per-session 随机 token（存在只有当前用户可读的文件里）＋ 校验 `Origin`/`Host`（防 DNS rebinding）＋ **默认关**。
- ⚠️ 理由是本仓已经有同类问题：`docs/SECURITY.md:117` 记着「CORS 前缀匹配放过 `http://127.0.0.1.evil.com`」「`Access-Control-Allow-Origin: *`」。**不要**在同一个仓里再开一个没有校验的监听。
- **不为 MCP 在服务端加索引**（§4）；**不把笔记内容写进** `shuyo-site/ops/**` 那类非公开区（工作区敏感边界）。
- **审计**：外部调用与插件调用走同一套审计轨迹（`plugins.rs` 已有 `push_audit`），这样"谁读过我的库"可查。

## 12. 诚实边界（这一篇**没**验什么）

1. **没有改过任何 DSH profile、没有跑过一次真实 MCP 连接** ⇒ DSH 那段配置**格式可信（取自它自己的模板与 Config schema）、端到端未验证**。
2. **没有运行过 ShuyoNote 应用**；§3 全部是静态读代码（＋一位只读子代理的独立取证，决定性读数已复核）。
3. `src-tauri/tauri.conf.json` 的 `app.security` **未逐条读完** ⇒ 第 7 条那条结论的来源是 `invoke_handler` + 「无 socket/管道/HTTP 依赖」的零命中，**不是**对 CSP / asset 协议的穷尽核查。
4. CodeBuddy 全局 MCP 文件名**官方自相矛盾**（§8）；WorkBuddy **只文档了 stdio**。
5. §7 的 token 估算是「字符数 → token」的粗估，**没有实跑分词器**。
6. 「应用内宿主面要动 `dispatch_capability` 的同步 + thread-local 结构」这条是读代码得到的判断，**改动量未估**（施工单里按"必须重构"记）。

## 13. 变更记录

- **2026-09-28** 建档（规划，未实装）。本仓**首次**引入 MCP 相关设计；同批落配套施工单 [M1 施工单](2026-09-28-mcp-host-m1-workorder.md)。
