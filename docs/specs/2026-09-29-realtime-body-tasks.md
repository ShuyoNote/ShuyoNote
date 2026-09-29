# 任务：正文「真实时」—— 可独立认领的执行清单

> 起草：macOS 侧｜**2026-09-29**｜需求 [`2026-09-29-realtime-body-requirements.md`](2026-09-29-realtime-body-requirements.md)（为什么）·
> 规格 [`2026-09-29-realtime-body-spec.md`](2026-09-29-realtime-body-spec.md)（什么不许变）·
> 方案 [`2026-09-29-realtime-body-approach.md`](2026-09-29-realtime-body-approach.md)（怎么落、每片承重判据）
> 依据：`AI-NATIVE-DEV.md` §5.4（**没有本次的读数，不许声称完成**）＋ §4（退出码 `0/1/2/3`：**2/3 不算通过**）＋ 本仓 `AGENTS.md` §3（**新增门禁必须注册进 `scripts/lib/gates.mjs`**）
> ⚠️ **本轮只写文档，不动任何代码。** 下面每一条都是**将来**的执行单位。

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
3. **验收读数必须在本机跑得出来**；跑不出来的（真机两台设备）**另立"人手验收"**，见 §4。
4. ⚠️ **本机有一条既存红**（见 T0）：**它不修完，任何"全绿"读数都是假的**。

---

## 1. 前置一档（**这七条是 §10.3 那张表 —— 但它整张已过期**，逐条实况见下面）

> 出处：[冲刺 §10.3](../plans/2026-09-23-crdt-full-launch-sprint.md)（原文那张表）＋ 本文需求 §8/§9（核对结果）。
> ⚠️ **冲刺 §10.3 的七条里，四条已关、一条已过期、两条仍开着** —— 下表逐条给出**实况**与**它对本轮的真实影响**。

| §10.3 # | 原文写的缺口 | **实况**（每行都可核） | 对本轮的真实影响 |
|---|---|---|---|
| **1** | 服务端发版（跑 v15 迁移 ＋ 部署 `feat/crdt-lineage-claim`） | ✅ **已关**：发版后探针实测 `POST https://shuyo.cn/sync/lineage-claim -> 401`（路由在、要鉴权）、旧错路径 `-> 404` | **无**（但"**真账号端到端探针**"仍开着：用真 token claim ⇒ 期望 `200 ＋ granted:true`，第二台 ⇒ `200 ＋ granted:false`；需要凭据 ⇒ owner 或人手。冲刺 §12.5 逐字） |
| **2** | 桌面侧 claim（Rust `reqwest` 发同一端点）＋ 撤掉 `WEB_ONLY` 登记 | ✅ **已关**：`src-tauri/src/sync.rs:1903` 一带的 `claim_page_lineage`（reqwest）＋ 登记**已撤**（`scripts/check-web-commands.mjs:111-119` 现在只剩 2 条 web 专属） | **无** |
| **3** | "页所属空间"传准（编辑器用 `getActiveWorkspaceId()` 近似） | ✅ **已过期**：编辑器现在**先**用这一页自己的 `workspace_id`（`api.getPage(id)`），`getActiveWorkspaceId()` 只是**取不到时的回落**（`src/editor/Editor.tsx:530-544`） | **无**（⚠️ 回落那一条仍然存在，但它是"如实 warn 再退"，不是"近似"） |
| **4** | **真机双设备验收**（离线各改一处 ⇒ 联网后两处都在） | ❌ **仍开着**（冲刺 §11.9 第 1 条逐字："本机脚本 84/0 **不等于**真机"） | ★ **本轮的 R-1/R-2 验收也在这一档**（需求 §5.3 场景 A、规格 §4.5） |
| **5** | Rust 成对判据**执行**（`STATUS_ENTRYPOINT_NOT_FOUND`） | ✅ **已关**（且**已给出根因**）：`C:\Windows\System32\comctl32.dll` 是 5.82 ⇒ 测试 exe 没有应用清单 ⇒ 加载期 `0xC0000139`；走 `scripts/win-cargo-test.ps1` 可跑（冲刺 §11.2：**"别再重复把 pdfium.dll 放到 target/debug 旁边那类实验"**）。⚠️ **在 macOS 上这条根本不适用**：本轮 `cargo test --lib` **跑起来了** | **无** |
| **6** | yrs 对拍尖刺（JS yjs vs Rust yrs）→ 再定 S5 阶段 2 | ✅ **已做**（结论：**格式层可行**；失败形态是"卡死"不是报错；"共享 Doc 会卡"那条已被**纠正**）。冲刺 §11.3 ＋ [结论稿](../plans/2026-09-23-yrs-interop-spike-conclusions.md) | **无**（S5 阶段 2 **暂缓**，冲刺 §14.2） |
| **7** | 阶段 1 的块级 LWW／补算器拆除 | ❌ **仍开着，且前置未满足**：桌面还在用它（`apply_upsert` → `merge_remote_content`）、无状态载荷每天在走、补算器根本不是过渡量（冲刺 §11.5 三条理由） | **无直接依赖**，但⚠️ **它是一条"看起来该做、其实会拆坏"的任务** —— 认领前先读冲刺 §11.5 |

