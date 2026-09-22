# CRDT 尖刺（阶段 0 第 3 项）：问题一/二/三的读数与阻碍 —— **从 `spike/crdt` 分支归档**

> 归档说明（2026-09-22，Windows 侧）。本文原为 `spike/crdt/README.md`，**逐字**搬来当档案。那条尖刺线
> 共 **10 笔**只存在于 `spike/crdt`（tip `71a3e1db`），**不属于**要并进 dev 的交付 —— 阶段 1（块级 LWW）
> 已经从它的结论里提炼并落地（见 `2026-09-22-block-rev-write-layer.md`）。owner 2026-09-22 拍板：
> **结论归档成这份文档、分支 ref 删掉**。
>
> 原始探针脚本**未随本文归档**（都是 `spike/crdt/` 下的文件，需要时按 sha 取回）：
> `q1-roundtrip.mjs`、`q1-output.txt`、`stage-b-static-audit.mjs`、`stage-b-app-nodes.mjs`、
> `stage-b-audit-output.txt`、`a1-blockid-declared-prop.mjs`、`a1-output.txt`、`q3-e2ee-snapshot.mjs`、
> `q3-output.txt`、`package.json`、`package-lock.json`
>
> ```bash
> git show <sha>:spike/crdt/<file>     # 例：git show 71a3e1db:spike/crdt/q1-roundtrip.mjs
> ```
>
> 10 笔（新→旧）：`71a3e1db` · `fe2d0ba3` · `65a1bf2e` · `c38f07f2` · `638455cf` · `965cc0fb` ·
> `073c3bfa` · `2f741b31` · `2600f577` · `eba77365`
>
> ⚠️ **边界（如实）**：删掉 ref 之后，这些对象会在 git 清理不可达对象时消失（默认两周）。本文保留的是
> **结论本体**（读数、阻碍、边界、对计划的判断），所以那段窗口过后仍读得到"当时测出了什么"，
> 只是取不回可以直接跑的探针脚本。

---
# CRDT spike（阶段 0 第 3 项）

> 上位：[全量 CRDT 冲刺计划](../../docs/plans/2026-09-18-crdt-full-migration-plan.md) §3 阶段 0；
> 施工单：[CRDT spike 施工单](../../docs/plans/2026-09-18-crdt-spike-workorder.md)。
> **本目录只回答三问，不产出可合并代码**；依赖**钉死**（`package.json` 里无 `^`），否则"当时能跑"无法复现。

## 0. 怎么跑

```bash
cd spike/crdt
npm install          # 独立 node_modules，**不进应用依赖图**
node q1-roundtrip.mjs          # 问题一；加 --verbose 看逐条差异
```

## 1. 问题一：`content_json` ⇄ `ydoc` 双向转换可靠吗？

**答：官方节点范围内**逐字段保真**（含表格/嵌套列表/代码块/链接）；但复现出**两条必须先改掉的前置阻碍**，
以及三条必须在迁移前处理的边界。**

环境（实测）：headless Lexical **0.50.0** ＋ `@lexical/yjs` **0.50.0** ＋ yjs **13.6.32**，
Node 22.15，Windows。注册节点 11 类：`heading/quote/list/listitem/code/code-highlight/link/autolink/table/tablerow/tablecell`。
读数：**11 通过 / 0 失败**（`q1-output.txt` 是原始输出）。

### 1.1 保真读数

| 样本 | JSON B | ydoc B | 保真 |
|---|---:|---:|---|
| 段落+行内格式（粗/斜/行内代码） | 585 | 353 | ✅ |
| 标题+引用 | 464 | 102 | ✅ |
| 嵌套列表（bullet 套 number） | 1189 | 335 | ✅ |
| 表格 2×2（含表头） | 1405 | 286 | ✅ |
| 代码块（带 language） | 295 | 88 | ✅ |
| 链接（url 带 query+fragment） | 455 | 114 | ✅ |
| 空页面（一个空段落） | 178 | 72 | ✅（只有序列化噪音） |
| 空文档（**真空 root**） | 90 | — | 抛错（预期，见 1.3①） |
| `"{}"`（**应用默认值**） | 2 | — | 抛错（预期，见 1.3①） |
| 未注册节点类型 | 363 | — | 抛错（预期，见 1.3②） |

