# 规格：正文「真实时」—— 不变式、数据形状、延迟目标与它怎么量

> 起草：macOS 侧｜**2026-09-29**｜需求见 [`2026-09-29-realtime-body-requirements.md`](2026-09-29-realtime-body-requirements.md)
> 依据：`_workspace/AI-NATIVE-DEV.md` §5.1（规格层）＋ 本仓 [`docs/specs/README.md`](README.md)（这一层的三条"不是什么"）＋ §12（判据的判据）
> 关联：方案 [`2026-09-29-realtime-body-approach.md`](2026-09-29-realtime-body-approach.md) · 任务 [`2026-09-29-realtime-body-tasks.md`](2026-09-29-realtime-body-tasks.md)
>
> ⚠️ **本层的第一优先级不是"多一份文档"，是"每条不变式都得有一条会红的判据"。**
> 本文件 §2 六条不变式里，**当前有现成载体的只有两条**（`INV-RT-single-source` 有半条、
> `INV-RT-no-server-no-lie` 的近似形态被封在既有门禁里 —— 逐条见 §2 第四列）。
> 其余**第四列全是 `❌ 无（要立）`** ⇒ **按 [`README.md`](README.md) 的铁律，它们现在【不进 `INVARIANTS.md`】**。
> 本文件的作用是**把"要立哪条判据、怎么证明它会红"写成可执行的前置条件**，
> 而不是让读者以为它们已经被守住了。

---

## 0. 字段口径（与 [`INVARIANTS.md`](INVARIANTS.md) 同形，便于将来机器迁移）

```text
id          INV-RT-<短名>             稳定标识；改口径不许改 id（改 id = 删除 + 新增）
口径        一句话；从判据的真源逐字引用，不在此重写
判据        <脚本／测试名> [注入方式]
会红证据    ✅ 有（证明命令 + 期望非 0 退出码 + 账本 sha）／❌ 无（⇒ 按 README 铁律，该条还不该进 INVARIANTS.md）
褪化        这条不成立时，**用户那边**会发生什么（不是"测试会红"，是"人会看到什么"）
```

**载体为什么是这几处**（本仓已有先例，不新建）：

| 载体 | 现在是什么 | 为什么适合本条 |
|---|---|---|
| `src-tauri/src/mesh.rs` / `sync.rs` / `page_crdt.rs` 的 `tests` 模块 | 本仓 Rust 单测，`cargo test --lib <前缀>::` 可只跑一片（**本机实测可跑**，见需求 §10） | 纯函数与库内行为（触发面、水位、状态落盘）⇒ 判据不吃真网络 |
| `src/hooks/*.wiring.test.ts` | **文本级接线判据**（先剥注释再断言），先例：`src/hooks/useSyncStream.wiring.test.ts` ⑧、`src/components/syncPanelMesh.wiring.test.ts` | "某条路必须挂上／某条路不许绕过"这类**接线**事实，只有文本级判得住（本仓已两次被真事故证明，见 `AI-NATIVE-DEV.md` §12.7） |
| `scripts/lib/gates.mjs` 注册的门禁 | 门禁清单的**单一事实来源**（本仓 `AGENTS.md` §3） | 静态面（"界面不许把拉取式说成推送"） |
| `scripts/criteria-mutations.json` | 跑 cargo 的判据的「看过它红」通道（[`README.md`](README.md) §每条不变式的四个字段） | ⚠️ **本机位置待查**（需求 §7-D6：我只在**另一个仓**找到同名文件）⇒ 这条通道**本轮不敢写 `✅`** |

---

## 1. 本规格要解决的**一个口径问题**（比六条不变式更根本）

```text
今天"多久能看到对端"这个数 = f(同步档位, 近实时开关, 有没有服务端, 有没有配网格, 用户点没点按钮)
而界面上只有一个下拉（"关闭 / 按间隔 / 近实时"）＋ 一句话（syncModeHint），
那句话只解释"连着同步服务时…"（src/lib/syncMode.ts:70-76）。
```

**纯局域网（owner 的场景）里**：SSE 那条路**不存在**（`sync_stream.rs:331-339`：没有绑定就不跑），
于是"多久"**只由那个定时器的间隔决定** ⇒ 默认 **5 分钟**（`src/lib/syncMode.ts:108-113`），
而面板上那个下拉**写着"近实时"**。

