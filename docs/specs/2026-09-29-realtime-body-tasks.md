# 任务：正文「真实时」—— 可独立认领的执行清单

> 行号钉在：`a5c0f614`（2026-09-29）｜核查方式：`git show a5c0f614:<path> | sed -n '<起>,<止>p'`
> 起草：macOS 侧｜**2026-09-29**｜需求 [`2026-09-29-realtime-body-requirements.md`](2026-09-29-realtime-body-requirements.md)（为什么）·
> 规格 [`2026-09-29-realtime-body-spec.md`](2026-09-29-realtime-body-spec.md)（什么不许变）·
> 方案 [`2026-09-29-realtime-body-approach.md`](2026-09-29-realtime-body-approach.md)（怎么落、每片承重判据）
> 依据：`AI-NATIVE-DEV.md` §5.4（**没有本次的读数，不许声称完成**）＋ §4（退出码 `0/1/2/3`：**2/3 不算通过**）＋ 本仓 `AGENTS.md` §3（**新增门禁必须注册进 `scripts/lib/gates.mjs`**）
> ⚠️ **本轮只写文档，不动任何代码。** 下面每一条都是**将来**的执行单位。

---

## ⚠️ 对齐说明（2026-09-29 深夜，**欠账 #1**）—— 清单从"旧框架七条"换成"上传侧那条线"

```text
本份**写于需求 §9 之前**，其**本体**用的是旧框架：任务清单 T1–T7 里，
T2（`mesh_sync_only`）／T3（把局域网轮询触发挂上）／T4（按对端名单触发）三条
全都在做**下载侧**（"多久拉一次"），而需求 §9 的结论是：
  · 9.1 ★ **下载侧已经有**（服务端档 SSE 16ms；局域网档 owner 已拍 5 秒节拍）
  · 9.3 缺的**只有一条线**：改动落库 ⇒（防抖）⇒ 立刻上传 —— **不是缺通道、不是缺 CRDT**
  · 9.4 ⚠️ 它对**局域网档无效**（局域网只有 `GET /mesh/pull`，没有"上传"这个动作）
⇒ 本份的**处置**：
  · **§2 只列上传侧那条线**，编号**直接对迭代 2 的 ①②③**（`both-editions-iteration-plan` §迭代 2 逐字）；
  · **下载侧（旧 T2/T3/T4）移出任务清单**，改成**§3"验收已有行为"**（旧文字与判据一条不删，逐条归位）；
  · **与两半正交的支撑件（读数 T1／护栏判据 T5／文案 T6/T7）保留原编号**，防两条真相源；
  · **T0 按复查台账标"✅ 已关"**（`d021948c`；`spec-layer-review-findings` R5 已经点出它还挂在"先做"）；
  · ⚠️ **"先发后落库"（迭代 2-②）卡 D3**（撤防抖要 owner 拍）—— 逐字标在任务上。
⚠️ 又记：那条缺的线**已经被 `dfa79e1a` 补上**（编辑信号 ⇒ 防抖 400ms ⇒ 立刻上传）
   ⇒ 迭代 2-② 的写法是"**已接上、读数未验、两层防抖仍在**"，而不是"从零接"。
```

---

## 0. 怎么读这份清单

每条任务四个必写字段 ＋ 一个**写域**：

```text
做什么      一句话（可验收的形状）
改哪里      **具体文件**（不是目录；目录只在"新建"时写）
验收读数    跑什么命令、期望看到什么（**exit 2/3 不算通过** —— AI-NATIVE-DEV.md §4/§12.1）
依赖        哪几条必须先完成（`—` ＝ 没有依赖）
写域        哪些文件/目录**只有这条任务**能动（防两条任务各改一半同一个文件）
```

**认领规则**：

1. **写域不重叠**是硬约束 —— 两条任务的写域一相交，就不能并行认领（要么串行，要么先拆文件）。
2. **依赖没完成不许开工**：依赖是"签名/字段名"这类的，读到对方**已落库的提交**才算完成。
3. **验收读数必须在本机跑得出来**；跑不出来的（真机两台设备）**另立"人手验收"**，见 §5。
4. ⚠️ **编号纪律**：§2 的任务编号**直接对迭代 2 的 ①②③**（不另起一套）；
   与两半正交的支撑件**沿用本单原有 T 编号**（T1/T5/T6/T7，避免第二套编号）。
5. ⚠️ **旧编号对照表在 §2.4**（T0–T7 各自去哪了，一条不丢）。

---

## 1. 前置一档（**这七条是 §10.3 那张表 —— 但它整张已过期**，逐条实况见下面）

> 出处：[冲刺 §10.3](../plans/2026-09-23-crdt-full-launch-sprint.md)（原文那张表）＋ 本文需求 §8/§9（核对结果）。
> ⚠️ **冲刺 §10.3 的七条里，四条已关、一条已过期、两条仍开着** —— 下表逐条给出**实况**与**它对本轮的真实影响**。

