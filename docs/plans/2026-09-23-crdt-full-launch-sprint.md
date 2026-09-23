# CRDT 全上线冲刺（阶段 2 全量，2026-09-23 起）

> owner 2026-09-23 口述口径：**「现在没有正式客户，可以不考虑向后兼容，大胆干，冲刺 CRDT 全上线」**。
> 上位：[边界决策简报](2026-09-23-crdt-plane-boundary-decision.md)（已拍 = **服务端合并**）／
> [Slice B 施工单](2026-09-23-crdt-slice-b-workorder.md)／[阶段 2 开工清单](2026-09-23-crdt-stage2-kickoff.md)。

## 0. 这条口径**作废/放宽**了哪些旧约束（写清楚，免得后面又按旧约束缩手）

| 旧约束 | 处置 |
|---|---|
| §0.5 口径 1「落盘**仍是 JSON**、ydoc 只当内存/传输平面」 | ❌ **作废**。落盘形态可以换 —— 而且 S1 实测证明**必须换**（见 §1） |
| 前提 2「混版本降级」（老客户端只写 JSON） | ❌ **作废**：没有正式客户，= 所有人一起升 |
| §0.6「发布版一律恒关」 | ❌ **作废**：不要求"关着逐字节不变"当上线门槛；开关只为开发期对照保留 |
| 前提 4「全库补种块身份」（只服务"持久化 ydoc 状态"那条路） | ✅ **重新变成必须**（因为那条路就是全上线唯一可走的路）—— 但补种时机由 S1/S2 定 |
| 面 5「E2EE 加密快照」 | ⏸ **不阻塞**：今天服务端存明文是可接受的临时态；面 5 落地时另做迁移（无客户 ⇒ 迁移成本可控） |

**仍然有效的纪律（不因"大胆干"而放弃）**：不静默失败（该抛就抛）、块身份不许丢/不许重、
判据不许删了不写替代、每次改动要有当轮 tip 读数、测试与文档同步。

## 1. ★ S1 实测：**"每次从 JSON 新建 ydoc"这条路不可合**（架构红线）

判据 `src/lib/crdt/mergeability.test.ts` ①（同日实跑）：

```
① 实测：同一份 JSON 各自新建的两份状态合起来 ⇒ 顶层块 = ["paragraph#blk-1","paragraph#blk-1"]
```

**一个块变成两个、而且两块 `blockId` 相同** ⇒ 块引用/反链当场失效。原因：`contentJsonToYDoc` 每次
新建 Y.Doc，插入的条目拿到**新的客户端身份与新时钟** ⇒ 两份状态在 CRDT 眼里是"两次独立插入"，
合起来就是两份。判据 ② 同时证了 Yjs 的**正例**（同一血统的两笔更新可合、**顺序无关**、不重复）。

⇒ **结论（定了架构）**：要能合，只能走

> **每页持久化一份「同一血统」的 CRDT 状态**：载入 → 在它上面应用本地编辑 → 存回新状态；
> 合并 = 交换状态/更新（服务端合并，已拍）。**绝不**用"JSON→新建 ydoc"当保存形态。

这也解释了为什么 Slice A/B 那套（`roundTripContentJson`）只能是**归一化**：它天生不可合。

### S2a 实测（同一天，`pageSession.test.ts`）：**载入既有血统这条路能合**

```
① 同血统两台设备各加一块 ⇒ A 侧 = ["blk-1","blk-2","blk-A","blk-B"]
                           B 侧 = ["blk-1","blk-2","blk-A","blk-B"]   ← 两处都在、无重复、两侧一致
② 两份「载入复用」状态合并 ⇒ ["blk-1","blk-2"]                        ← 不翻倍（对照 S1 反例）
```

⇒ 唯一可走的用法被证成：**`openPageSession({ state })` 载入 → `edit()` → `exportState()` 存回 → `merge()` 收另一端**。
`contentJsonToYDoc` 从此只用于**首次落盘**（建血统那一次），**不许**再当保存形态。

### S2b 实测（同一天，`pageStateStore.test.ts`）：**落盘之后重启还是同一条血统**

```
④ 跨重启（从库里的 BLOB 重新开会话）两台各加一块 ⇒ 合并后 = ["blk-1","blk-2","blk-B","blk-A"]
   两处都在、无重复、两台投影（含顺序）完全一致；合并后的状态再存回、再读回还能继续用
① 写回的字节含 0x00/0xFF/0x80 这类**非 UTF-8** ⇒ 读回逐字节相同（堵住"被当文本/base64 存"这条路）
```

**范围如实收窄（写进计划，免得读成"两侧都好了"）**：本切片 `page_crdt` **两侧都建表**（TS ＋ Rust `db.rs`），
但**读写只在 TS 那一层**；Rust 的三条镜像函数与会话接线归 **S7「两侧都接」**（`db.rs` 里已就地记档）。

### ★ 真问题（S3 顺手抓到的）：**生产入口早就在用 devDependencies**

`src/main.tsx:12`（**生产入口**）`import { roundTripContentJson } from "./lib/crdt/yDocBridge"` ⇒
`yjs` / `@lexical/yjs` **早就在打进 app 包**，而 `package.json` 里它们声明在 **devDependencies**
（Slice B 当时还专门写了"`yjs` 不升格"）。

**读数**（同一台机、同一套门禁）：升格前后产物 **10,658.10 kB → 10,658.84 kB**（+0.74 kB，噪声级）
⇒ 所以这不是"升格把包变大了"，而是"**清单终于追上事实**"：包里一直有它，只是清单说没有。

⚠️ **教训（写下来免得再犯）**："不升格"这类约定**必须**有门禁看着 —— 否则它会在某次"顺手 import"
之后就悄悄变成假话；这一轮的代价是查了一遍包体才敢把话说清。

## 2. 切片清单（顺序即依赖；每片都要有判据 ＋ 当轮 tip 读数）