> **⇒ 所以本规格的第一条不变式不是"把延迟降到 5 秒"，是"接口读数与文案不许把拉取式说成推送、
> 不许把 5 分钟说成近实时"。** 先把这句话钉住，再谈加速 —— 否则加速之后，
> 用户仍然不知道"我现在到底处在哪一档"（而这正是需求 §2 那个 300 倍差距的来源）。

---

## 2. 不变式（`❌ 无` ＝ 按 README 铁律，**暂不进 `INVARIANTS.md`**）

| id | 口径（一句话） | 判据（要立的那条） | 会红证据 ／ 褪化了会怎样 |
|---|---|---|---|
| **INV-RT-single-source** | **"实时"不许再造第二套状态**：正文的权威那一份仍然只有 `page_crdt` 状态（BLOB），落盘 JSON 是它的投影；**新加的触发／读数都不许各存一份"我到哪儿了"**。水位只有一处：`mesh_cursor:<空间>:<对端>` | ① **既有半边**（`check-crdt-plane`，已注册 `gates.mjs:105-117`）：`content_json` 必须是 TEXT、`page_crdt*` 的 `state` 必须是 BLOB、Rust 不许引 yjs／yrs、`mergeRemotePageState` 定义只许一处；② **要立的**：新读数里的"当前档位／上次拉到什么时候"**不许**落成第二个 KV —— 断言"新加的读数结构里没有可写字段"（只有 `#[derive(Serialize)]`，没有 `Deserialize`）＋ 文本级断言"没有新的 `set_meta_state(…)` 键" | **既有半边 ✅**（`check-crdt-plane` 在注册表里，`gates.mjs:110`）；**新半边 ❌ 无（要立）**。<br>**褪化了会怎样**：出现"两个地方各记一次我到哪儿了" ⇒ 它们会漂，而漂的时候**不炸、测试全绿**，只是用户那边"有时同步了有时没有" |
| **INV-RT-body-not-all** | **正文与非正文不许混为一谈**：任何**用户可见的**说法都不许把"正文实时"说成"全部实时"；标题／父节点／排序／图标走 HLC ＋ 页级 LWW（`sync.rs:209-238` 只挂页 upsert；`apply_upsert` 的 `UpsertApply::{Applied, KeptLocal}`，`sync.rs:245-262`） | 文本级判据：`src/lib/syncMode.ts:50-64` 的 `syncModeHint("realtime")`（`src/lib/syncMode.ts:50-64`）与面板上那一行文案里，**要么**只谈正文，**要么**显式写出"标题等仍按页级收敛"；＋ 反例断言：把那句话改成"所有内容立刻同步"⇒ 必须红 | **❌ 无（要立）**。<br>**褪化了会怎样**：用户改标题以为对面秒到，实际对面看到旧标题（**页级 LWW 下还可能被自己的旧版赢回去**），于是"这个同步不可靠" |
| **INV-RT-guard-not-bypassed** | **血统护栏不许绕过**：两条**独立血统**在任何新路径上都不许被合；`mergeRemotePageState` 的那条判定是唯一入口，新触发不许"顺手合一下" | ① 既有判据：`src/lib/crdt/lineageGuard.test.ts`（S8 三条，冲刺 §2）；② **要立的**：新增的触发面**不许**出现第二个"合并"调用点 —— 文本级断言 `mergeRemotePageState` / `lineagesRelated` 的**定义**仍只在一处（`check-crdt-plane` 判据④已覆盖 `mergeRemotePageState`；**新增**覆盖 `lineagesRelated`） | **既有 ✅**（`check-crdt-plane` ④ ＋ `lineageGuard.test.ts`）；**要立的**那一条 ❌ 无。<br>**褪化了会怎样**：实测过的 S1 现场 —— 顶层块 `["paragraph#blk-1","paragraph#blk-1"]`（一块变两块、`blockId` 重复）⇒ **块引用／反链当场失效**（冲刺 §1 判据①） |
| **INV-RT-pull-not-push** | **拉取式不许被说成推送**：网格是 `GET /mesh/pull`（`mesh.rs:251-262`、`:668`），读数与文案都不许暗示"对端推给我的" | 文本级判据（**要立**）：面板／文案里描述这条通道的那一句，**不许**出现"推送"这个词（除非句子同时说明了"文件里它是拉取式、我们说它是推送＝指触发频率"）；＋ 读数里"上次事件来自哪"这类字段**不许**新增（网格窗口**不发事件**：`grep emit src-tauri/src/mesh.rs` ＝ 0 处） | **❌ 无（要立）**。<br>**褪化了会怎样**：用户按"推送"的语义去理解网络行为（以为常连、以为断了会立刻知道）⇒ 排障时查错方向（先例：`docs/SYNC.md` §五 那句"这不是 WebSocket 推送，而是增量轮询"就是被这件事逼出来的订正） |
| **INV-RT-no-server-no-lie** | **没有服务端时不许假装有**：能力探测必须按**具体能力函数**，**不许**拿 `isDesktopPlatform()` 当近似 —— 它的源码注释明确禁止（`src/lib/platform/index.ts:26-35`，逐字"要判断'某个只在桌面存在的功能'，用下面的 `emailSupported()` 这类**具体能力**函数，别拿这个当近似"） | 文本级判据（**要立**）：新增的"真实时"相关分支里，**不许**用 `isDesktopPlatform()` 判"有没有服务端／能不能推"；判定服务端的唯一入口仍是 `resolveWorkspaceSyncScope`（`src/lib/crdt/claimScope.ts:61-70`，缺任一件 ⇒ `null`）；＋ 断言 `web.ts` 的 `lan_status` 那一支继续如实回"不可用"而不是空数组（同族判据已写在 [`2026-09-29-nearby-devices-spec.md`](2026-09-29-nearby-devices-spec.md) `INV-NEARBY-no-web-invite`） | **半条已有载体**（`isDesktopPlatform` 的"不许当近似"这条**纪律**写死在源码注释里，但**没有门禁**）；**❌ 无（要立）**。<br>**褪化了会怎样**：安卓 App 上 `isDesktopPlatform()` 也为真（`index.ts:36-37` ＝ `isTauri()`）⇒ 在手机上走进"桌面才有"的分支，行为与桌面不同但**没有任何信号** |
| **INV-RT-cadence-honest** | **"多久"必须有一个可读出来的数**：任何"实时"的档位都必须能从**接口读数**看出"当前这一档的间隔是多少、上一次真的拉成功是什么时候" —— 不许只靠用户猜，也不许只写在文案里 | **要立的**：`lan_status` / 新读数里带上 `body_pull_interval_ms`（**有效值**，＝ `effectiveAutoSyncMs()` 同一个函数的产物）＋ `last_body_pull_at`；断言：① 读数的间隔与 `effectiveAutoSyncMs()` **同源**（不许各算一遍）；② `syncModeHint` 里承诺的那个数与读数**一致**（变异：把 `SYNC_INTERVAL_MS` 改成 10 秒而不改文案 ⇒ 必须红） | **❌ 无（要立）**。<br>**褪化了会怎样**：这正是 `src/lib/syncMode.ts:100-104` 那段注释记下的**真机实测事故**："面板显示「近实时」、承诺'退回每 5 分钟兜底一次'，而**定时器压根没挂**" ⇒ 用户以为在自动同步，其实一次都不会发生 |