| §10.3 # | 原文写的缺口 | **实况**（每行都可核） | 对本轮的真实影响 |
|---|---|---|---|
| **1** | 服务端发版（跑 v15 迁移 ＋ 部署 `feat/crdt-lineage-claim`） | ✅ **已关**：发版后探针实测 `POST https://shuyo.cn/sync/lineage-claim -> 401`（路由在、要鉴权）、旧错路径 `-> 404` | **无**（但"**真账号端到端探针**"仍开着：用真 token claim ⇒ 期望 `200 ＋ granted:true`，第二台 ⇒ `200 ＋ granted:false`；需要凭据 ⇒ owner 或人手。冲刺 §12.5 逐字） |
| **2** | 桌面侧 claim（Rust `reqwest` 发同一端点）＋ 撤掉 `WEB_ONLY` 登记 | ✅ **已关**：`src-tauri/src/sync.rs:1903` 一带的 `claim_page_lineage`（reqwest）＋ 登记**已撤**（`scripts/check-web-commands.mjs:111-119` 现在只剩 2 条 web 专属） | **无** |
| **3** | "页所属空间"传准（编辑器用 `getActiveWorkspaceId()` 近似） | ✅ **已过期**：编辑器现在**先**用这一页自己的 `workspace_id`（`api.getPage(id)`），`getActiveWorkspaceId()` 只是**取不到时的回落**（`src/editor/Editor.tsx:530-544`） | **无**（⚠️ 回落那一条仍然存在，但它是"如实 warn 再退"，不是"近似"） |
| **4** | **真机双设备验收**（离线各改一处 ⇒ 联网后两处都在） | ❌ **仍开着**（冲刺 §11.9 第 1 条逐字："本机脚本 84/0 **不等于**真机"） | ★ **两半的真机验收都在这一档**（下载侧：局域网 5 秒节拍；上传侧：P1/P2，需求 §5.3 场景 A、规格 §4.5、本单 §5-M3） |
| **5** | Rust 成对判据**执行**（`STATUS_ENTRYPOINT_NOT_FOUND`） | ✅ **已关**（且**已给出根因**）：`C:\Windows\System32\comctl32.dll` 是 5.82 ⇒ 测试 exe 没有应用清单 ⇒ 加载期 `0xC0000139`；走 `scripts/win-cargo-test.ps1` 可跑（冲刺 §11.2：**"别再重复把 pdfium.dll 放到 target/debug 旁边那类实验"**）。⚠️ **在 macOS 上这条根本不适用**：本轮 `cargo test --lib` **跑起来了** | **无** |
| **6** | yrs 对拍尖刺（JS yjs vs Rust yrs）→ 再定 S5 阶段 2 | ✅ **已做**（结论：**格式层可行**；失败形态是"卡死"不是报错；"共享 Doc 会卡"那条已被**纠正**）。冲刺 §11.3 ＋ [结论稿](../plans/2026-09-23-yrs-interop-spike-conclusions.md) | **无**（S5 阶段 2 **暂缓**，冲刺 §14.2） |
| **7** | 阶段 1 的块级 LWW／补算器拆除 | ❌ **仍开着，且前置未满足**：桌面还在用它（`apply_upsert` → `merge_remote_content`）、无状态载荷每天在走、补算器根本不是过渡量（冲刺 §11.5 三条理由） | **无直接依赖**，但⚠️ **它是一条"看起来该做、其实会拆坏"的任务** —— 认领前先读冲刺 §11.5 |

### T0 ✅ **已关（`d021948c`）** —— 原文保留（留痕）

> ⚠️ **2026-09-29 晚标"已关"**：复查台账 [`spec-layer-review-findings`](2026-09-29-spec-layer-review-findings.md) **R5** 已经点出
> "T0 要修的既存红**已经修好了**，却仍列在'先做、不修完全绿都是假的'"。
> ⇒ 本单**摘掉它的"先做"地位**，正文保留（它是旧框架的物证，也留着"怎么修"的口径）。

| 字段 | 内容 |
|---|---|
| **状态** | ✅ **已关**（`d021948c` 已把 `"remote"` 从坏值表里摘掉、并去掉那句互斥断言 ⇒ 那条判据今天全绿；`:248-251` 现在留的是这次订正的注释） |
| **做什么（原文）** | ① 修 `lineage_conflict` 那条既存红判据；② 把"本轮读数基线"跑一遍并落进本文档（或它的续篇），作为后续所有任务的对照 |
| **为什么是它（原文读数）** | 本轮实测 `cargo test --lib` ＝ **719 passed / 1 failed / 20 ignored**；失败那条：`src-tauri/src/lineage_conflict.rs:250` panic `"remote" 不该被接受`。成因：`575a58c6` 把 `CHOICE_REMOTE` 放开成**合法**值（`lineage_conflict.rs:47`），而这条判据的 `bad` 列表里还留着 `"remote"`；同一条判据后半段还有**互相矛盾**的断言 |
| **改哪里** | `src-tauri/src/lineage_conflict.rs` 的 `#[cfg(test)] mod tests`（**只动判据**，不动实现 —— 实现是对的：三个字面量都该收，第四个别收） |
| **验收读数** | ① `cd src-tauri && cargo check --tests` ⇒ exit 0（⚠️ **不是 `--lib`**：`--lib` **不查 `#[cfg(test)]`** —— `32f6fef2` 那笔提交的教训逐字在提交信息里）；② `cargo test --lib lineage_conflict::` ⇒ **4 passed / 0 failed**；③ `cargo test --lib` ⇒ **720 passed / 0 failed / 20 ignored** |
| **⚠️ 纪律** | **不许删判据不写替代**（[`docs/specs/README.md`](README.md)）：这一条要**按新口径重写**（"三个都收 ＋ 第四个别收"），不是删掉 |

---

## 2. 任务清单（**只列上传侧那条线**；编号对齐迭代 2）

> ⚠️ **旧框架归位（留痕）**：旧清单的 T2/T3/T4 是**下载侧**的活 ⇒ 移出本清单、进 **§3"验收已有行为"**。
> 这里是 §9.3 那条线：**改动落库 ⇒（防抖）⇒ 立刻上传**，以及它的前提（增量 payload）。
> 依赖图见 §6；写域汇总见 §7；**旧编号对照见 §2.4**。

### 2.1 **迭代 2-① 增量 payload**（5~8 人日；**上传侧的前提**；⚠️ 不卡任何 owner 决定）

> 出处：`both-editions-iteration-plan` §迭代 2-①（"让'增量被留下'（今天只存整份 state）"；
> 验收 **P1 ≤100ms**）＋ [`payload-increment-deep-dive`](../plans/2026-09-29-payload-increment-deep-dive.md) §4 的 P1/P2/P3。