| # | 切片 | 交付 | 承重判据 |
|---|---|---|---|
| **S1** ✅ | 可合性红线 | 本文件 §1 ＋ `mergeability.test.ts`（2 条） | 反例：新建血统合 ⇒ 翻倍；正例：同一血统 ⇒ 顺序无关、不重复 |
| **S2a** ✅ | **同一血统的活会话** | `openPageSession({ state/json })`：载入既有血统 → `edit()` 产增量 → `exportState()` 存回 → `merge()` 收另一端（`yDocBridge.ts` S2 段）＋ `pageSession.test.ts` 5 条 | ① ★ 同血统两台各加一块 ⇒ 合并后 `["blk-1","blk-2","blk-A","blk-B"]`、**两侧一致**、无重复；② 载入复用**不翻倍**（对照 S1 反例）；③ 存回→载入投影不变、合并自己幂等；④ 会话与纯函数路径**同源** |
| **S2b** ✅ | **状态落盘位置** | 新表 `page_crdt(page_id, state BLOB, updated_at)` **两侧都建**（TS `platform/sqliteStore.ts` ＋ Rust `db.rs`）；读写三条函数（`readPageCrdtState` / `writePageCrdtState` / `clearPageCrdtState`）先在**那一层**（`lib/docContent.ts`，字节在层里是**不透明 BLOB**）＋ `pageStateStore.test.ts` 4 条 | ① 没状态 ⇒ `null`（≠空字节）；写回读**逐字节相同**（含非 UTF-8 字节，堵住"被当文本/base64 存"）；② 同页只留最新（主键 upsert）；③ 驱动回二进制字符串也能还原（**不用 `Buffer`**，Web 里没有）；④ ★ **跨重启仍同一条血统** ⇒ 合并后 `["blk-1","blk-2","blk-B","blk-A"]`、两处都在、不翻倍、两台投影一致 |
| **S3a** ✅ | **活绑定（常驻监听）** | `openPageSession` 把"本地编辑 → yjs"接成**常驻** `registerUpdateListener`（不再每次编辑手动挂一次），并新增 **`dispose()`** 撤监听；回声**由库自己挡**（`syncYjsStateToLexicalV2` 的变更带 `COLLABORATION_TAG`，`syncLexicalUpdateToYjsV2` 见到它就当场返回 —— 读 `@lexical/yjs` 的 V2 实现得到，不是猜的）＋ `pageSession.test.ts` 加 3 条 | ⑥ ★ **回声安全**：两台来回互合**三轮**不增殖、两侧仍一致；⑦ ★ **活绑定真进 doc**：`edit()` 之后**另一个会话**从状态打开就能看到（没有手动同步调用）；⑧ `dispose()` 之后编辑**不再**进 doc（否则 dispose 是假的） |
| **S3b-1** ✅ | **绑定既有编辑器 ＋ 「本地编辑」信号** | `openPageSession({ json\|state, editor })` 可绑**既有**编辑器（真编辑器要的就是这条）；新增 `onLocalEdit(cb)` —— **hydration（载入/远端合并落回编辑器）期间不报**，其余 update 报一次（真编辑器的保存路径要挂在它上面，而不是"每次 update 都存"）＋ `pageSession.test.ts` 加 2 条 | ⑨ ★ 直接改**那个**编辑器 ⇒ 会话状态里就有、与纯函数路径同源、另一端看得到；⑩ ★ 建血统/远端合并不报、本地编辑报一次、退订生效 |
| **S3b-2a** ✅ | **首开"只建一次"**（把"并发首开两套身份"这个风险堵成一条入口） | 层里新增 `ensurePageCrdtState(db, pageId, json, now, build)`：**有就载入、没有才建一次并立刻落盘**；`build` 是**注入**的（这一层不许 import 桥接层 —— 与 `setCrdtPlaneImpl` 同一手法）＋ `pageStateStore.test.ts` 加 2 条 | ⑤ ★ 首开建一次（`seeded=true`）并落盘；第二台/重启再开 ⇒ `seeded=false`、**builder 没被再调**（= 不会有第二套身份）、拿到的是同一条血统且能继续演进；⑥ `build` 抛错 ⇒ **一行都不落盘**，下一次仍能正常建 |
| **S3b-2b** ✅ | **一页 ↔ 真编辑器 的绑定（唯一实现）** | 新 `crdt/pageBinding.ts`：`bindPageToEditor({db,pageId,editor,seedJson,now})`（**先** `ensurePageCrdtState`、**再**开会话挂在**传入的**编辑器上）＋ `loadJsonForEditor(db,pageId,storedJson)`（**有状态 ⇒ 用状态的投影**；没有 ⇒ 原样返回）；桥接层加别名导出 `projectStateToJson`（见下面踩坑①）＋ `pageBinding.test.ts` 3 条 | ⑪ 首绑 `seeded=true`、状态落盘、编辑器与会话同血统；⑫ ★★ **真编辑器打字 → 存回 → 重开页面** ⇒ `seeded=false`、看得到"真编辑器打的字"、与重开后又打的那笔合并 ⇒ `["blk-1","blk-2","blk-live","blk-reopened"]`（两处都在、不翻倍、存回后一致）；⑬ 没状态 ⇒ 逐字节原样返回 |
| **S3b-2c** ✅ | **平台 API：状态的读/写**（组件接线的前置件） | `commands.ts` 加 `read_page_state` / `save_page_state`（载荷 `number[]`，二进制跨 IPC 只能这么走）；`api.ts` 包成 `readPageState(id): Promise<Uint8Array\|null>` / `savePageState(id, state)`（界面侧只看到字节）；`web.ts` 用那一层的 `readPageCrdtState` / `writePageCrdtState` 实现（`null` ≠ 空字节）；桌面未实现 ⇒ 登记进 `check-web-commands` 的 `WEB_ONLY_COMMANDS` 并写明归 **S7** | `check-web-commands` **绿**（Rust 239 个命令、web 共 242、契约 243 个含 web 专属 4 个）⇒ 新命令确实被那三条线（契约/桌面/Web）对上了；`tsc` ＋ build 绿 |
| **S3b-2d** ✅ | **真接线（真应用侧）** | 两件：① `pageBinding.ts` 加**端口版** `bindPageToEditorViaPort({port,pageId,editor,seedJson})`（界面侧手里没有 `ContentSql`、只有 `api` ⇒ 存取收成端口 `PageStatePort`，**顺序逻辑仍只写在 pageBinding 一个文件里**）；② `editor/Editor.tsx` 新增小子组件 `PageCrdtBinding`（挂在 composer 内、与 `<EditorStoreSync/>` 并列）：seed 用保存路径同一个 `serializeWithBlockIds` ⇒ 绑定 ⇒ `onLocalEdit` ⇒ `persist()`（失败**如实 toast ＋ 控制台**，不吞）⇒ 卸载 `dispose()`。**App.tsx 一行未改** | `check:web-build`（**浏览器级**）**8 通过 / 0 失败** —— 含"点新建页面之后编辑器起来了（DB 写入链路通）""**0 未捕获错误**""0 失败请求"；`pageBinding.test.ts` 加 ⑭（端口版：首开建一次并落盘、第二次只载入、两条绑定能合）⇒ `src/lib/crdt/` **7 文件 / 42 条全绿**；`tsc`／`build` 绿 |

| **S3b-2e** ✅ | **浏览器级判据：打字 ⇒ 刷新 ⇒ 字还在**（把上一轮"没有断言 CRDT 真生效"的缺口堵上） | `scripts/check-web-build.mjs` 加一条断言：新建页面后往 `[contenteditable]` 打字（`crdt-probe-2026`）⇒ 等保存去抖 ＋ 状态存回 ⇒ **刷新** ⇒ 轮询确认字还在；`tests/baseline.json` 的 `check-web-build` 下界 8 → 9 | ★ **变异实测**：把 `PageCrdtBinding` 里的 `onLocalEdit` 订阅去掉（＝本地编辑不存回状态）⇒ 恰好**这一条**红（**8 通过 / 1 失败**）；还原后 **9 通过 / 0 失败**。⇒ 这条断言**真的咬人**，也证明"刷新后编辑器被库里的状态 hydration 覆盖"确实发生（状态落后 ⇒ 刚打的字被抹掉） |

> 💡 **为什么这条能验 CRDT（别把它读成"刷新后字还在"这么弱）**：刷新后编辑器先按落盘的**投影**渲染，
> 随后被 `PageCrdtBinding` 用**库里的 CRDT 状态** hydration 覆盖 ⇒ 只要"本地编辑 ⇒ 状态存回"没接对，
> 刷回来的就是那份**旧状态**，刚打的字会被**抹掉**。所以它同时守住两条路：本地编辑 ⇒ 状态存回、
> 状态 ⇒ 载入。变异实测就是它的证据。