⚠️ **六条里有三条的形态是"不许说错话"**（文案／读数与事实一致）——
按 `AI-NATIVE-DEV.md` §12.2，**每条"扫到 0 个时它说什么"都必须先回答**：本表每一格的"褪化了会怎样"就是那个回答（**"没有发现问题"与"没检查"不许写成同一格**）。

---

## 3. 数据形状（新增／改动的命令、事件、读数）

> 这一节是**契约**：字段名、类型、谁产生、谁消费。三处必须逐字段一致
> （`check-web-commands` 管"命令存在性 ＋ 参数键 camelCase"那一维 —— `gates.mjs` 的 `INV-IPC-web-commands`；**字段一致性靠人 ＋ 契约注释**）。

### 3.1 ⚠️ 先说一条**与另一份规格冲突**的地方（**必须先定，否则两片各写一半**）

[`2026-09-29-nearby-devices-spec.md`](2026-09-29-nearby-devices-spec.md) §3.2 明确说：

> 「Rust 侧 `LanStatus` **没有** `#[serde(rename_all = "camelCase")]`（`sync.rs:3273` 只有 `#[derive(Serialize)]`）⇒ 现在发出去的就是 `snake_case`。… **本轮选 snake_case**（与 `LanStatus` 其余字段一致）」

**我核到的实况**：`LanStatus` 的 TS interface（`src/lib/platform/commands.ts:175-194`）**其余字段确实是 snake_case**（`enabled` / `peers` / `kind` / `line` / `mesh` —— 后两个正好没有大小写歧义），而**别的**结构体带 `rename_all = "camelCase"`（`MeshRoundReport` `:215`、`MeshConfigState` `:227` 对应的 Rust 侧，`mesh.rs:282` / `:299` / `:580`）。