**顺带两条有用的读数**：ydoc 状态**比 Lexical JSON 小**（表格 286 B vs 1405 B）；
**改 1 个字的增量 update = 129 B**（整份 ydoc 333 B、整份 JSON 585 B）——
最后这条是 CRDT 相对"页级 LWW 推整页"的**真实收益**（且不随页面变大而变大）。

### 1.2 ★ 阻碍 A：`blockId` 会被 CRDT 绑定丢掉（**块引用/backlinks/AI 块编辑会断**）

证据链（三段都是代码/实测，不是推测）：

1. **应用怎么存块 ID**：`src/editor/Editor.tsx::serializeWithBlockIds` 在**序列化时**往每个顶层块的
   JSON 里塞一个 `blockId`（`rootChildren[i].blockId = id`，见该文件 240–259 行），
   并按 Lexical node key 记忆，用于跨"重排/复制粘贴"保持块身份；
2. **谁在读它**：`src-tauri/src/blocks.rs::extract_block_ids` 读 `child.get("blockId")` 建 `blocks` 表，
   块引用 `((blockId))`、`{{blockId}}` 嵌入、反向链接、AI 的块级编辑全部依赖这个 ID；
3. **绑定会丢它**：`@lexical/yjs` 同步的是**节点属性**（走各类的 `exportJSON`）。`blockId` **不是**
   任何节点类的属性（`ParagraphNode`/`HeadingNode` 都没有它）⇒ 往返实测**丢两处**：
   `$.root.children[0].blockId`、`$.root.children[1].blockId`。

**后果（按今天的设计推演）**：ydoc → editor state 后块 ID 消失；再次保存时
`serializeWithBlockIds` 的 map 是**空的**（新 editor state 的 node key 全不同）⇒ **会重新铸一批新 ID**
⇒ 块引用/嵌入/反向链接指向**已不存在的 ID**、AI 的块级编辑落空。

⇒ **阶段 2/3（Yjs body）开工前必须先解决它**，三条候选（择一，需要拍）：
(a) 把块 ID 变成**声明的节点属性**（自定义 BlockId 混入/包装节点，`exportJSON` 带上它）——
最贴 Lexical 模型，但要动所有块级节点类；
(b) 让 CRDT 侧**另开一条通道**（Y.Map: nodeKey → blockId）并保证与结构变更一致——不动节点类，
但要自己维护一致性；
(c) 用**确定性 ID**（如由内容+位置派生）——最省事，但与"跨重排保持身份"的目标冲突。

### 1.3 ★ 阻碍 B：**任何不在节点 `exportJSON` 里的字段都会被丢**（通用形态）

同一实验的通用化（`非节点属性一律丢`）：段落上的 `shuyoBlockId`/`shuyoPrivateOnParagraph`、
链接上的 `shuyoPrivateFlag` **全丢**；而链接**自己的**属性 `url`/`rel`/`target` **没丢**。
⇒ 结论：**绑定同步的是"节点模型"，不是"JSON 里有什么"**。
迁移前必须把"我们塞进 `content_json` 的所有非模型字段"列成清单（`blockId` 是已确认的一个），逐个决定走 (a)/(b)。

### 1.4 三条边界（必须处理，但**不是**缺陷）

| # | 现象 | 含义 / 处置 |
|---|---|---|
| ① | 真空 root **parse 就抛**（`the editor state is empty`）；`"{}"`（**应用的 `content_json` 默认值**）抛 `Cannot read properties of undefined (reading 'type')` | **不是线上 bug**：应用已有 `src/lib/lexicalValidate.ts`（该文件 78–79 行明确写着"无 root 或无内容(如 `"{}"`)：视为合法空页"）＋`Editor.tsx::parseEditorState` 把空 root 归一成"空页"⇒ **yjs 路必须复用这一层归一**，不能绕过它直接 parse。空页在 Lexical 里的规范形态是**一个空段落**（往返保真 ✅） |
| ② | 未注册节点类型 ⇒ **硬报错**（`type "image" + not found`），**不是静默丢** | 这是**更好**的失败模式（静默丢才危险）。含义：**所有节点类型必须注册**；**旧客户端遇到新节点会解析失败** ⇒ 混版本同步（灰度期！）需要降级策略（未知节点 → 占位块），这与方案 §3 阶段 2 的"灰度一个发布周期"直接冲突，必须一起设计 |
| ③ | 往返后多出 `textFormat: 0`/`textStyle: ""`、`version` 变化 | **序列化噪音**（Lexical 按节点类写默认值/最新版本号）。harness 已把差异分成 `丢了/变了/噪音` 三类，只有"丢/变"判失败 —— 别让默认值注入掩盖真差异 |