> 🧯 **本轮两条踩坑（都记档，免得重犯）**：
> ① **门禁按字面量算 —— 连 import 的函数名也算**：`pageBinding.ts` 第一版直接
>    `import { yDocToContentJson }` 就被 `check-doc-content-access` 判红（"新增文件直接引用（不在基线里）：1 处"）
>    ⇒ 桥接层给了一个**别名** `projectStateToJson`，非层文件一律用它。这就是层清单决策树里那条
>    "会反复撞的税"的又一次实证：**名字也算**。
> ② **绝对不要用 PowerShell 的 `Get-Content -Raw | Set-Content` 改源码**：我用它做一次纯改名，
>    结果**加了 BOM（`EF BB BF`）＋ 中文全变乱码**，两个新文件只能按原内容重建。
>    本仓"不许用 `Set-Content` / `-replace` 动源文件"这条纪律**是血的教训** —— 这次是第三次撞。
>    ⇒ 源文件只用 `edit` / `write` 工具改（改完顺手查一次首三字节是不是 `47,47,32`＝`// `）。
>
> ⚠️ **"首开两套身份"这个风险（读代码时发现 → S3b-2a 已收敛，残留窗口归 S5）**：
> `src/editor/Editor.tsx:176/190` 的 `parseEditorState` 在**载入**时就会给缺 `blockId` 的顶层块铸
> `newBlockId` ⇒ 若"每台设备打开时各建一次血统"，两台各造一套身份 ⇒ 按 S1 红线合并会翻倍。
> **处置**：S3b-2a 给出唯一入口 `ensurePageCrdtState`（**有就载入、没有才建一次并立刻落盘**）。
> **残留（如实写）**：两台设备**同时**首开同一张**从没建过血统**的页、且各自离线时窗口仍在
> ⇒ 彻底解法在 S5（服务端可以拒绝/收敛第二条血统），本阶段不假装已解决。
| **S4a** ✅ | **远端来的状态怎么并进本机**（"真正的合并同步"在客户端这一侧的唯一入口） | `pageBinding.ts` 新增 `mergeRemotePageState(db, pageId, remote, now)`：本机**没有** ⇒ 直接**采用**它（它自带血统，别另起一条）；本机**有** ⇒ 载入本机血统 ⇒ `session.merge(remote)` ⇒ 存回。**只动状态，不碰投影、不标脏**（投影口径归 S6，回推与否归 S5）＋ `pageBinding.test.ts` 加 1 条（三问合一） | ⑮ 本机没有 ⇒ `adopted=true`、投影＝远端内容；⑯ ★★ 两端**各改一处** ⇒ 依次并进同一个库 ⇒ **两处都在、不重复**（实测 `["blk-1","blk-2","blk-A","blk-B"]`），重复并同一版**幂等**；⑰ ★ **次序无关**：先 A 后 B 与先 B 后 A ⇒ 最终投影**完全一致（含顺序）** |
| **S4b-0** ✅ | **wire 载荷的形状 ＋ 版本标记**（纯函数，接线前先把语义钉死） | 新 `crdt/wireConstants.ts`（`CRDT_WIRE_VERSION`，三方共用一个数字，避免各写字面量）＋ `crdt/wireState.ts`：`encodeCrdtWire(state)`（**没有状态 ⇒ `undefined`**，不发空壳）/ `decodeCrdtWire(raw)` ⇒ `none`（老载荷 ⇒ 走今天那条路）｜`ok`（解出来）｜`unknown-version`（**不猜**）⇒ `wireState.test.ts` 5 条 | ① 往返逐字节相同（含非 UTF-8）；② 没有/空状态 ⇒ `undefined`；③ 老载荷三种形态 ⇒ `none`（**缺字段 ≠ 空状态**）；④ ★ 版本不认识 ⇒ `unknown-version`（不当 v1 解）；⑤ 载荷坏了（`state` 非数组／字节越界）⇒ **如实抛**，不静默截断 |
| **S4b-1a** ✅ | **"推"那一侧接上**：outbox 的页面变更带上状态与版本标记 | `wireState.ts` 新增 `withCrdtWire(payload, state)`（没有状态 ⇒ **同一引用**；有状态 ⇒ 浅拷贝加字段；非普通对象 ⇒ 原样返回）；`web.ts::recordChange` 在 `page`/`upsert` 时挂上 `crdt_state`。**零新依赖**（只用那一层的读取 ＋ 那个纯函数文件） | ⑥ 没有状态 ⇒ 同一引用（载荷**逐字不变** ⇒ 老路径零感知）；⑦ 有状态 ⇒ 加字段且**不动调用方那份对象**；⑧ 非普通对象 ⇒ 原样返回。回归：`test:sync-verify`（双设备同页并发编辑）**84/0** |
| **S5-0** ✅ | **勘察：服务端是"哑中转" ⇒ 阶段 1「只存不算」免费成立**（**只读**，没动那个仓） | 读 `shuyonote-sync-server`（`git 6aa054a`）：`src/sync.rs:77` 明写 **"The server never parses `payload`"**，`payload: Option<String>`（`:24`/`:45`）⇒ 存（`:140`/`:148`）与取（`:200`/`:217`）都是**原样字符串**；同步路由 `/push`（`src/main.rs:444`）与 pull 同组 | ⇒ 客户端（S4b）挂上的 `crdt_state` **已经被服务端原样转存与转发** ⇒ "阶段 1 只存不算"**不需要改服务端一行**。★ **结论（改了 S5 的形状）**：阶段 2「服务端开算」的真实成本不是"加个字段"，而是 **Rust 侧要有一份与 JS `yjs` 互操作的 CRDT 实现**（`yrs` 或自研）＋ 与客户端**对拍**，且服务端从此**看得懂内容**（隐私口径要重新定义）⇒ **建议推迟**：先用"**客户端合并 ＋ 哑中转**"把端到端跑通（客户端两侧已经通了），服务端开算留到有明确需要时（例如状态体积/权威视图） |
| **S4b-1b** ✅ | **"收"那一侧接上**（**必须用注入**） | `platform/web.ts` 的 `applyChange` 页面分支：`decodeCrdtWire` ⇒ `ok` 交给**已注册的 applier**（`applyRemoteCrdtState` ⇒ `mergeRemotePageState`）／`none` ⇒ 今天那条路（逐字相同）／`unknown-version` ⇒ `console.warn` 如实报出（不猜）。⚠️ **不许**在 `web.ts` 里 import `pageBinding`：那会把编辑器节点表拖进 `web.ts` 的依赖图，而它会被 Node 侧脚本加载（2026-09-23 那次初始化环就是这么炸的：vitest 9 文件 ＋ smoke-web ＋ two-device-sync 同时红）⇒ 按 `setCrdtPlaneImpl` 同一手法注入（`crdt/plane.ts::setCrdtRemoteApplier`）＋ 新 `remoteApply.test.ts` 3 条 | ① 没注册落地实现 ⇒ **如实抛**（吞掉远端那一版＝丢更新，不许静默）；② 注册后 `(db, pageId, state)` 三个都传到位；③ 集成：注册**真实现** ⇒ 远端那一版真的落进本机。**实测 3/3 绿**（2026-09-23） |
| **S5** | **服务端合并（两阶段）** | 阶段 1「只存不算」→ 阶段 2「开算」＋ 总开关（可按空间关） | 阶段 1 行为零变化；阶段 2 服务端合并幂等、可重放、不丢块 |
| **S6a** ✅ | **派生文本：合并之后要**有痕**（不静默落后，也不造假账） | `mergeRemotePageState` 返回 `derivedStale`，两种情形打「待重建」：**采用**别人的一版、**合并真有新内容**（判定用**投影比**，**不用字节比** —— 字节不同未必内容不同，拿它当判据会多标）＋ 复用**既有**补算器链路（不引第二份派生实现）＋ 新 `derivedStale.test.ts` 2 条 | ⑱ ★ 真有新内容 ⇒ `text_stale` 打上、补算器收口后正文列跟上且标记清掉；⑲ ★ 重复并同一版 ⇒ **不**打（无假账）、状态仍在（幂等≠丢弃） |
| **S6b** ✅ | **块身份穿过合并**（口径 ＋ 判据） | 口径写死在判据文件头：**铸身份只发生在一处**（保存路径／首开补种，已由 S3b-2a 的 `ensurePageCrdtState` 收成一次），**转换层与合并路径一律不铸**；新 `identityThroughMerge.test.ts` 用**产品自己的** `topLevelBlockIds` 验（不是自己数 JSON） | ⑳ ★ 合并后块身份 = `["blk-1","blk-2","blk-A","blk-B"]`：**并集**、无重复（S1 红线的症状）、**没有任何新面孔**；㉑ ★ 幂等（同一版再并一字不变）＋ 换顺序仍是同一集合 |
| **S7-1** ✅ | **桌面侧 `page_crdt` 存取（Rust）** | 新 `src-tauri/src/page_crdt.rs`：`read_page_crdt_state` / `write_page_crdt_state` / `clear_page_crdt_state`（与前端三条**成对**）＋ 文件内 `#[cfg(test)]` 两条逐条对应前端判据；`lib.rs` 登记 `mod page_crdt;` | 编译通过（`cargo test --lib page_crdt` **建出 test profile**）；⚠️ **执行**被本机环境挡着（`STATUS_ENTRYPOINT_NOT_FOUND`，测试二进制起不来），编解码逻辑与前端的成对判据已在 TS 侧全绿 |
| **S7-2** ✅ | **Tauri 命令接上 ＋ 撤掉 web-only 假陈述** | `commands.rs` 的 `read_page_state` / `save_page_state`（`state: Vec<u8>`，前端 `number[]` 过 IPC）＋ `lib.rs` 的 `generate_handler!` 注册；`check-web-commands.mjs` 撤回那两条 `WEB_ONLY_COMMANDS`（web 专属 **4 → 2**） | `cargo check --lib` exit=0；`check-web-commands` 绿且 **Rust 命令 239 → 241**；`check-capabilities` 绿。★ 这同时修掉一个**真问题**：`PageCrdtBinding` 在桌面也跑，而命令只登记为 web 专属 ⇒ 桌面**每次开页弹一次「绑定失败」** |
| **S8** ✅ | **血统护栏**（读那篇《Lexical + Yjs 生产实践要点》第 2 条后加的：**切勿在客户端初始化文档内容**） | `pageBinding.ts` 新增 `lineageClientIds`（`Y.decodeUpdate` 取 client id 集合＝**血统指纹**）/ `lineagesRelated`；`mergeRemotePageState` **先验血统**：两条**独立创建**的状态 ⇒ **拒绝合并**并回 `lineageConflict`（本机那版原样保留、不标派生）＋ 护栏命中当场 `console.warn`；`main.tsx` 注册的那版再 **toast** 一次（用户可见）；`lineageGuard.test.ts` 3 条 | ① 同血统 ⇒ 不误报；② ★ 两条独立血统 ⇒ 有痕、本机原样、**内容没翻倍**（实测拒绝后仍 `["blk-1"]`）；③ 空状态/无指纹（`[0,0]`）⇒ 视为相关、不拦 |
| **S9** ✅（实现完成；**待发版**） | **服务端「首写者裁定」** ＋ 客户端接线（细节见 §10） | **服务端**（分支 `feat/crdt-lineage-claim`）：v15 迁移建 `page_lineage` ＋ `POST /sync/lineage-claim`（复用 `auth_user`／`require_space(editor)`；`INSERT OR IGNORE` ＋ 回读＝原子＋幂等；**不碰 payload**）。**客户端**：`bootstrap.ts` 四支决策 → `claimClient.ts`（403=denied／401·5xx·网络=抛⇒离线降级）→ `bindPageToEditorViaPort({claim})`（被拒⇒**不建不落盘如实抛**）→ `claim_page_lineage` 命令 → 编辑器真端口（空间取**这一页自己的**） | 服务端判据 `cargo test --bin …` **34/0**（含原子／幂等／每页一行／跨页独立）；客户端 `src/lib/crdt/` 76 条绿；`check-web-commands` 绿。⚠️ **未发版 ⇒ 生产上端点 404 ⇒ 客户端落"离线"那一支（不报错，裁定未生效）**；桌面侧 claim 待补（暂登记 `WEB_ONLY`） |
| **S7-3** | **两侧都接 ＋ 真机验收**（要人手） | 桌面（Rust）与 Web 两侧同语义已通（S7-1/S7-2）；**双设备人工验收**未做 | 两侧判据成对；真机双设备验收过 |