**⇒ 本规格的口径**（**与那份一致，不另立**）：

```text
· 新增到 LanStatus 的字段          ⇒ snake_case（跟着这个结构体走）
· 新增的独立读数结构（如果另起一条命令）⇒ camelCase ＋ #[serde(rename_all = "camelCase")]
  理由：MeshRoundReport / MeshConfigState 都是这个形状，而"一个结构体两种风格"才是真问题
```

⚠️ **待查 R1（会挡住实现）**：`commands.ts` 里 `LanStatus` 的 `kind` 是 **TS 联合类型** `"lan" | "configured" | ""`，而 Rust 侧是 `String` —— 这条**不一致**今天不影响（值域小），但**新增字段时别把"TS 能表达更窄的类型"当成"字段一致性有门禁"**：`check-web-commands` **不判字段**（同 [`nearby-devices-tasks.md`](2026-09-29-nearby-devices-tasks.md) T2 的"边界"那段）。

### 3.2 Rust：**新增一条读数命令**（推荐形态；理由在 §3.4）

```rust
// 位置：src-tauri/src/sync.rs（与 `LanStatus` 同域；真相源只有这一处）
//
// 为什么不在 `LanStatus` 上加字段：
//   `LanStatus` 是**发现层**的读数（谁在线、走哪档），而"正文多久能到"是**同步触发面**的读数。
//   两者的消费点不同（前者给"附近设备"那块，后者给"同步方式"那一行的说明），
//   塞进同一个结构体会让 `lan_status` 的每一次 5 秒轮询（SyncPanel.tsx:185）
//   都多算一遍与发现层无关的东西。⚠️ 这是**建议**，不是纪律 —— 若实现者选"加在 LanStatus 上"，
//   必须同时满足 §3.1 的 snake_case 口径，并且**不许**因此让 `peers` / `kind` / `line` 的读数改变
//   （反向保护先例：分片 ③-b-2a 的"没配 ⇒ 一个字节都不动"）。

/// 「正文多久能到对端」这一档的**可读出来的数**（INV-RT-cadence-honest 的载体）。
///
/// ⚠️ 三条口径：
/// 1. **间隔与 `effectiveAutoSyncMs()` 同源** —— 它算一次、这里读同一个函数；
///    不许在这里再判一遍"近实时开着吗"（两处各判一次迟早漂，先例：`syncGate.ts` 的文件头）。
/// 2. **`last_*` 一律可以是 `None`** —— 没跑过就是"没跑过"，**不许**回落成 0
///    （0 与"从没跑过"长得一样、含义相反，同 `AI-NATIVE-DEV.md` §12.2 那一族）。
/// 3. **没有服务端时 `server_bound = false`，并且这不是错误** —— 局域网那一档本来就不需要它。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BodyRealtimeStatus {
    /// 这一档**实际**会多久跑一次（ms）。`0` ＝ 不自动跑（"关闭"档）。
    /// **来源**：与 `App.tsx` 的定时器读数同一个函数（`effectiveAutoSyncMs()`）。
    pub interval_ms: i64,
    /// 最近一次"正文这一轮真的跑完了"的时刻（ms）。没跑过 ⇒ `None`。
    pub last_pull_at_ms: Option<i64>,
    /// 最近一次真的**拉到了别人的改动**的时刻（ms）。没拉到过 ⇒ `None`（**不是 0**）。
    pub last_change_at_ms: Option<i64>,
    /// 有没有服务端那条路（决定 SSE 能不能起来）。**这不是能力判定的近似** ——
    /// 它就是 `resolveWorkspaceSyncScope` 那份解析的结果。
    pub server_bound: bool,
    /// 网格这一档开着吗（`mesh::settings().bind.is_some()`，`mesh.rs:597` 的口径）。
    pub mesh_enabled: bool,
    /// ★ **人话那一句**（由 Rust 拼好，界面直接显示 —— 同 `mesh::config_state` 的 `note` 口径）。
    /// 必须**同时**说清"多久一次"与"哪一档"，且**不许**把拉取式说成推送（INV-RT-pull-not-push）。
    pub note: String,
}
```

