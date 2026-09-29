# 需求：正文「真实时」—— 同一空间多台设备之间的正文即时可见

> 行号钉在：`a5c0f614`（2026-09-29）｜核查方式：`git show a5c0f614:<path> | sed -n '<起>,<止>p'`
> ⚠️ 本份写于 `d021948c` 之前 ⇒ 其"局域网档 5 分钟"前提已作废；
>   ⚠️ 补记：那条缺的线**已经补上了**（`dfa79e1a`：编辑信号 ⇒ 防抖 400ms ⇒ 立刻上传）⇒ 下面那句「缺」也已作废。
>   **真正的缺口见本份 §9 补记**（缺的是【上传侧触发】那一条线，不是缺通道；下载侧已经实时）。
> 起草：macOS 侧｜**2026-09-29**｜依据：`_workspace/AI-NATIVE-DEV.md` §5.1（规格层）＋ 本仓 [`docs/specs/README.md`](README.md)
> 关联：[规格 `2026-09-29-realtime-body-spec.md`](2026-09-29-realtime-body-spec.md)（什么不许变）·
> [方案 `2026-09-29-realtime-body-approach.md`](2026-09-29-realtime-body-approach.md)（怎么落）·
> [任务 `2026-09-29-realtime-body-tasks.md`](2026-09-29-realtime-body-tasks.md)（谁做什么）
> 上游事实源：[CRDT 全上线冲刺](../plans/2026-09-23-crdt-full-launch-sprint.md)（§11–§16 是实况；§2/§9/§10 是各自当时的记录）·
> [同步机制](../SYNC.md) §五（"实时"到底是什么）·
> [桌面近实时流通道设计稿](../plans/2026-09-23-desktop-near-realtime-stream-design.md)
> ⚠️ 本文是**需求**（为什么做、做成什么样、什么不算）。**不变式在规格那份、落地顺序在方案那份、任务在任务那份**，四份不互相抄。

---

## 0. 一句话

> **小明这边在正文里打了字，小王那边（同一个空间、同一张页）应当自己冒出来 —— 不用谁去点「同步」。**

而这句话里有**三个必须分开回答的问题**，任何一个含混，"真实时"就会变成一句读起来很安心、其实没人守的话：

1. **"实时"是多少毫秒？** —— 今天同一个词同时指着三个差 300 倍的数字（毫秒／30 秒／5 分钟，见 §2）。
2. **"正文"的边界在哪？** —— 今天**只有正文**走 CRDT；标题／父节点／排序／图标走 HLC ＋ 页级 LWW（§3）。⇒ "全部实时"从数据模型上**只成立一半**。
3. **没有服务端时，谁算"首写者"？** —— owner 的场景是**纯局域网、没有服务端**，而今天的首写者裁定**必须有服务端**（§4）。⇒ 这一格必须正面回答，不许绕过。

---

## 1. owner 的场景（逐字转述，不加工）

> 小明开热点，小明笔记本和小王笔记本都连上这个热点。
> 小明在「项目A」里的某张页面上改正文，**小王那边应当几秒内自己看到**。
> 而不是今天这样：要么点「同步」，要么等轮次。

三条**必须同时成立**的属性：

1. **零动作**：接收侧**不点任何按钮**、不刷新、不切页；
2. **只对正文**：这条承诺**只覆盖正文内容本体**（其余字段按 §3 的既有口径走，不在本条承诺里）；
3. **同一空间**：两台设备在**同一个空间**（同一个 `space_id` 的那套档案）上。

---

## 2. 「实时」这个词今天的三个含义（**这是本需求必须先钉死的东西**）

代码里"多久能看到对端的改动"**不是一个数**，而是三档，且**没有任何一处把这个差说清楚**：

| # | 触发 | 多久 | 出处（逐字可核） |
|---|---|---|---|
| 1 | **服务端 SSE 变更流**推一帧 ⇒ 立刻拉一次 | 理论**秒级**（实际＝"服务端什么时候发这一帧"） | `src-tauri/src/sync_stream.rs:122` `stream_url` ＝ `{server}/spaces/{space_id}/changes-stream`；桌面 `sync_stream_start` 要求**有绑定**（`sync_stream.rs:341-348`：解析不到 `claim_config` 就回 `reason:"no-binding"` 不跑）；Web 侧见 `src/hooks/useSyncStream.ts:115-125` |
| 2 | **自动同步定时器**（"按间隔"档） | **30 秒** | `src/lib/syncMode.ts:25` `SYNC_INTERVAL_MS = 30_000`；定时器挂载在 `src/App.tsx:524-525`（`setInterval(tick, autoSyncMs)`；`tick` 在 `:523` 转调模块级的 `runAutoSyncRound`，防重入是 `:144` 的 `syncRoundBusy`），启动后 3 秒先跑一次（`App.tsx:527-528`，`setTimeout(tick, 3000)` 在 `:528`） |
| 3 | **"近实时"档的兜底轮询** | **5 分钟** | `src/lib/syncMode.ts:28` `SYNC_REALTIME_FALLBACK_MS = 5 * 60_000`；`syncMode.ts:198-213` `effectiveAutoSyncMs()`：**近实时开着而间隔键没写过 ⇒ 返回 5 分钟**（默认就是这一态） |

⚠️ **关键区分（决定了本需求的工作量下限）**：上面三档**全部驱动的是"服务端那条路"**（`api.syncWorkspace`）。

- 桌面 SSE 那一帧触发的是 `api.syncWorkspace(wsId)`（`src/hooks/useSyncStream.ts:54-78`，`pullOnce`），**它不跑网格**；
- 网格（丙档、对等直连）**只在两处被跑**：① 用户点面板「同步」时的 `finally`（`src/components/SyncPanel.tsx:584-612`，含"必须放在 finally 里"的真机教训注释 `:588-591`）；② `App.tsx` 自动同步定时器的每一轮（`App.tsx:167`）。**没有任何"推送"会触发网格。**
- ⇒ **纯局域网这一档下，正文的可见延迟就是那个定时器的间隔**：默认 **5 分钟**，选「按间隔」档是 **30 秒**。这就是"现在要么点同步、要么等轮次"的**确切机制**。

**⇒ 需求侧的结论**：**"实时"必须写出一个数**，且必须说清它**挂在哪一条路上**。见 §5。

---

## 3. 边界：**只有正文是 CRDT**，非正文走 HLC ＋ 页级 LWW

> 这一条不是"实现细节"，是**数据模型的事实**，必须写进需求边界 —— 否则"全实时"会被读成承诺，而它从模型上就不成立。

| 内容 | 合并模型 | 出处 |
|---|---|---|
| **正文内容本体**（顶层块的文本、块身份） | **CRDT**（Yjs／`page_crdt` 状态 BLOB，客户端合并） | `page_crdt(page_id, state BLOB, updated_at)`：TS `src/lib/platform/sqliteStore.ts` ＋ Rust `src-tauri/src/db.rs`（冲刺 §2 的 S2b 行）；合并入口 `src/lib/crdt/pageBinding.ts:183` `mergeRemotePageState`（定义只许有一处，由 `scripts/check-crdt-plane.mjs` 判据④钉住） |
| **标题 / 父节点 / 排序 / 图标 等页面级字段** | **HLC 戳 ＋ 页级 LWW**（`hlc::verdict`），**不合并** | `src-tauri/src/sync.rs:209-238` `record_page_upsert`：**只挂页 upsert** 这一条路（原注释逐字：「只挂**页 upsert** 这一条路（丙的页级 LWW 就是改它）；附件与页删除的路今天不动」）；`sync.rs:305-...` `apply_upsert` 与 `UpsertApply::{Applied, KeptLocal}`（`sync.rs:251-262`） |
| **块级 LWW / 补算器** | 过渡量，**今天拆不了**（桌面没有 Yjs，收下的状态要靠界面侧合并） | 冲刺 §11.5（三条理由）＋ §13.1（桌面"收下状态"那一半） |