### 1.5 ★ 阻碍 A 的**候选解法实测**（`a1-blockid-declared-prop.mjs`，4 通过 / 0 失败）

要让 `blockId` 穿过绑定，直觉上最省事的是"把内建 `ParagraphNode` 子类化、加一个声明字段"。
**跑出来这条路在 Lexical 0.50 上不可行**：

| 变体 | 做法 | 实测结果 |
|---|---|---|
| 1 | 子类化内建 `ParagraphNode`（**同 type** `"paragraph"`） | ❌ 抛 `Create node: Type paragraph in node ParagraphNode does not match registered node … with the same type` ⇒ 要绕开**一切内建工厂**（`$createParagraphNode`、粘贴、markdown 转换器都在用），不可行 |
| 2 | **应用自有的块级节点类型**（新 type `"shuyo-paragraph"`）＋ `blockId` 当声明字段 | ✅ **`blockId` 穿过 CRDT 往返**（`["blk-1","blk-2"]` 原样回来） |

变体 2 的两个附带读数（决定迁移怎么做）：

- **老 JSON（`type: "paragraph"`）仍能解析**（内置类继续注册着）—— 但它的 `blockId` **确实会丢**
  ⇒ 方案必须配一步「**老内容类型映射**」（加载时把老 type 换成新 type，块 ID 才不丢）；
- **两类段落可以共存**（`["shuyo-paragraph","paragraph"]`）⇒ 迁移**可以分批**，不必一次性全换。

⇒ 因此 §6 第 1 条的"块 ID 归属"里，**(a) 的可行形态是"新 type 的自有块级节点 + 加载时类型映射"**，
不是"子类化内建节点"；代价是三步：① 造块级自有节点（段落/标题/引用/列表/表格…）
② 加载时映射老类型 ③ 各导出/markdown 转换器按新 type 适配。
（原始输出见 `a1-output.txt`。）

## 2. 覆盖边界（**没测什么**，结论不能外推）

- **节点类型**：行为级往返只覆盖 11 类官方节点。应用私有的 20+ 个自定义节点**没有做行为级往返**
  （见 §2.1 的静态审计与 §2.2 的 Stage B 尝试记录）。
- **协作语义**：未测两客户端并发编辑/收敛、undo/redo、awareness、离线重连。
- **加密**（问题三）、**下游等价**（问题二）见 §3。

### 2.1 自定义节点：**静态审计 18/18 全绿**（阻碍 B 的风险面因此被收窄）

`node stage-b-static-audit.mjs`：对 `src/editor/nodes/` 下每个节点类，比对
「`__` 私有字段」与「`exportJSON` / `clone` 里是否都写了」：

| 结果 | 值 |
|---|---|
| 节点类文件 | **18**（另 2 个文件不是节点：`exportDom.test.ts`、`MediaResolver.tsx`） |
| `exportJSON` **漏字段**的 | **0** |
| `clone` 漏字段的 | **0** |
| 有 `importJSON` 的 | **18 / 18** |

⇒ 结论：**自定义节点的字段都在节点模型里**（`ImageNode` 7 个、`DrawingNode` 10 个、`AttachmentRef` 6 个…），
绑定会同步它们。**阻碍 B 的风险面不是自定义节点，而是"后注入进 JSON 的字段"** ——
`blockId` 是已确认的一处（§1.2）；检索 `src/` 未发现第二处注入点，但这类注入**结构上无法被静态审计穷尽**。