### 3.3 Rust：**新增一条命令**（可选，但要 owner 选；代价见 §3.4）

```rust
/// 「只跑网格那一轮」—— 当传输路线的选择是"轮询"时，需要一个**不碰服务端**的触发器。
///
/// ⚠️ 它**不新建合并路径**：内部只调既有的 `mesh::round`（`mesh.rs:403`，或它的后半
/// `round_candidates`，`mesh.rs:441`）。⇒ 与 `mesh_sync_now`（`sync.rs:3056`）的差别**只有一件**：
/// 「服务端那条不跑」。这正是纯局域网那一档要的。
///
/// 为什么必须放在 Rust：`mesh_sync_now` 自己带"没配网格 ⇒ 一个字节都不动"的早退
/// （`App.tsx:375-376` 的注释逐字："这条 gate **只在 Rust 侧**…前端**不重复判一遍**"）
/// ⇒ 前端再写一遍这个判断就是第二份真相源。
#[tauri::command]
pub async fn mesh_sync_only(
    db: State<'_, Db>,
    workspace_id: Option<String>,
) -> Result<crate::mesh::MeshRoundReport, String> {
    // 与 `mesh_sync_now` 同一套三步（认空间 / 取设置与对端 / 开窗 ＋ 拉一轮），
    // **不调用**服务端那条路。实现时**必须复用** `mesh_scope`（`sync.rs:3121-3136`）
    // 与 `mesh::round`，不许抄一份。
    todo!("实现见方案 §2 的片 T3")
}
```

### 3.4 三条传输路线的形状代价（**为什么上面这两条是"最小形状"**）

| 路线 | 要不要新命令 | 要不要动协议 | 形状代价 |
|---|---|---|---|
| **轮询**（把网格那一轮按更短的间隔跑） | **要**（§3.3 的 `mesh_sync_only`，或者接受"把服务端那条也一起跑"＝更贵） | ❌ **零协议** | 一个命令 ＋ 一处定时器；**代价**是"间隔 × 对端数"的请求量（如实写进方案 §4） |
| **长连接／推送** | 要（新通道的起停 ＋ 状态，形状同 `sync_stream_*` 三条，`commands.ts:629-631`） | ✅ **要**（局域网里没有现成端点可订；见方案 §3） | 一个 SSE／WS 客户端 ＋ 退避重连 ＋ 状态读数 —— **与 `sync_stream.rs` 872 行同量级** |
| **复用既有 SSE** | **不要**（命令已有，`sync_stream_start` 在 `sync_stream.rs:314`） | ❌ 零协议 | ⚠️ **纯局域网用不上**：它订的是 `{server}/spaces/{id}/changes-stream`（`sync_stream.rs:112-114`），而局域网里**没有服务端**（需求 §6.1 第 5/6 条）⇒ **这一条只服务"有服务端"那一档，不能解决 owner 的场景** |

### 3.5 TypeScript（`src/lib/platform/commands.ts`；三处必须一致）

```ts
/** 「正文多久能到对端」这一档的读数（与 Rust `sync::BodyRealtimeStatus` 逐字段相同）。 */
export interface BodyRealtimeStatus {
  /** 这一档**实际**会多久跑一次（ms）。`0` ＝ 不自动跑。 */
  intervalMs: number;
  /** 上次跑完的时刻；没跑过 ⇒ `null`（**不是 0**）。 */
  lastPullAtMs: number | null;
  /** 上次**真拉到别人改动**的时刻；没拉到过 ⇒ `null`。 */
  lastChangeAtMs: number | null;
  /** 有没有服务端那条路（`resolveWorkspaceSyncScope` 的解析结果，不是能力近似）。 */
  serverBound: boolean;
  /** 网格这一档开着吗。 */
  meshEnabled: boolean;
  /** 人话那一句（Rust 拼好，界面直接显示；**不许**在组件里自己拼）。 */
  note: string;
}

// CommandMap 里新增（参数键必须 camelCase —— Tauri 2 只收 camelCase，`check-web-commands` 判这一条）：
//   body_realtime_status: { args: { workspaceId?: string | null }; result: BodyRealtimeStatus };
//   mesh_sync_only:       { args: { workspaceId?: string | null }; result: MeshRoundReport };
```

