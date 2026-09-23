# 桌面「近实时」流通道：设计稿（2026-09-23，**未实现**）

> **进度（2026-09-23 第 48 轮）**：§7 **第 1–4 步已落** ——
> ① `src-tauri/src/sync_stream.rs` 纯函数（帧解析/退避/`stream_url`，**9 条判据全绿**）；
> ② 订阅任务 ＋ 状态机 ＋ 三条命令 `sync_stream_{start,stop,status}`（复用 `sync::claim_config` 选绑定，
> **没绑就不起流也不抛**；`ping`/断开都走**退避重连**、`last_error`/`reason` **不静默**）；
> ③ 契约/API/平台收口；④ `useSyncStream` 的桌面分支（**先挂监听再起流**、去抖 300ms、`ping` 立刻拉、
> 走既有 **C2 闸门 ＋ 防重入 ＋ 状态行配对**）＋ `components/SyncPanel.tsx` 的「近实时推送」开关。
>
> **判据现状（如实）**：1/2 ✅（Rust 单测）・3 ✅（`stream_url` ＋ 复用的 `claim_config` 判据）・
> 4 ✅（`check-web-commands`：Rust **247** / web 245 / 契约 **249**，桌面专属 **2 → 5**）・
> 6/7 ✅**部分**（状态默认值＋`reason`/`last_error` 有判据；"关掉立即断""拔网重连"的**真行为**
> 要跑起来才算）・**5 ✗ 未验**（端到端 <2s / 拔网重连需要 `tauri dev` 或真机 —— 与 §5 给它标的
> "人工/脚本"一致，本机没有 Tauri 应用可跑）。⇒ **这条片还没"做完"，差的就是判据 5 那一跑。**

> 起因：[实时协同分析](../realtime-collab-analysis.md) §9.3 的第一条缺口 ——
> **桌面没有推送通道**（`src/hooks/useSyncStream.ts` 首句 `if (isDesktopPlatform()) return;`）
> ⇒ 桌面的"近实时"实际由**轮询间隔**（用户可配 10s~5min）决定，而它同时也是 **CRDT 合并的可见延迟**。
>
> 本文只出稿：**列形态、判据、风险与不做的部分**，不写码。上位：
> [SYNC](../SYNC.md) §五（三条通道）、[全上线冲刺](2026-09-23-crdt-full-launch-sprint.md) §11–§15、
> [S5 决策稿](2026-09-23-s5-server-merge-decision.md)（本文**不改**服务端）。

## 1. 现状（两侧不对称，逐条可复核）

| 事实 | 出处 |
|---|---|
| 服务端**已有** SSE 端点：`GET /spaces/{id}/changes-stream`，`auth_user` ＋ `require_space(viewer)` | `shuyonote-sync-server/src/collab.rs:338`、`main.rs:409` |
| 它是 axum `Sse` ＋ **`KeepAlive::default()`**（约 15s 注释帧）⇒ 空闲≠断线 | `collab.rs:359` |
| 事件是**信号**不是内容：`{"type":"push","space_id":…,"accepted":N}`（服务端仍"哑且盲"） | `sync.rs:222-231` |
| 广播通道容量 **64**；订阅者落后时收到 `Err(Lagged)` ⇒ 服务端改发 `{"type":"ping"}` | `collab.rs:331`、`collab.rs:352-356` |
| **Web 已有消费方**：`fetch` + `ReadableStream`，按 `\n\n` 切帧，每帧 `api.syncWorkspace(wsId)` ＋ `loadPages()` | `src/hooks/useSyncStream.ts` |
| **桌面一个消费方都没有**（`grep changes-stream src-tauri/src` 零命中）｜桌面靠定时器 `useAutoSync` ＋ `api.syncNow()` | `src/hooks/useAutoSync.ts`、`src/App.tsx:350` |
| 桌面已有**事件**通路：Rust `app.emit("…")` ↔ 前端 `platform.event.listen(...)` | `sync.rs:2563`、`lib/platform/tauri.ts:8` |

⇒ 结论：这不是"要不要新造一条通道"，而是"**桌面缺一个 SSE 客户端**"。

## 2. 目标 / 非目标

**目标**：桌面把"远端有变更"从"下一次轮询"降到"**秒级**"，且**不引入第二套同步语义** ——
拉取仍然只有 push/pull 那一条路。

**非目标**（明确不做，别顺手做）：
- ❌ WebSocket、实时光标/选区（那属"真·实时"那一档，见分析 §9.4，仍后置）；
- ❌ **改服务端**（端点/鉴权/keep-alive 都已够用）；
- ❌ 把长连接当"同步引擎"：**拉取语义一行不改**（仍是 pull by seq ＋ 既有的合并/落库路径）；
- ❌ 移动端（Android 的后台/省电策略单独拍，别顺手带上）。