| 任务 | 做什么 | 改哪里（写域） |
|---|---|---|
| **迭代 2-①-a**（＝深度分析 P1） | **让增量在客户端被留下**：把 `onLocalEdit(cb)` 扩成能给出**那一次 update 的字节**（或新增 `onLocalUpdate(cb: (u: Uint8Array) => void)`；⚠️ **既有 `onLocalEdit` 语义不变**）；落库时**同时**存这一次 update（一张 `page_crdt_updates`，或直接进 outbox —— ⚠️ **只在 outbox 过一手**，不留无限日志） | `src/lib/crdt/yDocBridge.ts`、`src/lib/crdt/pageBinding.ts`、落库那一处（`page_crdt_updates` 或 outbox 形状） |
| **迭代 2-①-b**（＝深度分析 P2） | **线加字段**：与 `CRDT_WIRE_FIELD = "crdt_state"` **并列**加 `crdt_update`；老对端读不懂就忽略（`sync.rs:209-217` 既有纪律） | `src-tauri/src/crdt_wire.rs`、`src-tauri/src/sync.rs` 的 `with_wire_state` 一带 |
| **迭代 2-①-c**（＝深度分析 P3） | **消费侧**：有 `crdt_update` ⇒ 走"apply update"；没有 ⇒ 退回 `crdt_state`（兜底）。⚠️ **两者必须走同一条应用路径**（`apply_pulled_changes` → `apply_upsert`），不许新造"推送专用应用路" | `src-tauri/src/sync.rs` 的应用路径 |

**验收读数（三条子任务共用）**：
```text
① ★ 承重：`apply(旧 state, update) == 新 state`（逐字节）；且**重复 apply ⇒ 内容不变**（幂等）
   变异：把 `crdt_update` 当成**替换** `crdt_state` ⇒ 必须红（首收"空状态视为相关"那条门会走偏）
② ★ 承重：`mergeRemotePageState` / `lineagesRelated` 的**定义**仍只在一处（`check-crdt-plane` ④）
   变异：给"增量"新造一条应用路 ⇒ 必须红
③ ★ 承重：**非正文不改增量**（标题/排序/父节点走 HLC ＋ 页级 LWW，本来就要整行）
   变异：把非正文也改成增量 ⇒ 必须红
④ 既有读数不得减少：`cargo test --lib mesh::` ≥ 23 passed ／ `sync::` ≥ 54 ／ `crdt_wire::` ≥ 5 ／ `page_crdt::` ≥ 4
⑤ ⚠️ `vitest` 本机**两份读数冲突**（需求 §10 ❌ vs 压测 §7-7 ✅）⇒ **认领前先核**（方案 §7-9）
```

| 字段 | 内容 |
|---|---|
| **依赖** | —（但**建议 ①-a → ①-b → ①-c** 串行；三条同一文件面） |
| **写域** | `src/lib/crdt/yDocBridge.ts`、`src/lib/crdt/pageBinding.ts`、`src-tauri/src/crdt_wire.rs`、`src-tauri/src/sync.rs`（`with_wire_state` 与应用路径那两段；⚠️ **与迭代 2-② 的读数那一段同文件 ⇒ 串行**） |

### 2.2 **迭代 2-② 先发后落库**（2~3 人日；⚠️ **卡 D3**）

> 出处：`both-editions-iteration-plan` §迭代 2-②（"撤两层防抖 ⇒ 边打边到"；验收 **P2 ≤50ms 发出**；
> ⚠️ 该迭代明写"**要 owner 拍一条：撤防抖**"）＋ [`owner-decisions-pending`](../plans/2026-09-29-owner-decisions-pending.md) **D3**。
> ⚠️ **D3（撤两层防抖：编辑器 ~600ms ＋ 上传 400ms）未拍之前，本任务只做 `-a`（读数与判据），不许动那两个窗口。**

| 任务 | 做什么 | 改哪里（写域） |
|---|---|---|
| **迭代 2-②-a**（**不卡 D3，先做**） | **把上传侧变成可读出来的数**：`BodyRealtimeStatus` 补上传侧三个字段（`uploadDebounceMs` / `lastUploadAtMs` / `uploadTrigger`，形状**逐字**见规格 §3.3）；⚠️ 先解决规格 §6-R2（"间隔从哪读"）；上传侧那一处的**位置已核**（规格 §6-R6：`App.tsx` 的 effect `onAnyLocalEdit` ⇒ `LOCAL_EDIT_UPLOAD_DEBOUNCE_MS = 400` ＋ `yDocBridge.ts` 的模块级 `onAnyLocalEdit()`），**但"净等待"的读数仍没有** | 取决于 §6-R2：`src/lib/realtimeBodyStatus.ts`（新建，界面侧）／`src-tauri/src/sync.rs` ＋ `commands.ts` ＋ `web.ts` ＋ `api.ts` ＋ `lib.rs`（走命令） |
| **迭代 2-②-b**（**⚠️ 卡 D3；拍了才开工**） | **撤两层防抖**（保存 ~600ms ＋ 上传 400ms）⇒ "发"不等"存"；⚠️ **本地写入仍先于网络**（D3 的理由逐字就是"会改变'落库时机'的语义"） | `src/App.tsx`（`:420-431` 的 600ms；`:517-534` 的 tick；`dfa79e1a` 那个 effect 的 400ms）、`src/lib/crdt/yDocBridge.ts`（模块级 `onAnyLocalEdit()`）、`src/lib/crdt/pageBinding.ts`（`onLocalEdit` 一族） |
| **迭代 2-②-c**（与 `-b` 同批） | **闸门与唯一性**：上传触发**必须**过 `shouldAutoSyncNow()`（`src/lib/syncGate.ts:22-30`）；且**不许**出现第二个"自动上传"调用点 | `src/lib/syncGate.ts` 的调用点（新增这一处）、`src/lib/api.ts`（若需要薄包） |