### T0 ★ **修那条既存红，并把本轮读数基线写下来**（**先做，且它不修完下面全绿都是假的**）

| 字段 | 内容 |
|---|---|
| **做什么** | ① 修 `lineage_conflict` 那条既存红判据；② 把"本轮读数基线"跑一遍并落进本文档（或它的续篇），作为后续所有任务的对照 |
| **为什么是它**（读数） | 本轮实测 `cargo test --lib` ＝ **719 passed / 1 failed / 20 ignored**；失败那条：`src-tauri/src/lineage_conflict.rs:250` panic `"remote" 不该被接受`。成因：`575a58c6` 把 `CHOICE_REMOTE` 放开成**合法**值（`lineage_conflict.rs:47`），而这条判据的 `bad` 列表里还留着 `"remote"`；同一条判据后半段还有**互相矛盾**的断言（先 `resolve(..., CHOICE_LOCAL, 11)` 再断言 `Some(CHOICE_REMOTE)`，末了又断言 `Some(CHOICE_LOCAL)`） |
| **改哪里** | `src-tauri/src/lineage_conflict.rs` 的 `#[cfg(test)] mod tests`（**只动判据**，不动实现 —— 实现是对的：三个字面量都该收，第四个别收） |
| **验收读数** | ① `cd src-tauri && cargo check --tests` ⇒ exit 0（⚠️ **不是 `--lib`**：`--lib` **不查 `#[cfg(test)]`** —— `32f6fef2` 那笔提交的教训逐字在提交信息里）；② `cargo test --lib lineage_conflict::` ⇒ **4 passed / 0 failed**；③ `cargo test --lib` ⇒ **720 passed / 0 failed / 20 ignored** |
| **依赖** | — |
| **写域** | `src-tauri/src/lineage_conflict.rs` |
| **⚠️ 纪律** | **不许删判据不写替代**（[`docs/specs/README.md`](README.md)）：这一条要**按新口径重写**（"三个都收 ＋ 第四个别收"），不是删掉；`575a58c6` 的提交信息里已经声明它这么改过 —— 但**代码里没落地**，这正是要修的地方 |

---

## 2. 任务清单（可独立认领）

> 依赖图见 §5；写域汇总见 §6。

### T1 **把"多久一次"变成读数**（片 A 的读数那一半）

| 字段 | 内容 |
|---|---|
| **做什么** | 新增 `BodyRealtimeStatus`（形状**逐字**见规格 §3.2）＋ 一条命令把它交出去；⚠️ **先解决规格 §6-R2**（"间隔从哪读"）：档位住在 `localStorage['shuyonote:autoSync']`（`src/lib/syncMode.ts:65`），**Rust 看不到它** |
| **改哪里** | 取决于 §6-R2 的答案：<br>· 若读数**住在界面侧** ⇒ `src/lib/realtimeBodyStatus.ts`（新建，纯函数）＋ `src/components/SyncPanel.tsx`（展示那一行）<br>· 若**必须走命令** ⇒ `src-tauri/src/sync.rs`（结构体）＋ `src/lib/platform/commands.ts` ＋ `web.ts` ＋ `src/lib/api.ts` ＋ `src-tauri/src/lib.rs`（`generate_handler!`） |
| **验收读数** | ① `./node_modules/.bin/tsc --noEmit` ⇒ exit 0；② `node scripts/check-web-commands.mjs` ⇒ exit 0（若加了命令）；③ **承重**：`vitest` 里一条"读数的间隔与 `effectiveAutoSyncMs()` 同源"的断言 —— **变异**：把 `SYNC_INTERVAL_MS`（`src/lib/syncMode.ts:25`）改成 `10_000` 而不动读数 ⇒ 必须红（⚠️ **本机 `vitest` 今天跑不了**，见需求 §10 / 规格 §6 / 方案 §7-1 ⇒ 这条读数本轮**只能标"未跑"**） |
| **依赖** | —（但**开工前必须**先答规格 §6-R2） |
| **写域** | `src/lib/realtimeBodyStatus.ts`（新建，仅当走界面侧）／`src-tauri/src/sync.rs` 的**新结构体那一段**（⚠️ **与 T3 共享 `sync.rs`** ⇒ 串行，建议 T1 先落） |