### 2.2 Stage B 尝试记录（**没成功，留在案**）

`stage-b-app-nodes.mjs`：用 esbuild 把应用**自己的** `src/editor/config.ts`（含 20+ 自定义节点）打成
可被 Node 加载的 ESM。**打包成功**（18.8 MB，需要两个插件：vite 的 `?url` 桩 + **在解析阶段**截住
`.css/.svg/...`——`import "@excalidraw/excalidraw/index.css"` 会**解析失败**，而 esbuild 的 `loader` 只在解析成功后才生效），
但 **Node `import()` 时挂住**（`Detected unsettled top-level await`；bundle 里有大量 `await init_LexicalXxx_node()`，
属 esbuild 对 Lexical 双入口包的包装）。

⇒ 本次**没有**拿到"用应用真节点集做往返"的行为级结论；脚本留在目录里供后人继续
（可行方向：把 `@excalidraw/mermaid/katex/prismjs` 等**只被 decorate 用**的重依赖在解析阶段桩掉，
让节点类本身能轻量加载 —— headless 往返根本不调 `decorate`）。

## 3. 问题二（第一切片）：正文文本派生**在往返前后稳定**，但**应用里有两条派生实现**

问的是：换成"合并后的状态"当唯一真相之后，从内容派生出来的东西还重建得出来吗？
本切片只覆盖**正文文本**（`content_text` —— FTS、反链、预览、AI 上下文的共同输入）。

> ✅ **Rust 侧那三个下游已实测（2026-09-20，Windows）** —— 原来这里写的是"要那边验（Windows 跑不了
> `cargo test`）"，两半都过时了：
> · **Windows 跑得了**：`scripts/win-cargo-test.ps1`（注入 v6 清单绕开 `0xC0000139`，见 `docs/TESTING.md`
>   的三种形态表）；
> · **已经跑了**：分支 `test/crdt-legacy-input-rust @ 5bbcdd01`，把一份**落盘形态**的 JSON
>   （顶层 6 块带 `blockId`、含块引用/块嵌入/表格/列表/代码块、一个嵌套块）**真喂进**
>   `upsert_blocks` / `rebuild_block_graph` / `sync_fts`（真建库：`open_in_memory` + `db::migrate`）：
>   **3 passed** —— ① 只索引顶层 id（嵌套那个**不在**，块表 6 行）② 块级反链记下 link＋embed 两条
>   且**重建幂等** ③ `page_fts` 有且只有一行。
> · **承重证明**：把 `extract_block_ids` 临时改成"连嵌套块的 id 也收" ⇒ 判据① **红**（读数 7≠6）
>   ⇒ 这几条判据真的在守那件事，不是同义反复。
> · ⇒ AMD 在 `crdt-spike-q2-second-slice.reply-1` §一-② 钉下的**输入前提**（模型形态过 `toLegacyDoc`
>   ⇒ id 在顶层、`type` 回老形态）**成立，且下游正常** —— 这条下游面到此闭环。

跑法：`node q1-roundtrip.mjs` 的最后一段（先用 esbuild 把**应用的** `src/lib/ai/lexical.ts`
打成临时 ESM —— 它零依赖，所以这一步很轻）。

| 样本 | Lexical `getTextContent()` | `contentTextOf` | 两条派生一致？ |
|---|---|---|---|
| 段落+行内格式 | ✅ 往返前后稳定 | ✅ 稳定 | ⚠️ **不一致** |
| 标题+引用 | ✅ | ✅ | ⚠️ **不一致** |
| 嵌套列表 | ✅ | ✅ | ⚠️ **不一致** |
| 表格 2×2 | ✅ | ✅ | ⚠️ **不一致** |
| 代码块 | ✅ | ✅ | ✅ |
| 链接 | ✅ | ✅ | ✅ |
| 空页面 | ✅ | ✅ | ✅ |

**结论一（好消息）**：正文文本**可从合并后的状态稳定重建** —— 派生索引"可重建"这条假设成立。

**结论二（顺手查出来的真问题）**：应用里正文文本有**两个派生实现**，且**7 个样本里 4 个结果不同**：