## 2.5 S9 设计稿：服务端「首写者裁定」（**要动 `shuyonote-sync-server`，先出稿**）

**要解决的问题**（那篇文章第 2 条点名、我们已量化）：两台设备**同时**首开同一张**从没建过血统**的页、
且各自离线 ⇒ 各建一条血统。S8 的护栏只能**发现并拒绝合并**（不损坏），关不掉窗口本身。

**方案（不需要 yrs、不需要服务端看得懂内容）**：
1. 服务端加**一条原子 claim**（例如 `POST /pages/{id}/lineage-claim`）：库里一行一个 `page_id`，
   首次插入成功者即"首写者"（`INSERT OR IGNORE` ＋ 看 `changes()`）；**载荷只是 claim 记录本身**
   （device_id ＋ 时间戳），**不含内容** ⇒ 服务端仍然"哑且盲"。
   ⚠️ 这一条要动**另一个仓**（`shuyonote-sync-server`，Rust/axum，独立发布线）⇒ 未获点头前只出稿。
2. 客户端：打开一张**没有本地状态**的页时先 claim：
   · 拿到 ⇒ 由它建血统（＝今天的 `ensurePageCrdtState` 那一步）；
   · 拿不到（别人已 claim）⇒ **等待/拉取**对方的初始状态（联机时）；**离线**时按下面的降级走。
3. **离线降级（必须写清，否则会把"离线可用"弄坏）**：离线时允许建**临时本地血统**并打标记
   （"未 claim"）；联网后若发现已有人 claim ⇒ 走 S8 的冲突出口（**报出来**，本机版本保留），
   后续再决定要不要提供"把它并过来"的裁决路径（今天的 `page_conflicts` 裁决 UI 是同一类东西）。
4. **不做什么**：不做"把两条血统重新**rebase** 成一条"（那需要在权威血统上重放本地编辑，
   而重放的内容只能从投影 JSON 来 ⇒ 正是"从 JSON 重建"那个陷阱）⇒ 留作将来单独一片，
   且必须先有判据证明 rebase 不丢块身份。

## 3. 本冲刺**不做**

- 不做向后兼容/混版本降级（owner 已豁免）；不保留"发布版恒关"作为上线门槛；
- 不为面 5（E2EE 快照）先做半套设计 —— 但**记档**：服务端今天是明文，面 5 落地时另做迁移；
- 不把 `yjs`/`@lexical/yjs` 留在 devDependencies 里假装无害 —— S3 起它就是**生产依赖**，
  升格要单独一次提交并写清对打包产物的影响（体积/首屏）。

## 9. 冲刺 24 轮后的**状态与续做清单**（2026-09-23，诚实盘点）

### 9.1 已经**做完并有读数**的（都在 `dev`）

| 片 | 一句话交付 | 关键读数 |
|---|---|---|
| S1 | 可合性红线：**从 JSON 新建的状态不可合** | 实测合并后 `["paragraph#blk-1","paragraph#blk-1"]`（一块变两块、`blockId` 重复） |
| S2a/S2b | 同一血统活会话 ＋ 状态落盘（新表 `page_crdt`，两侧都建） | 跨重启合并 = `["blk-1","blk-2","blk-B","blk-A"]`；BLOB 非 UTF-8 字节逐字节往返 |
| S3 全族 | 真编辑器绑上真 Y.Doc（活绑定、`onLocalEdit`、`dispose`、首开只建一次） | 浏览器门禁 `check:web-build` **9/0**（含"打字 ⇒ 刷新 ⇒ 字还在"），**变异实测**：去掉状态存回 ⇒ 恰好那条红 |
| S4a | 远端状态并进本机（唯一入口） | 两端各改一处 ⇒ 都在、不重复、**次序无关** |
| S4b-0/1a/1b | wire 形状与版本标记（纯函数）＋ 推/收两侧接上（**注入**，不 import 编辑器节点表） | 双设备脚本 `test:sync-verify` **84/0**；载荷无状态时**逐字不变** |
| S5-0 | 服务端勘察：**哑中转**（"never parses payload"） | ⇒ 阶段 1「只存不算」**不需要改服务端一行**；阶段 2 的真实成本 = Rust 侧 Yjs 实现 |
| S6a/S6b | 合并后派生文本**有痕**；块身份穿过合并（口径 ＋ 判据） | `text_stale` 该打才打；合并后身份 = **并集、无重复、不新铸** |
| S6 尾巴 | 投影**写回**落盘那一列（只动那一列、不动 `dirty`） | 采用/合并后其他读侧立刻看到新内容；重复并同一版**一次写库都不做** |
| S7-1/S7-2 | 桌面 Rust 侧 `page_crdt` 存取 ＋ Tauri 两条命令注册 | `cargo check --lib` exit=0；`check-web-commands` 绿且 Rust 命令 **239 → 241** |
| S8 | **血统护栏**：两条独立血统**拒绝合并**并报出 | 实测拒绝后本机仍 `["blk-1"]`（不翻倍、有痕、有 toast） |
| S9（客户端半边） | 「要不要建血统」四种动作 ＋ claim 端口（纯函数） | 5 条判据把四支钉死；**今天不接线**（没有端口 ⇒ 行为与接线前逐字相同） |