**验收读数**：
```text
① `./node_modules/.bin/tsc --noEmit` ⇒ exit 0
② `node scripts/check-web-commands.mjs` ⇒ exit 0（若 `-a` 走了命令那一支）
③ ★ 承重（`-a`）：读懂数 —— `lastUploadAtMs` 在编辑之后**真的前进**（`None` ≠ 0）
   变异：把 `pageBinding` 的 `onLocalEdit` 订阅注掉 ⇒ 读数**必须停止前进**（红了是对的）
④ ★ 承重（`-a`）：`uploadDebounceMs` 与**真实的两层防抖**同源（不许在读数里写成 0 而两处 setTimeout 还在）
   变异：只改读数 ⇒ 必须红（这条同时挡住"没拍 D3 就先斩后奏"）
⑤ ★ 承重（`-b`）：**本地优先不许变** —— 本地写入仍先于网络
   变异：把上传挪到"落库之后才发"、或让网络失败阻塞本地写入 ⇒ 必须红
⑥ ★ 承重（`-c`）：新触发不调闸门 ⇒ 必须红（真机实测过"把间隔调成每 10 秒就在蜂窝上照拉"，`syncGate.ts` 文件头逐字）
⑦ 真机：P2 ≤50ms 发出（本机做不到 ⇒ §5-M3；回环只能当下界）
```

| 字段 | 内容 |
|---|---|
| **依赖** | **迭代 2-①**（增量：不把 payload 变小，"边打边到"每一下都传整页）＋ **D3 拍板**（`-b`/`-c`）；`-a` 只依赖规格 §6-R2/R6 |
| **写域** | `src/App.tsx`、`src/lib/crdt/pageBinding.ts`、`src/lib/syncMode.ts`（若档位口径要动）、`src/lib/syncGate.ts`、`src/lib/platform/commands.ts`、`src/lib/api.ts`、`src-tauri/src/sync.rs`（**与迭代 2-①-c 同文件 ⇒ 串行**）、`src-tauri/src/lib.rs`（⚠️ 共享，见 §7） |
| **⚠️ 卡点（逐字）** | D3 原文：「**撤两层防抖**（编辑器 ~600ms ＋ 上传 400ms）｜**企业版 P2「边打边到」**｜会改变"落库时机"的语义 ⇒ 要一句确认」 |

### 2.3 **迭代 2-③ 光标**（5~8 人日；⚠️ **另一条线，不算进 §9 那条线**）

> ⚠️ **告示**：需求 §9.5① 把"看不到对方光标"列为**非目标**，需求 §9 的"不做"表把"多光标／在线状态"
> 划成**另一条线**；迭代 2 的 ③ 是**同一迭代里的另一条线**。
> ⚠️ **不许**把它算成"§9 缺的那条线"，更不许说它"同时解决两档"（§9.4 点名的旧错误）。
> ⚠️ **只在明文空间做**：个人空间（E2E）里光标位置就是内容元数据 ⇒ **不该有**（`10000-with-wps-experience` 账三／§7-②）。

| 字段 | 内容 |
|---|---|
| **做什么** | 局域网光标：新一条**光标报文**（⚠️ **必须另立版本号**：`decode_announce` 对不认识的版本**一律丢弃且不猜**，`lan.rs:117-129`）＋ 编辑器侧渲染点；节流 **50~100ms**（P3 验收逐字："光标可见且**没人动时零流量**"） |
| **改哪里** | `src-tauri/src/lan.rs` 一带（协议）＋ 编辑器侧渲染点（`src/editor/Editor.tsx` 或专用组件）＋ `src/lib/platform/commands.ts` / `api.ts`（若需要） |
| **验收读数** | ① `cargo test --lib lan::` ⇒ ≥ 19 passed（本机基线）；② ★ 承重：**没人动时零流量**（变异：空转也发 ⇒ 必须红）；③ ★ 承重：**E2E 空间不许有光标**（变异：接到个人空间 ⇒ 必须红）；④ 真机：两个光标互相可见（本机做不到 ⇒ §5-M4 形状） |
| **依赖** | —（但与 [`nearby-devices-*`](2026-09-29-nearby-devices-requirements.md) 的 UDP 通道改动**串行**：**同一时刻只有一条线能动那个通道**） |
| **写域** | `src-tauri/src/lan.rs`（⚠️ **热点文件**：与 nearby-devices 的通道改动**串行**）、`src/editor/Editor.tsx`（新增一段；⚠️ 与其它编辑器改动串行） |

### 2.4 支撑件（**与两半正交 ⇒ 沿用原有 T 编号，不另起一套**）

> ⚠️ **旧框架归位（留痕）**：T1/T5/T6/T7 不是"下载侧"也不是"上传侧"，换框架**不动它们**；
> 只在两处按两半**扩口径**：T1 的读数分成两半、T6 的文案要分开说两半（并处理"5 分钟兜底"那句）。

#### T1 **把"多久一次"变成两半读数**（扩口径；⚠️ 不卡 D3 的那一半＝迭代 2-②-a）

