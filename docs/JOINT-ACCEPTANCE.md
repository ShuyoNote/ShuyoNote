# 三平面联合验收（国密 × 全库 AI 覆盖 × 块级 CRDT）

> 这份文档回答四件事：**什么时候能一起测**（准入）、**一起测什么**（联合格子）、**谁跑**（责任方）、
> **什么算过**（判据与下限）。执行器是 `scripts/joint-acceptance.mjs`，登记表是
> `scripts/lib/joint-planes.mjs`（**单一事实来源**：本文档里那张机器事实块由门禁逐字核对）。
>
> 一句话口径：**分开绿 ≠ 一起绿。**

## 0. 为什么是「联合」而不是「三条线各跑一遍」

三条线各自都有常开门禁，各自都绿。但它们**两两/三三相交的格子没有任何人负责**，而那些格子恰好最贵：
三个平面的数据住在**同一张空间库**里、走**同一条写路径**、还要一起过**加密 / 备份 / 同步 / 全库扫描**。

本仓最爱举的反例就发生在交界处：发版链那次「`--prepare` 只清 dev profile ⇒ release 的旧 SQLCipher 被原样复用
⇒ **包表面全对而库级不是国密**」——每一步单看都没错。

三平面为什么各自都必须参与：

| 平面 | 它带来的东西 | 它踩到谁 |
| --- | --- | --- |
| **国密** `sm` | 空间库的**磁盘字节**（库级 SM4 页 / 国密 MAC·KDF ＋ 应用层 v2 容器） | 另两个平面的每一次落盘都要过它 |
| **全库 AI 覆盖** `coverage` | `attachment_text.coverage`、派生表、块/嵌入；**一次扫全库**的入口 | 与 CRDT 的 `page_crdt` 同库；全库扫描正好撞上「存量页面没补种块身份」 |
| **块级 CRDT** `crdt` | 每页一份**新的权威状态** `page_crdt`（要跨设备合并） | 加密库上的新表（国密）＋ 让全库扫描读到老页面（覆盖） |

## 1. 准入：什么时候能开跑

```bash
node scripts/joint-acceptance.mjs            # 就绪面板 ＋ 格子矩阵（只读，不改任何东西）
node scripts/joint-acceptance.mjs --check    # 就绪 ⇒ 0；未就绪 ⇒ 2；探针自己坏了 ⇒ 1
node scripts/joint-acceptance.mjs --check --require sm,crdt   # 只要求某几个平面
```

**三态**（沿用 `check-release-state.mjs --deep` 与 `check-gm-wired.mjs` 的既有口径）：

- **就绪**：本机可查的探针**全部**命中 ⇒ 这一平面具备联合验收条件；
- **未就绪**（退出码 **2**）：有本机探针不命中 ⇒ 明确点名还缺哪一件。**这不是红**，是「还没到」；
- **未实查**：需要真机 / 外部机器的读数（真机重启、Windows 静态前缀、LibreOffice、真模型、Web CORS）。
  它**不参与**本机就绪判定——否则本机永远未就绪——但**开跑前**每一条都要有着落。
- **红**（退出码 **1**）：探针自己坏了（登记表指向的文件不存在、命令跑不出 `test result:` 行、判据低于下限）。

> ⚠️ **就绪 ≠ 功能完成**。就绪只说明「这一平面的代码面在岗、联合测试跑得起来」。
> ✅ **2026-09-25 更正**：本节原先还列着 coverage 的**第二条**缺口 ——「面板侧**消费**抽取结果那一层」——
> 那一层**已经落地**（覆盖方案 §8.0「已落地」表：`AiSettingsForm.tsx` 的「检查索引覆盖」入口 ＋
> 只读能力 `coverage.report`，各带 4 条判据，均为 2026-09-23）⇒ **别再去补它**。
> coverage 今天真正还缺的只有**旧格式（.doc/.xls）的真转换读数**（要有 LibreOffice 的机器）。

