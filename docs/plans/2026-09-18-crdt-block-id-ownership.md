# 块 ID 归属：把 `blockId` 变成**声明的节点属性**（决定：方案 (a)，2026-09-18）

> 上位：[全量 CRDT 冲刺计划](2026-09-18-crdt-full-migration-plan.md) 阶段 2/3 的前置；
> 实测证据：`spike/crdt/README.md` §1.2（阻碍 A）与 §1.5（候选解法实测）、`spike/crdt/a1-output.txt`。
> **人类所有者已拍：选 (a)，开工。**

## 1. 问题（一句话）

今天 `blockId` 不是节点自己的数据，而是 `Editor.tsx::serializeWithBlockIds` 在**序列化时塞进 JSON**
（`rootChildren[i].blockId = id`，240–259 行）。CRDT 绑定只同步**节点模型**（`exportJSON`）
⇒ 实测往返**丢两处**；ID 一丢，块引用 `((blockId))` / 嵌入 `{{blockId}}` / 反链 / AI 块级编辑全断，
而且重存会**重铸新 ID**。

## 2. 形态（已实测，不靠猜）

| 变体 | 做法 | 实测 |
|---|---|---|
| 同 type 子类化内建节点 | `class X extends ParagraphNode { static getType() { return "paragraph" } }` | ❌ 抛 `Type paragraph in node ParagraphNode does not match registered node … with the same type` ⇒ 必须绕开**一切**内建工厂（`$createParagraphNode`、粘贴、markdown 转换器都在用） |
| **新 type + 声明字段**（采用） | `"shuyo-paragraph"`，`__blockId` 进 `exportJSON/importJSON/clone` | ✅ `blockId` **穿过 CRDT 往返**；老 JSON 仍能解析（内置类继续注册）；两类**可共存**（可分批迁移） |

## 3. ⚠️ 由此带出的**兼容性约束**（这条决定怎么落地，别漏）

新 type 一旦落到**持久化/同步的 JSON** 里，**旧版本客户端会静默丢块**：
`src/lib/lexicalValidate.ts` 的 `sanitizeChildren(…, allowedTypes)` 会**丢掉所有未注册类型**
⇒ 混版本期间打开新文档 = 段落全没了。**这比"块 ID 漂移"严重得多。**

⇒ **采用双形态**：

| 面 | 形态 | 理由 |
|---|---|---|
| **编辑器内存模型** ＋ **CRDT 平面** | 新 type（`shuyo-paragraph`），`blockId` 是声明字段 | 绑定才会同步它（§2） |
| **落盘 / 同步 wire / 导出** | **保持今天的形态**（`type: "paragraph"` ＋ `blockId` 字段照旧注入） | 旧版本照常读；Rust 侧 `extract_block_ids` 不用改；导出/markdown 转换器不受影响 |

⇒ 两形态之间的转换是**一层**（本工作单的交付物之一），并且它是**可逆、可测**的纯函数：
`toModelDoc()` / `toLegacyDoc()`，属性测试保证 `toLegacyDoc(toModelDoc(x))` 与今天的输出一致。

## 4. 步骤（每步单独提交，都能本机验证）

| # | 内容 | 判据 | 状态 |
|---|---|---|---|
| **1** | 决策记录（本文件）＋ `src/editor/nodes/BlockParagraphNode.ts`（新 type 段落节点，声明 `__blockId`）＋ `src/lib/blockIdentity.ts`（两形态互转、块 ID 补种）＋ 单测 | `vitest` 新测全绿 ＋ 全量 `vitest` 不回归 ＋ `tsc --noEmit` 干净 | ✅ `7e98945`（12 条判据） |
| **2** | 注册进 `EDITOR_NODES`；加载路径接 `toModelDoc()`、保存路径接 `toLegacyDoc()`（`Editor.tsx` / `ColumnEditor.tsx` / `emailRichNote.ts`） | 内存里是模型 type 且块 ID 稳定；写出去的产物里**一个模型 type 都没有**；全量 `vitest` 不回归 | ✅ 本提交（16 条判据，全量 1095 通过 / 1 跳过） |
| 3 | 让**新建块**也走新 type（粘贴、markdown 导入、HTML 导入、空编辑器首段；Enter 已由 `insertNewAfter` 覆盖） | 三种创建路径各一条用例：新块的块 ID 来自**模型**而不是保存时注入 | ✅ 本提交（5 条判据，全量 1100 通过 / 1 跳过） |
| 4 | 同类推广到其它块级类型（标题/引用/列表/代码/表格 + 18 个自有节点） | 逐类型一个判据；`--update` 收口基线只减不增 | 🟡 **标题已完成**（`5b5de42`）；其余类型待做 |