### T2 **`mesh_sync_only` 命令**（片 A 的触发那一半；**零协议**）

| 字段 | 内容 |
|---|---|
| **做什么** | 新增 `mesh_sync_only`（形状见规格 §3.3）：**只跑网格那一轮**，**不跑服务端**。必须**复用** `mesh_scope`（`sync.rs:3121-3136`）与 `mesh::round`（`mesh.rs:403`），不抄第二份 |
| **改哪里** | `src-tauri/src/sync.rs`（命令）＋ `src-tauri/src/lib.rs`（`generate_handler!`）＋ `src/lib/platform/commands.ts` ＋ `src/lib/platform/web.ts`（如实回"不可用"，照 `web.ts:1565-1576` 的同一句人话）＋ `src/lib/api.ts` |
| **验收读数** | ① `cargo check --tests` ⇒ exit 0；② `cargo test --lib mesh::` ⇒ **≥ 23 passed / 0 failed**（本机基线，不得减少）；③ `cargo test --lib sync::` ⇒ **≥ 54 passed / 0 failed**；④ `check-web-commands` ⇒ exit 0；⑤ ★ **承重**：一条**文本级**断言 —— `mesh_sync_only` 的实现体里**不许**出现 `sync_workspace` / `do_push` / `do_pull`（**先剥注释再断言**，先例 `src/lib/platform/webClaimScope.wiring.test.ts`）。**变异**：在它里面加一句 `sync_workspace_only(...)` ⇒ 必须红 |
| **依赖** | — |
| **写域** | `src-tauri/src/sync.rs`（**与 T1 串行**）、`src-tauri/src/lib.rs`（**只加一行**；⚠️ 与 T3/T5 共享 `lib.rs`，见 §6）、`src/lib/platform/web.ts`、`src/lib/api.ts`（⚠️ 与 T3 共享 `commands.ts`／`api.ts` ⇒ 串行） |

### T3 **把触发真的挂上（局域网这一档）**（片 B）

| 字段 | 内容 |
|---|---|
| **做什么** | 把 `App.tsx` 自动同步那条 `tick` 里的**两条路解耦**：**网格那一轮不许被"有服务端档案"包住**（今天 `App.tsx:405-407` 的 `if (bound.length)` 只包服务端那条，网格那条在 `:425-428`，**已经**在外面 —— ⇒ 本任务其实是**加判据 ＋ 把间隔的选择落成用户可选项**，不是重写逻辑）；＋ 面板那一行的**说明与读数**（照规格 `INV-RT-cadence-honest`） |
| **改哪里** | `src/App.tsx`（tick 那一段，`:398-446`；网格那一轮在 `:426`）、`src/components/SyncPanel.tsx`（"同步方式"那一行 ＋ 读数展示）、`src/lib/syncMode.ts`（**若**要新档位）、`src/lib/platform/commands.ts` ＋ `src/lib/api.ts`（若 T2 还没加完） |
| **验收读数** | ① `tsc --noEmit` ⇒ exit 0；② `vitest` 的 `src/lib/syncMode.test.ts` ⇒ 全绿（含"近实时开着 ⇒ 兜底轮询必须挂着"那条谓词）；③ ★ **承重**（**复用现成载体**）：`src/components/syncPanelMesh.wiring.test.ts` 已经在断言**两处**都有 `api.meshSyncNow(`（`:25` / `:38`）⇒ **变异**：把网格那一轮挪进 `if (bound.length)` ⇒ 必须红；④ ★ **承重**：`src/hooks/useSyncStream.wiring.test.ts` ⑧（"流通道不碰轮询"）＋ 它里面的 `expect(app, "轮询必须**无条件**挂在 App 上")` ⇒ **变异**：让新触发**代替**那个定时器 ⇒ 必须红；⑤ ★ **承重**：新触发**必须**过 `shouldAutoSyncNow()`（`src/lib/syncGate.ts:22-30`）—— **变异**：不调闸门 ⇒ 必须红（真机实测过"把间隔调成每 10 秒就在蜂窝上照拉"，`syncGate.ts` 文件头逐字） |
| **依赖** | **T1 ＋ T2**（读数与命令） |
| **写域** | `src/App.tsx`、`src/lib/syncMode.ts`、`src/components/SyncPanel.tsx`（⚠️ **热点文件**：与 T6/T7 共享 ⇒ 同一时刻只有一个执行者能持它）、`src/lib/platform/commands.ts`、`src/lib/api.ts` |
| **⚠️ 已知不确定（如实写）** | ⚠️ **"5 秒"这个数的代价我没量**（方案 §7-6）：真要选它，先在**一台真机**上量"每 5 秒一次网格轮询"的请求量／耗电。⇒ 本任务的默认间隔**不许**由实现者自定：**等 owner 给数**（需求 §7-D2） |