**⇒ 需求边界（写死在这里）**：

1. 本轮承诺的"实时"**只覆盖正文内容本体**；
2. **不许**在文案、文档、验收里把"正文实时"说成"全部实时" —— 标题改了、拖动排序了，仍然按页级 LWW 收敛（**可能就是"后改的赢"**）；
3. **非正文的"实时"如果将来要做**，是**另一条线**（要么给页级字段也上 CRDT，要么接受 LWW），本文不做。

> ⚠️ **一条口径的精确化（免得被读歪）**：第 2 条说的"非正文不是实时"指的是**合并模型**，
> **不是**"标题传得慢" —— 标题与正文是**同一条页 upsert**（`src-tauri/src/sync.rs:209-238`），
> 所以它们的**到达延迟是同一档**（需求 §2 那张表的三个数）。
> **差别在"同时改谁赢"**：正文**合**（两处都在），标题走**页级 LWW**（后到的戳赢，可能覆盖）。
> ⇒ 说全应当是：**"它到得一样快，但它不合并"**。

---

## 4. ⚠️ 必须正面回答的那个洞：**没有服务端时，"首写者"怎么裁定？**

### 4.1 洞是什么（事实链，每条可当场复核）

**今天"要不要建一条血统"的决策树**（`src/lib/crdt/bootstrap.ts:37-48` `decideBootstrap`）：

```text
本地已有状态                ⇒ load-existing（载入，不 claim）
没有状态 ＋ claim = granted  ⇒ mint（由本机建血统）
没有状态 ＋ claim = denied   ⇒ wait-for-remote（不建，抛出去让调用方如实报）
没有状态 ＋ claim = unavailable ⇒ mint-provisional-offline（照旧建，标记为"未裁定"）
```

而 `claim` 端口**只有在能跟服务端说话时才存在**：

- HTTP 端口 `createHttpClaimPort` 打的是 `{server}/lineage-claim`（`src/lib/crdt/claimClient.ts:27` `LINEAGE_CLAIM_PATH = "/lineage-claim"`）；
- 平台侧选服务端与**远端** `space_id` 的唯一一处是 `src/lib/crdt/claimScope.ts:61-70` `resolveWorkspaceSyncScope`：**档案里缺 `server_url` 或缺 `space_id` ⇒ 返回 `null`** ⇒ 上层 `web.ts:1524`／`sync.rs` **连请求都不发**，直接回"用不了"；
- 用不了 ⇒ `claimVerdict` 归一成 `unavailable`（`src/lib/crdt/bootstrap.ts:56-66`）⇒ 走 `mint-provisional-offline`。

**⇒ 所以纯局域网（小明开热点、两台笔记本、没有服务端、只配了网格）里：**

```text
两台设备同时首开同一张「从没建过血统」的页
  ⇒ 两台都拿不到 claim（根本没有服务端可问）
  ⇒ 两台都走 mint-provisional-offline（各自建一条血统）
  ⇒ 对端那一版到达时撞上 S8 血统护栏
  ⇒ mergeRemotePageState 拒绝合并（pageBinding.ts:183-227，两条独立血统 ⇒ 记 page_lineage_conflicts ＋ 返回 lineageConflict）
  ⇒ **实时推送做得再好，推过去也合不了**
```

**这不是"可能发生"，是必然发生** —— 只要两台设备在**任何一次同步之前**各自打开过同一张新页。而这恰好是 owner 场景的**第一分钟**。

### 4.2 诚实的定性（先写这一句，免得下面七个方案读起来像"都很便宜"）

> **在纯局域网、没有服务端、且两台设备从未交换过这张页的状态的条件下，"首写者"这个事实在分布式系统里【不存在唯一的真值】。**
> 任何"可判定的确定性规则"都只能**在多个都不坏的选择里挑一个**，代价是**另一台的那一版必须被安放到别处**（这正是 `page_lineage_conflicts` 那三个选项存在的理由：留本机／用对端／另存为新页，`src/components/LineageConflictBanner.tsx` 三个按钮都在）。

⇒ 所以下面七条**没有一条是"免费的"**；每条我都给出**代价**与**它承诺了什么、不承诺什么**。

### 4.3 七个可选方案（**每个都带代价**）

