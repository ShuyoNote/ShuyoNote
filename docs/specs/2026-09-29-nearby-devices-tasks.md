# 任务：丙档「附近设备」—— 可独立认领的执行清单

> 行号钉在：`a5c0f614`（2026-09-29）｜核查方式：`git show a5c0f614:<path> | sed -n '<起>,<止>p'`
> 起草：macOS 侧｜**2026-09-29**｜需求 [`2026-09-29-nearby-devices-requirements.md`](2026-09-29-nearby-devices-requirements.md)（为什么）·
> 规格 [`2026-09-29-nearby-devices-spec.md`](2026-09-29-nearby-devices-spec.md)（什么不许变）·
> 方案 [`2026-09-29-nearby-devices-approach.md`](2026-09-29-nearby-devices-approach.md)（怎么落、每片承重判据）
> 依据：`AI-NATIVE-DEV.md` §5.4（**没有本次的读数，不许声称完成**）＋ 本仓 `AGENTS.md` §3（**新增门禁必须注册进 `scripts/lib/gates.mjs`**）
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

**认领规则（每条都能被一个不同的执行者独立认领）**：

1. **写域不重叠**是硬约束 —— 两条任务的写域一相交，就不能并行认领（要么串行，要么先拆文件）。
2. **依赖没完成不许开工**：依赖是"签名/字段名"这类的，读到对方**已落库的提交**才算完成。
3. **验收读数必须在本机跑得出来**；跑不出来的（真机两设备）**另立"人手验收"**，见 §3。

---

## 1. 先做的前置（owner 指定的那条：把 `space_id` 提出来成为独立一行）

### T0 ★ 空间身份独立成行（**先做**，不阻塞 T1–T3，但阻塞 T7 的文案质量）

| 字段 | 内容 |
|---|---|
| **做什么** | 在同步面板里把 `space_id`（远端组织空间 id）从「服务器」折行**内部**的「组织空间」栏里**提出来**，成为一行**独立的「空间身份」**；组织空间栏**保留"写"**（下拉选择/输入），但**不再重复展示**同一串 |
| **改哪里** | `src/components/SyncPanel.tsx`（新增一行；组织空间那一栏在 `:1362-1399`）＋ `src/App.css`（若需要样式，**加在既有窄屏那 5 节之外**） |
| **验收读数** | ① `pnpm exec tsc --noEmit` ⇒ exit 0；② 真 Chromium 门禁里断言：**面板上 `space_id` 的展示只有一处**（组织空间栏里数不到第二处）；③ 人工：`space_id` 为空 / 非空两种状态下，那一行分别显示什么字（**空态必须写"还没绑空间"这类人话，不许空白**） |
| **依赖** | — |
| **写域** | `src/components/SyncPanel.tsx`（**本任务独占**：因为 T1/T2/T3/T7 也改这个文件 ⇒ 见 §2 的串行说明）|
| **为什么先做** | 现在它只在折行**内部**（`:1254` 的 `<details>` → `:1363` 的字段）；而网格那一行在 `space_id` 为空时**根本不渲染**（`:1538`）⇒ 用户的自然结论是**"网格要有服务器"**，与 `:1535` 那条注释正好相反（需求 §2 第 2 条） |

⚠️ **T0 与 T1–T3、T7 写域相交**（都在 `SyncPanel.tsx`）⇒ 方案 §2 的顺序（A→B→C→E）**必须串行**。
若要有两个执行者并行，先做**T1/T2**（它们不动 `SyncPanel.tsx`），再做 **T0 → T3 → T7**。

---

## 2. 任务清单

### T1 把对端表上抛（Rust 读数）