### T4 **片 C：按对端触发（名单式）**（**依赖另一份文档**）

| 字段 | 内容 |
|---|---|
| **做什么** | 用 `LanStatus.nearby`（那份文档要加的字段）决定"这一轮跑不跑"；⚠️ **不许**自己算"某台设备服务哪些空间"（`serves_current` 已经是 Rust 判的） |
| **改哪里** | `src/App.tsx` 或新建 `src/hooks/useBodyPull.ts`（若新 hook：**必须先看** `check-hook-order`／`check-store-subscriptions` 两条门禁的要求，`AGENTS.md` §8）；`src/lib/api.ts`（若类型转发需要） |
| **验收读数** | ① `node scripts/check-store-subscriptions.mjs` ⇒ exit 0（**基线只减不增**：新 hook 不许整店订阅）；② `node scripts/check-hook-order.mjs` ⇒ exit 0；③ ★ **承重**：判"要不要跑"的那个数**必须**来自 `nearby`（列表），**不许**来自 `peers`（数量）—— **变异**：写成 `lanStatus.peers > 0` ⇒ 必须红（数量在"有人但不服务这个空间"时**也为真**）；④ ★ **承重**：组件里**不许**出现 `p.spaces.includes(...)` —— **变异**：加一句 ⇒ 必须红（第二份真相源） |
| **依赖** | **T2**（触发器）＋ **[`nearby-devices-tasks.md`](2026-09-29-nearby-devices-tasks.md) 的 T1 ＋ T2**（`LanStatus.nearby` 与契约三处一致） |
| **写域** | `src/App.tsx`（⚠️ 与 T3 共享 ⇒ 串行）、`src/hooks/useBodyPull.ts`（新建，若选 hook） |
| **⚠️ 显式不做** | ❌ **不**把 `nearby` 用在**血统裁定**上（那是需求 §4.3-B，**需要 owner 拍**，且它要动 `src/lib/crdt/bootstrap.ts` 的决策输入 ⇒ **另立任务，不许混进 T4**） |

### T5 **文本级护栏：`lineagesRelated` 也只许有一处**（片 D 的判据那一半）

