// 邮箱 HTML → Lexical 富文本 JSON，供「存为笔记」建富文本页面。
// 复用项目里的 $importHtml（editor/htmlToLexical），走一个 headless Lexical editor：
//   - $importHtml 把邮件 HTML 转成真正的 Lexical 节点（段落/加粗/链接/标题/列表/表格等）；
//   - 图片节点保留 src（链接），不下载到本地；
//   - 最终 editor.getEditorState().toJSON() 得到可存进 ShuyoNote 页面的 content_json。
//
// 关键：创建 headless editor 时必须用与页面编辑器**完全相同**的 EDITOR_NODES 集合，
// 这样产出的 JSON 节点类型才落在 ALLOWED_NODE_TYPES 内，页面打开时才不会被
// lexicalStateValid 丢弃（否则会出现「存了但打开空白」）。

import { createEditor, $getRoot } from "lexical";
import { EDITOR_NODES } from "../editor/config";
import { $importHtml } from "../editor/htmlToLexical";

function makeEditor() {
  return createEditor({ nodes: EDITOR_NODES, namespace: "shuyonote-email-import" });
}

/** 从 Lexical EditorState JSON 递归抽取纯文本。 */
function extractPlainText(json: unknown): string {
  const out: string[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const rec = node as Record<string, unknown>;
    if (typeof rec.text === "string") out.push(rec.text);
    if (rec.root && typeof rec.root === "object") walk(rec.root);
    if (Array.isArray(rec.children)) for (const c of rec.children) walk(c);
    if (rec.$slots && typeof rec.$slots === "object")
      for (const k of Object.keys(rec.$slots as Record<string, unknown>))
        walk((rec.$slots as Record<string, unknown>)[k]);
  };
  walk(json);
  return out.join("\n");
}

/**
 * 把邮件 HTML 转成 Lexical 富文本 JSON 字符串 + 纯文本。
 * @returns { content_json, content_text }（JSON 为字符串，纯文本用于搜索/FTS）
 */
export function emailHtmlToLexical(html: string): { content_json: string; content_text: string } {
  if (!html.trim()) {
    return { content_json: "{}", content_text: "" };
  }
  const editor = makeEditor();
  try {
    editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        $importHtml(html, root);
      },
      { discrete: true },
    );
    const json = editor.getEditorState().toJSON();
    const content_json = JSON.stringify(json);
    const content_text = extractPlainText(json);
    return { content_json, content_text };
  } catch (e) {
    // 转换失败时给最小根节点，避免整页失败。
    console.error("[emailHtmlToLexical] 转换失败:", e);
    return { content_json: "{}", content_text: "" };
  }
}
