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

// 清理 Lexical EditorState JSON：去掉空 paragraph / 空 text 等无内容节点，
// 判断一个节点（含其子树）是否有「可见内容」：存在任何非空白 text。
// 纯 linebreak / 纯空白 text 不算内容——用于去掉版式撑出的空白块。
function hasVisibleText(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  const rec = node as Record<string, unknown>;
  if (typeof rec.text === "string" && rec.text.replace(/\s+/g, "").length > 0) return true;
  if (Array.isArray(rec.children)) {
    for (const c of rec.children) if (hasVisibleText(c)) return true;
  }
  if (rec.$slots && typeof rec.$slots === "object") {
    for (const k of Object.keys(rec.$slots as Record<string, unknown>)) {
      if (hasVisibleText((rec.$slots as Record<string, unknown>)[k])) return true;
    }
  }
  return false;
}

// 清理 Lexical EditorState JSON：去掉空段落 / 空 text / 仅换行与空白等无内容节点，
// 避免邮件 HTML 里 `padding` 等版式转成一大片空白块。
function cleanEditorState(node: unknown): unknown {
  if (!node || typeof node !== "object") return node;
  const rec = node as Record<string, unknown>;
  // 递归清理 children / $slots
  if (Array.isArray(rec.children)) {
    const cleaned: unknown[] = [];
    for (const c of rec.children) {
      const cc = cleanEditorState(c);
      // 只有包含可见文字的子节点才保留；纯换行/空白的段落块丢弃。
      if (hasVisibleText(cc)) {
        cleaned.push(cc);
      }
    }
    rec.children = cleaned;
  }
  if (rec.$slots && typeof rec.$slots === "object") {
    const slots = rec.$slots as Record<string, unknown>;
    for (const k of Object.keys(slots)) {
      slots[k] = cleanEditorState(slots[k]);
    }
  }
  return rec;
}

// 把邮件 HTML 里的 `<table>` 版式拆平：去掉 table/tr/td 结构，但保留单元格内文本与内联元素，
// 使表格文本作为普通段落流式显示（避免营销邮件的版式表格变成大空白表格/窄列竖排）。
function flattenTables(html: string): string {
  let out = html;
  // 移除 hr（营销邮件常用作分隔线，转成 Lexical 是一大段间距）。
  out = out.replace(/<hr\b[^>]*>/gi, "");
  // 连续 <br> 压成一个（多余的换行会撑出大空白）。
  const brRun = /(?:\s*<br\s*\/?>\s*){3,}/gi;
  out = out.replace(brRun, "\n");
  // 移除 table 级标签本身，但保留其内部内容。
  out = out.replace(/<\/?(table|tbody|thead|tfoot|tr)[^>]*>/gi, "\n");
  // td/th 之间加换行，保留单元格内容。
  out = out.replace(/<t[dh][^>]*>/gi, "\n");
  out = out.replace(/<\/t[dh]\s*>/gi, "\n");
  // 去掉单元格里的高度撑高占位符（&nbsp; 只在 cell 里）——把仅含 nbsp/空白的 cell 行清掉。
  out = out.replace(/=E3=80=80|&nbsp;|&#160;|\u00a0/g, "\n");
  // 去掉「纯高度占位」的 cell 空行（如 `<td height=5>` 无内容 → 已删标签，只余空行）
  // 及由 nbsp 撑出的行，避免大空白。
  out = out.replace(/\n\s*\n\s*\n+/g, "\n\n");
  // 连续换行压成一个空行（段落分隔）。
  out = out.replace(/\n{3,}/g, "\n\n");
  return out;
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
        $importHtml(flattenTables(html), root);
      },
      { discrete: true },
    );
    const json = cleanEditorState(editor.getEditorState().toJSON());
    const content_json = JSON.stringify(json);
    const content_text = extractPlainText(json);
    return { content_json, content_text };
  } catch (e) {
    // 转换失败时给最小根节点，避免整页失败。
    console.error("[emailHtmlToLexical] 转换失败:", e);
    return { content_json: "{}", content_text: "" };
  }
}