| 字段 | 内容 |
|---|---|
| **做什么** | 把 `check-crdt-plane` 的判据④从"`mergeRemotePageState` 定义只许一处"**扩到** `lineagesRelated`（今天它的定义在 `src/lib/crdt/pageBinding.ts:185-190` 一带，**只有一处**） |
| **改哪里** | `scripts/check-crdt-plane.mjs`（**扩判据**）＋ `scripts/check-crdt-plane.test.mjs`（若它自己有自测：**必须两边都验** —— 正例绿 ＋ 负例红）＋ ⚠️ **若改了门禁判据 ⇒ 它自己的「看过它红」证据会过期**（`_workspace/mutation-evidence.json` 按脚本 sha 绑定，`AI-NATIVE-DEV.md` §12.5）⇒ **顺手重做那条证据**，否则 `check-gate-manifest` 的判据 D2 会红、且**提交会被 hook 拦下** |
| **验收读数** | ① `node scripts/check-crdt-plane.mjs` ⇒ exit 0；② `node scripts/check-crdt-plane.mjs --self-test` ⇒ 全绿（若它支持）；③ ★ **承重（变异实测）**：在 `pageBinding.ts` 里加一个**第二处** `lineagesRelated` 的**定义**（例如一个只在测试里用的包装，但**不用 `export`** 也要能被判到）⇒ 门禁**必须红**；随后**逐字节还原**（`git status --short` 为空 **不算**还原的证据 —— `AI-NATIVE-DEV.md` §12.7 逐字："还原的判据只能是 sha／逐字节比"） |
| **依赖** | —（与 T1/T2/T3/T4 **完全并行**：只碰 `scripts/`） |
| **写域** | `scripts/check-crdt-plane.mjs`、`scripts/check-crdt-plane.test.mjs`、`_workspace/mutation-evidence.json`（⚠️ **它在工作区根，不在本仓** ⇒ 若本机没有它，见需求 §7-D6） |

### T6 **文案与读数：不许把"正文实时"说成"全部实时"**（片 D 的另一半）

| 字段 | 内容 |
|---|---|
| **做什么** | ① `syncModeHint` 那一句（`src/lib/syncMode.ts:50-64`）**现在只说"连着同步服务时…"** —— 要**补上局域网这一档会发生什么**（并把"多久"换成**读数里的同一个数**）；② 面板上那一行的文案不许暗示"推送"；③ 不许暗示"所有内容立刻同步"（标题／排序仍按页级 LWW） |
| **改哪里** | `src/lib/syncMode.ts`（文案唯一来源）、`src/components/SyncPanel.tsx`（展示）、`src/lib/i18n/*`（若文案有译文条目） |
| **验收读数** | ① `tsc --noEmit` ⇒ exit 0；② ★ **承重**：一条**文本级**判据 —— `syncModeHint` 与面板文案里**不许**出现"推送"（除非同句说明"文件里它是拉取式"），且**不许**出现"所有内容/全部内容立刻同步"这类说法 —— **变异**：把文案改成"所有内容立刻同步" ⇒ 必须红（`INV-RT-body-not-all` ＋ `INV-RT-pull-not-push` 的落点） |
| **依赖** | **T1**（文案里那个数要来自读数，不许各写一遍） |
| **写域** | `src/lib/syncMode.ts`、`src/components/SyncPanel.tsx`（⚠️ 与 T3/T7 共享 ⇒ 串行）、`src/lib/i18n/*` |

### T7 **片 D 的文案：把"同时首开新页会怎样"如实说出来**

| 字段 | 内容 |
|---|---|
| **做什么** | 在"同步方式"那一行（或血统冲突横幅的说明里）**如实写出**：两台设备**同时**打开一张**从没同步过**的新页 ⇒ 会各自建一条编辑历史 ⇒ 需要用户选一次（`LineageConflictBanner` 三个选项）。**不许**承诺"自动合并"（需求 §4.2 已经定性：这一格**没有唯一真值**） |
| **改哪里** | `src/components/SyncPanel.tsx` 或 `src/components/LineageConflictBanner.tsx`（文案 ＋ 说明）＋ `src/lib/i18n/*` |
| **验收读数** | ① ★ **承重**：一条文本级判据 —— 那段文案里**必须**出现"选"（用户要做决定这件事），且**不许**出现"自动合并／会自动解决" —— **变异**：改成"会自动合并" ⇒ 必须红；② 真 Chromium 门禁里那三种态**各自有断言**（形状照 [`nearby-devices-tasks.md`](2026-09-29-nearby-devices-tasks.md) T3 的"四态可分"） |
| **依赖** | —（文案独立；但**建议在 T6 之后落**，两条都改 `SyncPanel.tsx`） |
| **写域** | `src/components/SyncPanel.tsx`（⚠️ 串行）、`src/components/LineageConflictBanner.tsx`、`src/lib/i18n/*` |

---

## 3. **不做**（本轮显式留白）