| 字段 | 内容 |
|---|---|
| **做什么** | 新增 `BodyRealtimeStatus`（形状**逐字**见规格 §3.3：**下载侧五个字段 ＋ 上传侧三个字段**）＋ 一条命令／读数把它交出去；⚠️ **先解决规格 §6-R2**（"间隔从哪读"：档位住在 `localStorage['shuyonote:autoSync']`，`src/lib/syncMode.ts:140`，**Rust 看不到它**） |
| **改哪里** | 取决于 §6-R2：<br>· 若读数**住在界面侧** ⇒ `src/lib/realtimeBodyStatus.ts`（新建，纯函数）＋ `src/components/SyncPanel.tsx`（展示那一行）<br>· 若**必须走命令** ⇒ `src-tauri/src/sync.rs`（结构体）＋ `src/lib/platform/commands.ts` ＋ `web.ts` ＋ `src/lib/api.ts` ＋ `src-tauri/src/lib.rs`（`generate_handler!`） |
| **验收读数** | ① `./node_modules/.bin/tsc --noEmit` ⇒ exit 0；② `node scripts/check-web-commands.mjs` ⇒ exit 0（若加了命令）；③ **承重**：`vitest` 里一条"读数的 `pullIntervalMs` 与 `effectiveAutoSyncMs()` 同源"的断言 —— **变异**：把 `SYNC_INTERVAL_MS`（`src/lib/syncMode.ts:25`）改成 `10_000` 而不动读数 ⇒ 必须红；④ **新增承重**：`uploadDebounceMs` 与两处真实防抖同源（规格 §4.4(b)）—— **变异**：只改读数 ⇒ 必须红 |
| **依赖** | —（但**开工前必须**先答规格 §6-R2/R6） |
| **写域** | `src/lib/realtimeBodyStatus.ts`（新建，仅当走界面侧）／`src-tauri/src/sync.rs` 的**新结构体那一段**（⚠️ **与迭代 2-①-c／2-② 共享 `sync.rs`** ⇒ 串行） |

#### T5 **文本级护栏：`lineagesRelated` 也只许有一处**（片 D 的判据那一半）

| 字段 | 内容 |
|---|---|
| **做什么** | 把 `check-crdt-plane` 的判据④从"`mergeRemotePageState` 定义只许一处"**扩到** `lineagesRelated`（今天它的定义在 `src/lib/crdt/pageBinding.ts:132` 一带，**只有一处**） |
| **改哪里** | `scripts/check-crdt-plane.mjs`（**扩判据**）＋ `scripts/check-crdt-plane.test.mjs`（若它自己有自测：**必须两边都验** —— 正例绿 ＋ 负例红）＋ ⚠️ **若改了门禁判据 ⇒ 它自己的「看过它红」证据会过期**（`_workspace/mutation-evidence.json` 按脚本 sha 绑定，`AI-NATIVE-DEV.md` §12.5）⇒ **顺手重做那条证据** |
| **验收读数** | ① `node scripts/check-crdt-plane.mjs` ⇒ exit 0；② `node scripts/check-crdt-plane.mjs --self-test` ⇒ 全绿（若它支持）；③ ★ **承重（变异实测）**：在 `pageBinding.ts` 里加一个**第二处** `lineagesRelated` 的**定义** ⇒ 门禁**必须红**；随后**逐字节还原**（`git status --short` 为空 **不算**还原的证据 —— `AI-NATIVE-DEV.md` §12.7 逐字："还原的判据只能是 sha／逐字节比"） |
| **依赖** | —（与任何任务**完全并行**：只碰 `scripts/`） |
| **写域** | `scripts/check-crdt-plane.mjs`、`scripts/check-crdt-plane.test.mjs`、`_workspace/mutation-evidence.json`（⚠️ **它在工作区根，不在本仓** ⇒ 若本机没有它，见需求 §7-D6） |

#### T6 **文案与读数：两半分开说，且不许把"正文实时"说成"全部实时"**（扩口径）

| 字段 | 内容 |
|---|---|
| **做什么** | ① `syncModeHint` 那一句（`src/lib/syncMode.ts:125-137`）**现在只说"连着同步服务时…"** —— 要**补上局域网这一档会发生什么**（并把"多久"换成**读数里的同一个数**）；② ⚠️ **补上"两半"**：文案**必须**能分开回答"别人改了我多久看到"与"我改了别人多久看到"，且**不许**拿"最坏 5 分钟兜底"解释上传侧（`INV-RT-two-halves`）；③ 面板上那一行的文案不许暗示"推送"；④ 不许暗示"所有内容立刻同步"（标题／排序仍按页级 LWW） |
| **改哪里** | `src/lib/syncMode.ts`（文案唯一来源）、`src/components/SyncPanel.tsx`（展示）、`src/lib/i18n/*`（若文案有译文条目） |
| **验收读数** | ① `tsc --noEmit` ⇒ exit 0；② ★ **承重**：一条**文本级**判据 —— `syncModeHint` 与面板文案里**不许**出现"推送"（除非同句说明"文件里它是拉取式"）、**不许**出现"所有内容/全部内容立刻同步"、且"5 分钟／兜底"只许出现在**下载侧**那一句 —— **变异**：把文案改成"所有内容立刻同步"、或拿兜底间隔解释上传侧 ⇒ 必须红（`INV-RT-body-not-all` ＋ `INV-RT-pull-not-push` ＋ `INV-RT-two-halves` 的落点） |
| **依赖** | **T1**（文案里那两个数要来自读数，不许各写一遍） |
| **写域** | `src/lib/syncMode.ts`、`src/components/SyncPanel.tsx`（⚠️ 与其它面板任务共享 ⇒ 串行）、`src/lib/i18n/*` |

#### T7 **片 D 的文案：把"同时首开新页会怎样"如实说出来**

| 字段 | 内容 |
|---|---|
| **做什么** | 在"同步方式"那一行（或血统冲突横幅的说明里）**如实写出**：两台设备**同时**打开一张**从没同步过**的新页 ⇒ 会各自建一条编辑历史 ⇒ 需要用户选一次（`LineageConflictBanner` 三个选项）。**不许**承诺"自动合并"（需求 §4.2 已经定性：这一格**没有唯一真值**） |
| **改哪里** | `src/components/SyncPanel.tsx` 或 `src/components/LineageConflictBanner.tsx`（文案 ＋ 说明）＋ `src/lib/i18n/*` |
| **验收读数** | ① ★ **承重**：一条文本级判据 —— 那段文案里**必须**出现"选"（用户要做决定这件事），且**不许**出现"自动合并／会自动解决" —— **变异**：改成"会自动合并" ⇒ 必须红；② 真 Chromium 门禁里那三种态**各自有断言**（形状照 [`nearby-devices-tasks.md`](2026-09-29-nearby-devices-tasks.md) T3 的"四态可分"） |
| **依赖** | —（文案独立；但**建议在 T6 之后落**，两条都改 `SyncPanel.tsx`） |
| **写域** | `src/components/SyncPanel.tsx`（⚠️ 串行）、`src/components/LineageConflictBanner.tsx`、`src/lib/i18n/*` |

