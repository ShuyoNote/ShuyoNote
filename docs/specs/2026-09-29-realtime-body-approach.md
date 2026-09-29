# 方案：正文「真实时」—— 分片、承重判据、传输路线取舍与代价

> 起草：macOS 侧｜**2026-09-29**｜需求见 [`2026-09-29-realtime-body-requirements.md`](2026-09-29-realtime-body-requirements.md)（为什么）·
> 规格见 [`2026-09-29-realtime-body-spec.md`](2026-09-29-realtime-body-spec.md)（什么不许变）·
> 任务见 [`2026-09-29-realtime-body-tasks.md`](2026-09-29-realtime-body-tasks.md)（谁做什么）
> 依据：`_workspace/AI-NATIVE-DEV.md` §5.4（声称完成之前：**没有本次的读数，不许声称完成**）＋ §12（判据的判据）＋ §4（退出码 `0/1/2/3`）
> ⚠️ 本文只写**怎么落**：分片顺序、每片动什么、**哪条判据退化了会变红**、传输取舍、风险与代价。**不重写需求与规格的口径。**

---

## 1. 一句话

> **"实时"差的第二半不是合并（合并已经通了），是【谁在什么时候去拉那一轮网格】。**
> ⇒ 本方案把工作切在**触发面**：先让"多久一次"变成**可读出来的数**（片 A），
> 再让那个数**真的小下来**（片 B），最后才谈"按对端触发"（片 C，且它**依赖另一份文档**）。
> **而需求 §4 那个"没有服务端时谁算首写者"的洞【不在任何一片里】** —— 它是**产品决定**，
> 见 §5 的"没做成 / 拿不准"。

---

## 2. 分片（落地的先后顺序）

> 每片三件事必写：**改哪些文件 · 动没动协议 · 能不能本机验证**。
> ★ ＝ **承重判据**（退化了就变红）；其余判据是"副证据"。

### 片 A：**把"多久"变成读数 ＋ 给一个不碰服务端的触发器**（零协议，本机可验）

| 项 | 内容 |
|---|---|
| **改哪些文件** | `src-tauri/src/mesh.rs`（**若**要把"开窗 ＋ 拉一轮"里与服务端无关的那半抽成可复用的入口，就放在 `round` 紧邻处，不搬进 `sync.rs`）；`src-tauri/src/sync.rs`（`mesh_sync_only` 命令 ＋ `BodyRealtimeStatus`，**复用** `mesh_scope` `sync.rs:3121-3136` 与 `mesh::round` `mesh.rs:403`）；`src-tauri/src/lib.rs`（`generate_handler!` 加一条）；`src/lib/platform/commands.ts`（两条契约 ＋ 参数键 camelCase）；`src/lib/platform/web.ts`（两支如实回"这一档不可用"，照 `web.ts:1565-1576` 的先例）；`src/lib/api.ts`（两个薄包）；`scripts/check-web-commands.mjs` 的**计数会被门禁自己算**（不用手改，但要在提交信息里报新读数） |
| **动没动协议** | ❌ **零协议**。`LAN_PORT`（`lan.rs:46`）/ `WIRE_VERSION`（`lan.rs:55`）/ `LanAnnounce`（`lan.rs:65-84`）/ `GET /mesh/pull`（`mesh.rs:668`）**一个字不动** |
| **能不能本机验证** | ✅ 能。`cargo test --lib mesh::`（23 条，本机实测可跑，见需求 §10）＋ `cargo check --tests`（**注意**：`cargo check --lib` **不查 `#[cfg(test)]`** —— 这是 `32f6fef2` 那笔提交的教训，逐字在它的提交信息里）＋ `pnpm exec tsc --noEmit` ＋ `node scripts/check-web-commands.mjs` |
| **★ 承重判据** | ① ★ **"只跑网格"不许顺手跑服务端**：`mesh_sync_only` 的实现体里**不许**出现 `sync_workspace` / `do_push` / `do_pull`（文本级断言，**先剥注释再断言** —— 与 `webClaimScope.wiring.test.ts` 同一个坑）—— **变异**：在 `mesh_sync_only` 里加一句 `sync_workspace_only(...)`（"反正顺手"）⇒ 必须红。**为什么这条是承重的**：纯局域网那一档**没有服务端**，顺手跑一次就是**每次触发都白等一个网络超时**（真机表现是"延迟忽大忽小"，而日志里看不出因果）；<br>② ★ **间隔与文案同源**：`BodyRealtimeStatus.intervalMs` 与 `syncModeHint` 承诺的那个数**必须来自同一个函数** —— **变异**：把 `src/lib/syncMode.ts:25` 的 `SYNC_INTERVAL_MS` 改成 `10_000` 而**不动** Reads 那一边 ⇒ 必须红（`INV-RT-cadence-honest` 的落点；⚠️ 这一条**先要定 §6-R2/"间隔从哪读"**，见 §6 没做成第 3 条）；<br>③ ★ **反向保护（不回归）**：`lan_status` 的 `peers` / `kind` / `line` **逐字段不变** —— **变异**：把 `nearby`（另一份文档要加的那个字段）强行置空 ⇒ 这三条读数必须**一个字节都不变**（先例：分片 ③-b-2a 的"没配 ⇒ 一个字节都不动"） |
| **副证据** | `check-web-commands` 的读数（命令三方向一致 ＋ 参数键 camelCase）；`web.ts` 两支的人话与 `mesh_sync_now` 的**同一句** |

