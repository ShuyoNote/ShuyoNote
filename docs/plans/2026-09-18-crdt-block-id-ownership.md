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

| # | 内容 | 判据 |
|---|---|---|
| **1（本次）** | 决策记录（本文件）＋ `src/editor/nodes/BlockParagraphNode.ts`（新 type 段落节点，声明 `__blockId`）＋ `src/lib/blockIdentity.ts`（两形态互转、块 ID 补种）＋ 单测 | `vitest` 新测全绿 ＋ 全量 `vitest` 不回归 ＋ `tsc --noEmit` 干净 |
| 2 | 把 `BlockParagraphNode` 注册进 `EDITOR_NODES`，并在**加载路径**接上 `toModelDoc()`；保存路径接 `toLegacyDoc()` | 打开老页面 → 内存里是新 type 且块 ID 稳定；保存后**落盘仍是老形态**（与今天逐字节一致） |
| 3 | 让**新建块**也走新 type（Enter 分行、粘贴、markdown 导入、模板中心…） | 三种创建路径各一条用例：新块的块 ID 来自**模型**而不是保存时注入 |
| 4 | 同类推广到其它块级类型（标题/引用/列表/代码/表格 + 18 个自有节点） | 逐类型一个判据；`--update` 收口基线只减不增 |

## 5. 不做 / 边界

- **不动 Rust 侧**：`extract_block_ids` 读的还是老形态 JSON（wire/落盘没变）。
- **不动 wire 协议**：本次不引入任何同步字段；CRDT 平面是阶段 2 的事。
- **不做一次性大改**：§4 第 4 步是"逐类型"，中途允许两类共存（已实测可共存）。
- **回滚**：步骤 1/2 都是"多一层转换"，回滚 = 不接那条转换（老形态是默认路径）。

## 6. 第 2 步的**接线点清单**（`grep` 出来的全部，一处都不许漏）

**进**（老形态 → 编辑器状态，前面接 `toModelDoc(json, newBlockId)`）：

| 位置 | 说明 |
|---|---|
| `src/editor/Editor.tsx:156` `parseEditorState()` | **主路径**：页面打开。后面已有 `lexicalStateValid` 归一，`toModelDoc` 接在它**之前**（先换类型再校验签名） |
| `src/editor/Editor.tsx:177` | 同一函数里的 `probeEditor.parseEditorState` |
| `src/editor/Editor.tsx:83` / `:96` | 另一个探测助手（看内容能不能解析） |
| `src/editor/Editor.tsx:410` | `editorState:` 初值（用上面那个函数，通常自动覆盖） |
| `src/components/ColumnEditor.tsx:76` / `:95` | 分栏里的子编辑器 |
| `src/lib/exportMarkdown.ts:89` | 导出 Markdown 前建的临时编辑器 |

**出**（编辑器状态 → JSON，后面接 `toLegacyDoc(json)`）：

| 位置 | 说明 |
|---|---|
| `src/editor/Editor.tsx:240` `serializeWithBlockIds()` | **主路径**：保存。`toJSON()` 已经带上模型里的 `blockId`；补种逻辑保留（给未迁移类型兜底），**最后一步**过 `toLegacyDoc` |
| `src/components/ColumnEditor.tsx:104` | 分栏保存 |
| `src/lib/emailRichNote.ts:122` | 邮件转笔记（产物会写进 `content_json`） |

**也要看**（不经编辑器、直接改 JSON 的路径，**必须保持老形态**，别把模型类型漏出去）：

| 位置 | 说明 |
|---|---|
| `src/components/PdfAnnotationCanvas.tsx` / `PdfAskBar.tsx` | 直接 `JSON.parse(content_json)` 改完 `savePage` ⇒ 只要**不**把它们接进 `toModelDoc`，就不会污染落盘形态 |
| `src/lib/ai/lexical.ts`（`appendBlocksToJson` 等） | 同上：按老形态拼 JSON |

**验收（第 2 步做完必须有的三条读数）**：

1. 打开一个老页面 → 内存里段落是 `shuyo-paragraph`、块 ID 与落盘的一致（**不换 ID**）；
2. 保存 → 落盘的 `content_json` 与今天**逐字节一致**（类型还原、`blockId` 位置不变）；
3. 全量 `vitest` 不回归（当前 1094 条）＋ `tsc --noEmit` 干净。