| 不做 | 出处 |
|---|---|
| ❌ **纯局域网"同时首开新页"的自动裁定**（名册式／页创建者／内容同源可合／局域网准服务端） | 需求 §4.3（七个方案 ＋ `G` 被 owner 2026-09-25 冻结）／§9 |
| ❌ **重启甲-2（客户端自己发号牌／留账本）** | owner 2026-09-25 冻结（[nearby-devices 需求](2026-09-29-nearby-devices-requirements.md) §9） |
| ❌ **给 Rust 加 Yjs／yrs（服务端合并那一半）** | 冲刺 §14.2（S5 阶段 2 **暂缓**：能不能做已回答，值不值得做没回答） |
| ❌ **把 CRDT 状态塞进 `content_json`／让 Rust 认识 CRDT** | 混版本共存三句地基（`check-crdt-plane`，`gates.mjs:105-117`） |
| ❌ **在桌面上再写一份合并实现** | 规格 `INV-RT-guard-not-bypassed`（唯一实现：`crdt/pageBinding.ts`） |
| ❌ **非正文（标题／父节点／排序／图标）的实时** | 需求 §3 |
| ❌ **Web 档的多设备实时正文** | 需求 §9（Web 没有发现层、开不了网格窗口） |
| ❌ **多光标／在线状态／"谁在编辑哪一块"** | 需求 §9（那是 [`docs/realtime-collab-analysis.md`](../realtime-collab-analysis.md) §2 的"档次 A"，另一条线） |
| ❌ **接收侧派生文本滞后的收口** | 需求 §9 ＋ 方案 §4 风险 4/5（**要有"什么时候补算"的口径 ＋ 判据**；顺手的修法 `dirty=1` 是**假账**，冲刺 §13.3 逐字警告过） |
| ❌ **`page_crdt_pending` 的"按 seq 逐条留"语义** | 冲刺 §13.1（服务端 pull 不回 `device_id` ⇒ "每页一行"是**真丢**） |

---

## 4. 人手 / 设备 / owner 点头 的那一档（**不许混进"本机可做"**）

> ⚠️ `AI-NATIVE-DEV.md` §5.4 的红旗之一是「上次是全绿的」/「队友说成功了」；
> 这里的正确写法是**「没做」**，不是"应该没问题"。

| # | 要谁 | 要什么 | 为什么本机做不了 | 读数 |
|---|---|---|---|---|
| **M1** | **owner** | **给"实时"一个数**：R-1（≤30 秒）够不够？还是要 R-2（≤5 秒）？ | 代码里没有这个数（需求 §7-D2）；而两者成本差一个数量级（方案 §3.1） | owner 的答复原话（落进本文档的续篇） |
| **M2** | **owner** | **拍需求 §4 那一格**：纯局域网同时首开新页 ⇒ 走 A（只做有服务端／已有血统的实时）＋F（三选项出口）？还是 B（名册式）？ | 代价**用户可见**（"小明和小王同时开一张新页会发生什么"）；agent 不该替 owner 定 | owner 的答复原话 |
| **M3** | **人手 ＋ 两台真机** | 需求 §5.3 场景 A：A 改字 ⇒ B **≤30 秒**（R-1）／**≤5 秒**（R-2）可见，**全程零操作** | 要两台机器 ＋ 热点；真机行为与回环不同（方案 §4 风险 7） | 秒表／两侧日志时间戳（截图或录屏） |
| **M4** | **人手 ＋ 两台真机** | 需求 §5.3 场景 B：两台**同时**首开一张新页 ⇒ 两侧**各自**出现血统冲突横幅，且三个选项**真的都能选** | 要能**同时**操作 ＋ 两台机器 | 两张截图（各自的横幅）＋ 选完之后两侧内容 |
| **M5** | **owner 或人手（要凭据）** | **真账号端到端探针**：真 token claim 一次 ⇒ 期望 `200 ＋ granted:true`；第二台 ⇒ `200 ＋ granted:false` | 要真账号凭据（冲刺 §12.5 逐字："需要凭据 ⇒ owner 或人手"） | 两条 HTTP 响应（**别回显 token**） |
| **M6** | **人手 ＋ 一台真机** | 量"每 5 秒一次网格轮询"的请求量与耗电（安卓那台最要紧） | 只有真机能量（方案 §7-6） | 请求数／电量截图；**这一条会回填 M1 的答案** |

⚠️ **M3/M4 不许写成"通过"**：`AI-NATIVE-DEV.md` §5.4 的"队友说成功了"那一行逐字适用。

