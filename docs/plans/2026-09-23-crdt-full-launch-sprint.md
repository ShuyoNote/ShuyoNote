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
| **S4b-1b** | **"收"那一侧接上**（下一件，**必须用注入**） | `applyChange` 的页面分支：`decodeCrdtWire` ⇒ `ok` 交给**已注册的 applier**（`mergeRemotePageState`）／`none` ⇒ 今天那条路（逐字相同）／`unknown-version` ⇒ 如实报出（不猜）。⚠️ **不许**在 `web.ts` 里 import `pageBinding`：那会把编辑器节点表拖进 `web.ts` 的依赖图，而它会被 Node 侧脚本加载（2026-09-23 那次初始化环就是这么炸的：vitest 9 文件 ＋ smoke-web ＋ two-device-sync 同时红）⇒ 按 `setCrdtPlaneImpl` 同一手法注入 | 带状态的载荷 ⇒ 本机并进同一条血统（两端各改一处 ⇒ 都在、不重复）；不带状态的载荷 ⇒ 行为与今天**逐字相同**；版本不认识 ⇒ **有痕**（不静默） |
| **S5** | **服务端合并（两阶段）** | 阶段 1「只存不算」→ 阶段 2「开算」＋ 总开关（可按空间关） | 阶段 1 行为零变化；阶段 2 服务端合并幂等、可重放、不丢块 |
| **S6** | **派生与身份口径重定** | `content_text`/FTS 在合并后的重建时机；块身份在 CRDT 下的铸/补种 | 合并后正文不落后（或有痕）；`topLevelBlockIds` 在合并前后**集合不变**（除真正新增块） |
| **S7** | **两侧都接 ＋ 真机验收** | 桌面（Rust）与 Web 两侧同语义 —— 含 **`page_crdt` 读写三条镜像**（`doc_content.rs` 的 `read_page_crdt_state` / `write_page_crdt_state` / `clear_page_crdt_state`）与会话接线；双设备人工验收 | 两侧判据成对；真机双设备验收过 |

## 3. 本冲刺**不做**

- 不做向后兼容/混版本降级（owner 已豁免）；不保留"发布版恒关"作为上线门槛；
- 不为面 5（E2EE 快照）先做半套设计 —— 但**记档**：服务端今天是明文，面 5 落地时另做迁移；
- 不把 `yjs`/`@lexical/yjs` 留在 devDependencies 里假装无害 —— S3 起它就是**生产依赖**，
  升格要单独一次提交并写清对打包产物的影响（体积/首屏）。