- 编辑器保存路径：`src/editor/Editor.tsx:420` → `_editorState.read(() => $getRoot().getTextContent())`（Lexical 自己算，块间默认换行）；
- AI / PDF 路径：`src/lib/ai/lexical.ts::contentTextOf`（自己 walk JSON、用**空格**连接）。

⇒ **同一份 `content_json`，谁最后保存决定了 `content_text` 长什么样** ⇒ FTS 命中、反链片段、预览都会随路径漂。
换 CRDT 后**必须只留一个 derive 实现**（正是冲刺计划 §4 规则 1/2 说的"派生只能从 derive 出"）——
这条以前只是纪律，现在有**读数**了。

> ✅ **已在应用侧修掉（2026-09-18）**：新增 `src/lib/contentText.ts::deriveContentText` 作为**唯一实现**
> （建一个探测编辑器、取 Lexical 的 `$getRoot().getTextContent()`，与编辑器保存路径**同语义**；
> 解析不了时退化成老算法、**不抛**）；`src/lib/ai/lexical.ts::contentTextOf` 改为**委托**它
> ⇒ AI/PDF 那几个调用点一次性统一。判据 `src/lib/contentText.test.ts` 11 条
> （逐类断言"与编辑器路径逐字相同"＋脏输入不抛）。**本 spike 的读数因此变成历史记录**，
> 但它记录的"两条实现会漂"这件事值得留着。

### 3.1 问题二（**第二切片**）：Markdown 导出在往返前后等价 —— 但**官方导出器看不出阻碍**

`node q1-roundtrip.mjs` 的最后一段（新增）。问的是："换成合并后状态当唯一真相之后，**导出**还等价吗？"

**先给一条方法论结论（它决定了这一片该测多少）**：
导出是"内容 JSON 的**纯函数**" ⇒ 「往返后再导出」== 「原样导出」**当且仅当往返没丢东西**；
而"丢了什么"§1 已经逐样本量出来了（`lost` 清单）。⇒ 这一片的作用是**抽一个真实导出器把这条推理验一遍**，
**不是**把所有导出器逐个再测一遍。

| 样本 | 导出（官方 transformer 集）在往返前后 |
|---|---|
| 段落+行内格式 / 标题+引用 / 嵌套列表 / 表格 2x2 / 代码块 / 链接 / 空页面 | ✅ 7 条**全部一致** |

**★ 最有用的一条读数**：把 §1.2 那两条**确实丢 `blockId`** 的样本也过一遍导出 ⇒
`丢 2 处 · 导出 ✅ 看不出差别`、`丢 3 处 · 导出 ✅ 看不出差别`。
原因是**官方 transformer 的语法里没有块引用**。

> ★★ **我随后写下的推论被证伪了 —— 如实记这里（AMD，`feat/md-export-blockid-criteria @27bb6021`）**：
> 我当时写的是"应用自己那套 `SHUYONOTE_TRANSFORMERS` 认 `((blockId))` / 块嵌入 ⇒ **它一定会受影响**"。
> AMD 在**应用侧**做了两条判据（把序列化里**所有 `blockId` 字段抹掉**，再走应用自己的导出器）：
> **导出结果逐字节相同（差异：无）** —— 块引用与块嵌入都还在。
>
> **为什么不受影响（关键，值得记住）**：
> · `BlockRefNode` 的 id 存在**节点文本**里（文本本身就是 `((id))`）⇒ 不依赖字段；
> · `BlockEmbedNode` 的**目标**序列化成 `targetId`（它**自己的身份**字段才叫 `blockId`，而导出器不读那个）。
> ⇒ 这两个**下游不依赖被丢的那个字段**。
>
> ⇒ 正确的表述是：**"块 ID 被绑定丢掉"的受影响面不在导出，要另找** ——
> 例如依赖块身份做**跳转 / 反链 / `blocks` 派生表 / AI 块级编辑**的那些地方（那才是 §1.2 阻碍的后果面）。
> 这条教训与 §4 里那两条"被证伪的猜想"同一个性质：**猜测必须写成可证伪的断言，被证伪就照实记，别悄悄删**。