---

## 5. 依赖图（一张图看完"谁先谁后"）

```text
T0（修既存红 ＋ 基线）──→ 所有任务的"全绿"读数都依赖它 ✗ 不修完都是假的
                              │
T5（scripts/，护栏判据）───────┼── 独立，可与任何任务并行
                              │
T1（"多久"的读数）─┬─→ T3（把触发挂上）─→ T4（按对端触发）← 还要 nearby-devices 的 T1/T2
                   │                              ↑
T2（mesh_sync_only）┘                             │（名单来自那份文档，不来自本方案）
                   │
                   └─→ T6（文案：不许说成全实时）─→ T7（文案：同时首开会怎样）

M1/M2（owner 拍）──→ 决定"要不要做 R-2 那一档"（T3 的默认间隔）
M3/M4（真机）──────→ 验收（依赖 T3/T4 落地）
M5（凭据）─────────→ 与本文档无关，但它是 §10.3-1 那条"真账号探针"的收口
M6（真机量）───────→ 回填 M1
```

**并行提示（写域的约束）**：

- `src-tauri/src/sync.rs` 是**热点**（T1/T2 都要动）⇒ **串行**，建议 T2 先落（它的写域更小）。
- `src/components/SyncPanel.tsx` 也是**热点**（T3/T6/T7）⇒ **同一时刻只有一个执行者能持它**。
- `src-tauri/src/lib.rs` 与 `src/lib/platform/commands.ts` 也是共享的（T2/T3）⇒ **T3 必须等 T2 收工**。
- 真正能并行的：**T5 ‖ 任何**（只碰 `scripts/`）＋ **T1 ‖ T5**。

---

## 6. 每条的写域汇总（**防两条任务各改一半同一个文件**）

| 任务 | 写域（文件级） |
|---|---|
| T0 | `src-tauri/src/lineage_conflict.rs`（只动 `#[cfg(test)]`） |
| T1 | `src/lib/realtimeBodyStatus.ts`（新建）／`src-tauri/src/sync.rs`（新结构体那一段） |
| T2 | `src-tauri/src/sync.rs`、`src-tauri/src/lib.rs`、`src/lib/platform/commands.ts`、`src/lib/platform/web.ts`、`src/lib/api.ts` |
| T3 | `src/App.tsx`、`src/lib/syncMode.ts`、`src/components/SyncPanel.tsx`、`src/lib/platform/commands.ts`、`src/lib/api.ts` |
| T4 | `src/App.tsx`、`src/hooks/useBodyPull.ts`（新建，若选 hook） |
| T5 | `scripts/check-crdt-plane.mjs`、`scripts/check-crdt-plane.test.mjs`、`_workspace/mutation-evidence.json`（**工作区根，不随仓分发**） |
| T6 | `src/lib/syncMode.ts`、`src/components/SyncPanel.tsx`、`src/lib/i18n/*` |
| T7 | `src/components/SyncPanel.tsx`、`src/components/LineageConflictBanner.tsx`、`src/lib/i18n/*` |

⚠️ **三处共享要写清楚**：

1. `src-tauri/src/lib.rs`：T2 加 `generate_handler!` 一行；
2. `src/lib/platform/commands.ts` ＋ `src/lib/api.ts`：T2/T3 都要加同两条命令的契约与薄包 ⇒ **T2 落库之后 T3 才开工**；
3. `src/components/SyncPanel.tsx`：T3/T6/T7 三个都要改 ⇒ **按 T3 → T6 → T7 串行**（T3 要先有真实写法，T6/T7 才知道该说什么）。

⚠️ **新增门禁的纪律**（本仓 `AGENTS.md` §3 铁律）：**任何新判据**在动手前先问"它要不要成为一条门禁" ——
若是静态扫描，**必须**注册进 `scripts/lib/gates.mjs`（**只挂 `package.json` 的 build 链等于在 CI 上隐形** —— 本仓踩过两次：
`mobile-views` 2026-09-22、`check-hook-order` 2026-09-25）；**删门禁／改 id／调低基线一律判红**。
⚠️ 而**改门禁判据 ⇒ 它的「看过它红」证据过期**（`AI-NATIVE-DEV.md` §12.5：跨机生效）⇒ 顺手重做，否则提交会被 hook 拦下。