### 4.2 第 4 步的进度与两个坑

**已完成（内建块级类型全部收口）**：段落 / 标题 / 引用 / 列表 / 代码块 / 水平线 / 表格
（模型 type：`shuyo-paragraph` / `shuyo-heading` / `shuyo-quote` / `shuyo-list` / `shuyo-code` /
`shuyo-horizontalrule` / `shuyo-table`）。

**★ 自有节点走的是另一条更轻的路（2026-09-18 摸清，`callout` 已落地）**：内建类型必须
"新 type + 映射 + 变换"三件套（同 type 子类化内建节点在 0.50 会抛）；而**自有节点的类就是类型** ⇒
只要 ①类里加声明字段（import/export/clone/afterCloneFrom）②`exportJSON` 空 ID 不写字段
③一条 `ensureBlockIdOnTopLevelNode` 变换（只认顶层、只在空 ID 时写，幂等）。
**不需要**新 type / 映射 / `toLegacyDoc` 还原。剩余 17 个自有节点照此办理，其中：
- **装饰型**（`Image/Video/Drawing/Mermaid/WebBookmark/ImageRow` 等）按 §4.2 末条办（不传 `includeChildren`、无 format 系列方法）；
- **行内节点**（`BlockRefNode`/`InlineFormulaNode`/`PageLinkNode`）**本来就不是块级，不给身份**；
- `ColumnsNode`/`ColumnNode` 是容器，需逐类确认它是不是顶层块。


**★ 一个会反复遇到的分叉（新记）**：**ElementNode 与 DecoratorNode 的升级写法不同**。
水平线是 DecoratorNode ⇒ ① 没有 `setFormat/getFormatType/setIndent/setDirection`（tsc 会挡）；
② **`node.replace(replacement, true)` 非法**（`includeChildren should only be true for ElementNodes`，
运行期抛、整个 update 失败、root 变空）。后者编译期不报，是判据抓出来的。
⇒ 推广**装饰型自有节点**（`ImageNode`/`VideoNode`/`DrawingNode`/`MermaidNode`/`WebBookmarkNode`…）时照这条办。


**一条细化（本轮补的，避免落盘形态漂移）**：只有**顶层块**才有块身份 —— 嵌套段落（表格单元格/分栏/
引用里的）**升级类型但不给 ID**，且 `exportJSON` 在 **ID 为空时不写 `blockId` 字段**。
理由：今天的落盘形态只有顶层块带 `blockId`；若嵌套块也带一个空 ID，写出去的 JSON 会多出一片
`"blockId": ""`，"写出去与今天一致"这条承诺就破了（也让 diff 无谓变大）。
判据里有一条专门验它（表格里的嵌套段落类型升级、无 ID、落盘产物里一个 `blockId` 都没有）。

**⚠️ 顺手纠正一个我自己的错误假设**：Lexical 的**列表项会把段落"拆直"**（`listitem` 里直接是文本，
不是段落），所以"拿列表测嵌套段落"其实测不到嵌套 —— 判据已改用**表格单元格**。


**坑 1（本步抓出来的真洞）**：`BlockParagraphNode.insertNewAfter` 原先造的是**空 ID** 的模型段
⇒ "回车新建的块"在 CRDT 平面里仍然没有稳定身份。判据当场抓出，改成**当场铸 ID**。
⇒ **推广时每一类都要问一句：这个类自己造的节点，ID 从哪儿来？**

**坑 2（下一批类型会遇到的雷）**：`SafeCodeNode` 是**同 type**（`"code"`）子类 —— 它今天能用，
只是因为 `src/` 里**没有**任何地方调 `$createCodeNode()`。而**同 type 子类 + 内建工厂**在 0.50 会抛
`Type code in node CodeNode does not match registered node SafeCodeNode`（本工作单 §2 实测过同一现象）。
⇒ 推广代码块时**必须**走"新 type + 映射"这条正路；也请留意将来任何库内变压器（如 `@lexical/markdown`
的内建 code 规则）若开始调内建工厂，就会**当场炸**。

**坑 3（自己的操作事故，记下来）**：用 `Get-Content | Set-Content` 改 `Editor.tsx` 把 UTF-8 读坏了
（中文变乱码）——正是本仓早写明的老坑。处置：`git restore` 还原后改用编辑工具重做，提交前 `git diff` 逐行确认。
**源码改动不要过 PowerShell 文本管道。**


### 4.1 第 3 步的做法与遗留