| # | 方案 | 机制（落在哪） | 代价（如实） | 能承诺什么 |
|---|---|---|---|---|
| **A** | **本轮不解决这一格**：只做"有服务端时的真实时"＋"局域网里已有血统的页的真实时" | 不改血统决策；只加传输层触发（方案 §2） | ⚠️ **owner 的场景会被"第一分钟"卡住**：两台同时首开新页 ⇒ 就是今天那个护栏挡住。⇒ **必须在需求里显式写出这条留白**，并**在界面上说清**（不是只在文档里） | 有服务端 ⇒ 秒级；局域网已有血统 ⇒ 秒级；局域网同时首开新页 ⇒ **不承诺** |
| **B** | **一份"对端名册"当裁定输入**：claim 端口在没有服务端时，由**发现层那张对端表**提供一份候选名单，用**确定性的字典序**挑最小值 | 名册＝`lan_state` 的对端表（`src-tauri/src/lan.rs:65-84` `LanAnnounce`：每台都报了 `device_id`）；规则＝"候选里 `device_id` 最小的那台建血统，其余 `wait-for-remote`" | ① **双方的选择必须一致** —— 两端看到的名册不同（A 看得见 B、B 看不见 A，热点主机那一轮最多要等一个广播间隔，`lan_state.rs:245` `ANNOUNCE_INTERVAL_MS = 30_000`）⇒ **规则会算出两个不同的赢家**，护栏照样命中；② 名册里**必须包含自己**才判得出"我是不是最小"，而"我是不是最小"在只有一台时恒真 ⇒ 幂等但不能防"同时"；③ 需要一条**新的平台读数**（名册是"附近设备"那份文档要上抛的东西，见 §6） | 名册稳定（双方互相看见）⇒ 只有一台建血统；名册不稳 ⇒ **两条都建、护栏兜底**（不比 A 差） |
| **C** | **由已持有血统的一方广播**（谁先建成功谁说） | 复用发现层那条 UDP 通道发一条"我建了第 N 页的血统"的报文（形状仿 [`2026-09-29-nearby-devices-spec.md`](2026-09-29-nearby-devices-spec.md) §5.2 的 `NearbyInvite`） | ① **要动协议**（新报文类型 ＋ 版本号）；② **广播会丢** ⇒ 收不到的那台照样建 ⇒ 仍需护栏兜底；③ **有延迟**：先建的那台广播出去要一个往返，而对面可能已经在同一毫秒里建了 | 广播能到 ⇒ 大幅降低同时建的概率；广播丢失 ⇒ 退化成 A |
| **D** | **不可判定的当合**：给"血统指纹不同但内容同源"开一条受控通道（例如要求两份状态的**投影逐字节相同**才许合） | 改护栏的判据（`src/lib/crdt/pageBinding.ts:132-139` `lineagesRelated`） | ⚠️ **这就是 S1 红线**：两份各自从同一份 JSON 新建的状态，投影**本来就相同**，硬合的结果是实测过的 `["paragraph#blk-1","paragraph#blk-1"]`（冲刺 §1 判据①）—— **一块变两块、`blockId` 重复** ⇒ 块引用／反链当场失效。⇒ **这一条要写死在"不做"里**，除非有新的判据证明不翻倍 | 不承诺（这一条是反模式，列出来是为了**堵住**它） |
| **E** | **"首开只建一次"改成"首开只建一次 ＋ 只由**页面的创建者**建"** | 页面行里已经有 `created_at`／设备信息（`meta.workspaces` 与 `pages` 那一族）；规则＝"这一页不是本机创建的 ⇒ 不建，等对端" | ① **要判得出"这页是不是本机创建的"** —— 本机**没有**这个字段（`pages` 里没有 `created_by_device`，**待查** §7-1）；② 这一页如果是**在 Web 上**或**导入**进来的，创建者信息可能不存在 ⇒ 退化成 A；③ 反方向：**只有本机创建过的页才许首开**，会让"别人发给我一张新页、我离线打开"这条**直接变空页**（那比现在更坏） | 同一台机器创建 ⇒ 只有它建；其余 ⇒ 退化成 A |
| **F** | **承认"这一格这一轮不解决"，但把出口做完整**：护栏命中时**给用户三个真实选项**（留本机／用对端／另存为新页） | 已经在仓里：`page_lineage_conflicts` 表 ＋ `LineageConflictBanner`（`src/components/LineageConflictBanner.tsx`，三个按钮分别 `"local"` `:94` / `"remote"` `:84` / `"saved-as-new"` `:58`） | ⚠️ 代价不在实现，在**语义**：用户必须**自己裁**（这是"不默认选边"的纪律，`src-tauri/src/lineage_conflict.rs:14`）；且**"用对端"是不可逆的**（清掉本机血统，`LineageConflictBanner.tsx:66-75` 一带的注释逐字「本机那份可合并的编辑历史就此没了」） | **不承诺自动**；承诺"两版都不丢、用户能选"（这正是今天已有的能力，F 是**把它说清楚**，不是新做） |
| **G** | **局域网里长出一个"准服务端"**：某台设备（开热点的那台）充当裁定者 | 要新造一个"局域网内的 claim 端点"＋ 谁当裁定者的选举 | ⚠️ **这是甲-2「内嵌接待窗口：客户端自己发号牌 ＋ 留账本」**，owner **2026-09-25 已冻结**（[`2026-09-29-nearby-devices-requirements.md`](2026-09-29-nearby-devices-requirements.md) §9 最后几行逐字：「甲-2（内嵌接待窗口：客户端自己发号牌 ＋ 留账本）｜**owner 2026-09-25 已冻结**」）。⇒ **本轮不许重启它**；列在这里是为了**说明它为什么不在候选里** | 不承诺（被 owner 冻结） |

### 4.4 本需求**推荐的组合**（要 owner 点头，见 §7 待查）

> **A ＋ F（本轮）＋ B（下一轮，且以"附近设备"那份文档的读数为前置）**

理由三条，都是既有事实：

1. **F 已经在仓里且是真的**（不是"待做"）：护栏命中会落 `page_lineage_conflicts`（`src/lib/crdt/pageBinding.ts:213-221` `recordLineageConflict`）＋ 三选项横幅真的会动数据（`saveAsNew` 真的 `createPage`、`adoptRemote` 真的 `writePageProjection` ＋ 清状态）。⇒ **"两个都不丢"这条底线今天成立**；
2. **B 的前置不在本轮**：它要"对端名册"，而对端名册的**唯一来源**是同一张发现层表 —— 那份工作归 [`2026-09-29-nearby-devices-spec.md`](2026-09-29-nearby-devices-spec.md) §3.1 的 `LanStatus.nearby`（今天只有 `peers: usize`，`src-tauri/src/sync.rs:3489`）。**先有列表，才谈得上"按名册裁定"**；
3. **G 被 owner 冻结、D 是反模式** ⇒ 候选面收窄到 A/B/C/E/F，而**C 要动协议**（本轮零协议的代价最低）。

⚠️ **但推荐 ≠ 决定**。这一格**必须 owner 拍**，因为它的代价是**用户可见的**（"小明和小王同时打开一张新页时会发生什么"，答案可能是"各看到一版，界面上让你选"）。拍之前不许把 A 写成"就这样"。

---

## 5. 可验收的定义（"实时"到底指什么）

### 5.1 两个延迟目标（**R-1 现在就有，R-2 要新触发**）

| id | 目标（**可断言**） | 今天能不能成立（读数） | 成立的前提 |
|---|---|---|---|
| **R-1** | 在**`按间隔`档（用户选了 30 秒）**（`syncModeOf` ＝ `"interval"`，`src/lib/syncMode.ts:106-109`）下，一端改正文，另一端**不点任何按钮**，**≤ 30 秒**内看到 | ✅ **成立（只在这个档位成立，不是默认档）**（"按间隔"档就是 30 秒，`src/lib/syncMode.ts:25`；定时器在 `src/App.tsx:524-525`，且每一轮**顺手跑网格**，`App.tsx:167`） | 发现层能看到对端 ＋ 网格已配（`isDesktopPlatform() && lanStatus && activeRow.space_id`，`src/components/SyncPanel.tsx:1535-1538` 的门槛，**门槛一个字没改**） |
| **R-2** | 同上场景，**≤ 5 秒** | ❌ **不成立**（默认档位的兜底是 5 分钟；SSE 那条路**只在有服务端时**有，且**不跑网格**） | 需要新的触发（方案 §2），或把档位改成"按间隔"（那是**用户自己**把间隔调小，不是"实时"） |

> ⚠️ **2026-09-29 13:47 起已作废**（`d021948c`，比本份晚 12 分钟）：局域网这一档的间隔
> 已被 owner 改成 **5 秒**，实现是 `src/lib/syncMode.ts:71` 的 `PULL_INTERVAL_DEFAULT_MS = 5_000`
> （`a5c0f614` 上它还多了一个用户可见的三档设置 `PULL_INTERVALS`／`PULL_INTERVAL_KEY`）。
> ⇒ **R-2 的结论作废**（"❌ 不成立"这个判定不再成立）；上面那句"默认值 5 分钟"也不再成立。
> 原文保留，是留痕。
> ⚠️ 而**真正缺的那半不在这里** —— 见本份 **§9 补记**：缺的是【**上传侧触发**】那一条线
> （下载侧已经实时 16ms），不是缺通道、不是缺 CRDT。
> ⚠️ 又记：`dfa79e1a` 已把那条线**补上**了（编辑信号 ⇒ 防抖 400ms ⇒ 立刻上传）⇒ §9 那句「缺」今天也已作废。