| 字段 | 内容 |
|---|---|
| **做什么** | 新增 `sync::NearbyPeer` 与 `LanStatus.nearby`（形状逐字见规格 §3.1）；`lan_status` 里用**已经取到的那一次** `state.peers(now)`（`sync.rs:3417`）映射成列表；`invitable` 的判定与 `mesh::mesh_peers`（`mesh.rs:243`）**同一把尺** |
| **改哪里** | `src-tauri/src/sync.rs`（`NearbyPeer` ＋ `LanStatus` ＋ `lan_status` 里那段映射）；`src-tauri/src/mesh.rs`（**若**要把 `mesh_peers` 里那段逐条过滤抽成可复用的纯函数，就放在 `mesh_peers` 紧邻处） |
| **验收读数** | `cd src-tauri && cargo test --lib sync::` ⇒ **0 failed**；`cargo test --lib mesh::` ⇒ **23 passed / 0 failed**（本轮实测基线，不得减少）；**新增**三条：① 同源（`nearby.len() == peers`，喂同一个 `Vec<Peer>`）；② 同尺（`nearby.filter(invitable)` 的 `device_id` 集合 == `mesh_peers(...)`）；③ 反向保护（`nearby` 置空 ⇒ `peers`/`kind`/`line` 逐字节不变） |
| **依赖** | —（但读规格 §3.1 的字段名与 spec §3.2 的 snake_case 约定） |
| **写域** | `src-tauri/src/sync.rs`、`src-tauri/src/mesh.rs`、`src-tauri/src/lan.rs`（**Rust 侧全部归本任务**，T5 不动这几个文件） |
| **变异证据（要入账）** | 把 `peers: peers.len()`（`sync.rs:3466`）改成用 `observed_all().len()` ⇒ 判据① 必须红（`scripts/criteria-mutations.json` 那条通道） |

### T2 契约三处一致（TS ＋ Web）

| 字段 | 内容 |
|---|---|
| **做什么** | `commands.ts` 加 `NearbyPeer` ＋ `LanStatus.nearby`（**snake_case**，与 Rust 一致）；`web.ts` 的 `lan_status` 分支（`:1544`）加 `nearby: []` 并**保留** `enabled:false` 与那句"没有这一层" |
| **改哪里** | `src/lib/platform/commands.ts`、`src/lib/platform/web.ts`、`src/lib/api.ts`（若类型转发需要） |
| **验收读数** | `pnpm check:web-commands` ⇒ **exit 0**（三个方向一致）；`pnpm exec tsc --noEmit` ⇒ exit 0；人工核：Web 侧 `nearby: []` **同时** `enabled:false`（不许只回空数组） |
| **依赖** | **T1**（字段名以 T1 落库的为准） |
| **写域** | `src/lib/platform/commands.ts`、`src/lib/platform/web.ts`、`src/lib/api.ts` |
| **边界（写下来）** | ⚠️ **`check-web-commands` 不判字段一致性**（它判命令存在性与参数键 camelCase）⇒ 字段一致**靠人核**；若要做成机器判据，得**新立**一条（**并注册进 `scripts/lib/gates.mjs`**，`AGENTS.md` §3）—— 本任务**不擅自**加门禁 |

### T3 面板里那个「同网段的设备」块

| 字段 | 内容 |
|---|---|
| **做什么** | 渲染四态（不可用 / 发现中 / 有设备 / 不可邀请的静默）；门槛**复用** `isDesktopPlatform() && lanStatus && !!activeRow?.space_id.trim()`（`SyncPanel.tsx:1538` 同一个表达式）；文案照规格 §4 的表 |
| **改哪里** | `src/components/SyncPanel.tsx`、`src/App.css` |
| **验收读数** | 真 Chromium 门禁（`node scripts/test-report.mjs --group mobile`，需 dev server :5173）里四种态**各有一个断言**；文案断言：块内不出现 `device_id`／裸 IP；`lanStatus.peers` 只出现在文案、不参与算术 |
| **依赖** | **T1 ＋ T2**（读数与类型） |
| **写域** | `src/components/SyncPanel.tsx`（**与 T0 串行**）、`src/App.css` |
| **⚠️ 已知不确定** | ① 四种态能不能在 `verify-mobile-views.mjs` 里造出来，**我没实测**（先例是"注入 `__TAURI_INTERNALS__` ＋ mock 命令"，需求 §2 复现说明）；② 方案 §2 片 C 的①条若要复用既有 5 条接线判据，先找到它们在哪个文件（待查 R1） |

### T4 新键的静态纪律（**可选，先立判据再改代码**）