**Web 侧（`src/lib/platform/web.ts`）**：两条都**如实回"这一档不可用"**，照 `mesh_sync_now` 的先例（`web.ts:1565-1576` 的同一句人话），**不许**回一个空对象冒充"没有内容要同步"。

### 3.6 「事件」这一维：**本轮不新增事件**（写下来免得被"顺手加"）

- 桌面已有的流事件是 `sync-stream-change`（`useSyncStream.ts:25` `STREAM_EVENT`），**服务端那条路的**；
- 网格窗口**不发事件**（`grep -n "emit\|AppHandle" src-tauri/src/mesh.rs` ⇒ **0 处**，本轮实测）；
- ⇒ 任何"网格推来一个事件 ⇒ 界面立刻刷新"的写法**今天不存在**；要加就是**新增一条通道**（方案 §3 的长连接那一档），
  不是"复用一下"。

### 3.7 数据形状的**边界**（写下来免得后人"顺手"扩张）

- ❌ **不加 `peer_device` / 对端名进了读数**：那会把"附近设备"那张表变成第二份（[`nearby-devices-spec`](2026-09-29-nearby-devices-spec.md) §1 那条"列表只能有一处来源"）。
- ❌ **不加 `last_error`**：退避与错误属 `sync_stream.rs` 的 `StreamStatus`（`commands.ts:153-165`）；正文这一档的失败是**普通的同步失败**，走既有的 `withSyncStatus` ＋ 状态行（`App.tsx:413-416`、`useSyncStream.ts:70-78`）。
- ❌ **不加"延迟毫秒数"这种自报字段**：那是**读数**，该由判据量出来（§4），不该由程序自报（自报的数没有第三方）。

---

## 4. 延迟目标与**它怎么量**

### 4.1 目标（与需求 §5.1 同一张表，**这里只加"怎么量"**）

| id | 目标 | 我能量的部分 | **我不能量的部分**（如实） |
|---|---|---|---|
| **R-1** ≤ **30 秒** | 默认档下，一端改字 ⇒ 另一端 ≤ 30 秒可见 | ✅ **能**：把整条链拆成三段（§4.2），每段都是**本机可跑的**读数 | 真机两台隔热点 —— **不能**（要人手，同 [`nearby-devices-tasks.md`](2026-09-29-nearby-devices-tasks.md) §3 M1–M3 的形状） |
| **R-2** ≤ **5 秒** | 同上，≤5 秒 | 🟡 **能**：单次拉取本身的耗时（§4.3 段③）＋ 触发间隔**可断言**（§4.4） | 同上；**并且**需要先落方案 §2 那一片，否则**根本没有 5 秒这个可能性** |

### 4.2 三段分解（**每一段一条本机判据**）

```text
① 本地编辑 → 状态落盘 page_crdt                （今天：立即；Editor.tsx:573-578）
② 状态落盘 → outbox changes 里有一条带 crdt_state（今天：≤ 600ms 的去抖 ＋ 一次 save_page；App.tsx:308）
③ outbox → 对端真的合并进来                     （今天：取决于谁跑网格；mesh.rs:251-262 的单次拉取耗时）
```

**段①的判据形状**（`vitest`，`src/lib/crdt/` 下）：夹具编辑器改一次 ⇒ 断言**在同一个 tick 之后**（不 await 定时器）`readPageState` 已经非 `null` 且能 `decodeCrdtWire` 解出 `ok`。
**★ 变异**：把 `Editor.tsx:573` 的 `b.session.onLocalEdit(...)` 整段注掉 ⇒ 段① 必须红（这是 S3b-2e 那条"打字⇒刷新⇒字还在"的**上游**，先例：去掉 `onLocalEdit` 订阅 ⇒ 浏览器门禁恰好一条红，冲刺 §2 的 S3b-2e 行）。

**段②的判据形状**（`cargo test --lib`，`src-tauri/src/sync.rs` 的 `tests`）：起一个内存库 ⇒ `record_page_upsert` 一页 ⇒ 断言 `changes` 里那一行的 payload **含 `crdt_state`**（既有判据 `record_page_upsert_attaches_crdt_state_only_when_present`，`sync.rs:4948-4985` 已在做这件事）。
**★ 要补的是"时机"那半**：断言"`save_page_state` **之后**、`record_page_upsert` **之前**，`changes` 里那一页的 payload 仍是**旧状态**" ⇒ 把这条时序**本身**钉成事实（它今天是**真**的，见需求 §6.4 第 21 条）。**变异**：在 `save_page_state` 里顺手加一句 `record_page_upsert` ⇒ 这条判据红（**红了是对的**：那说明"改字 → outbox"之间不再需要 600ms，而那时这条时序判据就该**按新口径重写**，不是删掉 —— [`README.md`](README.md) 的铁律）。