### 片 B：**把触发真的挂上（局域网这一档的"短间隔轮询"）**（零协议，本机可验一半）

| 项 | 内容 |
|---|---|
| **改哪些文件** | `src/App.tsx`（自动同步那条 `tick`，`App.tsx:398-446`：**把"服务端那条"与"网格那条"的触发解耦** —— 今天两者共用一个间隔，而网格那一档**不需要**服务端）；`src/lib/syncMode.ts`（**若**要新档位，读写口径只在这里一处；今天的三档见 `:36-46`）；`src/components/SyncPanel.tsx`（"同步方式"那一行的**说明文字** ＋ 读数展示）；`src/lib/api.ts`（若片 A 的薄包还没加） |
| **动没动协议** | ❌ 零协议 |
| **能不能本机验证** | 🟡 **一半**：① **接线面**（"网格那条不许被服务端那条连坐"）→ 本机可判（文本级，先例 `src/components/syncPanelMesh.wiring.test.ts` 已经在断言**两处**都有 `api.meshSyncNow(`，`:25` / `:38`）；② **真行为**（两台真机隔热点多久可见）→ ❌ **本机做不到**（要人手，见任务 §3 的 M 档） |
| **★ 承重判据** | ① ★ **解耦**：自动同步那条 tick 里，网格那一轮**不许**被包在 `if (bound.length)` 里（`bound` ＝ 有 `server_url` 的档案，`App.tsx:405-407`）—— **变异**：把 `meshSyncNow` 挪进 `if (bound.length)` ⇒ 必须红。**为什么承重**：`mesh::tests::a_space_with_no_server_profile_can_still_turn_the_mesh_on` 钉着"**只开网格、不绑服务端**是被支持的配置"，而那条配置在界面上**今天就靠这一行不被包住**；<br>② ★ **闸门只有一处**：新触发**必须**过 `shouldAutoSyncNow()`（`src/lib/syncGate.ts:22-30`（函数在 `:26`））—— **变异**：新触发里直接 `await api.meshSyncOnly(...)`、不调闸门 ⇒ 必须红。**为什么承重**：真机实测过"把间隔调成每 10 秒就在蜂窝上照拉"（`syncGate.ts` 文件头逐字），而网格这一档**更要**过闸（它是**自动**行为）；<br>③ ★ **不许有第三条自动路**：面板那个 **5000ms** 定时器（`SyncPanel.tsx:185`）**只读读数**这条口径不许破 —— **变异**：在那个 tick 里加一句拉数据 ⇒ 必须红（`INV-RT-single-source` 的一半：一个"多久跑一次"只能有一处） |
| **副证据** | `pnpm exec tsc --noEmit`；`vitest` 的 `syncMode.test.ts`（"近实时开着 ⇒ 兜底轮询必须挂着"那条谓词）；`useSyncStream.wiring.test.ts` ⑧（"流通道不碰轮询"） |