**当轮全绿读数**：`tsc` 0 ・ `src/lib/crdt/` **14 文件 / 68 条** ・ `pnpm run build` 0 ・
`check-doc-content-access` 562/562（基线未动）・ `check-web-build` 9/0 ・ `test:sync-verify` 84/0。

### 9.1.1 ★ 预算末（第 40 轮）的**当前 tip 读数** —— 交接以上面这一组为准

前面 §9.1/§10.4 的读数是各片当时跑的数字；预算末在 tip **`b38baeae`**（第 38 轮的修复之后）上重跑：

```
tsc --noEmit                        ⇒ exit 0
pnpm vitest run（**全量**）          ⇒ 202 文件通过 | 4 跳过；2117 条通过 | 9 跳过；exit 0
pnpm run build（全套门禁）           ⇒ exit 0
build:web ＋ check:web-build        ⇒ 9 通过 / 0 失败（含「打字⇒刷新⇒字还在」「0 未捕获错误」）
test:sync-verify（双设备同页并发）   ⇒ 84 通过 / 0 失败
check-doc-content-access            ⇒ 562/562（基线未动）
check-web-commands / doc-links / doc-facts ⇒ 全绿
src/lib/crdt/                       ⇒ 16 文件 / 75 条
```

**这条线上唯一"红过又被修掉"的**（记档，说明门禁确实在干活）：第 38 轮浏览器门禁抓到
`[web] invoke error claim_page_lineage`（没有同步配置时我让命令抛异常 ⇒ 平台 invoke 层记 error）
⇒ 改成 `{granted:false, unavailable:true}` 结果标记、UI 侧再转异常交给 `claimVerdict` 归一（提交 `b38baeae`）。

### 9.2 **没做完的**（不结项的原因，按"谁能推"分组）

| # | 缺口 | 谁能推 | 现状/证据 |
|---|---|---|---|
| 1 | **S9 服务端原子 claim 端点** | **owner 点头**（要改 `shuyonote-sync-server`） | 设计稿见 §2.5；客户端半边已就绪。目标里"服务端合并两阶段"的**阶段 2** 也在这条线上 |
| 2 | **真机双设备验收** | **人手（两台设备）** | 目标里明写的一条；本机脚本 84/0 **不等于**真机 |
| 3 | Rust 成对判据**执行** | 环境 | `cargo test --lib` ⇒ 测试二进制 `0xc0000139 STATUS_ENTRYPOINT_NOT_FOUND`。**已试过**：把 `pdfium.dll` 放到 `target/debug/` 与 `target/debug/deps/` 旁边 ⇒ **无效**（⇒ 不是它；别再重复这个实验）。编译是干净的 |
| 4 | **yrs 对拍尖刺**（JS yjs vs Rust yrs） | 本机可做（要加 `yrs` 依赖 ＋ 编译） | 做完才知道 S5 阶段 2 可不可行；**yrs 有多线程限制**（共享 Doc 不可并发写）⇒ 设计已定为"每页独立、请求内短命 Doc" |
| 5 | 阶段 1 的**块级 LWW / 补算器**拆除 | 本机可做 | 口径 1 作废后它们是过渡量；拆之前要确认没有读侧还依赖它们 |

### 9.3 续做时先读什么 / 先跑什么

- 读：本文件（状态与清单）→ §2.5（S9 设计）→ `2026-09-23-crdt-plane-boundary-decision.md`（边界决策）；
- 跑：`pnpm vitest run src/lib/crdt/`（68 条）→ `pnpm run build` → `pnpm build:web && pnpm check:web-build` →
  `pnpm run test:sync-verify`；Rust 侧 `cargo check --lib`（**别**指望 `cargo test` 能跑起来，见 9.2-3）。

## 10. 补记：24 轮之后又做了什么（第 25–30 轮，S9 服务端 ＋ 客户端接线）

owner 于第 24 轮后给了一句 **"可以动服务端，不考虑向后兼容，最快速度实现 crdt"** ⇒ S9 从"只出设计稿"
变成"已实现"。

### 10.1 服务端（**另一个仓** `shuyonote-sync-server`，分支 `feat/crdt-lineage-claim`，**未部署**）

| 内容 | 读数 |
|---|---|
| `db.rs` 加 **v15 迁移**：`page_lineage(page_id 主键, space_id, device_id, claimed_at)` ＋ `schema_version=15` | — |
| `sync.rs` 加 `lineage_claim` handler：`require_space(..., "editor")` ＋ `INSERT OR IGNORE` ＋ **回读**判定；**不碰 payload**（仍"哑且盲"） | 幂等靠回读天然满足 |
| `main.rs` 的 `sync_routes` 加 `/lineage-claim`（复用 `auth_user`） | — |
| `sync.rs` 加语义判据：原子／**同设备重复 claim 仍 granted**／每页一行／跨页独立 | `cargo test --bin …` **34 passed / 0 failed** |
| ⚠️ 过程中我**误删了 v14 的 dispatch 分支**（改 v15 时 old_string 连带的既有分支没写回）⇒ `device_keys` 没建、4 条判据红。定位法：**先在 `main` 上跑同样测试（全绿）** ⇒ 证明是自己改的。已恢复 | 已记进代码注释 |

### 10.2 客户端（本仓）

| 片 | 内容 | 读数 |
|---|---|---|
| S9-客户端半边（第 22 轮） | `bootstrap.ts`：四种动作 ＋ `PageClaimPort` ＋ `claimVerdict` | 5 条判据 |
| HTTP 端口（第 27 轮） | `claimClient.ts`：`POST {server}/sync/lineage-claim`；**403 ⇒ denied**／**401·5xx·网络 ⇒ 抛 ⇒ 离线降级** | 4 条判据 |
| 绑定路径接线（第 28 轮） | `bindPageToEditorViaPort({ claim })`：拿到⇒建／**被拒⇒不建不落盘如实抛**／没端口⇒与接线前**逐字相同** | 3 条判据 |
| 平台命令（第 29 轮） | `claim_page_lineage`（`api.claimPageLineage`）＋ `web.ts` 复用 `syncFetch`/`sync_profiles`/`getAuthSession`；桌面侧暂登记 `WEB_ONLY`（**没接时落"离线"那一支、不报错**） | `check-web-commands` 绿（Rust 241 / web 243 / 契约 244） |
| 编辑器接线（第 30 轮） | `PageCrdtBinding` 里造真端口接进绑定；`device_id` 收到**平台侧**（`syncDeviceId()`）⇒ 界面少一个能填错的地方 | `tsc`/build 绿 |

### 10.3 现在**还差**什么（按谁能推）

| # | 缺口 | 谁能推 |
|---|---|---|
| 1 | **服务端发版**（跑 v15 迁移 ＋ 部署 `feat/crdt-lineage-claim`）—— 不部署的话，`/lineage-claim` 在生产上 404 ⇒ 客户端一直走"离线"那一支（**不报错，但裁定没生效**） | **owner**（我不部署） |
| 2 | **桌面侧 claim**（Rust `reqwest` 发同一端点）＋ 撤掉 `WEB_ONLY` 登记 ⇒ 两侧同行为 | 本机可做（要读该仓 `sync.rs` 的 HTTP 封装） |
| 3 | **"页所属空间"传准**（现在编辑器用的是 `getActiveWorkspaceId()` 近似） | 本机可做（要动 App→Editor 的 props） |
| 4 | **真机双设备验收**（两台设备；离线各改一处 ⇒ 联网后两处都在） | **人手 ＋ 真机** |
| 5 | Rust 成对判据**执行**（`STATUS_ENTRYPOINT_NOT_FOUND`；已排除 pdfium） | 环境 |
| 6 | yrs 对拍尖刺（JS yjs vs Rust yrs）→ 再定 S5 阶段 2 | 本机可做 |
| 7 | 阶段 1 的块级 LWW/补算器拆除 | 本机可做（先确认没有读侧依赖） |