## 3. 形态（三条候选，选第二条）

| 候选 | 做法 | 结论 |
|---|---|---|
| A. 只把轮询间隔调小（例如 2s） | 零新代码 | ❌ 不解决"何时该拉"，而且把**请求量**变成常态（每台设备每 2s 一次 pull）|
| **B. Rust 订阅 SSE ＋ 向前端发事件，拉取仍由前端发起** | 新 Rust 模块收流；`app.emit` ⇒ 前端 `listen` ⇒ `api.syncWorkspace(wsId)`（**与 Web 完全同构**） | ✅ **推荐**：复用既有拉取入口 ⇒ 自动经过 **C2 Wi-Fi 闸门**（`lib/syncGate.ts`）、防重入与状态行（`withSyncStatus`）——这三件绕过去就会重现 `syncGate.ts` 文件头记的那个 bug |
| C. Rust 收到事件后**自己**调 `sync_workspace_only` | 少一次 IPC | ❌ 绕过闸门/状态/防重入，且与 Web 不同构（两条路要各自维护） |

## 4. 详细设计（推荐形态 B）

### 4.1 Rust 侧：`src-tauri/src/sync_stream.rs`（新）

- **订阅**：`reqwest` 起 `GET {server}/spaces/{space_id}/changes-stream`，
  `Authorization: Bearer {token}`，`bytes_stream()` 逐块读。
  ⚠️ **reqwest 要用 `stream` feature**（已在依赖里：`reqwest = { features = ["json","stream"] }`）。
- **帧解析**（**纯函数**，与 `crdt_wire.rs` 同一种写法：可单测、不碰网络）：
  输入是"累计缓冲"，输出是"切出来的帧 ＋ 剩余半帧"。必须处理：
  `\n\n` 分帧；`\r\n\r\n` 也要认（代理会改写行尾）；忽略 `:` 注释帧（keep-alive 就是它）；
  `data:` 后可有/无空格；一帧多行 `data:` 按 SSE 规定用 `\n` 连接；
  **半帧必须留在缓冲里**（不能"收到就 parse"）。
- **重连**：指数退避 **1s → 2s → 4s → … → 封顶 30s**（＋小抖动），退避表本身也是纯函数；
  收到任何帧（含注释/`ping`）⇒ 视为"连接活着"，退避清零。
  ⚠️ **不要**用"多久没收到帧"判断死连接（keep-alive 15s 才一次）—— 判死交给 reqwest 的读超时/断开。
- **语义：`ping` / `Lagged` 不是"没事"**：服务端在订阅者落后（broadcast 容量 64）时发的就是
  `{"type":"ping"}` ⇒ **那意味着可能漏了事件** ⇒ 客户端必须**立刻拉一次**（与"收到 push 就拉"同待遇）。
  这条要写进代码注释与判据，否则会变成"高峰期静默不更新"。
- **生命周期与状态**：进程内**只有一份**订阅（Rust 侧天然如此，多窗口不会各订一份）。
  持一个 `Mutex<SyncStreamState>`：`{ running, ws_id, server, last_event_at, reconnects, last_error }`；
  `stop` 会 abort 掉后台任务（`JoinHandle::abort`）并把 `running` 置假。
- **"订谁"复用既有解析**：与 claim 的 Rust 版同一处 —— `claim_config(c, ws_id)` 已经回答
  "这个工作空间绑到哪台服务器/哪个远端空间，且 `server_url`/`space_id` 都非空"。
  ⇒ 没绑定/绑不全就**不起流**（退回轮询），**不抛**（第 38 轮的教训：正常情况不许抛）。

### 4.2 命令面（Tauri）

| 命令 | 作用 | Web 侧 |
|---|---|---|
| `sync_stream_start(ws_id)` | 起/重起订阅（切工作空间时调） | **桌面专属**（见下） |
| `sync_stream_stop()` | 断开且不再重连（用户关开关/退出登录时调） | **桌面专属**（见下） |
| `sync_stream_status()` | 读数：`{running, ws_id, server, last_event_at, reconnects, last_error, reason}` | **桌面专属**（见下） |

⚠️ **这三条与刚撤掉的 `claim_page_lineage` 是相反方向**：Web 平台**不需要**它们（浏览器自带 SSE，
`useSyncStream.ts` 自己就是那个客户端）⇒ 硬在 `web.ts` 里实现一遍等于把同一件事写两份。
⇒ 登记进 `check-web-commands.mjs` 的 **`DESKTOP_ONLY_COMMANDS`**（"Rust 有、Web 故意没有"；
**桌面专属 2 → 5**），**理由与调用点收口方式**都写在登记项里。
⚠️ **本文这里原来写成"web 专属 / `WEB_ONLY_COMMANDS`"，是错的**（第 48 轮实现时被门禁当场纠正）：
那张表是**反方向**——"契约里有、Rust 没有"（`claim_page_lineage` 当年属于它）。
两张表的区别一句话：**"两侧是不是都要做"** —— claim 两侧都要（所以它撤销登记），流通道只有桌面要。