### 片 C：**按对端触发（名单式）**（**依赖另一份文档；本轮不一定做**）

| 项 | 内容 |
|---|---|
| **改哪些文件** | ⚠️ **前置**：[`2026-09-29-nearby-devices-*.md`](2026-09-29-nearby-devices-requirements.md) 的片 A/B（`LanStatus.nearby` 上抛 ＋ 契约三处）。本片**不改** `nearby` 的形状，只**消费**它：`src/App.tsx` 或新的 hook（按 `nearby.length` / `invitable` 决定这一轮跑不跑）；`src/lib/crdt/…`（**若**名册要参与血统裁定，见需求 §4.3-B —— 那是**另一件事**，不要混进这一片） |
| **动没动协议** | ❌ 零协议（名单来自**已有**的发现层，`lan.rs:65-84`） |
| **能不能本机验证** | 🟡 **一半**：名单本身（纯函数）→ 本机可判（那份文档的片 A 判据）；"按名单跳过/触发"的**行为** → 本机只能到"接线面"，真行为要真机 |
| **★ 承重判据** | ① ★ **同源**：界面用来判"要不要跑"的那个数**必须**来自 `nearby`（列表），**不许**来自 `peers`（数量）—— **变异**：把判断写成 `lanStatus.peers > 0` ⇒ 必须红（数量在"有人但不服务这个空间"时**也为真** ⇒ 会白跑一轮，而这一轮的表现是"延迟忽大忽小"）；<br>② ★ **不许自己算交集**：界面**不许**自己判断"某台设备服务哪些空间"（那份规格 §3.1 的 `serves_current` 就是为此存在的）—— **变异**：在组件里写 `p.spaces.includes(spaceId)` ⇒ 必须红（第二份真相源） |
| **副证据** | 那份文档的 `INV-NEARBY-one-source` 判据；`check-web-commands` |

### 片 D：**首写者那一格**（**它是产品决定，不是一个实现片**）

| 项 | 内容 |
|---|---|
| **本轮做什么** | **只做两件**：① 把**已有的**冲突出口说清楚（需求 §4.3-F：`LineageConflictBanner` 三个选项**已经都在**，`src/components/LineageConflictBanner.tsx:58/84/94`）；② 在"同步方式"那一行的说明里，把"同时首开新页会怎样"**如实说出来**（文案事实：`src/lib/crdt/bootstrap.ts:56-66` 的离线降级 ＋ 护栏 `pageBinding.ts:183-227`） |
| **本轮不做什么** | ❌ 不做名册式裁定（片 C 的**行为**面、需求 §4.3-B）· ❌ 不做"内容同源即可合"（需求 §4.3-D，**反模式**）· ❌ 不重启甲-2（owner 2026-09-25 冻结）· ❌ 不做"页创建者才许首开"（需求 §4.3-E，**前置数据不存在**，需求 §7-D1） |
| **★ 承重判据** | ★ **护栏不许被绕过**：新路径上**不许**出现第二个合并点 —— `mergeRemotePageState` / `lineagesRelated` 的**定义**只许一处（`check-crdt-plane` ④ 已经钉住 `mergeRemotePageState`，`gates.mjs:105-117`；**要补** `lineagesRelated`）—— **变异**：在片 A/B 的新代码里加一个 `session.merge(remote)` 的调用点 ⇒ 必须红 |
| **⚠️ 为什么它单独一片而不是塞进 A/B** | 因为它的**判据对象是"产品的选择"**，不是"代码的形状"。把它塞进 A/B 的下场是：一片里既有"能不能本机验证"的活、又有"要 owner 点头"的活 ⇒ 后者永远拖住前者（本仓的老问题：需求 §7-D2） |

**⇒ 顺序即依赖**：**A → B**（B 要用 A 的读数与命令）；
**C 依赖 A ＋ 另一份文档的片 A/B**（名单不来自本方案）；
**D 独立**（它只碰文案 ＋ 一条护栏的判据覆盖），可与 A/B **并行**认领。