**段③的判据形状**（`cargo test --lib mesh::`，**已成先例**）：

```text
形状：mesh::tests::two_clients_converge_over_real_loopback_with_no_hub_and_no_server
      （本机实测 23 passed / 0 failed，见需求 §10）
做法：两个库、没有服务端进程、TCP 走真环回、A 改一笔 ⇒ B 拉一轮 ⇒ 两侧投影逐字节相同
★ 变异：把 `pull_and_absorb` 里的 `absorb_peer_batch` 换成"只推进水位不应用"
        ⇒ 必须红（那正是"拉了但没合"）
⚠️ 它验的是"**能**收敛"，不是"**多久**" —— 见 §4.3
```

### 4.3 单次拉取的耗时（**可量，但要按本仓的计时纪律量**）

**形状**（新增一条**读数型**判据，不设墙钟门禁）：

```rust
// src-tauri/src/mesh.rs 的 tests：起一个真窗口（回环）＋ 一个真 client，
// 循环 N=20 次 pull_and_absorb（一次一笔新改动），**跑 3 遍取最快值**，把分布打出来。
//
// ⚠️ 三条纪律（都是本仓已经付过学费的）：
// 1. **不设墙钟门禁**：计时判据在负载下会**假红**（真事故：`graphLayout.test.ts` 250ms 收敛
//    判据实测 260ms 红，单独重跑 7/7 绿 —— 冲刺 §11.8；治法是"读数 ＋ 数量级兜底"，
//    见 `docs/TESTING.md` 的「计时类判据」条）。
// 2. **数量级兜底要有个上限**：例如"单次 pull ≤ 1500ms（**数量级**兜底）" —— 挡的是
//    "把整库扫一遍"这类退化，不挡 30/34/31ms 那种抖动。
// 3. **读数要带机器与并发负载**：只写"最快值"，并注明"当时有没有别的门禁在跑"。
```

**★ 变异**：把 `serve_own_records`（`mesh.rs:84-107`）的 `LIMIT` 去掉（返回全库）⇒ 单次耗时**必须**显著上升（**红了是预期的**：这条判据的用途就是"把退化变成读数"，不是把它变成拦路虎）。

### 4.4 触发间隔（**这是 R-1/R-2 的真正变量，也是"必须有一条读数判据"的地方**）

**形状**：一条**纯函数**判据 ＋ 一条**文本级接线**判据（两者都本机可跑，且都不吃网络）：