### 2.5 ⚠️ **旧编号 → 新位置 对照表**（**一条不丢**）

| 旧编号 | 它原来是（旧框架） | 现在去哪了 | 为什么 |
|---|---|---|---|
| **T0** | 修既存红 ＋ 基线（"先做"） | **§1 · ✅ 已关**（`d021948c`） | 复查台账 R5 |
| **T1** | "多久一次"读数 | **§2.4 · T1**（扩口径：两半读数） | 与两半正交；只按两半拆字段 |
| **T2** | `mesh_sync_only` 命令（局域网触发） | **§3 · 下载侧（旧框架遗留，不进本单）** | 下载侧已有答案（5 秒节拍）；形状与判据归位到规格 §3.2 |
| **T3** | 把触发挂上（局域网这一档） | **§3 · 下载侧"验收已有行为"** | 触发**已经挂着**（`App.tsx:167`），且节拍已由 owner 拍成 5 秒 |
| **T4** | 按对端触发（`LanStatus.nearby` 名单式） | **§3 · 下载侧（优化；归 nearby-devices）** | 它是下载侧优化，不是 §9 缺的那条线 |
| **T5** | `lineagesRelated` 只许一处 | **§2.4 · T5**（原样） | 与两半正交（护栏） |
| **T6** | 文案：不许说成"全实时" | **§2.4 · T6**（扩口径：＋两半分开说） | 与两半正交；新增"不许拿兜底解释上传侧" |
| **T7** | 文案：同时首开会怎样 | **§2.4 · T7**（原样） | 与两半正交（片 D） |

---

## 3. 下载侧：**验收已有行为**（⚠️ **不实现** —— 旧 T2/T3/T4 归位到此）

> ⚠️ **旧框架归位（留痕）**：旧清单把 T2/T3/T4 当成"缺的那半"来**实现**。
> 两半框架下下载侧**已经有答案**（§9.1）⇒ 本节把它们改成**验收已有行为**：
> 一条不删（判据与变异逐条保留在方案 §2 片 0），但**不进"要写的代码"清单**。

| 要验的（已有行为） | 今天是什么（读数） | 已有的判据载体 |
|---|---|---|
| 服务端档：推到收到 | 服务端 push 帧 ⇒ `pullOnce` ⇒ `api.syncWorkspace` = **16ms**（设计稿 §5.1 实测，需求 §9.1） | `src/hooks/useSyncStream.wiring.test.ts` ⑧（"流通道不碰轮询"） |
| 局域网档：拉取节拍 | **5 秒**（owner 拍，`src/lib/syncMode.ts:71` `PULL_INTERVAL_DEFAULT_MS = 5_000`）＋ 每一轮顺手跑网格（`App.tsx:167`） | `vitest` 的 `src/lib/syncMode.test.ts`（"近实时开着 ⇒ 兜底轮询必须挂着"那条谓词） |
| 网格那一轮**不许**被"有服务端档案"包住 | 今天它在 `if (bound.length)` **外面**（`App.tsx:153` vs `:163-169`） | `src/components/syncPanelMesh.wiring.test.ts`（断言两处都有 `api.meshSyncNow(`，`:25` / `:38`） |
| 自动触发**必须**过闸门 | `src/lib/syncGate.ts:22-30`（`shouldAutoSyncNow` 在 `:26`） | 同上 ＋ `App.tsx:149` 的调用点 |
| 面板那个 **5000ms** 定时器**只读读数、不拉数据** | `SyncPanel.tsx:179-205`（`tick` 只调 `api.lanStatus`） | 既有文本级判据（若没有，按方案 §2 片 0 判据②的形状补一条） |
| 网格是**拉取式**、**不发事件** | `GET /mesh/pull`（`mesh.rs:265-273`）；`grep emit src-tauri/src/mesh.rs` = **0 处** | `INV-RT-pull-not-push` 要立的那条（T6 的文案判据同源） |
| 既有收敛判据（"能收敛"，不是"多久"） | `mesh::tests::two_clients_converge_over_real_loopback_with_no_hub_and_no_server`（本机 **23 passed / 0 failed**） | `cargo test --lib mesh::` |

**⚠️ 两条旧框架遗留（明确不属本单，留痕）**：
```text
① `mesh_sync_only`（旧 T2）：形状与三条判据（必须复用 mesh_scope / mesh::round；内部不许出现
   sync_workspace / do_push / do_pull；lan_status 的 peers/kind/line 逐字段不变）
   ⇒ 逐字保留在**规格 §3.2 的归位块**里。要做得**另立"下载侧"任务**，不许塞进本单。
② 按对端触发（旧 T4，用 LanStatus.nearby）：前置是 nearby-devices 的 T1/T2；
   两条纪律保留（判"要不要跑"必须来自 nearby 列表而不是 peers 数量；组件里不许自己算
   "某台设备服务哪些空间"）⇒ 它是**下载侧优化**，不是 §9 那条线。
```

---

## 4. **不做**（本轮显式留白）