⚠️ **片 B 的②③两条判据在今天的工作树上就已经有载体了**（`syncPanelMesh.wiring.test.ts` / `useSyncStream.wiring.test.ts` ⑧）⇒ **B 的第一步是"读那两条，看能不能直接复用"**，而不是新写（本仓纪律：判据不许删了不写替代，也不许无谓地写第二条同样的）。

---

## 3. 三条传输路线的取舍（**含"纯局域网无服务端"这一档**）

> 三条路线的**形状代价**已经在规格 §3.4 列了（要不要新命令／要不要动协议）。
> 本节只谈**为什么选它、代价是什么、哪一档能用**。

### 3.1 三条路线

| # | 路线 | 机制 | 延迟量级 | 代价（如实） | **纯局域网无服务端能用吗** |
|---|---|---|---|---|---|
| **①** | **轮询**（把网格那一轮按更短的间隔跑） | `App.tsx` 的定时器 → `mesh_sync_only` → `mesh::round` → `GET /mesh/pull` | ＝**间隔**（可配到 5s） | ① 请求量 ＝ 间隔 × **对端数**（每台对端一次 HTTP）；② 空闲时也发（没有"什么都没变"的快路径 —— 有**水位** `mesh_cursor`，`mesh.rs:116-141`，所以返回体是空的，但**请求仍然发出**）；③ **移动端耗电**（安卓也在这一档里，`isDesktopPlatform()` 在安卓为真，`platform/index.ts:36-37`） | ✅ **能用**，而且**只有它**能用（见 3.2） |
| **②** | **长连接推送** | 局域网里新起一条通道（UDP 通知 或 每台设备一个小 SSE／WS 端点），"我有新东西了" ⇒ 对端立刻 `GET /mesh/pull` | **毫秒～秒级** | ① **要动协议**（新报文／新端点）；② 要**退避重连 ＋ 状态读数**（形状同 `sync_stream.rs` 872 行那套：`backoff_ms` / `drain_sse_frames` / `SyncStreamStatus`）；③ ⚠️ **它仍然要靠 pull** —— 网格窗口的**服务侧只服务自己产生的记录**（`mesh.rs:78-86`），所以"推送"永远只能是**通知**，不能是**数据**。⇒ 这条路的收益是**延迟**，不是架构 | ✅ 能用（这正是它比 ③ 强的地方） |
| **③** | **复用既有 SSE** | 订 `{server}/spaces/{id}/changes-stream` | **秒级**（服务端什么时候发帧） | ⚠️ **它今天已经实现了**（桌面 `sync_stream.rs:314`；Web `useSyncStream.ts:118-125`），**代价≈0** | ❌ **不能用**：它订的是**服务端**（`stream_url`，`sync_stream.rs:112-114`），而纯局域网**没有服务端**；且它**根本不驱动网格**（`useSyncStream.ts:71` 的 `pullOnce` 只调 `api.syncWorkspace`）⇒ **它解决不了 owner 的场景** |

### 3.2 结论（**把 owner 场景正面回答掉**）

```text
· 有服务端那一档        ⇒ ③ 已经接近成立（秒级），本轮只需把"它不驱动网格"这件事说清楚
· 纯局域网 + 无服务端   ⇒ 只有 ①（今天）或 ②（要动协议）
                          ⚠️ 而 ① 的默认值是**5 分钟**（syncMode.ts:108-113）⇒ 本轮 R-2 的最小修法
                             就是"把它变成 5 秒"，代价是 3.1-① 那三条
```

⚠️ **一条必须写进风险的物理事实**：**无论走 ① 还是 ②，数据的到达永远是"对端来拉"**
（`GET /mesh/pull`，`mesh.rs:251-262`；服务侧 `serve_own_records` 只服务自己的记录，`mesh.rs:84-107`）。
⇒ **"推送"这个词在这条链路上只能是"通知"的意思**，它**不改变**"谁发起 HTTP"。
这条是 `INV-RT-pull-not-push` 的技术根据。

### 3.3 本方案的取舍