⇒ 这一片的价值因此变成两条：① 官方语法下导出等价（实测 7/7）；② **"下游会不会受影响"不能用推理代替实测** ——
我推理错了，AMD 的实测把它纠正了。


**HTML/百科导出**（`wikiExport.ts::renderWikiBody`）的输入是 `content_text`，
所以它**由 §3 第一切片蕴含**（派生稳 ⇒ 导出稳），本片没有单独测 —— 不写成"已测"。

**⚠️ 两版弯路（都是"两个 lexical 实例"，报错却长得像"导出不等价"）** ——
`Unable to find an active editor state … 0 compatible editor(s)`：
① 为了"少一个依赖"去 bundle **应用**那份 `@lexical/markdown` ⇒ bundle 里带上第二份 `lexical`；
② 改成 bundle **spike 自己**这份 ⇒ 仍然两个实例：esbuild 按 `platform: node` 选 `exports.import.node`，
   而脚本运行时 `import "lexical"` 选 `exports.import.default`。
⇒ **同一份依赖要么都走 bundler、要么都走运行时解析，别混**。
正解：把 `@lexical/markdown` 按 `0.50.0` 钉进本目录 `package.json`，与其它依赖一样**直连 import**。


## 4. 问题三：E2EE 之下 CRDT 可行 —— **服务端可以继续"哑且盲"**（13 通过 / 0 失败）

`node q3-e2ee-snapshot.mjs`。全部在 Node 里跑：真 `yjs` ＋ 真 `@lexical/yjs` 绑定 ＋
`node:crypto` 的 **AES-256-GCM 代指**产品的内容层加密（真品是 SM4/AES-GCM 那一层；
这里验的是**协议**：谁在什么时机加密、快照如何替代历史）。

| 场景 | 结果 |
|---|---|
| 一、服务端只做"追加不透明 blob"，客户端**乱序 + 重复**投递 | ✅ 三台设备收敛（CRDT 幂等 + 交换律）；两边编辑都在，**没有 LWW 覆盖** |
| 二、客户端产**加密快照** → 服务端丢掉全部旧 blob → **新设备**只用"快照 + 之后的增量" | ✅ 收敛；服务端占用 249 B → 175 B |
| 三、★ **离线设备**（旧状态 + **自己没推的编辑**）在服务端**回收之后**回来 | ✅ 收敛、**它自己的编辑没丢**、A 在它离线期间的编辑也在 |

**结论（对产品架构的意义）**：服务端**不需要**理解内容、也不需要实现 CRDT 的合并逻辑 ——
它只是"**追加不透明 blob + 按游标发回**"，再加一个**客户端产快照替换历史**的动作。
E2EE 与 CRDT **不冲突**：加密发生在客户端，快照也在客户端算。

**体积读数**（同步预算要用）：单条增量 明文 ~112 B → **密文 140 B**（+28 B = GCM 的 iv+tag）；
整份快照 522 → 550 B。⚠️ 走 JSON 传输时 **base64 会再放大 ~1/3**（192 B 而不是 140 B），
要么在协议里把 blob 变成二进制字段，要么把这部分算进同步预算。

**两条被证伪的猜想（如实记下）**：
1. 我以为"两台设备各自先建根、之后才合并"会丢内容 —— 实测**没丢**（两个根被 Yjs 合并了）；
2. 我以为"对空文档做一次同步会写回一个占位空段落" —— 实测**没有**（字节数不变、投影里 0 个段落）。
⇒ 两条都**不作为结论**；空页归一仍要**应用自己**负责（见 §1.4①）。

**还没做的（要那边验，Windows 跑不了 `cargo test`）**：服务端接口改动（快照替换/截断、配额与限流语义）、
真机多设备并发（真网络、真重连、真时钟）、awareness/光标的加密策略。

## 5. 还没做的