> ⚠️ **不许把 R-1 说成 R-2。** 今天 30 秒那个数是**"按间隔"档的一个用户可选项**，而**"近实时"档的默认值是 5 分钟**（`src/lib/syncMode.ts:198-213`）。owner 的"几秒内"= **R-2**，它需要新工作。（同上：这一句里"默认值 5 分钟"已作废，见上。）

### 5.2 「正文」的边界（**可断言的形状**）

一次"正文改动"＝ 编辑器里**顶层块的文本或块身份**发生变化。可断言的三件事（都是既有实现能给的）：

1. 它有 `onLocalEdit` 信号（`src/lib/crdt/pageBinding.ts:57` 的 `onLocalEdit`；S3b-1 的承重判据⑨⑩，冲刺 §2）；
2. 它会被落成 `page_crdt` 的新状态（`src/editor/Editor.tsx:573-578`：`onLocalEdit ⇒ b.persist()` ⇒ `api.savePageState`）；
3. 它会被挂进 outbox 的页面载荷（`src-tauri/src/sync.rs:209-238` `record_page_upsert` 读 `page_crdt` 并 `with_wire_state`）。

**⇒ 不属于"正文"的（本条不承诺）**：标题、父节点、排序、图标、附件、标签、属性、数据库视图结构（见 §3 表）。

### 5.3 验收场景（**能照着演**）

#### 场景 A（硬目标）：纯局域网、两台设备、同一空间、**已有血统**的页

**器材**：小明笔记本（macOS 桌面版）＋ 小王笔记本（桌面版）。小明开热点，两台都连上。同一个版本。**同一个空间**（`space_id` 一致），**网格已配**（各自填了本机 `IP:端口` 与同一个口令 —— 门槛见 `SyncPanel.tsx:1535-1538`）。

| 步 | 在哪台 | 动作 | 预期读数 |
|---|---|---|---|
| A1 | 两台 | 各自打开**同一张页**（这张页此前已经过一次同步 ⇒ 两台都有血统） | 面板不出现血统冲突横幅（`LineageConflictBanner` 不渲染） |
| A2 | 小明 | 在正文里打一段字 | 小明这边：`page_crdt` 当场更新（`Editor.tsx:573-578`）；≤ 600ms 后 `save_page` 落一条带 `crdt_state` 的 `changes` 行（`src/App.tsx:431` 的去抖 ＋ `sync.rs:209-238`） |
| A3 | 小王 | **什么都不做** | ≤ 30 秒（R-1）看到那段字。⚠️ **若要求 ≤ 5 秒（R-2），必须先落方案 §2 的那一片**，否则这一格**必定失败**，而失败原因**不是 bug，是没做那一片** |
| A4 | 小王 | 也改一处（**不同的块**） | 小明那边同样收敛；两侧内容**都在**（不是覆盖）—— 这是 CRDT 的定义行为（`pageBinding.ts:183` `mergeRemotePageState`；S4a 判据⑯⑰，冲刺 §2） |

**A 的"做成"读数**：A2 → A3 的**墙上时间**（秒表／日志时间戳），且**接收侧全程零操作**。

#### 场景 B：纯局域网、**两台同时首开一张从没建过血统的新页**（**就是 §4 那个洞**）

- **今天的必然结果**：两条独立血统 ⇒ 护栏拒绝合并 ⇒ 两边各自看到**自己那一版**，且**各自收到一次留痕／提示**（`pageBinding.ts:207-225` 的 `console.warn` ＋ `recordLineageConflict`；`Editor.tsx:568-572` 的 `toast`）。
- **本轮期望**：**如实发生 ＋ 如实报出 ＋ 用户能选**（F 那三个选项），**不是**"悄悄合并"。⇒ 这个场景是**"不算做成"的对照**（写在 §8），用来防止把 A 的成就算到它头上。

#### 场景 C：有服务端（对照，说明 R-2 在另一条路上已经接近成立）

- 两台都绑了同一个同步服务 ⇒ SSE 流起来（桌面 `sync_stream.rs:324-348`；Web `useSyncStream.ts:118-125`）⇒ 服务端推一帧 ⇒ 立刻拉一次。
- ⚠️ **但仍然不跑网格**（`useSyncStream.ts:54-63` 的 `pullOnce` 只调 `api.syncWorkspace`）⇒ 有服务端时"正文实时"靠的是**服务端那条路的 CRDT 状态搬运**，与网格无关。

#### 场景 D（**本机可演**，用于 R-1 的机械验收）：两个库 ＋ 真环回

- 形状有现成先例：`mesh::tests::two_clients_converge_over_real_loopback_with_no_hub_and_no_server`（本机实测 **23 passed / 0 failed**，见 §6）⇒ 两个库、没有服务端进程、TCP 走真环回、互换一笔改动后两侧投影逐字节相同。
- **但它验的是"能收敛"，不是"多久收敛"** —— "多久"由**触发频率**决定，而触发频率在纯局域网里就是那个定时器（§2）。⇒ 这一条要**另立计时读数**（规格 §4 给形状）。

---

## 6. 现状（已核到代码的既有事实 —— 每条都能当场复核）

> 这一节只写**既有**事实，用途是给规格与方案当底座。**不写愿望。**
> 下面每条都是我**这一轮亲自跑过／读过**的；我在 §8 列出**与转述不一致**的地方。

### 6.1 传输层

| # | 事实 | 出处 |
|---|---|---|
| 1 | 网格是**拉取式**：`GET /mesh/pull?space_id=…&since=<发送方自己的 device_seq>&limit=…`，**没有推送侧** | `src-tauri/src/mesh.rs:265-273` `pull_from_peer` 拼的 URL；`mesh.rs:682` 路由表只认 `"GET" if path == "/mesh/pull"`；服务侧 `mesh.rs:84-107` `serve_own_records` 是 `SELECT … WHERE device_id = 我 AND device_seq > ?` |
| 2 | **游标是对端水位**（KV `mesh_cursor:<空间>:<对端>`），**只许前进** | `mesh.rs:116-141`（`cursor_key` / `peer_cursor` / `set_peer_cursor`，倒退当场报错） |
| 3 | 网格**只服务自己产生的记录**（没有账本） | `mesh.rs:78-86` 注释逐字「这就是"没有账本"」 |
| 4 | 网格**不发任何事件给界面** | `grep -n "emit\|AppHandle" src-tauri/src/mesh.rs` ⇒ **0 处**（本轮实测） |
| 5 | 服务端 SSE 端点**是服务端的**：`{server}/spaces/{space_id}/changes-stream` | `src-tauri/src/sync_stream.rs:122-124`；桌面起流要 `claim_config` 解析出绑定，否则 `reason:"no-binding"`（`sync_stream.rs:341-348`） |
| 6 | ⇒ **纯局域网这一档用不上 SSE**（它连的是 `server`；没有服务端就没有中枢可代言） | 同上 ＋ [`2026-09-29-nearby-devices-spec.md`](2026-09-29-nearby-devices-spec.md) §5.5 末（网格不经服务端） |

### 6.2 触发频率（**这就是"实时差的那第二半"**）