## 2. 机器事实（**由 `scripts/lib/joint-planes.test.mjs` 逐字核对，别手改**）

<!-- joint:begin -->
平面 3 条 · 联合格子 8 个（已落地 4 / 待施工 1 / 真机或外部 3）
sm：探针 6 条（外部待读 1）· 单独读数 4 条
coverage：探针 9 条（外部待读 3）· 单独读数 3 条
crdt：探针 9 条（外部待读 2）· 单独读数 3 条
j1 landed macos sm+coverage+crdt
j2 todo macos sm+coverage+crdt
j3 landed macos coverage+crdt
j4 landed macos crdt+coverage
j5 landed macos sm+coverage+crdt
j6 manual owner sm+coverage+crdt
j7 manual amd sm+coverage+crdt
j8 manual macos coverage+crdt
<!-- joint:end -->

> 上面这一段**由默认门禁核对**（`scripts/lib/joint-planes.test.mjs` 是 vitest 用例，随 `pnpm verify` 的
> smoke 组跑）：改了登记表就要同步改它，否则红。同一条判据还要求**每个格子都在本文档里出现**，
> 以及**每条探针指到的文件真实存在** —— 计划腐烂的两种方式（文件搬走、文档与登记表各说各话）都当场红。

## 3. 联合格子

状态：`▶`＝判据已在岗（今天就能跑）／`✎`＝施工单已写、还没落地／`◻`＝需真机或外部读数。

> ⚠️ **2026-09-25 更正（j2/j3/j4 三格）**：这三格原先都写成"**平面开着**（`VITE_CRDT_PLANE=1`）"，
> 而**那个开关已经在第 47 轮撤出**（`plane.ts` 上半段删除，见冲刺 §16 ＋ `plane.withdrawn.test.ts`）
> ⇒ 它们的**施工对象不存在了**：不是"施工单已写、判据没落"，而是**这一格得先重写**。
> **进展（2026-09-27）**：**j3 与 j4 都已按新口径落地**（各见下面那一节）——
> j3 的对象换成「CRDT 合并留下的**派生落后**标记 × 覆盖报告的读数」；
> j4 的对象换成「**载荷里的状态 × 真 `applyChange` × 注入的落地实现**」。
> 只剩 **j2**（与开关无关，照原施工单仍可做）。

| # | 状态 | 责任方 | 跨平面 | 这一格问的问题 | 命令 |
| --- | --- | --- | --- | --- | --- |
| **j1** | ▶ | macos | sm+coverage+crdt | 导出的快照把另两平面的新表/新列一起带走了吗？（血统与覆盖度） | `cargo test --lib workspace_io::` |
| **j2** | ✎ | macos | sm+coverage+crdt | 两份**页加密不同**的夹具里，另两个平面写进去的东西还读得出来吗？（**与平面开关无关** ⇒ 照原施工单仍可做） | 施工：`security.rs` 两份夹具生成器 |
| **j3** | ▶ | macos | coverage+crdt | 派生落后（CRDT 合并的痕）**不许**被覆盖报告算成「已覆盖」 | `npx vitest run src/lib/extract/coverageReport.test.ts src/lib/libraryCoverage.test.ts src/components/aiSettingsCoverage.test.tsx` |
| **j4** | ▶ | macos | crdt+coverage | 载荷里的 CRDT 状态走**真 `applyChange`** ⇒ 逐字节交给落地实现（老载荷/未知版本不许被调） | `node scripts/verify-two-device-sync.mjs` |
| **j5** | ▶ | macos | sm+coverage+crdt | 国密构建下**全量 lib** 是否 0 失败（含 `page_crdt` / 派生 / 导出那几族）？ | `node scripts/check-gm-wired.mjs` |
| **j6** | ◻ | owner | sm+coverage+crdt | 真机一次走完：加密开 → CRDT 编辑 → 抽取 → 覆盖报告 → **重启** → 仍可读？ | 真机剧本（§5） |
| **j7** | ◻ | amd | sm+coverage+crdt | Windows **静态前缀**下 j1/j5 是否同绿？ | 静态前缀就绪后复跑 |
| **j8** | ◻ | macos | coverage+crdt | Web 端（**没有 SQLCipher**）能证明什么、不能证明什么？ | `npx vitest run src/lib/crdt` ＋ 如实记档 |