| 不做 | 出处 |
|---|---|
| ❌ **纯局域网"同时首开新页"的自动裁定**（名册式／页创建者／内容同源可合／局域网准服务端） | 需求 §4.3（七个方案 ＋ `G` 被 owner 2026-09-25 冻结）／§9 |
| ❌ **重启甲-2（客户端自己发号牌／留账本）** | owner 2026-09-25 冻结（[nearby-devices 需求](2026-09-29-nearby-devices-requirements.md) §9） |
| ❌ **把"缺一条线"做成"缺通道／长连接／CRDT"** | 需求 §9.3 明说不是；本单 §2 的承重判据就是挡它的 |
| ❌ **指望同一条线解决局域网档** | 需求 §9.4：局域网只有 `GET /mesh/pull`，**没有"上传"这个动作** |
| ❌ **拿"5 分钟兜底"解释上传侧** | 需求 §9.2：那个理由**只对下载侧成立** |
| ❌ **给 Rust 加 Yjs／yrs（服务端合并那一半）** | 冲刺 §14.2（S5 阶段 2 **暂缓**：能不能做已回答，值不值得做没回答） |
| ❌ **把 CRDT 状态塞进 `content_json`／让 Rust 认识 CRDT** | 混版本共存三句地基（`check-crdt-plane`，`gates.mjs:105-117`） |
| ❌ **在桌面上再写一份合并实现** | 规格 `INV-RT-guard-not-bypassed`（唯一实现：`crdt/pageBinding.ts`） |
| ❌ **非正文（标题／父节点／排序／图标）的实时** | 需求 §3 |
| ❌ **Web 档的多设备实时正文** | 需求 §9（Web 没有发现层、开不了网格窗口） |
| ❌ **多光标／在线状态进"这条线"** | 需求 §9.5① ＋ 需求 §9"不做"表（＝迭代 2-③ **另一条线**，见 §2.3） |
| ❌ **接收侧派生文本滞后的收口** | 需求 §9 ＋ 方案 §4 风险 4/5（**要有"什么时候补算"的口径 ＋ 判据**；顺手的修法 `dirty=1` 是**假账**，冲刺 §13.3 逐字警告过） |
| ❌ **`page_crdt_pending` 的"按 seq 逐条留"语义** | 冲刺 §13.1（服务端 pull 不回 `device_id` ⇒ "每页一行"是**真丢**） |

---

## 5. 人手 / 设备 / owner 点头 的那一档（**不许混进"本机可做"**）

> ⚠️ `AI-NATIVE-DEV.md` §5.4 的红旗之一是「上次是全绿的」/「队友说成功了」；
> 这里的正确写法是**「没做」**，不是"应该没问题"。

| # | 要谁 | 要什么 | 为什么本机做不了 | 读数 |
|---|---|---|---|---|
| **M1** | owner | 给"实时"一个数：R-1（≤30 秒）够不够？还是要 R-2（≤5 秒）？ | 代码里没有这个数（需求 §7-D2） | ✅ **已拍（`d021948c`）= 局域网档 5 秒节拍**；⚠️ 原文保留（它当时是下载侧的问题） |
| **M2** | **owner** | **拍需求 §4 那一格**：纯局域网同时首开新页 ⇒ 走 A（只做有服务端／已有血统的实时）＋F（三选项出口）？还是 B（名册式）？ | 代价**用户可见**（"小明和小王同时开一张新页会发生什么"）；agent 不该替 owner 定 | owner 的答复原话 |
| **M3** | **人手 ＋ 两台真机** | ① 下载侧：局域网档 A 改字 ⇒ B **≤5 秒**可见（owner 拍的节拍），**全程零操作**；② **上传侧：P1 ≤100ms ｜ P2 ≤50ms 发出**（迭代 2 验收；⚠️ 要先撤防抖＝等 D3） | 要两台机器 ＋ 热点；回环没有丢包与 Wi-Fi 重传（方案 §4 风险 7） | 秒表／两侧日志时间戳（截图或录屏）＋ "撤没撤防抖" |
| **M4** | **人手 ＋ 两台真机** | 需求 §5.3 场景 B：两台**同时**首开一张新页 ⇒ 两侧**各自**出现血统冲突横幅，且三个选项**真的都能选** | 要能**同时**操作 ＋ 两台机器 | 两张截图（各自的横幅）＋ 选完之后两侧内容 |
| **M5** | **owner 或人手（要凭据）** | **真账号端到端探针**：真 token claim 一次 ⇒ 期望 `200 ＋ granted:true`；第二台 ⇒ `200 ＋ granted:false` | 要真账号凭据（冲刺 §12.5 逐字："需要凭据 ⇒ owner 或人手"） | 两条 HTTP 响应（**别回显 token**） |
| **M6** | **人手 ＋ 一台真机** | 量"每 5 秒一次网格轮询"的请求量与耗电（安卓那台最要紧） | 只有真机能量（方案 §7-6） | 请求数／电量截图；**这一条回填 M1 的"代价"那一半（数已给，代价未量）** |
| **M7** | **owner** | ⚠️ **拍 D3：撤两层防抖**（编辑器 ~600ms ＋ 上传 400ms） | 它改变"落库时机"的语义；且**本地优先的性质不能变**（"发"不等"存"） | D3 的答复原话（落进 [`owner-decisions-pending`](../plans/2026-09-29-owner-decisions-pending.md) 的「已拍」）；**未拍 ⇒ 迭代 2-②-b/-c 停在这里** |
| **M8** | **owner** | 确认**光标分层**：光标只在**明文空间**有，E2E 个人空间没有（因为光标位置就是内容元数据） | 元数据边界不是工程能定的（`10000-with-wps-experience` §7-②） | owner 的答复原话；**未拍 ⇒ 迭代 2-③ 只能停在"局域网明文"那一半** |

⚠️ **M3/M4 不许写成"通过"**：`AI-NATIVE-DEV.md` §5.4 的"队友说成功了"那一行逐字适用。

---

## 6. 依赖图（一张图看完"谁先谁后"）