### 10.4 当轮 tip 的合并读数（第 35 轮，`56570ff6` 上一次性跑完）

§9.1 那些读数是**各片当时**的数字；这里给一份**同一个 tip 上**的合并读数（本仓纪律：别只在旧 tip 上跑过）：

```
TIP=56570ff6
tsc --noEmit                     ⇒ exit 0
vitest run src/lib/crdt/         ⇒ 16 文件 / 75 条全绿（含 S9 的 bootstrap/claimClient/claimWiring）
pnpm run build（全套门禁）        ⇒ exit 0
check-doc-content-access         ⇒ 562/562（基线未动）
test:sync-verify（双设备同页并发）⇒ 84 通过 / 0 失败
```

⚠️ **这份读数里没有的**（别当成已验证）：服务端那条端点在**生产**上的行为（未发版）、**真机**双设备、
桌面侧 claim、Rust 成对判据的执行（环境问题）、yrs 对拍 —— 都在 §10.3 的缺口清单里。

## 11. 第 41 轮：缺口 §10.3-2 / -5 / -6 收口 ＋ **新发现一个缺口**（2026-09-23）

> 本轮开工时的 tip 是 `6dc61ba4`；期间**另一个会话在同一工作树**提交了 `f45ab8c3`
> （claim 路径去掉 `/sync` 前缀：部署后探针实测 `/sync/lineage-claim`=404、`/lineage-claim`=401）
> 并**完成了服务端发版**。本轮所有改动都按 `f45ab8c3` 之后的路径口径写。

### 11.1 缺口 2：桌面侧 claim（Rust）—— 已接，且**登记已撤**

| 内容 | 位置 |
|---|---|
| `claim_page_lineage` 命令（`reqwest` POST `{server}/lineage-claim`，Bearer 优先取 `auth_sessions`） | `src-tauri/src/sync.rs`（`claim_page_lineage` / `claim_config` / `lineage_claim_verdict`） |
| 注册进 `generate_handler!` | `src-tauri/src/lib.rs` |
| 撤掉 `WEB_ONLY_COMMANDS` 登记（web 专属 **3 → 2**） | `scripts/check-web-commands.mjs` |
| 与前端成对的判据 3 条（403⇒denied／401·5xx⇒"问不到"／200 缺字段⇒denied） | `sync.rs` 的 `#[cfg(test)]`（`lineage_claim_verdict_matches_client_semantics` 等） |

**口径与 web 侧逐条对齐**（这不是"再写一份"）：403 ⇒ `granted:false`（**不许**混进离线那一支）；
401/5xx/网络/载荷读不懂 ⇒ `{granted:false, unavailable:true}`；**没有同步配置也算"用不了"、不抛**
（第 38 轮浏览器门禁就是被"抛异常"抓住的）。

**读数**：`cargo check --lib` exit=0；`check-web-commands` 绿且 **Rust 命令 241 → 242**；
Rust 侧 524/0（见 §11.2）。

### 11.2 缺口 5：Rust 成对判据**执行** —— 已解，根因与"换依赖查看器"的结论一致

**根因（本机 PE 依赖查看器实测）**：测试 exe 直接导入 `comctl32.dll` 的 **`TaskDialogIndirect`**，
而 `C:\Windows\System32\comctl32.dll` 是 **5.82**（不含该导出）⇒ 加载期 `0xC0000139`。
它不是缺 DLL、不是 CRT、不是 PATH —— 是**测试 exe 没有应用清单**（`Microsoft.Windows.Common-Controls`
v6 只能靠 SxS 清单绑到），与 `docs/TESTING.md`「已知边界」和 `scripts/win-cargo-test.ps1` 文件头
写的**是同一件事**。

⚠️ **所以缺口 §9.2-3 / §10.3-5 这条登记本身是旧的**：答案早在仓里（脚本 ＋ 文档），只是没人把它
和"缺口"对上。⇒ **别再重复"把 pdfium.dll 放到 target/debug 旁边"那类实验**。

**读数**（`powershell -ExecutionPolicy Bypass -File scripts\win-cargo-test.ps1`）：

```
524 passed / 0 failed / 18 ignored      ← 含本轮新加的 3 条 claim 判据与 page_crdt 两条
```

### 11.3 缺口 6：yrs 对拍尖刺 —— 已做，结论**格式层可行**

独立 crate `spikes/yrs-interop`（**不进 app 依赖树**）＋ 尖刺判据
`src/lib/crdt/yrsInterop.spike.test.ts`（没有那个二进制就自报跳过）。完整结论见
[yrs 对拍尖刺：结论](2026-09-23-yrs-interop-spike-conclusions.md)。三条读数：

1. **互操作成立**：JS 合并与 Rust 合并同一批 fixtures ⇒ 投影**逐字节相同**
   （`["blk-1","blk-2","blk-A","blk-B"]`），Rust 侧 `root_children=4` 与 JS 侧读到的一致；
2. **失败形态是"卡死"不是报错**：读事务还活着时再调 `get_or_insert_*` ⇒ **不返回**（实测挂住
   ≥45s，另一次整条命令 120s 超时）；
3. ⚠️ **一条被我读错过、必须纠正的**：并发共享一个 `Doc` **没有**复现失败 —— 第一版把它读成
   "共享 Doc 就会卡"，那是错的（当时的卡死来自 ① 那种写法）。⇒ "每页独立、请求内短命 Doc"这条
   设计**没有被推翻**，但也没因此获得新证据；它仍是**最省心**的口径。

⇒ **对 S5 阶段 2 的影响**：成本从"Rust 侧从零写一份 Yjs 实现"降到"接 `yrs` ＋ 写合并/存储"，
剩下的前置是**隐私口径（服务端从此看得懂内容）／状态体积／并发口径**——**能不能做**已回答，
**值不值得做**没回答。

### 11.4 ★★ 新发现的缺口（原清单里没有）：**桌面侧同步路径根本不消费 `crdt_state`**

这是本轮做 §11.5 的勘察时撞上的，**比原缺口 2 严重**（缺口 2 是"桌面不问"，这条是"桌面收不到"）。

**证据（每条都可当场复核）**：

| # | 事实 | 出处 |
|---|---|---|
| 1 | `src-tauri` 全仓 grep `crdt` 只有 `page_crdt.rs`（存取不透明字节）＋注释；**没有任何 wire 解码** | `grep -i crdt src-tauri/src` |
| 2 | 桌面 pull 的落库唯一入口是**块级 LWW**：`sync::apply_upsert` → `doc_content::apply_remote_page` → `merge_remote_content` | `sync.rs:153`、`doc_content.rs:913` |
| 3 | `decodeCrdtWire` **只出现在 Web 平台**（`platform/web.ts` 的 `applyChange`） | `src/lib/platform/web.ts:877` |
| 4 | 桌面**推**出去的载荷也没有状态：`record_page_upsert` 序列化的是 `PageDetail`（没有 crdt 字段） | `sync.rs:127`、`models.rs:20` |
| 5 | `PageDetail` **没有** `deny_unknown_fields` ⇒ Web 端推来的 `crdt_state` 在桌面被**静默丢掉**（不报错、不留痕） | `models.rs:20` |

**后果**：桌面拿到的远端页只走 LWW（不合并状态）；而编辑器的 hydration 以**本地状态**为准
（S3b-2e 那条 💡 自己写着："刷新后编辑器先按落盘的投影渲染，随后被 `PageCrdtBinding` 用库里的
CRDT 状态 hydration 覆盖"）⇒ 库里的状态一旦落后于对端，**桌面上的跨设备编辑会被自己的旧状态覆盖**，
而且**一声不响**。Web 侧那半（`applyChange` 消费 `crdt_state`）是真的通了，所以 §9.1/§10.4 说的
"客户端全链路已通" **只对 Web 成立**。

**本轮为什么不顺手补**：补它只有两条路，两条都要先出设计 ＋ 判据（本仓纪律：判据不许删了不写替代）：
① Rust 侧真合并（`yrs`，§11.3 已证可行）—— 要连带回答隐私/体积；
② 中间方案：桌面把收到的状态**原样存进旁路表**，交给 WebView 里那份 TS 实现在**打开页面时**合并
—— 改动小，但要么给出"什么时候合"的口径、要么会在合并前先丢一次内容，**不能不带判据就上**。