| 字段 | 内容 |
|---|---|
| **做什么** | 若 T3 的"界面不许自己数"要做成**静态扫描**判据（而不是靠 Chromium 断言）：新建 `scripts/check-*.mjs`，扫 `SyncPanel.tsx` 里 `lanStatus.peers` 的**用法**只许出现在字符串/JSX 文本里、不许进算术 |
| **改哪里** | `scripts/check-<名>.mjs`（新建）＋ `scripts/lib/gates.mjs`（**必须注册**）＋ `package.json`（挂命令，**不够**——注册表才是被 CI 跑到的集合）＋ `docs/README.md` / `docs/TESTING.md`（`check-doc-facts` 要求文档里有门禁的名字） |
| **验收读数** | `node scripts/check-<名>.mjs --self-test` ⇒ 正例绿 / 负例红（写进脚本头）；`node scripts/test-report.mjs --list` 里**看得到它的 id**；`node scripts/check-gate-manifest.mjs` ⇒ exit 0（**它自己的 "看过它红" 证据要入账**，`AI-NATIVE-DEV.md` §4.7 判据 D） |
| **依赖** | T3 落地（要先有真实写法才能定"什么算违规"） |
| **写域** | `scripts/`（新脚本 ＋ `gates.mjs`）、`package.json`、`docs/README.md`、`docs/TESTING.md` |
| **⚠️ 判定** | **本任务可以不做** —— 若 T3 的 Chromium 断言已经能咬人（变异：把行数写成 `lanStatus.peers` ⇒ 断言红），再立一条静态扫描就是**噪声门禁**（`AI-NATIVE-DEV.md` §12.7 末尾："一条永远吵的门禁等于没有"） |

### T5 邀请的**纯函数那一半**（载荷 ＋ 白名单）

| 字段 | 内容 |
|---|---|
| **做什么** | 新模块 `nearby_invite.rs`：`NearbyInvite { v, from_device_id, from_device_name, space_id, token, note }` ＋ `#[serde(deny_unknown_fields)]` ＋ `encode`/`decode`（不认识版本 ⇒ **不猜**，照 `pairing.rs:77-90` 的形状）＋ 去重键的纯函数 |
| **改哪里** | `src-tauri/src/nearby_invite.rs`（新建）＋ `src-tauri/src/lib.rs`（`mod nearby_invite;`） |
| **验收读数** | `cd src-tauri && cargo test --lib nearby_invite::` ⇒ **0 failed**；**必须有一条**"字段集是白名单"的断言（**变异**：给载荷加 `#[serde(default)] material: String` ⇒ 必须红）；`cargo test --lib` 全量 ⇒ **既有用例一条都不许少** |
| **依赖** | —（**与 T1/T2/T3 完全并行**：它只碰新文件 ＋ `lib.rs` 一行） |
| **写域** | `src-tauri/src/nearby_invite.rs`、`src-tauri/src/lib.rs`（**只加一行 `mod`**；`generate_handler!` 那段留给 T6 —— ⇒ **两条任务都碰 `lib.rs`，必须串行开这一段**，见下面 T6 的写域说明） |

### T6 邀请的**命令面那一半**（发 / 收 / 接受）