| # | 事实 | 出处 |
|---|---|---|
| 7 | 网格只在**两处**被跑：面板「同步」的 `finally`、自动同步定时器每一轮 | `src/components/SyncPanel.tsx:584-612`（＋ 注释 `:588-591`："**必须放在 finally 里**"的真机原因）；`src/App.tsx:167` |
| 8 | 面板里那个 **5000ms** 定时器**只读读数、不拉数据** | `src/components/SyncPanel.tsx:179-205`：`tick` 只调 `api.lanStatus(activeId)` 并 `setLanStatus`；`setInterval(..., 5000)` 在 `:201`（`tick` 在 `:183`） |
| 9 | 自动同步的间隔：`"off"` ⇒ 不挂；`"interval"` ⇒ **30 秒**；`"realtime"` ⇒ **5 分钟兜底** | `src/App.tsx:508-534`（读 `effectiveAutoSyncMs()`）＋ `src/lib/syncMode.ts:106-122` / `:198-213` |
| 10 | 桌面那条 SSE 流**只驱动服务端那条路**，**不驱动网格** | `src/hooks/useSyncStream.ts:54-63`（`pullOnce` 里只有 `withSyncStatus(… api.syncWorkspace(wsId))`）＋ `:80-95`（桌面分支只调 `syncStreamStart(wsId)`） |
| 11 | 两条路都必须过 **C2 网络闸门**（一处实现） | `src/lib/syncGate.ts:22-30`（`shouldAutoSyncNow` 在 `:26`）；调用点 `App.tsx:149`、`useSyncStream.ts:58` |

### 6.3 血统与 claim

| # | 事实 | 出处 |
|---|---|---|
| 12 | 四条决策分支 | `src/lib/crdt/bootstrap.ts:37-48` `decideBootstrap` |
| 13 | claim 端点是**服务端的**，路径**没有 `/sync` 前缀** | `src/lib/crdt/claimClient.ts:27` `LINEAGE_CLAIM_PATH = "/lineage-claim"`（＋ `:19-26` 记着"部署后探针实测 404／401"那次现场） |
| 14 | 没有服务端／没选空间 ⇒ **连请求都不发**，回"用不了" | `src/lib/crdt/claimScope.ts:61-70` `resolveWorkspaceSyncScope`（缺任一件 ⇒ `null`） |
| 15 | `unavailable` ⇒ **离线临时建**（离线可用性不让路） | `src/lib/crdt/bootstrap.ts:56-66` `claimVerdict` ＋ `:43-47` 的第 4 支；`pageBinding.ts:429-430` 的 `mint-provisional-offline` 与上面的注释「仍是**未裁定**的」 |
| 16 | **S8 护栏**：两条**独立血统**拒绝合并，本机那版原样保留 ＋ 留痕 | `src/lib/crdt/pageBinding.ts:183-227`（`lineagesRelated` 判定 ＋ `recordLineageConflict` ＋ `console.warn`）；同一对纯函数也被端口版复用（`pageBinding.ts:350-372` 一带） |
| 17 | 留痕是**页级**的，且**含对端那一版的投影快照**（否则事后无从救援，因为待并状态随后被 `clearPending` 清掉） | 表 `page_lineage_conflicts`（`src-tauri/src/lineage_conflict.rs:25-33` `PageLineageConflict` 的 `remote_doc` 注释） |
| 18 | 三个裁决选项**真的会动数据**（不是"只记一笔"）：`saved-as-new` 真的建新页、`remote` 真的写回投影 ＋ 清本机状态 | `src/components/LineageConflictBanner.tsx:47-98`（`saveAsNew` `:47-62` / `adoptRemote` `:63-88` / `keepLocal` `:89-98`） |
| 19 | Rust 侧 `resolve_lineage_conflict` **只改状态列**（真正的动作在界面那三个函数里） | `src-tauri/src/lineage_conflict.rs:159-181`（`UPDATE … SET resolved_at, resolved_choice`） |

### 6.4 正文状态的存取与推

| # | 事实 | 出处 |
|---|---|---|
| 20 | 本地编辑 ⇒ **当场**写 `page_crdt`（不经 outbox） | `src/editor/Editor.tsx:573-578`（`onLocalEdit ⇒ b.persist()`）＋ `pageBinding.ts:396-398`（`persist()` ＝ `port.save(pageId, session.exportState())`）＋ `src-tauri/src/commands.rs:397-400` `save_page_state` |
| 21 | `save_page_state` **不写 `changes`**（不产 outbox 记录） | `commands.rs:396-400`：函数体只有一行 `crate::page_crdt::write_page_crdt_state(...)`（本轮逐行读过） |
| 22 | 页面**完整保存**才产 outbox 记录，且**那一刻**才去读 `page_crdt` 挂状态 | `commands.rs:535-566`（`save_page` → `record_page_upsert`）；`sync.rs:209-238` |
| 23 | 编辑 ⇒ `save_page` 之间有个 **600ms 去抖** | `src/App.tsx:420-431`（`debounceRef.current = window.setTimeout(` 在 `:428`）（`debounceRef` ＋ `window.setTimeout(..., 600)`）；卸载/切页会 flush（`App.tsx:457-466`） |
| 24 | ⇒ **今天的链路**：改字 →（瞬时）`page_crdt` →（≤600ms）`changes` 里那条带 `crdt_state` →（**取决于谁跑网格**）对端拉到 | 20/21/22/23 ＋ `mesh.rs:265-273` |
| 25 | 桌面收下对端状态进**旁路表**（按 `seq` 逐条留，上限 24），**打开页面时**才合并 | `src-tauri/src/sync.rs:274-303` `absorb_incoming_crdt_state`；`page_crdt.rs:82` `MAX_PENDING_PER_PAGE = 24`；`pageBinding.ts:336-...`（`readPending` ⇒ 先并后谈建血统） |
| 26 | 合并／承接之后**投影也要跟上**（否则反链／FTS 要等下次保存） | `pageBinding.ts:388-400` 一带（`writeProjection`）；Rust `src-tauri/src/doc_content.rs:145-173` `write_page_projection`。⚠️ **这个函数只写 `pages` 两列 ＋ 重建块图 ＋ 打 `text_stale`，也不产 outbox 记录**（本轮逐行读过） |

### 6.5 与本仓另两份在飞文档的关系（**它们改的是同一片地带**）

| 文档 | 它改什么 | 与本文的关系 |
|---|---|---|
| [`2026-09-29-nearby-devices-*.md`](2026-09-29-nearby-devices-requirements.md) | 给 `LanStatus` 加 `nearby: NearbyPeer[]`（把对端表上抛）＋ 邀请（动那条 UDP 协议） | **本文的硬前置**：① 它的 `nearby` 是"按对端触发"与 §4.3-B 名册的**唯一来源**；② 它明确规定 **`nearby` 里的字段名沿用 `LanStatus` 的 snake_case**（[spec](2026-09-29-nearby-devices-spec.md) §3.2「本轮选 snake_case」）⇒ 本文**不许**另起一套 |
| [`2026-09-29-crdt-mixed-version-degradation.md`](2026-09-29-crdt-mixed-version-degradation.md) | 混版本共存的三句地基（`content_json` 是 TEXT／状态只进 BLOB／Rust 不认识 CRDT） | **本文的红线出处**：`scripts/check-crdt-plane.mjs` 已经把这些判成机器判据（`scripts/lib/gates.mjs:105-117`，id `check-crdt-plane`）⇒ 本文任何改动**不许**碰这三句 |

---

## 7. 待查（**我没给你、我在代码里也没找到的** —— 明确写"待查"，不许编）