### 4.3 前端接线

- 新 hook（或 `useSyncStream` 加桌面分支）：桌面侧
  `platform.event.listen("sync-stream-change", …)` ⇒ **去抖 300ms** ⇒ `api.syncWorkspace(wsId)` ⇒ `loadPages()`。
  - **去抖是必须的**（D2）：一次 push 可能连发多帧（批量推送/多设备），一帧一次拉会打出突发。
  - **闸门与防重入照旧**：走 `useAutoSync` 同一套（`syncGate` 判定 ＋ `withSyncStatus` 配对）——
    所以建议把"拉一次"抽成一个小函数，让**定时器与流事件共用**（一处实现，别写第二份）。
  - **轮询保持不变**（D3）：它是通道断开时的兜底；"有流"不等于"可以关轮询"。
- 事件载荷：`{ ws_id, server, kind: "push" | "lagged" }`（**不含页面内容**，与服务端一致：只当信号）。

### 4.4 开关与默认值（要 owner 拍）

- 存 `meta.sync_state`（与同步预算/网络闸门同族），设置项放「同步」面板：**「近实时推送」**。
- **建议默认开**（与 Web 现状一致 —— Web 上这条流一直是默认开的），并给**一键关闭**
  （企业代理/镜像会掐长连接；关掉后与今天逐字相同：纯轮询）。
- 关掉必须**立即断开且不再重连**（否则"关"是假的）。

## 5. 判据（缺一条不算做完）

| # | 判据 | 怎么验 |
|---|---|---|
| 1 | **帧解析**：半帧/粘包/`\r\n\r\n`/注释帧/多行 `data:`/`data:` 无空格 | Rust 单测（纯函数，照 `crdt_wire.rs`）|
| 2 | **退避表**：1→2→4→…→30 封顶；收到帧即清零 | Rust 单测 |
| 3 | **订谁**：没绑定/绑不全 ⇒ 不起流且**不抛**；切工作空间 ⇒ 重订 | Rust 单测（复用 `claim_config`）|
| 4 | **命令面**：三条注册；`check-web-commands` 绿且**桌面专属 2 → 5**（理由写在登记项）| 门禁 |
| 5 | **端到端**（真机/集成）：本地服务端 ＋ 桌面在跑 ⇒ A 改一处 ⇒ 桌面 B **< 2s** 拉到；**拔网再插** ⇒ 自动重连并恢复 | 人工/脚本（`test:sync-collab` 已有服务端那一半）|
| 6 | **可关**：关开关 ⇒ 连接数立刻归零、`status.running=false`、不再重连 | 单测（状态机）＋ 人工 |
| 7 | **不静默**：连不上/被代理掐 ⇒ `status.last_error` 有痕，且**不影响**轮询（照旧能同步）| 单测 ＋ 人工 |

## 6. 风险与边界（写清，别到时候当 bug 查）

1. **企业代理/Nginx 缓冲**：SSE 最常死在这里。兜底＝轮询不变；部署侧若走 Nginx，需要
   `proxy_buffering off` 与 `X-Accel-Buffering: no`（**服务端部署文档要核一遍**，本文不假设）。
2. **`Lagged` ⇒ 可能漏事件**：语义已定（§4.1）——收到 `ping` 就拉一次。**不许**把它当心跳忽略。
3. **连接数**：一台设备一份订阅；服务端每空间一个 broadcast channel（容量 64）⇒ 团队规模下要留意
   服务端 fd 数（这是**服务端容量**问题，不在本片）。
4. **移动端不在本片**：Android 后台被杀/省电策略会让长连接时断时续，那是另一套取舍。
5. **与 CRDT 的关系**：本片只改善"多久**看到**"，**不改变**合并正确性（合并路径一行不动）。

## 7. 如果要动手，顺序建议

1. `sync_stream.rs` 的两个纯函数（帧解析、退避）＋ 单测 —— **先有判据**；
2. 订阅任务 ＋ `claim_config` 接线 ＋ 三条命令 ＋ `check-web-commands` 登记；
3. 前端 hook（去抖 ＋ 共用"拉一次"）＋ 设置项；
4. 真机/集成读数（判据 5）—— 这一步与 [CRDT 真机双设备验收](2026-09-23-crdt-full-launch-sprint.md) §11.9 可以**一次做完**。