**做法：用「节点变换」而不是逐个改调用点。** 创建段落的点太散（粘贴 / markdown 导入 / HTML 导入 /
空编辑器首段，还有 Lexical 内部自己造的），逐个改**必漏**；挂在
`editor.registerNodeTransform(ParagraphNode, upgradeParagraphToBlockNode)` 上**一处覆盖全部**
（`src/editor/blockIdTransform.ts`，注册在既有的 `BlockIdPlugin` 里 —— 它本来就是管块身份的）。
变换对模型段**不会反复触发**（模型段 type 是 `shuyo-paragraph`，不在 `paragraph` 名下），函数里另有一道
`getType()` 守卫。

**⚠️ 0.50 的坑（第 4 步推广时会同样踩）**：`ElementNode.getFormat()` 返回的是**数字**（center = 2），
而 `exportJSON().format` / `getFormatType()` 才是字符串 `"center"`。第一版抄了 `getFormat()`
⇒ 对齐样式在升级时**悄悄丢掉**（被判据抓出来才修掉）。另外段落级 `textFormat/textStyle` 在
**有子节点时**会被 `ParagraphNode.exportJSON()` 按第一个文本子节点重算（Lexical #7971 的兼容行为），
只有**空段落**上它才是权威 —— 两条都写进了判据。

**遗留（写清楚）**：

- **模板中心**：`TemplateCenterView` 直接 `createPage({ content_json })` 落库、**不经编辑器** ⇒
  它的块 ID 要等**下次加载**时由 `toModelDoc` 补种。可接受（不是编辑热路径），但 CRDT 开工前要确认
  "新建即同步"的页也有稳定身份；
- **嵌套块**（列表项/引用/分栏里的段落）今天就没有块身份，不在本次范围；
- 其它块级类型（标题/引用/列表/代码/表格与 18 个自有节点）仍是老类型 ⇒ **第 4 步**。



## 5. 不做 / 边界

- **不动 Rust 侧**：`extract_block_ids` 读的还是老形态 JSON（wire/落盘没变）。
- **不动 wire 协议**：本次不引入任何同步字段；CRDT 平面是阶段 2 的事。
- **不做一次性大改**：§4 第 4 步是"逐类型"，中途允许两类共存（已实测可共存）。
- **回滚**：步骤 1/2 都是"多一层转换"，回滚 = 不接那条转换（老形态是默认路径）。

## 6. 第 2 步的**接线点清单**（`grep` 出来的全部，一处都不许漏）

**进**（老形态 → 编辑器状态，接 `toModelDoc(json, newBlockId)`）：

| 位置 | 说明 | 第 2 步做了吗 |
|---|---|---|
| `src/editor/Editor.tsx:156` `parseEditorState()` | **主路径**：页面打开。接在 `lexicalStateValid` **之后**（先按老形态校验/净化，再换模型类型） | ✅ |
| `src/editor/Editor.tsx:83` / `:96` / `:177` | 探测/救回路径：**有意不接** —— 它们只判"能不能解析"，老形态本来就是它们认识的形态 | 不接（有意） |
| `src/components/ColumnEditor.tsx:76` / `:95` | 分栏里的子编辑器（两处：初建 + 父级改动后重放） | ✅ |
| `src/lib/exportMarkdown.ts:89` | **有意不接**：它读落盘形态；把模型 type 送进 markdown 变压器是额外风险 | 不接（有意） |

**出**（编辑器状态 → JSON，接 `toLegacyDoc(json)`）：

| 位置 | 说明 | 第 2 步做了吗 |
|---|---|---|
| `src/editor/Editor.tsx` `serializeWithBlockIds()` | **主路径**：保存。补种逻辑保留（未迁移类型兜底），**最后一步**过 `toLegacyDoc` | ✅ |
| `src/components/ColumnEditor.tsx` `onChange` | 分栏写回父编辑器 | ✅ |
| `src/lib/emailRichNote.ts:122` | 邮件转笔记（产物会写进 `content_json`） | ✅（结构性保险） |

**也要看**（不经编辑器、直接改 JSON 的路径，**必须保持老形态**，别把模型类型漏出去）：

| 位置 | 说明 |
|---|---|
| `src/components/PdfAnnotationCanvas.tsx` / `PdfAskBar.tsx` | 直接 `JSON.parse(content_json)` 改完 `savePage` ⇒ 只要**不**把它们接进 `toModelDoc`，就不会污染落盘形态 |
| `src/lib/ai/lexical.ts`（`appendBlocksToJson` 等） | 同上：按老形态拼 JSON |

**验收（第 2 步做完必须有的三条读数）**：

1. 打开一个老页面 → 内存里段落是 `shuyo-paragraph`、块 ID 与落盘的一致（**不换 ID**）；
2. 保存 → 落盘的 `content_json` 与今天**逐字节一致**（类型还原、`blockId` 位置不变）；
3. 全量 `vitest` 不回归（当前 1094 条）＋ `tsc --noEmit` 干净。