| # | 待查的事 | 怎么查 | 影响 |
|---|---|---|---|
| **D1** | 页面行里**有没有**"这一页是哪台设备创建的"这个事实 | `grep -n "created_by\|creator_device\|origin_device" src-tauri/src/db.rs src-tauri/src/commands.rs`（我这轮**没找到**任何一处；`pages` 的建表语句在 `db.rs`） | 决定 §4.3-E 可不可行 |
| **D2** | §5.1 的 **R-2（≤5 秒）** owner 要的到底是哪一个数（"几秒"能不能接受 5–10 秒？还是要"像 Notion 那样"） | **只能问 owner**（编码里没有这个数） | 决定方案 §2 要不要做"长连接／推送"那一档（成本差一个数量级） |
| **D3** | 纯局域网这一档**用户实际**会不会去改「同步方式」那个下拉（默认是"近实时"＝5 分钟兜底） | 无代码可查：这是产品/可用性问题。可查的部分：`syncModeHint("realtime")` 的文案（`src/lib/syncMode.ts:131-135`）现在说的是**"连着同步服务时…"** —— 它**默认没在说局域网** | 决定"什么都不做、只改文案"能不能算 A 方案的一部分 |
| **D4** | 网格窗口**收到一次 pull** 时，能不能顺手把"有人来拉过我"这件事变成界面可见的读数（"对方来过"） | 现有材料：`peer_cursor` 只写在**收侧**（`mesh.rs:120-141`）；而"被拉过"发生在**服务侧**（`serve_own_records`，`mesh.rs:84`）—— 我看不出服务侧有没有地方记它。⇒ `grep -n "window_addr\|serve\|accept" src-tauri/src/mesh.rs` 通读那一圈 | 决定"要不要把'对端已看到'做成读数"（不是本需求的必要条件，但它是"实时"的**反馈面**） |
| **D5** | `vitest` 在本机**能不能**跑起来（本轮**没跑成**，见 §6.6 的环境读数） | `node_modules/.pnpm` 里有 `@rolldown/binding-darwin-arm64@1.2.5`，但 `dlopen` 失败（报错被截断）；bundled node 是 **v24.21.0**，`process.versions.modules = 137`。⇒ 试另一份 node（`nvm`／系统 node）或 `pnpm install --force` | 决定"本机可验"的边界：**CRDT 那一层全部判据今天在这台机上跑不了**，方案里所有 `vitest` 读数都要标"未跑" |
| **D6** | `_workspace/criteria-mutations.json` 在**本机哪里** | `find ~/zhai -name criteria-mutations.json -not -path "*/node_modules/*"` ⇒ 本轮只找到 `/Users/shuyo/zhai/repos/shuyo-community/scripts/criteria-mutations.json`（**另一个仓**） | 决定"跑 cargo 的判据"那本账怎么写（[`docs/specs/README.md`](README.md) §每条不变式的四个字段 把它列为承重证明通道之一） |

---

## 8. 我读到的、与给我的描述**不一致**的地方（逐条，最重要）

> 这一节是**核对结果**，不是复述。每条都给可核读数。

| # | 给我的描述里是这么说的 | 我核到的是 | 出处／读数 |
|---|---|---|---|
| 1 | 「`src-tauri/src/sync.rs:3274` 的 `pub struct LanStatus` 里只有 `peers: usize`」 | ❌ **已漂**：`pub struct LanStatus {` 在 `a5c0f614` 上是 `:3483`（`daac8e1e` 之前才是 `:3274`），`pub peers: usize,` 在 `:3489`。**但**"只有"也要补一句：还有 `enabled` / `kind` / `line` / `mesh`（`sync.rs:3484-3502`） | `sync.rs:3483-3502` |
| 2 | 「`isDesktopPlatform()` 的源码注释在 `src/lib/platform/index.ts:31-41`」 | ❌ **行号不准**（且原引的 `:31-41` 也过期）：`isDesktopPlatform` 在 `a5c0f614` 上是 **`:39-41`**（注释 `:31-38`；`isTauri()` 在 `:27-29`）。而 `:37-38` 那句才是"用下面那些**具体能力**函数，别拿这个当近似" | `src/lib/platform/index.ts:31-41` |
| 3 | 「`S9`（实现完成、**待发版**）」 | ❌ **已过期**：**已发版**，且**发版后探针实测过**；另外路径也比 `S9` 写的短一截（`/lineage-claim`，**没有** `/sync`） | 冲刺 §11.6 的四行读数（`POST https://shuyo.cn/sync/lineage-claim -> 401`）；`claimClient.ts:19-27` |
| 4 | 「§10.3 的 7 条缺口是**你的前置清单**」 | ❌ **§10.3 整张表已过期**（冲刺开头的**现状指针** `:9-14` 就是这么写的）。逐条实况见本文 §9 | 冲刺 §11–§16 |
| 5 | 「桌面侧 claim（Rust `reqwest` 发同一端点）＋ 撤掉 `WEB_ONLY` 登记」 | ❌ **两件都已做完**：`claim_page_lineage` 在 `src-tauri/src/sync.rs:1903` 一带（reqwest）＋ 登记**已撤** | `scripts/check-web-commands.mjs:111-119`（`WEB_ONLY_COMMANDS` 现在只剩 **2** 条：`request_persistent_storage` / `export_wiki`，注释里逐字写着"第 41 轮撤登记"）；冲刺 §11.1 |
| 6 | 「"页所属空间"传准（现在编辑器用 `getActiveWorkspaceId()` 近似）」 | ❌ **已收口**：编辑器现在**先**用**这一页自己的** `workspace_id`（`api.getPage(id)`），`getActiveWorkspaceId()` 只是**取不到时的回落** | `src/editor/Editor.tsx:530-551`（注释逐字"★ S9：用**这一页自己的工作空间**…而不是'当前工作空间'"）；冲刺 §11.7 |
| 7 | 「`S7-3` 两侧都接 ＋ 真机验收（要人手）」 | ✅ 一致（**仍未做**） | 冲刺 §11.9 第 1 条 |
| 8 | 「Rust 成对判据执行（`STATUS_ENTRYPOINT_NOT_FOUND`）是 §10.3-⑤ 的已知环境问题」 | ❌ **在 macOS 上不成立**：本轮 `cargo test --lib` **跑起来了**（719 passed / 1 failed / 20 ignored，166s）。那个 `0xC0000139` 是**Windows** 的事，且冲刺 §11.2 已给出根因（测试 exe 没有应用清单） | 本轮实测（§6.6）＋ 冲刺 §11.2（"别再重复把 pdfium.dll 放到 target/debug 旁边那类实验"） |
| 9 | 「yrs 对拍尖刺」列为缺口⑥ | ❌ **已做**，结论"格式层可行" | 冲刺 §11.3 ＋ [`2026-09-23-yrs-interop-spike-conclusions.md`](../plans/2026-09-23-yrs-interop-spike-conclusions.md) |
| 10 | 「网格那一轮现在是**点「同步」时在 `finally` 里跑一次** `meshSyncNow`」 | ⚠️ **不完整**：还有**第二条**触发 —— `App.tsx` 自动同步定时器的**每一轮**（`:167`）。而**真正的**问题是这一条：**桌面 SSE 那条流不驱动网格**（`useSyncStream.ts:54-63`）⇒ 于是纯局域网这一档的可见延迟**等于定时器间隔**（默认 **5 分钟**，不是 30 秒） | `App.tsx:167` ＋ `useSyncStream.ts:54-63` ＋ `syncMode.ts:198-213` |
| 11 | 「面板里那个 5 秒定时器只读读数」 | ✅ 一致（已重钉）：`:201` 的 `setInterval(…, 5000)` 只调 `api.lanStatus` | `SyncPanel.tsx:179-205` |
| 12 | 「`sync_stream.rs`（872 行）」 | ✅ 一致：**872** 行 | `wc -l` |
| 13 | 「`src-tauri/src/lan.rs` 的 `LanAnnounce`：`device_id`/`device_name`/`hub_base`/服务哪些空间」 | ✅ 基本一致，**字段名是 `hub_spaces`**，且**还有一个 `fp`**（`＝ device_id`，owner 2026-09-25 拍板） | `lan.rs:65-84` |
| 14 | （冲刺 §9.1/§10.4 记的）「`test:sync-verify` 84/0」 | ⚠️ **数字过期**：本轮实测 **91 通过 / 0 失败** | 本轮实跑 `node scripts/verify-two-device-sync.mjs` |
| 15 | （冲刺 §13.2 记的）「`check-web-commands` ⇒ Rust 244 / web 245 / CommandMap 246」 | ⚠️ **数字过期**：本轮实测 **Rust 260 / web 250 / CommandMap 262（web 专属 2）** | 本轮实跑 `node scripts/check-web-commands.mjs` |
| 16 | （冲刺 §9.1.1 记的）「`vitest` 全量 202 文件 / 2117 条」 | ⚠️ **偏少**：`git log` 最近一笔 `2d5eebd5` 又加了四份文档；而**仓库根 `docs/specs/` 下现在是 12 个 `.md`**（含本轮新增前是 9 个）。数字别抄，跑命令 | `ls docs/specs/*.md` |
| 17 | 未在转述里、但**必须知道**的一条 | ⚠️ **`cargo test --lib` 在本机 HEAD（`2d5eebd5`）上【不是全绿】**：`lineage_conflict::tests::resolve_accepts_the_three_literals_refuses_a_fourth_and_refuses_a_second_time` **失败**（`src-tauri/src/lineage_conflict.rs:250` panic：`"remote" 不该被接受`。⚠️ **该处代码已不存在**：`d021948c` 已把 `"remote"` 从坏值表里摘掉、并去掉那句互斥断言 ⇒ 这条判据今天全绿；`:248-251` 现在留的是这次订正的注释）。成因很清楚：`575a58c6` 把 `CHOICE_REMOTE` 放开成**合法**值，而这条判据的 `bad` 列表里还留着 `"remote"`（同一条判据后半段还有互相矛盾的断言：先 `CHOICE_LOCAL` 再断言 `CHOICE_REMOTE`）。⇒ **是既存红，不是本轮造成的**（本轮只读、`git status --short` 为空） | 本轮实跑 ＋ `git log -S "CHOICE_REMOTE" -- src-tauri/src/lineage_conflict.rs` ⇒ `575a58c6` |