### 11.5 缺口 7（阶段 1 过渡量拆除）的勘察结论：**它们今天不是死代码**

原话是"口径 1 作废后块级 LWW / 补算器是过渡量 ⇒ 可以拆"。**勘察结果：今天拆不了**，三条理由：

1. **桌面还在用它**：§11.4 证据 2 —— 桌面 pull 的合并**就是** `merge_remote_content`；
   拆掉它等于让桌面"没有合并"；
2. **无状态载荷仍然存在**：桌面推的页载荷**从不带**状态（§11.4 证据 4），没建过血统的页也没有状态
   ⇒ S4b-1b 那条"`none` ⇒ 走今天那条路"**每天都在走**，不是历史遗留；
3. **"补算器"根本不是过渡量**：`text_stale` / `refresh_page_text_if_stale` 是**投影的修复通道**，
   S6a 明确复用它（"不引第二份派生实现"）⇒ 它服务的是 CRDT 路径，不是阶段 1 专属。
   而 `pages.content_json` / `content_text` 两列本身是**读侧投影**（FTS/反链/导出/插件都读它），
   按 §0 的口径它们**本来就要留**。

**拆除的前置条件**（写清楚，免得下次又当"死代码"删）：先关掉 §11.4（桌面消费状态）或等服务端合并
（S5 阶段 2）落地，**并且**确认每一页都有血统；两件都成立之前，"块级 LWW"是**唯一**兜底合并路径。

### 11.6 缺口 1（服务端发版）：**已关**（另一个会话做的，本轮独立复核）

```
POST https://shuyo.cn/sync/health         -> 405（路由在，只是不收 POST）
POST https://shuyo.cn/sync/lineage-claim  -> 401（★ 路由在、要鉴权 ⇒ 裁定生效）
POST https://shuyo.cn/sync/sync/lineage-claim -> 404（旧的错路径）
```

### 11.7 缺口 3（"页所属空间"传准）：**登记已过期**

`src/editor/Editor.tsx` 自 `0aeb8ab9` 起就用**这一页自己的** `workspace_id`
（`api.getPage(id)` ⇒ `workspace_id`，取不到才 `console.warn` 并退回当前工作空间）。
⇒ §10.3-3 这条可以划掉。

### 11.8 当轮 tip 读数（第 41 轮，**一次性跑完、全绿**）

工作树 = `f45ab8c3` ＋ 本轮改动（下面这组就是这个工作树上的读数）：

```
tsc --noEmit                        ⇒ exit 0
pnpm vitest run（全量）              ⇒ 204 文件通过 | 4 跳过（208）；2138 条通过 | 9 跳过（2147）；exit 0
pnpm run build（全套门禁）           ⇒ exit 0
check-doc-content-access            ⇒ 562/562（基线未动）
check-web-commands                  ⇒ 绿：Rust 242 / web 243 / CommandMap 244（**web 专属 3 → 2**）
check-doc-links                     ⇒ 绿（131 个 .md / 771 条相对链接）
check-doc-facts                     ⇒ 绿
test:sync-verify（双设备同页并发）   ⇒ 84 通过 / 0 失败
build:web ＋ check:web-build        ⇒ 9 通过 / 0 失败（含「打字⇒刷新⇒字还在」「0 未捕获错误」）
cargo check --lib                   ⇒ exit 0
scripts\win-cargo-test.ps1（Rust）   ⇒ 526 passed / 0 failed / 18 ignored（含本轮新加的 3 条 claim 判据）
src/lib/crdt/yrsInterop.spike.test.ts ⇒ 2 通过（尖刺；没有那个二进制时**自报跳过**）
```

⚠️ **两次全量跑之间唯一红过一次的地方**（如实记，因为它教了一件事）：第一次全量里
`src/lib/graphLayout.test.ts` 的**计时**判据（250 节点收敛 ≤250ms）实测 **260ms** ⇒ 红；
**单独重跑 7/7 绿**、最终全量也绿。那一刻同一台机上并行跑着 build／浏览器门禁／另一个会话的命令
⇒ 计时类判据在负载下会**假红**，不能当回归信号（判断方法：单独重跑一次）。

### 11.9 本轮**仍然没有**关闭的（按谁能推）

| # | 缺口 | 谁能推 |
|---|---|---|
| 1 | **真机双设备验收**（两台设备；离线各改一处 ⇒ 联网后两处都在）—— 本机脚本 84/0 **不等于**真机 | **人手 ＋ 真机** |
| 2 | **桌面侧消费 `crdt_state`**（§11.4 新发现，比原缺口 2 严重） | 本机可做，但**先要出设计 ＋ 判据**（两条路见 §11.4） |
| 3 | 阶段 1 的块级 LWW / 补算器拆除 | 本机可做，但**前置未满足**（§11.5） |
| 4 | S5 阶段 2（服务端开算） | 本机可做（格式层已证可行，§11.3），**要不要做**是产品/隐私决策 |

## 12. 第 42 轮：★ 修一条**已经上线**的 claim bug（本地 id 当远端 space 发）＋ 403 口径两端统一

### 12.1 怎么发现的

§11 收口后我按"接下来做什么"复核了自己镜像的那段取配置口径（`web.ts` 的 claim 分支），
发现它挑的是"**第一个配了 `server_url` 的档案**"，而请求体里的 `space_id` 用的是**编辑器传来的
本地工作空间 id**。顺着查下去，这是个真 bug，而且**服务端刚发版 ⇒ 它现在就生效**。

### 12.2 事实链（两套 id，没有任何路径对齐）

| # | 事实 | 出处 |
|---|---|---|
| 1 | 服务端 `require_space` 查的是 `space_members(space_id, user_id)`，而 space id 是**服务端生成的 32 位十六进制** | `shuyonote-sync-server/src/space.rs:39` / `:31`（`gen_id`）|
| 2 | 本地工作空间 id 是 `uuid::Uuid::new_v4()`（首库是 `default`） | `src-tauri/src/workspaces.rs:204` |
| 3 | 绑定关系存在 `sync_profiles.space_id`（面板写的是**远端** `sp.id`）| `src/components/SyncPanel.tsx:617` |
| 4 | claim 发的却是本地 id ⇒ `require_space` 查不到成员行 ⇒ **必然 403** | `Editor.tsx`（第 41 轮前）+ `web.ts` / `sync.rs` |

### 12.3 后果（分平台不一样，两条都不好）

| 平台 | 403 的处置（修前） | 现象 |
|---|---|---|
| Web | `syncFetch` 非 2xx 就抛 ⇒ `{unavailable:true}` | **静默**降级回"离线临时建"：功能不坏，但**首写者裁定从未生效、层里一条痕都没有** |
| 桌面（第 41 轮刚接的那条） | 403 ⇒ `granted:false` ⇒ `denied` | `wait-for-remote` ⇒ **绑定被拒 ＋ 一句错话**（"这一页正在另一台设备上编辑"），**每一张没本地状态的页**都会这样 |

⇒ 第 41 轮我按 `crdt/claimClient.ts` 的口径写桌面侧，而**生产上真正跑的**是 `web.ts`（403 ⇒
`unavailable`）—— 那个 HTTP 端口在生产里根本没人调用，我读错了参照物。两条一起修。

### 12.4 修了什么（四件，两侧成对）

1. **新纯函数 `src/lib/crdt/claimScope.ts`**：`resolveClaimScope(rows, workspaceId)` ⇒ 只认
   **这一页所属工作空间**的档案；缺地址或**缺远端 `space_id`**（登录了还没选空间）⇒ `null`
   ⇒ 上层回 `unavailable`（**连请求都不发**：发出去只会换来 403，而 403 会被误读成裁定）。
2. **入参改名 `space_id` → `workspace_id`**（`commands.ts` / `api.ts` / `Editor.tsx` / Rust
   `LineageClaimArgs`）：语义写实，免得下一个人再把它当远端 id 发出去。