```text
T0（修既存红）✅ 已关（d021948c）—— 不再是任何任务的前置

【上传侧那条线（§9.3）】
迭代 2-①（增量 payload）─→ 迭代 2-②-a（上传侧读数）─→ 迭代 2-②-b/-c（撤防抖＋闸门）
                                                          ⚠️ -b/-c **卡 M7（D3）**
迭代 2-① ‖ 迭代 2-②-a ‖ T5（scripts/）‖ T1（读数）——可并行（写域与迭代 2-① 相交的按 §7 串行）

【另一条线（不算进上面）】
迭代 2-③（光标）—— 与 nearby-devices 的 UDP 通道改动**串行**；⚠️ 卡 M8 的分层确认

【正交支撑】
T5（护栏判据）── 独立，可与任何任务并行
T1（两半读数）─┬─→ T6（文案：两半分说）─→ T7（文案：同时首开会怎样）
               └─→ 迭代 2-②-a（上传侧读数就挂在它上面）

【下载侧（不进本单）】
§3 的"验收已有行为"── 与上传侧**无依赖**，随时可做（只产出读数与判据的验收）

M2（首写者）／M7（D3）／M8（光标分层）── owner 拍；M1 ✅ 已拍（5 秒）
M3/M4（真机）──────→ 验收（下载侧 ＋ 上传侧 ＋ 光标）
M5（凭据）─────────→ §10.3-1 那条"真账号探针"的收口
M6（真机量）───────→ 回填 M1 的"代价"那一半
```

**并行提示（写域的约束）**：

- `src-tauri/src/sync.rs` 是**热点**（迭代 2-①-c／迭代 2-②-a／T1 都要动）⇒ **串行**，建议顺序：T1 的结构体 → 迭代 2-①-c 的应用路径 → 迭代 2-②-a 的读数补字段。
- `src/components/SyncPanel.tsx` 也是**热点**（T1 展示／T6/T7）⇒ **同一时刻只有一个执行者能持它**。
- `src-tauri/src/lib.rs`、`src/lib/platform/commands.ts`、`src/lib/api.ts` 也是共享的（迭代 2-②／T1）⇒ **按"谁先落库谁先动"串行**。
- `src-tauri/src/lan.rs` 与 nearby-devices 共用 ⇒ **迭代 2-③ 必须等那份文档的通道改动收工**。
- 真正能并行的：**T5 ‖ 任何**（只碰 `scripts/`）＋ **迭代 2-① 的 JS 那一半 ‖ 迭代 2-②-a 的读数那一半**（不同文件时）。

---

## 7. 每条的写域汇总（**防两条任务各改一半同一个文件**）

| 任务 | 写域（文件级） |
|---|---|
| 迭代 2-①-a | `src/lib/crdt/yDocBridge.ts`、`src/lib/crdt/pageBinding.ts`、落库那一处（`page_crdt_updates` 或 outbox 形状） |
| 迭代 2-①-b | `src-tauri/src/crdt_wire.rs` |
| 迭代 2-①-c | `src-tauri/src/sync.rs`（应用路径那一段） |
| 迭代 2-②-a | `src/lib/realtimeBodyStatus.ts`（新建）／`src-tauri/src/sync.rs`（读数结构体那一段） |
| 迭代 2-②-b/-c | `src/App.tsx`、`src/lib/crdt/yDocBridge.ts`、`src/lib/crdt/pageBinding.ts`、`src/lib/syncMode.ts`、`src/lib/syncGate.ts`、`src/lib/platform/commands.ts`、`src/lib/api.ts`、`src-tauri/src/sync.rs`、`src-tauri/src/lib.rs` |
| 迭代 2-③ | `src-tauri/src/lan.rs`、`src/editor/Editor.tsx`（光标渲染那一段）、`src/lib/platform/commands.ts`／`api.ts`（若需要） |
| T1 | `src/lib/realtimeBodyStatus.ts`（新建）／`src-tauri/src/sync.rs`（新结构体那一段） |
| T5 | `scripts/check-crdt-plane.mjs`、`scripts/check-crdt-plane.test.mjs`、`_workspace/mutation-evidence.json`（**工作区根，不随仓分发**） |
| T6 | `src/lib/syncMode.ts`、`src/components/SyncPanel.tsx`、`src/lib/i18n/*` |
| T7 | `src/components/SyncPanel.tsx`、`src/components/LineageConflictBanner.tsx`、`src/lib/i18n/*` |

⚠️ **四处共享要写清楚**：

1. `src-tauri/src/sync.rs`：**四个任务**都要动（迭代 2-①-c／2-②-a／T1）⇒ **串行**；
2. `src-tauri/src/lib.rs`：迭代 2-②-a（走命令那一支）＋ T1 各加 `generate_handler!` 一行 ⇒ **合一次改**；
3. `src/lib/platform/commands.ts` ＋ `src/lib/api.ts`：迭代 2-②／T1／迭代 2-③ 都要加契约与薄包 ⇒ **串行**；
4. `src/components/SyncPanel.tsx`：T1/T6/T7 三个都要改 ⇒ **按 T1 → T6 → T7 串行**（T1 要先有真实读数，T6/T7 才知道该说什么）。

⚠️ **新增门禁的纪律**（本仓 `AGENTS.md` §3 铁律）：**任何新判据**在动手前先问"它要不要成为一条门禁" ——
若是静态扫描，**必须**注册进 `scripts/lib/gates.mjs`（**只挂 `package.json` 的 build 链等于在 CI 上隐形** —— 本仓踩过两次：
`mobile-views` 2026-09-22、`check-hook-order` 2026-09-25）；**删门禁／改 id／调低基线一律判红**。
⚠️ 而**改门禁判据 ⇒ 它的「看过它红」证据过期**（`AI-NATIVE-DEV.md` §12.5：跨机生效）⇒ 顺手重做，否则提交会被 hook 拦下。

---

> ⚠️ **欠账 #1 的对齐范围**：本次只动本份、规格与方案三份的**本体**（把它们从旧框架换到 §9 的两半框架）。
> **需求（含 §9）、两份版本需求、判据矩阵、迭代计划、成本分析、`nearby-devices-*`、`owner-decisions-pending`、
> 任何代码、`AGENTS.md`／`INVARIANTS.md` 一律未动。**