> **本轮选 ①**，理由三条：
> 1. **零协议**（② 要动那条 UDP 通道的报文类型，而那条通道的 `decode_announce` 对不认识的版本**一律丢弃且不猜**，`lan.rs:117-129` ⇒ 加新报文类型必须**另立版本号**，那是 [`nearby-devices-spec`](2026-09-29-nearby-devices-spec.md) §5.2 已经在做的一件事 —— **别两条线同时动同一个通道**）；
> 2. **① 的读数可以直接用**（"我多久跑一次"是一个数，而 ② 的读数是"流断没断"，形状完全不同，要新造一套状态）；
> 3. **② 的收益（毫秒 vs 秒）对"正文可见"这件事没有用户价值** —— 用户不会因为从 3 秒变 300 毫秒而改观，**但会**因为"每次都亮一下网卡／耗一格电"而抱怨（② 的空闲成本更高：它要维持连接，而 ① 的空闲成本是"一个空 HTTP"）。

---

## 4. 风险与代价（**如实写，不许美化**）

| # | 风险 / 代价 | 读数与出处 | 处置（本轮怎么落） |
|---|---|---|---|
| 1 | **短间隔轮询在安卓上是耗电与流量的真实代价** | 安卓也走桌面那条路（`isDesktopPlatform() ≡ isTauri()`，`platform/index.ts:36-37`）；而发现的广播目标里包含**受限广播** `255.255.255.255`（`lan.rs:434-443`），网格那一轮是**真 HTTP** | ① 默认间隔**不许**自己偷偷变短（用户选什么就是什么）；② ②的"只在 Wi-Fi"闸门**必须**过（`syncGate.ts:22-30`，片 B 判据②）；③ **不做**"空闲时也保持更短间隔"的自适应（那是一个会漂的隐藏状态） |
| 2 | **每台对端一次 HTTP ⇒ 对端数线性放大** | `mesh::round` 对 `candidates` **逐个**拉（`round_candidates`，`mesh.rs:441-470`：`for p in &candidates { pull_and_absorb(...) }`） | 如实写进文案（"网段里 N 台 ⇒ 每轮 N 次请求"）；**不做**合并请求（那是新协议） |
| 3 | **"拉了但合不了"的窗口仍然存在**（需求 §4 那个洞） | 护栏在 `pageBinding.ts:183-227`；局域网里命中它**不报错**（`console.warn` ＋ 留痕 ＋ 界面 toast，`Editor.tsx:568-572`） | 本轮**不假装解决**；片 D 只做"说清楚 ＋ 三选项出口"；**要 owner 拍** |
| 4 | ⚠️ **接收侧的派生文本会滞后**（"搜不到刚同步过来的字"） | **核实过的事实**：`write_page_projection`（Rust `doc_content.rs:145-173`）**会**把投影写回 `pages.content_json` ＋ 重建块图 ＋ 打 `text_stale`，**但正文文本列与 FTS 要等补算器**；而**接收侧的补算发生在"编辑器打开这一页"时**（`src/editor/Editor.tsx:607-621` 的 `PageTextRepairPlugin`（挂在 `:674`） 调 `api.refreshPageText`） | ① 如实写在这里（**这不是本轮引入的**：它同时是 `mesh` 路径的既有行为）；② **不**用"合并后触发一次保存"当修法（`dirty=1` ⇒ 把对端内容当本机改动推回去＝假账，冲刺 §13.3 逐字警告过）；③ 若这一格要收，是**另一片**（要有"什么时候补算"的口径 ＋ 判据） |
| 5 | **投影写回只发生在"打开页面"那一刻** | `pageBinding.ts:388-400` 一带（`writeProjection` 的调用点在"有待并状态"那一支里） | ⇒ **对端一直在看这一页**（不重开）时，`pages` 那两列**不会**因为远端合并而更新（只有编辑器里的内容更新了）⇒ 面板／反链／导出看到的仍可能是旧的。**如实记**；要收就得定"合并之后谁的投影先写"（同上，另一片） |
| 6 | **计时类判据会假红** | 真事故：`graphLayout.test.ts` 的 250ms 判据实测 260ms 红，单独重跑 7/7 绿（冲刺 §11.8） | 按冲刺 §11.8 的治法：**跑 3 次打印最快值 ＋ 数量级兜底（1500ms）**，**不**拿墙钟当门禁（规格 §4.3 已经这么写） |
| 7 | **回环读数不能代表真网段** | 回环没有丢包／没有 Wi-Fi 重传／没有安卓的 `MulticastLock`（`src-tauri/src/lan_android.rs`） | 回环那条读数只能当**下界**；R-1/R-2 的**验收**必须在真机（任务 §3 M1–M3）⇒ **不许**把回环读数写成"R-2 达成" |
| 8 | **"多久"这个数今天住在两处**（界面 localStorage vs 库） | `App.tsx:387` 读 `localStorage['shuyonote:autoSync']`（`syncMode.ts:79` `AUTO_SYNC_KEY`）；而**Rust 侧看不到它** | ⚠️ **这是本方案最大的**形状**风险**：`BodyRealtimeStatus` 若放在 Rust，`intervalMs` **算不出来**（规格 §6-R2）。⇒ 处置：**先定这一格**（要么读数住在界面侧，要么把档位搬进库 —— 后者是**第二份真相源**，要谨慎），**没定之前不许开工片 A 的读数那一半** |
| 9 | **面板那个 5000ms 轮询会让"读数"本身有延迟** | `SyncPanel.tsx:185`：`lan_status` 每 5 秒一次 | 新读数若也走 5 秒轮询，则"上一次拉到是什么时候"这个数**最多滞后 5 秒** ⇒ 文案**不许**说"实时显示"（说"每 5 秒刷新"） |
| 10 | **测试环境今天不完整**（`vitest` 在本机跑不了） | 需求 §10 最后两行：`Startup Error … Cannot find native binding`；本机**没有系统 node**（只有 harness 那份 v24.21.0） | 片 A/B 的 `vitest` 读数**本轮标"未跑"**；**不许**因为它跑不了就把它从判据里删掉（那正是 `AI-NATIVE-DEV.md` §12.1 的"2 不算通过"） |