### j1 已落地（2026-09-23）

`snapshot_carries_the_other_two_planes_new_tables`（`src-tauri/src/workspace_io.rs`）三条断言：
快照**不给钥**读得开 ⇒ `page_crdt` 的**字节逐字节**相同 ⇒ `attachment_text.coverage` 的**文本逐字**相同。

为什么值得钉：导出走的是**整库在线备份**（不是按表列举），所以「新表/新列自动随行」**看起来**是不证自明的
—— 而「看起来」正是要钉的东西。`src-tauri/src/db.rs` 里那两族表的注释甚至写着派生表「不进导出」，
而实现是整库快照 ⇒ 这条判据把**实际行为**钉住（哪个说法对是另一件要拍的事，见 §6）。

### j3 已落地（2026-09-27）

**这一格换过对象**：原来是「平面开着 ＋ 存量老页面 ⇒ 全库扫描炸不炸」，而平面开关第 47 轮撤了。
新问的是**交界处那条**：CRDT 合并会把页面标成「派生待重建」（`mergeRemotePageState` ⇒ `markTextStale`
⇒ `pages.text_stale=1`），那些页面**照样有块、照样搜得到** —— 但搜到的是**合并前那版**；
而覆盖报告此前**完全不看这个标记** ⇒ 「页面 5/5 有正文」会被读成「检索面里都是最新的」。

处置与 §15.10 的 `partial` **逐条对齐**（「成功 ≠ 抽全了」的姊妹条：「搜得到 ≠ 是新的」）：

| 口径 | 判据 |
|---|---|
| 落后的页面**照旧计入 `indexed`**（它确实搜得到）＋ 另开一条 `text_stale` gap | `coverageReport.test.ts` ① |
| **没查**（清单不传）⇒ `pages.stale === null`，摘要**不打印** | ②（「不知道」不许印成「0 页落后」） |
| 查过了、没有落后的（`{total:0}`）⇒ `stale === 0`（与 ② 分得开） | ③ |
| 又落后又没块 ⇒ 报 `page_empty`（同一件事不说两遍），总数仍如实计 | ④ |
| 取材层**真的问过**队列；取不到 ⇒ `null` ＋ **有痕**，且不把整份报告弄挂 | `libraryCoverage.test.ts`（两条） |

落地三处：`src/lib/extract/coverageReport.ts`（新 reason ＋ `pages.stale: number | null`）、
`src/lib/libraryCoverage.ts`（取材那一问，`api.listStaleTextPages(50)`）、
`src/components/AiSettingsForm.tsx`（单列一栏，`null` 显示「未知」）。
`--run j3` 走的是三个文件的 vitest（下限 37 条 ⇒ **空跑即红**）。

### j4 已落地（2026-09-27）

**它也换过对象**：原来是「平面开着时，块级合并走真同步路径对不对」，平面开关第 47 轮撤了。
新对象是那一段**谁也没跑过的中间链**：

```text
wireState.test.ts        验编解码          ┐
remoteApply.test.ts      验「注册了就用它」 ├─ 三段各自有判据
pageBinding.test.ts      验真实现能合      ┘
真 applyChange 拿到载荷里的状态、按字节交给落地实现   ← ★ 这一段此前没人验（场景 O 补上）
```

`scripts/verify-two-device-sync.mjs` 场景 O（7 条判据）：
真 wire 编码（`withCrdtWire`）⇒ 载荷里**真的**挂上 `crdt_state` ⇒ 真 `applyChange`
⇒ 状态**逐字节**交给已注册的落地实现；**老载荷**（无该字段）与**版本不认识**两种情形
**一次都不许调**（"没有"与"不认识"必须分得开），且都不阻塞主路径。