| 字段 | 内容 |
|---|---|
| **做什么** | ① 在既有 UDP socket 上发/收一条非公告报文（`lan.rs` 那条 socket，`LAN_PORT = 47821`，`lan.rs:46`）；② `lan_state` 收报处按类型分流（⚠️ **不许改 `decode_announce` 的"不认识就不猜"**，`lan.rs:117-129`）；③ 命令 `nearby_invite_send` / `nearby_invite_accept`；④ 接受侧写 `sync_profiles(space_id=邀请里的, ws_id=当前空间)` ＋ `mesh_token:<space_id>`，**并且必须过 `sync_bind_gate`**（`sync.rs:1136-1160`）；⑤ TS/Web/api 三处契约（Web 侧显式"这一档不可用"，照 `mesh_sync_now` 的先例） |
| **改哪里** | `src-tauri/src/lan.rs`、`src-tauri/src/lan_state.rs`、`src-tauri/src/sync.rs`、`src-tauri/src/lib.rs`（`generate_handler!`）、`src/lib/platform/commands.ts`、`src/lib/platform/web.ts`、`src/lib/api.ts` |
| **验收读数** | ① `cargo test --lib nearby_invite::` 与 `cargo test --lib sync::` ⇒ 0 failed；② **两条新判据**：**两个 id 不合成一个**（接受的写入断言 `space_id != ws_id` 时窗口服务的是本地库；**变异**：写成 `space_id = ws_id` ⇒ 必须红）＋ **闸门不过就是不过**（未加密个人空间 ⇒ `Err` 且本机一个字节不改；**变异**：删掉那次 `sync_bind_gate` 调用 ⇒ 必须红）；③ `pnpm check:web-commands` ⇒ exit 0 |
| **依赖** | **T5**（载荷）＋ **T1/T2**（契约的先例）＋ **T0**（接受时要不要写"接到哪个空间上"，取决于 T0 定下的界面口径） |
| **写域** | 上面那 7 个文件（⚠️ 与 T1 共享 `sync.rs`／`lan.rs`、与 T2 共享 `commands.ts`／`web.ts`／`api.ts` ⇒ **T6 必须在 T1/T2 完成之后串行开工**，否则两条任务各改一半同一文件） |
| **明确不做（本轮）** | ❌ 回执 / 重传 / 超时（规格 §5.3）· ❌ 邀请的时效（规格 §5.3）· ❌ 落"已处理过的邀请"表（§4 风险 8）· ❌ 换口令（§4 风险 9） |

### T7 邀请的**界面那一半**

| 字段 | 内容 |
|---|---|
| **做什么** | T3 那个块里：能邀请的行给按钮「邀请加入「<空间名>」」；点后进入「已发出邀请 · 等对方接受」；收到邀请时在**接受侧**显示"来自 <设备名>，加入「…」"＋「接受」；接受侧文案要**写出两个名字**（规格 §5.6） |
| **改哪里** | `src/components/SyncPanel.tsx`（**与 T0/T3 串行**）、`src/App.css` |
| **验收读数** | Chromium 断言：① 点邀请后该行进入"已发出"态**且文案里没有"已接受"/"已连接"**（本地观测不到，规格 §4 那一态）；② 不可邀请的行**没有**按钮；③ 接受侧文案里出现**两个**空间名（本地那个 ＋ 对方那个） |
| **依赖** | **T3 ＋ T6**（按钮要调的命令）＋ **T0**（"接到我哪个空间上"的口径） |
| **写域** | `src/components/SyncPanel.tsx`（**独占**，此时 T0/T3 已收工）、`src/App.css` |
| **⚠️ 阻塞点（如实写）** | "对方那个空间的名字"从哪来**未定**（规格 §6 待查 R4）⇒ 若邀请里不带名字，**这一条任务会被 `INV-UI-copy-no-internal-ids` 卡住**（不许显示裸 id）⇒ **先定 R4，再开 T7** |

---

## 3. 人手验收（**不属于任何任务、本机做不出来**）

| # | 验收 | 为什么本机做不了 | 读数 |
|---|---|---|---|
| **M1** | 两台真机 ＋ 热点：互相**看得见** | 要真网络环境与两台机器；先例：③-b-2b-2 的"真机两设备复验没做（要人手）"（`../plans/2026-09-24-lan-p2p-topology-decision.md` §13 表内） | 两台各自的 `peers` 与列表行数（截图或日志） |
| **M2** | 三台（小明手机 ＋ 小明笔记本 ＋ 小王笔记本）：A4–A8 全流程 | 同上；且安卓那台要 `MulticastLock` 生效（`src-tauri/src/lan_android.rs` 模块头） | 两两之间各跑一次交换，投影一致；**全程零字符串输入**（可用录屏佐证） |
| **M3** | 掐表：热点主机首轮到底等多久 | 常量是 30s（`lan_state.rs:245`）而真机读数记的是 ≈45 秒（同 §18）⇒ 只能实测 | 秒表读数（这一条会回填需求 §7 待查 D2） |

⚠️ **M1–M3 不许写成"通过"**：`AI-NATIVE-DEV.md` §5.4 的红旗之一是「上次是全绿的」/「队友说成功了」；
这里的正确写法是**「没做」**。

---

## 4. 依赖图（一张图看完"谁先谁后"）