---

## 5. 与 [`2026-09-29-nearby-devices-*`](2026-09-29-nearby-devices-requirements.md) 四份文档的关系

```text
谁依赖谁：
  本文片 C  ──依赖──▶  nearby-devices 片 A（LanStatus.nearby 上抛）＋ 片 B（契约三处一致）
  本文片 A/B ──不依赖──▶ nearby-devices 的**任何**片   ✅ 可以现在就做
  本文片 D  ──不依赖──▶ 任何东西（文案 ＋ 一条护栏判据的覆盖）

可以并行的：
  本文片 A ‖ nearby-devices 片 A     （不同文件：sync.rs/mesh.rs vs sync.rs ⚠️ 见下）
  ⚠️ 冲突点：**两份文档都要改 `src-tauri/src/sync.rs` 的 `LanStatus` 周边**
     ⇒ 若两条线同时开工，**先让 nearby-devices 的片 A 落**（它加字段），
       本文片 A 再加**自己的**结构体（不在同一个结构体上叠字段）—— 这正是规格 §3.2 选"另起一条读数"的理由之一

不许重复的（互引，不抄）：
  · "对端列表只有一处来源"        ⇒ nearby-devices 规格 §1 ＋ INV-NEARBY-one-source
  · "snake_case vs camelCase"      ⇒ nearby-devices 规格 §3.2（本文规格 §3.1 只**追加**了"独立结构体走 camelCase"）
  · "邀请要动那条 UDP 通道"        ⇒ nearby-devices 规格 §5.2（本文片 C **不许**同时动它）
  · "附近设备的四种态与文案"        ⇒ nearby-devices 规格 §4
  · "混版本共存的三句地基"          ⇒ 2026-09-29-crdt-mixed-version-degradation.md ＋ check-crdt-plane
```

---

## 6. 本机验证计划（**照着跑就能复核这份方案**）

