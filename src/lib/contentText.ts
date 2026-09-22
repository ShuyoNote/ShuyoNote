// **正文纯文本的唯一派生实现**（页面表里那个纯文本字段）。
//
// ## 为什么要有这个文件（spike 问题二查出来的真问题）
//
// 应用里原来有**两条**派生：
//   · **编辑器保存路径**：`Editor.tsx` → `editorState.read(() => $getRoot().getTextContent())`（Lexical 自己算）
//   · **AI / PDF 路径**：`src/lib/ai/lexical.ts::contentTextOf`（自己 walk JSON、用**空格**连接）
//
// 实测（`spike/crdt/README.md` §3）：**7 个样本里 4 个两者结果不同**（段落+行内格式、标题+引用、
// 嵌套列表、表格）⇒ **同一份内容 JSON，"谁最后保存"决定了正文文本长什么样**
// ⇒ FTS 命中、反链片段、预览会随路径漂。
//
// ## 处置：以**编辑器那条**为唯一实现
//
// 理由：用户看到的就是编辑器渲染出来的文本（块间换行、列表项各自成行），
// 而"搜索命中/预览片段"应当反映用户看到的东西。⇒ 这里用**同一套 Lexical 语义**派生：
// 建一个探测编辑器（与 `Editor.tsx` 的 `probeEditor` 同套路）解析 JSON，再取 `$getRoot().getTextContent()`。
//
// ⚠️ **不抛**：派生在任何保存路径上都会被调用，脏 JSON 只能退化成"旧算法"或空串，绝不能把保存打断。

import { createEditor, $getRoot, type LexicalEditor } from "lexical";

import { EDITOR_NODES } from "../editor/config";

/** 探测编辑器只建一次（解析与取文本都不需要 DOM）。 */
let probe: LexicalEditor | null = null;

function probeEditor(): LexicalEditor {
  if (!probe) {
    probe = createEditor({
      nodes: EDITOR_NODES,
      namespace: "shuyonote-content-text",
      // 解析失败由 Lexical 路由到这里；**不抛**，由调用方按"空串"处理。
      onError: () => {},
    });
  }
  return probe;
}

/** 老算法（walk JSON、空格连接）。**只作兜底**：Lexical 解析不出来时用它，避免把文本丢成空串。 */
function legacyWalk(docJson: string): string {
  try {
    const parsed = JSON.parse(docJson || "{}");
    const root = parsed?.root && Array.isArray(parsed.root.children) ? parsed.root : { children: [] };
    const out: string[] = [];
    const walk = (n: unknown): void => {
      if (!n || typeof n !== "object") return;
      const node = n as { text?: unknown; children?: unknown };
      if (typeof node.text === "string") out.push(node.text);
      if (Array.isArray(node.children)) node.children.forEach(walk);
    };
    (root.children as unknown[]).forEach(walk);
    return out.join(" ");
  } catch {
    return "";
  }
}

/**
 * 由页面的内容 JSON 派生正文纯文本 —— **全应用唯一实现**。
 *
 * 与编辑器保存路径**同语义**（`$getRoot().getTextContent()`）；解析不了时退化成老算法（不抛）。
 */
export function deriveContentText(docJson: string): string {
  if (!docJson) return "";
  try {
    const editor = probeEditor();
    const state = editor.parseEditorState(docJson);
    if (!state) return legacyWalk(docJson);
    editor.setEditorState(state);
    return editor.getEditorState().read(() => $getRoot().getTextContent());
  } catch {
    return legacyWalk(docJson);
  }
}