```text
T5（载荷，纯函数，独立）──────────┐
                                  ↓
T1（Rust 读数）──→ T2（TS/Web 契约）──→ T3（列表块）──→ T7（邀请 UI）
   │                                     ↑                 ↑
   │                                     │                 │
   └─────────────（T1 的字段名）─────────┘                 │
                                                           │
T0（空间身份独立成行，独立）───────────────────────────────┘
                                  ↓
                            T6（命令面：发/收/接受）← 依赖 T5
                                  ↓
                            T7（邀请 UI）

T4（静态判据，可选）← 依赖 T3
M1/M2/M3（人手验收）← 依赖 T6/T7
```

**并行提示（写域的约束）**：

- `SyncPanel.tsx` 是**热点文件**（T0/T3/T7 都要改）⇒ **同一时刻只有一个执行者能持它**。
- `sync.rs` / `lan.rs`（T1/T6）、`commands.ts` / `web.ts` / `api.ts`（T2/T6）也是两两共享
  ⇒ **T2 与 T1 可并行**（不同文件），**T6 必须等 T1/T2 收工**。
- 唯一能真并行的是：**T1 ‖ T5**（不同文件、不同 crate 模块）＋ **T4 ‖ 任何**（只碰 `scripts/`）。

---

## 5. 每条的写域汇总（**防两条任务各改一半同一个文件**）

| 任务 | 写域（文件级） |
|---|---|
| T0 | `src/components/SyncPanel.tsx`、`src/App.css` |
| T1 | `src-tauri/src/sync.rs`、`src-tauri/src/mesh.rs`、`src-tauri/src/lan.rs` |
| T2 | `src/lib/platform/commands.ts`、`src/lib/platform/web.ts`、`src/lib/api.ts` |
| T3 | `src/components/SyncPanel.tsx`、`src/App.css` |
| T4 | `scripts/check-*.mjs`（新建）、`scripts/lib/gates.mjs`、`package.json`、`docs/README.md`、`docs/TESTING.md` |
| T5 | `src-tauri/src/nearby_invite.rs`（新建）、`src-tauri/src/lib.rs`（只加一行 `mod`） |
| T6 | `src-tauri/src/lan.rs`、`src-tauri/src/lan_state.rs`、`src-tauri/src/sync.rs`、`src-tauri/src/lib.rs`（`generate_handler!`）、`src/lib/platform/commands.ts`、`src/lib/platform/web.ts`、`src/lib/api.ts` |
| T7 | `src/components/SyncPanel.tsx`、`src/App.css` |

⚠️ **T5 与 T6 都碰 `src-tauri/src/lib.rs`**（一个加 `mod`、一个加 `generate_handler!` 条目）
⇒ **两条任务不能同时开工**；建议 T5 先落、T6 后落（T6 依赖 T5 本来就该后落）。

---

## 6. 本轮明确不做的（**留白要显式**）

| 不做 | 出处 |
|---|---|
| ❌ 回执 / 重传 / 超时 / 邀请时效 | 规格 §5.3 ＋ 方案 §4 风险 8 |
| ❌ 换口令（旧邀请里的口令会一直有效） | 方案 §4 风险 9 |
| ❌ 设备重命名 / "我的设备"归属 | 需求 §9 ＋ 规格 §6 待查 D3 |
| ❌ 跨网段 / NAT / 中继 | 需求 §4.3 |
| ❌ Web 版的邀请入口 | 需求 §4.3 ＋ 规格 `INV-NEARBY-no-web-invite` |
| ❌ 自动轮询（发现是手动刷新的面板读数） | 需求 §4.3（"手动是口径"） |
| ❌ 甲-2（内嵌接待窗口） | owner 2026-09-25 已冻结（`../plans/2026-09-24-lan-p2p-topology-decision.md` §13 开头） |
| ❌ 裁决 UI 重做（丙-⑤ 剩下的部分） | 它是另一条线（同 §13 末尾"只有它做完，丙才算能用"） |
| ❌ 把 `nearby` 写进同步协议 / 上报服务端 | 本轮零协议（方案 §2 片 A/B/C/D）；上报等于把"网段里的别人"变成服务端可见的数据 |