| 问题 | 状态 |
|---|---|
| 一、JSON ⇄ ydoc | ✅ 行为级（官方 11 类）＋ 静态审计（自定义 18 类） |
| 二、下游等价 | ✅ 正文文本（§3）＋ **Markdown 导出**（§3.1：官方 transformer 集 7/7 一致）；<br>✅ **应用自己的** `SHUYONOTE_TRANSFORMERS` 导出：**实测不受 `blockId` 丢失影响**（AMD `27bb6021`，见 §3.1 的"被证伪"框）；<br>✅ **块表 / 块图 / FTS**：已实测（Windows，`test/crdt-legacy-input-rust @ 5bbcdd01`：3 passed ＋ 一条承重变异，见 §3 顶上那个框）；HTML/百科导出由 §3 蕴含（输入就是 `content_text`），未单独测 |
| 三、E2EE 加密快照 / GC | ✅ 第一切片（协议可行性 + 体积读数）；服务端接口改动与真机多设备未做 |

## 6. 对冲刺计划的判断（据问题一、二、三）

1. **阶段 2/3 不能直接开工**：先解 §1.2/§1.3（块 ID 与非模型字段的归属）——否则"换成 CRDT"会把
   块引用体系打碎，而那是本产品与"普通 Markdown 编辑器"的差别所在；
2. **空页归一必须在 yjs 路上复用应用既有的 `lexicalStateValid`**（§1.4①）；
3. **混版本降级策略要进阶段 2 的设计**（§1.4②），不是实现细节；
4. **派生文本必须先合一**（§3 结论二）——这条以前是纪律，现在有读数：**7 个样本里 4 个不一致**；
5. **服务端侧只有一处要改**（§4）：加"客户端产快照替换历史"的接口 + 相应配额语义；
   合并逻辑**一行都不用写**（今天服务端还要做 LWW 的序号分发，将来更简单）；
6. 收益已量化：**增量 129 B/字**（问题一）、**密文 140 B/条**（问题三）、ydoc 比 JSON 更小
   ——"同页并发"这条商业叙事有了数字。

---

## 附录：Stage B 探针里**未提交**的那 17 行（2026-09-22 归档时抢救进来）

归档时发现 `ShuyoNote-spike` 工作树里 `spike/crdt/stage-b-app-nodes.mjs` 有一处**从未提交**的改动。
它是结论形状的（"到底是不是根因"的实测与两条反例），所以逐字抄在这里，随工作树一起清掉时不会丢：

```js
    // ⚠️ **只被 `decorate()` 用的渲染器依赖，也在解析阶段换成空模块**。
    // 它们体积巨大（excalidraw / mermaid / katex / prismjs / tesseract）且与"节点模型"无关；
    // headless 往返**不会**调 `decorate`。第一版没桩掉它们，18.8 MB 的 bundle 在 Node `import()` 时挂住 ——
    // 这里就是把那次失败的前提换掉，看它是不是根因。
    // ⚠️ **只桩掉"确实要 DOM/体积巨大"的那几个**：`prismjs` 与 `katex` 的模块级代码是纯 JS
    //    （不需要 DOM），桩掉反而会炸 —— 实测把 `prismjs` 也桩了之后，`@lexical/code-prism` 里
    //    那句 `(Prism)` 直接 `ReferenceError: Prism is not defined`。
    const RENDERER_ONLY = /^(@excalidraw\/excalidraw|mermaid|tesseract\.js|pdfjs-dist)(\/.*)?$/;
    build.onResolve({ filter: RENDERER_ONLY }, (args) => ({ path: args.path, namespace: "stub-renderer" }));
    build.onLoad({ filter: /.*/, namespace: "stub-renderer" }, () => ({
      // ⚠️ 必须写成 **CJS**（`module.exports = …`）：esbuild 对 ESM 会**静态校验命名导出**，
      // 用 `export default new Proxy(...)` 会被 "No matching export ... for import "Excalidraw"" 挡下（实测）。
      // CJS 则把 `import { X }` 当作默认导出上的属性访问，任意命名都能过。
      contents: "module.exports = new Proxy({}, { get: () => () => ({}) });",
      loader: "js",
    }));
```

⚠️ 但**结论本身没写在这段代码里**（当时忙在"换掉前提看是不是根因"）：`README.md` §2.2 记的仍是
"打包应用的 `config.ts` 成功、Node 加载挂住，如实留案"。⇒ 这条附录只保住**手法与两条反例**，
"桩掉渲染器依赖之后到底还挂不挂"**没有复跑读数**，不要当成已结论。