```bash
# 0) 前置：工作树干净（本轮只写文档）
git status --short                                  # 期望：空

# 1) 片 A 的承重判据（纯函数 ＋ 库内行为，无真网络）
cd src-tauri && cargo check --tests                 # ⚠️ 不是 --lib：--lib 不查 #[cfg(test)]（32f6fef2 的教训）
cd src-tauri && cargo test --lib mesh::             # 本轮实测基线：23 passed / 0 failed
cd src-tauri && cargo test --lib sync::             # 本轮实测：54 passed / 0 failed / 1 ignored
cd src-tauri && cargo test --lib page_crdt::        # 本轮实测：4 passed / 0 failed
cd src-tauri && cargo test --lib crdt_wire::        # 本轮实测：5 passed / 0 failed

# 2) 片 A/B 的契约与类型
node scripts/check-web-commands.mjs                 # 本轮实测：Rust 260 / web 250 / CommandMap 262（web 专属 2）
./node_modules/.bin/tsc --noEmit                    # 本轮实测：exit 0

# 3) 文档面（新增四份文档之后必须重跑）
node scripts/check-doc-links.mjs                    # 本轮实测：165 个 .md / 1018 条链接可达

# 4) 既有的"双设备同页并发"读数（本轮实测 91 通过 / 0 失败）
node scripts/verify-two-device-sync.mjs

# 5) ⚠️ 本机**跑不了**的那些（如实报"没做"，不许报绿）
./node_modules/.bin/vitest run src/lib/crdt/        # 本轮实测：Startup Error（缺 @rolldown native binding）
node scripts/test-report.mjs --group browser        # 需要真 Chromium
```

⚠️ **`exit 2` / `exit 3` 不是通过**（`AI-NATIVE-DEV.md` §4；§12.1「2/3 不许当成拦，但也不许说成绿」）。
⚠️ **本机跑不了的那几条**（`vitest` / 真机两台隔热点 / 真 Chromium）⇒ 报告里**写"没做"**，不写成"通过"（§5.4 的铁律）。

---

## 7. 没做成 / 拿不准的（**如实写**）

1. **`vitest` 在这台机上跑不起来**（`Cannot find native binding` / `@rolldown/binding-darwin-arm64` 存在但 `dlopen` 失败；本机**没有系统 node**）。⇒ 本方案里**所有** `src/lib/crdt/` 与 `src/hooks/` 的 `vitest` 判据都是**"要立"**，**我没有跑过它们**。⇒ 这是本方案最大的读数缺口（需求 §7-D5）。
2. **需求 §4 那个洞我给了七个候选但没有替 owner 拍**（"没有服务端时首写者怎么办"）。理由：它的代价是**用户可见的**，且推荐项（A ＋ F）会让 owner 的场景**在第一分钟**遇到护栏 —— 那不是一个 agent 该替 owner 决定的取舍。
3. **`BodyRealtimeStatus.intervalMs` 从哪读，我没定**（规格 §6-R2）：档位住在 `localStorage`（`src/lib/syncMode.ts:65`），而 Rust 看不到它。⇒ 三条可能的路：① 读数由**界面侧**拼（不走命令）；② 把档位搬进库（**第二份真相源**，要谨慎）；③ 读数只报"库侧知道的那半"（`server_bound` / `mesh_enabled`），间隔由界面自己显示。**我倾向 ①**，但**没核**"界面侧拼的读数"在这套契约里有没有先例 ⇒ 见规格 §6-R2。
4. **接收侧派生文本的滞后（风险 4/5）我只核到"有这个滞后"，没核它有多严重**：要真机 ＋ 两个库 ＋ 一个"搜一下刚同步过来的字"的动作才能量。⇒ 本条**没有读数**，只是"读代码得到的结论"。
5. **`mesh_sync_now` 与 `mesh_sync_only` 的重叠我没量**：两者共用 `mesh::round`，但前者多跑一次服务端。⇒ 若实现者选择"干脆让定时器调 `meshSyncNow`（连服务端一起跑）"，那与本方案的取舍**冲突**（片 A 判据①）—— 但我**没有**它"每次白等多久"的读数（那要一个连不上的服务端地址 ＋ 真机）。
6. **"5 秒"这个数我没验证过它的代价**（风险 1/2 只有形状、没有读数）：真要选它，应该先在**一台真机上**量"每 5 秒一次网格轮询"的耗电与请求量。⇒ 这也是需求 §7-D2 要 owner 给的数字的一部分。