⚠️ 两个**实测撞出来**的施工约束（写在脚本注释里）：
1. **必须一个入口打一个包**（`web.ts` ＋ `crdt/plane.ts` ＋ `crdt/wireState.ts`）——
   分成两个 bundle 会得到**两份** `plane.ts` 模块实例，注册的落地实现在另一份里读不到，
   判据会永远"没被调用"而红得毫无线索；
2. **不能把 `crdt/pageBinding.ts` 拉进这个包**（实测 61 个 esbuild 报错：它 → `yDocBridge`
   → `editor/config` ⇒ excalidraw 的 CSS、katex 的字体全进包）⇒ 「**合得对不对**」那半条链
   留在 vitest（`remoteApply.test.ts` ③ 注册的**就是**真实现 `mergeRemotePageState`）。

`--run j4` 走 `node scripts/verify-two-device-sync.mjs`（下限 **91** 条 ⇒ 空跑即红）。

### j5 已落地，但它**不能**替代 j3/j4

`check-gm-wired` 跑的是**全量 lib 单测**，里面本来就含 `workspace_io::`（j1）、`derived_transport::`（覆盖度那一列）、
`page_crdt::` 与 `doc_content::`（CRDT）。所以它是一份**已经存在**的联合读数。⚠️ 但它跑在**平面默认关**的状态
—— 它证明的是「国密构建下这些代码编得过、单测过」，**不是**「平面开着时也对」。

## 4. 执行顺序（推荐剧本）

```bash
# ① 看就绪（任何时候都能跑，只读）
node scripts/joint-acceptance.mjs

# ② 三个平面**各自**的读数先各自绿（分开绿是前提，不是结论）
npx vitest run src/lib/crdt src/lib/extract src/lib/libraryCoverage.test.ts src/components/aiSettingsCoverage.test.tsx
cargo test --lib block_rev doc_content page_crdt

# ③ 联合格子（今天能跑的两格）
node scripts/joint-acceptance.mjs --run j1
node scripts/joint-acceptance.mjs --run j5     # 需要 SM 版 OpenSSL 前缀；缺前缀会**自报跳过** ⇒ 本格判红
```

**还原与卫生**（★ 别跳过）：j5 那条命令内部会**自己还原**（撤补丁 ＋ 重建默认特性）；
若中途 Ctrl-C，手工收尾：

```bash
node scripts/sm-library-build.mjs --revert          # 撤补丁（含私有 .gm-build/ 隔离目录）
node scripts/check-gm-registry-clean.mjs            # 确认共享 registry 没留补丁
node scripts/check-crypto-backend.mjs               # 确认最新产物回到平台默认
```

## 5. 真机剧本（j6）

一次走完，中间**不重启**，最后重启。

> ✅ **2026-09-25 更正**：本节原先教人 `VITE_CRDT_PLANE=1 pnpm tauri dev` —— **那个开关已经没了**
> （第 47 轮撤出：`plane.ts` 上半段删除，判据去向见冲刺 §16；护栏在
> `src/lib/crdt/plane.withdrawn.test.ts`）。⇒ **直接起应用就行**，没有"先把它打开"这一步。

```bash
pnpm tauri dev        # 什么都不用设：今天没有"平面开关"这种东西
```

1. **加密**：设置里开启磁盘加密（库级后端按平台默认；国密那一档见 [SM-CRYPTO-DELIVERY](SM-CRYPTO-DELIVERY.md)）；
2. **CRDT**：新建一页 → 编辑 → **两台设备各改同一页的一块** → 合并后两处都在、顺序一致；
3. **覆盖**：给该页挂一个附件 → 触发抽取 → 「检查索引覆盖」的数字**确实变了**（而不是一直显示旧数）；
4. **重启应用**：上述内容仍可读；**不出现**「打不开 / 空白 / 覆盖度变回未知」。

第 4 步是三条线真正的交界：`page_crdt` 的字节要过 IPC、加密库要过重启、覆盖读数要过真实附件。
三条各自的本机单测**都碰不到**这一层 —— 所以这一格只能由真机交读数（`owner`，与 CRDT 冲刺的 S7-3 同一件事）。