---

## 9. 本轮明确**不做**的（显式留白，不许含糊）

| 不做 | 归属／理由 |
|---|---|
| ❌ **纯局域网"同时首开新页"的自动裁定** | §4.4 推荐 A（本轮只做有服务端／已有血统的真实时）＋ F（把三选项出口说清）；**要 owner 拍**（§7-D2 与 §4.4 末） |
| ❌ **把"血统指纹不同但内容同源"当可合**（§4.3-D） | S1 红线：实测会 `["paragraph#blk-1","paragraph#blk-1"]`（冲刺 §1） |
| ❌ **重启甲-2（客户端自己发号牌／留账本）** | owner 2026-09-25 已冻结（[nearby-devices 需求](2026-09-29-nearby-devices-requirements.md) §9） |
| ❌ **非正文（标题／父节点／排序／图标）的实时** | §3：它们走 HLC ＋ 页级 LWW，**不是** CRDT |
| ❌ **服务端合并（S5 阶段 2）** | 冲刺 §14.2 建议**暂缓**（"能"做已证，**值不值得**是产品/隐私决策） |
| ❌ **把 CRDT 状态塞进 `content_json`／让 Rust 认识 CRDT** | 混版本共存的底线，已由 `check-crdt-plane` 判成机器判据（`gates.mjs:105-117`） |
| ❌ **Web 档提供多设备实时正文** | Web 没有发现层、开不了本机端口、也开不了网格窗口（[nearby-devices 需求](2026-09-29-nearby-devices-requirements.md) §4.3 第 3 条 ＋ `web.ts` 的 `lan_status` 那一支如实回不可用） |
| ❌ **改网格门槛**（`isDesktopPlatform() && lanStatus && activeRow.space_id`） | `SyncPanel.tsx:1535` 逐字「门槛一个字没改」 |
| ❌ **在桌面上再写一份 Yjs 合并实现** | 唯一实现是 `crdt/pageBinding.ts`（`check-crdt-plane` 判据④把它钉成"定义只许一处"）。⇒ 真要 Rust 合并，那是 **yrs**（S5 阶段 2），不是"再写一份" |
| ❌ **多光标／在线状态／"谁在编辑哪一块"** | 那是另一条线（[`docs/realtime-collab-analysis.md`](../realtime-collab-analysis.md) §2 的"档次 A"），本文只做"改动多久可见" |
| ❌ **换 `page_crdt_pending` 的"按 seq 逐条留"语义** | 冲刺 §13.1：服务端 pull 不回 `device_id`，不同设备的状态互相不包含 ⇒ "每页一行"是**真丢** |

---

## 10. 本轮我跑过的只读命令（**可原地重放**）

> 全部**只读**；**没有改任何代码、没有提交、没有推远端**。⚠️ 唯一的例外是**本文档的四份新文件**（任务要求"只写文档"）。

| 命令 | 读数 | 用途 |
|---|---|---|
| `git rev-parse --short HEAD` / `--abbrev-ref HEAD` | `2d5eebd5` / `feat/sync-panel-ia` | 读数绑在哪个提交上 |
| `git status --short` | 空（开工时） | §8-17 的"既存红"不是本轮造成的 |
| `cargo check --lib` | **exit=0**（`Finished dev profile … 23.53s`） | Rust 编译面 |
| `cargo test --lib` | **719 passed / 1 failed / 20 ignored**（166.35s） | §8-17 那条既存红 |
| `cargo test --lib mesh::` | **23 passed / 0 failed** | 钉「没有服务端也收敛」那条既有判据（§5.3 场景 D 的形状来源） |
| `cargo test --lib lan::` | **19 passed / 0 failed** | 发现层既有行为 |
| `cargo test --lib sync::` | **54 passed / 0 failed / 1 ignored** | 同步路 |
| `cargo test --lib page_crdt::` | **4 passed / 0 failed** | 状态存取 |
| `cargo test --lib crdt_wire::` | **5 passed / 0 failed** | wire 形状 |
| `cargo test --lib lineage_conflict::` | **3 passed / 1 failed** | §8-17 |
| `node scripts/verify-two-device-sync.mjs` | **91 通过 / 0 失败**（末行"两设备同页并发编辑·同步一致性验收全部通过 ✅"） | 双设备同页并发的既有读数（§8-14） |
| `node scripts/check-web-commands.mjs` | exit 0；**「Rust 260 个命令，web 共 250 个，CommandMap 契约 262 个，其中 web 专属 2 个」** | §8-15 |
| `node scripts/check-doc-links.mjs` | exit 0；**「165 个 .md，1018 条相对链接全部可达；方案索引齐全（95 篇）」** | 本文件的互链要过它 |
| `./node_modules/.bin/tsc --noEmit` | **exit 0** | TS 面 |
| `pnpm vitest run src/lib/crdt/` | ❌ **跑不了**：`Startup Error … Cannot find native binding … '@rolldown/binding-wasm32-wasi'`；`node_modules/.pnpm/@rolldown+binding-darwin-arm64@1.2.5` 存在但 `dlopen` 失败（bundled node **v24.21.0**、`process.versions.modules=137`） | §7-D5：**CRDT 那 17 个测试文件本轮全部未跑** |
| `which -a node` / `node --version` | **无系统 node**；只有 harness 自带的那一份 | 同上 |