```text
① 纯函数（`src/lib/syncMode.test.ts` 已有先例）：断言
     effectiveAutoSyncMs() 与读数里的 intervalMs **是同一个值**
   ★ 变异：把 `SYNC_INTERVAL_MS` 改成 10_000 而不改 `BodyRealtimeStatus` 的来源
     ⇒ 必须红（这就是 INV-RT-cadence-honest 的承重那一半）

② 文本级接线（`src/components/*.wiring.test.ts` 的形状，先例 `syncPanelMesh.wiring.test.ts`）：
     断言"跑网格的那条路"在**有服务端时也不被跳过**、且"服务端那条路"与"网格那条路"
     **不是同一个调用点**（今天它们是两个：`api.syncWorkspace` / `api.meshSyncNow`）
   ★ 变异：把网格那条改成只在 `if (serverBound)` 里跑 ⇒ 必须红
     （那会让"只开网格、不绑服务端"这个**被明确支持的配置**失效 ——
      先例：`mesh::tests::a_space_with_no_server_profile_can_still_turn_the_mesh_on`）
```

⚠️ **`AI-NATIVE-DEV.md` §4 的退出码语义**：`2`（环境不具备）／`3`（无可检查对象）**都不算通过**（§12.1）。⇒ 上面这些判据**没有"读不到就跳过"这一支**：读不到配置文件／跑不起来 ⇒ 如实报，不报绿。

### 4.5 真机那一段（**本机做不了，别写成通过**）

| 要验的 | 为什么本机做不了 | 读数 |
|---|---|---|
| 两台设备隔热点，A 改字 ⇒ B ≤30s 可见（R-1） | 要两台机器 ＋ 一个热点 ＋ 人手；且**发现层**要真的互相看得见（`lan_android.rs` 那条 `MulticastLock` 只在真机可验，[nearby-devices 需求](2026-09-29-nearby-devices-requirements.md) §7-D5） | 秒表／两侧日志时间戳（截图或录屏） |
| 同上 ≤5s（R-2） | 同上 ＋ 需要先落方案 §2 的触发片 | 同上 |
| 两台**同时首开新页**（需求 §4 那个洞） | 同上；且要能**同时**操作 | 两侧是否各自出现血统冲突横幅 ＋ 两个选项都真的能选 |

---

## 5. 这里**故意不含**的

- ❌ **分片顺序、每片改哪些文件、每条判据的变异证据** —— 在方案 [`2026-09-29-realtime-body-approach.md`](2026-09-29-realtime-body-approach.md) §2。
- ❌ **每条任务的写域** —— 在任务 [`2026-09-29-realtime-body-tasks.md`](2026-09-29-realtime-body-tasks.md)。
- ❌ **为什么 owner 要这件事、他的场景原文** —— 在需求 §1（本文件只引用它的结论）。
- ❌ **`LanStatus` 既有五字段的口径** —— 逐字写在 `sync.rs:3274-3294` 与 `commands.ts:166-194`，**本文件不重写**（重写就是第二份真相源）。
- ❌ **`page_crdt` / `page_crdt_pending` 的表结构** —— 在 `db.rs` 与 `src-tauri/src/page_crdt.rs`（＋ 混版本共存那份规格）。
- ❌ **"没有服务端时首写者怎么办"那七个方案的取舍** —— 在需求 §4.3／§4.4（本文件只管"不变式不许被它绕过"）。

---

## 6. 待查（**本规格不编的**）

| # | 待查 | 怎么查 | 影响 |
|---|---|---|---|
| **R1** | `check-web-commands` **到底判不判字段一致性** | 读 `scripts/check-web-commands.mjs` 的判据段落（我读到的四条：命令存在性三方向 ＋ 参数键 camelCase；[`nearby-devices-tasks.md`](2026-09-29-nearby-devices-tasks.md) T2 的"边界"也这么写） | 决定 §3.5 的"字段一致"能不能变成机器判据（现在只能靠人核） |
| **R2** | `body_realtime_status` 的 `intervalMs` **从哪读**：`App.tsx` 读的是 `localStorage['shuyonote:autoSync']`（**界面侧的键**），Rust 侧**不知道**它 | `grep -n "autoSync\|nearRealtime\|localStorage" src-tauri/src/*.rs` ⇒ 若 Rust 完全不知道这两个键，则 **Rust 侧算不出这个数** ⇒ 读数要么由**界面**拼（那就得新增一个 TS 侧读数而不是命令），要么把档位**搬进库**（那是第二份真相源 ⚠️） | **决定 §3.2 那个结构体该住在哪一侧** —— 这一条不定，实现会走岔 |
| **R3** | 「上一次真拉到别人的改动」这个时刻**今天记不记** | `grep -n "set_peer_cursor\|last_pull\|seen_at" src-tauri/src/mesh.rs src-tauri/src/sync.rs` —— `peer_cursor` 是**水位**（`mesh.rs:120`），不是**时刻** | 决定 `last_change_at_ms` 是**真数据**还是**删掉这一项**（照 [`nearby-devices-spec`](2026-09-29-nearby-devices-spec.md) §6-R3 的处置："读不到就说读不到，不许编一个我们没观测到的状态"） |
| **R4** | 计时读数那条判据，**回环上跑**能不能代表真网段 | 无代码可查：回环没有 Wi-Fi 的丢包与延迟 | 决定 §4.3 的读数**能不能**当作 R-2 的证据 —— 我倾向"不能"，它只能当**下界**（如实写在方案 §4 风险里） |
| **R5** | `src-tauri/src/mesh.rs` 的窗口**服务侧**有没有地方记"这台对端来过" | 通读 `mesh.rs:639-900` 那一圈（`serve_own_records` / `route` / accept 循环） | 决定需求 §7-D4（"对方来过"能不能变成读数） |