## 6. 已知缺口与**不做**的事

- **不做**：把联合验收塞进每次 push 的 CI。它需要真 SM 前缀、会打补丁重建、还要真机 ⇒ 它是**发版窗口**的动
  （与 `docs/RELEASING.md` 的配方同一档）。CI 已有的那一半（j5）继续由 `rust-sm-wired` 门禁常开覆盖。
- **缺口**：`db.rs` 那句派生表「不进同步 / 备份 / 导出」与**整库快照**的实现口径不一致（见 j1）。
  哪个说法对需要拍：要么承认「派生表随包走、导入后可重建」，要么让导出真的排除它们。
- **缺口（2026-09-25 改口径；2026-09-27 有进展）**：j2/j3/j4 三格**不再是"施工单已写、判据没落"** ——
  j3/j4 原来的对象是「**平面开着**」（`VITE_CRDT_PLANE=1`），而那个开关**第 47 轮已经撤出**。
  ⇒ **j3 与 j4 已于 2026-09-27 按新口径落地**（对象分别换成「派生落后 × 覆盖报告的读数」与
  「载荷里的状态 × 真 `applyChange` × 注入的落地实现」，见 §3 下面两节）；
  只剩 **j2** —— 它与开关无关，**仍可照原施工单直接落**。
  前提侧的好消息：CRDT 冲刺的 **S4b-1b**（「收」那一侧）、**S7-1/S7-2**（桌面侧 `page_crdt`）与
  **桌面侧消费 `crdt_state`**（第 43 轮）都已落地；剩下的外部件是**真机双设备验收**（S7-3）。
- ✅ **已做（2026-09-23 第 47 轮）**：上面那条"**磁盘边界平面开关该撤没撤**"已经撤出 ——
  `docContent.ts` 两读一写三处各回一行原样、`plane.ts` 上半段（开关本体）删除、`main.tsx` 那句注册与 import 删掉
  （**下半段**"远端落地注入"保留，它每天在用）。判据逐条交代去向（12 条 → 替换映射）见
  [全上线冲刺](plans/2026-09-23-crdt-full-launch-sprint.md) §16；新护栏在 `src/lib/crdt/plane.withdrawn.test.ts`。
  ⇒ 本文 §5 的 j6 剧本**不再需要** `VITE_CRDT_PLANE=1` 那一步（**§5 已按这条改掉**）；
  剧本第 2 步照常做（CRDT 编辑那条路走的是 `page_crdt` ＋ 载荷状态，与本开关无关）。
  ⚠️ **仍然要记的一条**：三格里 **j3/j4 已按新口径落地**（2026-09-27）、**j2 仍可施工**；
  **真机双设备验收**照旧缺。
- **Web 端**：`platform/web.ts` 用 sql.js，**没有 SQLCipher** ⇒ 国密那一维在 Web 上不存在（j8）。
  把「Web 也绿了」写成联合结论，等于用一半的证据说两倍的话。

## 7. 怎么改这份计划

1. 改 `scripts/lib/joint-planes.mjs`（平面 / 探针 / 格子）；
2. `node -e "import('./scripts/lib/joint-planes.mjs').then(m=>console.log(m.renderDocFacts()))"` 取新块，替换本文档 §2；
3. `npx vitest run scripts/lib/joint-planes.test.mjs`（会自动核对：探针目标存在、格子跨 ≥2 平面、文档逐字一致）。

相关：[测试与门禁](TESTING.md) · [发版 runbook](RELEASING.md) · [国密交付](SM-CRYPTO-DELIVERY.md) ·
[覆盖方案](plans/2026-09-17-knowledge-base-ai-coverage-plan.md) · [CRDT 冲刺](plans/2026-09-23-crdt-full-launch-sprint.md) ·
[CRDT Slice B 施工单](plans/2026-09-23-crdt-slice-b-workorder.md)