⚠️ **本机跑不了的那几条**（真机两台设备隔热点、`vitest` 那一层）⇒ 报告里写**"没做"**，不写成"通过"（`AI-NATIVE-DEV.md` §5.4 的五action：`exit 2/3` 不算通过、没跑的读数不许说成绿）。

---

## §9 补记（2026-09-29 深夜）：**它到底缺什么 —— 两半拆解**

> 这四份文档写完之后，又核了几天，挖出几条**当时没写进去的**。逐条补上，不覆盖原文。

### 9.1 ★ 把"实时"拆成两半 —— 一半已经有，一半缺
```text
【下载侧：别人改了，我多久看到】  ✅ **真的实时**
   服务端 push 帧 ⇒ 客户端 `pullOnce` ⇒ `syncWorkspace`
   真服务端实测（设计稿 §5.1）：订阅 ⇒ 推送 ⇒ 收到 = **16ms**

【上传侧：我改了，别人多久看到】  ❌ **不是实时 —— 这才是缺的那半**
   `syncWorkspace` 全仓只有 **5 个调用点**（已逐条核过）：
     · `App.tsx:159`       自动同步定时器（按间隔）
     · `SettingsDialog.tsx:784` 手动
     · `SyncPanel.tsx:538`      手动点「同步」
     · `useSyncStream.ts:63`     收到 SSE 通知时 ←★ 唯一实时触发，但它是"收到通知才拉"
     · `useSyncStream.ts:146`    同上
   ⇒ ⇒ **没有一处是「编辑器改完就调用它」**
```

### 9.2 ⚠️ 而那个"5 分钟兜底"的理由，**只对下载侧成立**
```text
`SYNC_REALTIME_FALLBACK_MS = 5 * 60_000`，代码里给的理由是：
  「流通道'能连…断了就该退回轮询' ⇒ 所以不是关掉轮询，是把间隔拉长当兜底」

⇒ **这个理由只覆盖下载侧**（流负责"别人改了我知道"）。
⇒ 上传侧一直吃这个 5 分钟：
   · 下载侧：SSE 推来 ⇒ 16ms 看到 ✅
   · 上传侧：我改完 ⇒ **最坏 5 分钟后才被推上去** ⚠️
⇒ ⇒ **服务端档的"近实时"承诺只兑现了一半**，而这个不对称在界面上看不出来。
```

### 9.3 所以缺的**只有一条线**（不是缺通道、不是缺 CRDT）
```text
接法：改动落库 ⇒ 【防抖 300~500ms】⇒ 立刻上传（`syncWorkspace` 或只推这一页）
信号源已经现成：S3b-1 的【「本地编辑」信号】。
⇒ 接上这一条，服务器档就是**真·双向实时**。
```

### 9.4 ⚠️ 而它对局域网档**无效**（别指望一条线解决两档）
```text
局域网档的网格只有 `GET /mesh/pull` —— **纯拉取，没有 push、没有"上传"这个动作**。
  · 服务端档：我改了 ⇒【我上传】⇒ 服务端广播 ⇒ 对方拉      （我推 ＋ 对方拉）
  · 局域网档：我改了 ⇒【就放我本地】⇒ 对方按它的节拍来拉我   （只有对方拉）
⇒ ⇒ "改完立刻上传"对局域网档【无意义】。
   局域网档唯一的杠杆是【调短拉取节拍】—— 而局域网里调短非常便宜（同网段本地请求）。
   ⚠️ 我一度把这两件事混为一谈（说"那条线同时解决局域网档"），**那是错的**。
```

### 9.5 体验预估（如实，含毛刺）
```text
延迟拆解：防抖 300~500ms ＋ 上传 50~200ms ＋ 服务端几 ms ＋ 广播 16ms
        ＋ 对方拉取 50~200ms ＋ 合并几 ms = **约 0.4~1 秒**
⇒ 落在"能用、但与腾讯文档有明显半拍差"的区间。

四个真实毛刺：
  ① 看不到对方光标（我们明确列为非目标；见 `nearby-devices-*` §8 那条局域网方案）
  ② 大页面吃亏：按既有形状（S4b-1a「带上状态」）一次上传可能带【整页 CRDT 状态】
     ⇒ 成本 O(整页) 而非 O(改动) —— **⚠️ 本条待实测**，它决定"小文档爽、大文档难受"
  ③ 非正文（标题/排序）同改仍会丢一方（不是 CRDT，走 HLC ＋ 页级 LWW）
  ④ 防抖窗口内对方看不到（300~500ms 的滞后）
```

### 9.6 与腾讯文档 / WPS 的差别（架构决定的 vs 策略决定的）
```text
WPS 官方原理页原话（[open.wps.cn](https://open.wps.cn/documents/app-integration-dev/docs-center/online-preview-edit/principle)）：
  「每个文档在系统内部对应【一个具体的进程】，所有编辑或预览该文档的用户都会导向该进程中。
    进程利用【内核库】对文档进行处理」
  「每个用户的改动，都会通过【广播】的形式更新所有在线用户」
⇒ 他们的模型：文档在【服务端进程】里 ⇒ 改动【必经服务端】⇒ **双向实时是架构白送的**，
   不存在"我攒着还没上传"这回事。
⇒ 我们的模型：文档在【每个客户端本地】＋ 允许离线 ⇒ "多久上传"是**策略** ⇒ 必须显式接一条线。

⚠️ **不能照抄**（照抄会同时坏三件）：
   ① 服务端要懂内容 ⇒ 个人空间的 E2E 承诺就没了
   ② 服务端要跑文档内核 ⇒ 那是"服务端内嵌客户端" ⇒ **破 F6 许可边界**
      （客户端 AGPL-3.0／服务端 LICENSE-COMMERCIAL，两边不许缝在一起）
   ③ 离线能力变弱
⇒ 所以"客户端合并 ＋ 服务端哑中转 ＋ 显式上传触发"是我们这条路的**必然形状**。
```

### 9.7 落地顺序（与 owner 2026-09-29 的裁定一致）
```text
① 本档：局域网直连开关 ＋ 拉取间隔 ＋ 附近设备（`nearby-devices-*`）  ← 先做
② 本片：服务器档的【上传触发】＝ 本文件四件套                      ← 后做（owner 已定）
③ 局域网光标（`nearby-devices-*` §8/§11/§7）                      ← 更后（与 ① 串行同一块 UDP 代码）
```