3. **403 口径两端统一**：**403 ⇒ `unavailable`**（授权/配置问题），`denied` **只认
   200 ＋ `granted:false`**（服务端就是这么表达"别人先 claim"的）。改动落在 `claimClient.ts`
   （含文件头那张表）＋ `sync.rs::lineage_claim_verdict` ＋ `web.ts` 的注释。
4. **两侧判据**：`crdt/claimScope.test.ts` 3 条（**承重**：发出去的是远端 id、不是本地 id）
   ↔ `sync::tests::claim_config_*` 2 条；`claimClient.test.ts` ③ 改成"403 ⇒ unavailable"并
   加一条"200＋false 才是 denied"的对照；另加**文本级接线判据**
   `platform/webClaimScope.wiring.test.ts` 3 条（防接线退回旧形状 —— 这段接线没有别的判据，
   浏览器门禁不配同步、走的是"没配置"那一支）。

⚠️ **记一条自己刚踩的坑**：`api.ts` 的注释里写了 `**403**/5xx`，其中"星号紧跟斜杠"**提前关掉了块注释**
⇒ `tsc` 一口气报 20 多个 TS1005。与"中文里直引号套直引号"同一族：**注释里的字符序列也会被解析器当真**。

### 12.5 这一轮**还没关**的

**真账号端到端探针**（需要凭据 ⇒ owner 或人手）：用真 token claim 一次 ⇒ 期望 **200 ＋
`granted:true`**；第二台设备再 claim 同一页 ⇒ 期望 **200 ＋ `granted:false`**。
这一条同时把"发版后端点真的生效"验掉 —— **本轮的判据都到不了这里**（它们验的是"发给谁/怎么读回话"，
不验"服务端真的按这个 space 认得你"）。在那之前，只能说"**必然 403 的那条路已经拆了**"。

## 13. 第 43 轮：桌面侧**收下** `crdt_state`（§11.4 那条缺口的收口）

### 13.1 做了什么（两半，都是"桌面原先根本不消费状态"）

| 半 | 做法 | 为什么这么做 |
|---|---|---|
| **收（pull）** | Rust 侧新 `src-tauri/src/crdt_wire.rs`（与 TS `wireState.ts` 同一张表：没有 ⇒ 走今天那条路／版本不认识 ⇒ **不猜**／载荷坏了 ⇒ **如实报**）＋ 新表 `page_crdt_pending`（**按 `seq` 逐条**留）＋ pull 分支里**收到就收**（`absorb_incoming_crdt_state`，与"最后用谁的版本"无关：页级 `KeptLocal` 时那一版同样不能丢）＋ 两条平台命令 `read_pending_page_states` / `clear_pending_page_states` | Rust **没有** Yjs（要不要引进 `yrs` 是 S5 阶段 2 的决策）⇒ 不在这里长第二份合并实现；把字节交回**有编辑器语义的那一侧** |
| **推（push）** | `sync::record_page_upsert` 落 outbox 时**挂上状态**（`crdt_wire::with_wire_state`，字段名/形状与 TS 的 `withCrdtWire` 一致） | §11.4 证据 4：桌面**推出去的载荷从不带状态** ⇒ 桌面↔Web 那条 CRDT 链路本来是断的。⚠️ **没有状态 ⇒ 载荷逐字不变**（那条路不经过序列化改写） |
| **并（打开页面时）** | `crdt/pageBinding.ts` 的端口版绑定：**先并掉收下的状态，再谈建不建血统**。本机已有 ⇒ 在它上面继续；本机没有但收下了对端的 ⇒ **承接对端那条血统**（`adopted=true`、**不 claim**、立刻落盘）；两条**独立血统** ⇒ 与 `mergeRemotePageState` **同一对纯函数**做护栏，拒绝并**留痕**（`pendingSkipped`） | 这正是 `bootstrap.ts` 里 `wait-for-remote` 想要的"等它同步下来"；护栏复用同一份判定 ⇒ 不产生第二套血统语义 |

⚠️ **`page_crdt_pending` 为什么按 `seq` 逐条留、而不是"每页一行"**：服务端 pull **不回 `device_id`**
（`shuyonote-sync-server/src/sync.rs` 的 select 里没有它），而**不同设备**的全量状态互相并不包含对方的
编辑 ⇒ "每页一行"就是**真丢**。上限 `MAX_PENDING_PER_PAGE = 24`，超了丢最旧的并 `eprintln!` **留痕**
（最新那条是全量状态，最终内容不受影响）。

### 13.2 读数（本机实跑）

```
pageBinding.test.ts  ⇒ 7 通过（含新加的 ⑱⑲）
【⑱ 实测】承接后          = ["blk-1","blk-2","blk-peer"]                    ← 本机没建血统、也没 claim
【⑲ 实测】合并后          = ["blk-1","blk-2","blk-mine","blk-peer"]        ← 两处都在、不重复
【⑲② 实测】独立血统被拒后 = 原样（pendingSkipped=1，留痕）
Rust：crdt_wire 5 条 ・ page_crdt::pending 2 条 ・ absorb/push 各 1 条 ⇒ 全绿
check-web-commands ⇒ Rust 244 / web 245 / CommandMap 246（+2 条命令，两侧都实现）
```

### 13.3 这一片**没有**关掉的（如实写，别读强）

1. **投影列的滞后**：打开页面时合并/承接只写**状态**（＋hydration 把内容落进编辑器），
   `pages` 那两列要等**下一次保存**才跟上 ⇒ 在那之前这一台的 FTS/反链看不到刚并进来的字。
   与 `apply_remote_page` 那条已知边界同一族（"派生要编辑器语义，不在同步路径现算"），
   **不是**新引入的静默 —— 但确实是滞后，记在这里。
2. **`pendingSkipped > 0` 现在只到 `console.warn`**：没有走 S8 那条"冲突可见 + 用户可裁决"的出口
   （那要动 `page_conflicts` / 裁决 UI）。**下一片**该把它接上（与 `mergeRemotePageState` 的
   `lineageConflict` 合流）。
3. **真机双设备验收仍未做**（要人手）—— 而且现在**更值得做**了：这一片之后，桌面的
   "打开页面 ⇒ 承接对端血统"这条路才有东西可验。

## 14. 第 44 轮：状态体积读数 ＋ S5 阶段 2 的"要不要做"（建议**暂缓**）

### 14.1 体积读数（`src/lib/crdt/stateSizeReading.test.ts`，用**应用自己那份**实现跑）

```
   块数    CRDT 状态     落盘 JSON（对照）    平均
    1      167 B         341 B             167.0 B/块
   10     1545 B        2609 B             154.5 B/块
   50     8026 B       12769 B             160.5 B/块
  200    31576 B       51069 B             157.9 B/块
增量编辑（50 块时追加一块）：8026 B → 8115 B（**+89 B**）
```

⇒ 两条结论：① 体积**线性**（约 158 B/块）；② 状态**比它替代的那份 JSON 更小**
（200 块：31.6 KB ＜ 51.1 KB），且增量是"按块"的 ⇒ **"服务端存不下/传不动"这条不成立**。
判据钉住的是"单调增 ＋ 每块 ≤4KB ＋ 与 JSON 同量级"，**不做时限断言**（那是 `graphLayout` 那条
计时判据的教训：负载下会假红）。

### 14.2 S5 阶段 2：**建议暂缓**，把"能不能做"与"值不值得做"分开

完整建议见 [S5 阶段 2 决策稿](2026-09-23-s5-server-merge-decision.md)（四条启动条件、
改动面、五条承重判据、明确不做的三件）。一句话：

> **能**做（尖刺已证格式层可行、体积也不是问题），但今天**不必**做 ——
> 客户端两侧（Web 当场合并／桌面收下后打开页面时合并）**第 43 轮起已闭环**，
> 而服务端开算要连带重定义**隐私口径**（服务端从此看得懂明文）⇒ 那是**面 5 E2EE 的输入约束**，
> 两者必须同批设计（边界决策 §6.3 已写明）。

⇒ 本轮**不落实现**：只出稿 ＋ 留读数，等 §3 的四条触发条件之一成立再动工。



