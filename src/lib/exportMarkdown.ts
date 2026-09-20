import { createEditor, $getRoot, $createParagraphNode, $createTextNode } from "lexical";
import { $convertToMarkdownString } from "@lexical/markdown";
import { platform } from "./platform";
import { api } from "./api";
import { SHUYONOTE_TRANSFORMERS } from "../editor/markdownTransformers";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import { ListNode, ListItemNode } from "@lexical/list";
import { CodeNode, CodeHighlightNode } from "@lexical/code";
import { LinkNode } from "@lexical/link";
import { HorizontalRuleNode } from "@lexical/react/LexicalHorizontalRuleNode";
import { TableNode, TableCellNode, TableRowNode } from "@lexical/table";
import { CalloutNode } from "../editor/nodes/CalloutNode";
import { ColumnsBlockNode, $isColumnsBlockNode } from "../editor/nodes/ColumnsBlockNode";
import { ImageNode } from "../editor/nodes/ImageNode";
import { ImageRowNode } from "../editor/nodes/ImageRowNode";
import { VideoNode } from "../editor/nodes/VideoNode";
import { BlockRefNode } from "../editor/nodes/BlockRefNode";
import { BlockEmbedNode } from "../editor/nodes/BlockEmbedNode";
import { AttachmentRefNode } from "../editor/nodes/AttachmentRefNode";
import { DrawingNode } from "../editor/nodes/DrawingNode";
import { MermaidNode } from "../editor/nodes/MermaidNode";

const NODES = [
  HeadingNode,
  QuoteNode,
  ListNode,
  ListItemNode,
  CodeNode,
  CodeHighlightNode,
  LinkNode,
  CalloutNode,
  HorizontalRuleNode,
  ColumnsBlockNode,
  ImageNode,
  ImageRowNode,
  VideoNode,
  BlockRefNode,
  BlockEmbedNode,
  AttachmentRefNode,
  DrawingNode,
  MermaidNode,
  TableNode,
  TableCellNode,
  TableRowNode,
];

function sanitizeName(name: string): string {
  // Strips characters invalid on Windows/macOS paths; keeps CJK & starts safe.
  let s = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  s = s.replace(/[.\s]+$/g, ""); // trailing dots/spaces
  if (!s) s = "未命名";
  return s.slice(0, 120);
}

/** Extract the visible text of a single column's serialized EditorState. */
function extractColumnText(columnJson: string): string {
  try {
    const doc = JSON.parse(columnJson);
    const out: string[] = [];
    walkText(doc, out);
    return out.join("");
  } catch {
    return "";
  }
}

function walkText(node: unknown, out: string[]) {
  if (!node || typeof node !== "object") return;
  const rec = node as Record<string, unknown>;
  if (typeof rec.text === "string") out.push(rec.text);
  if (rec.root && typeof rec.root === "object") walkText(rec.root, out);
  if (Array.isArray(rec.children)) for (const c of rec.children) walkText(c, out);
  if (rec.$slots && typeof rec.$slots === "object")
    for (const k of Object.keys(rec.$slots as Record<string, unknown>)) walkText((rec.$slots as Record<string, unknown>)[k], out);
}

/**
 * 把一个页面的 `content_json` 转成 Markdown（**纯函数、无副作用**：起一个 headless editor
 * 解析 + 转换，不碰 DOM、不碰文件）。
 *
 * 两处共用这一条转换：工作区导出（`exportWorkspaceToMarkdown`）与「发布到社区」的发布前清单。
 * 各写一份的代价已经在别处付过学费——比如 Route-B 列布局要不要先展开：不展开的话列里的内容
 * 会**整块丢**，而只有一份实现时这个坑只需要修一次。
 */
export function pageContentToMarkdown(contentJson: string): string {
  const editor = createEditor({ nodes: NODES, namespace: "shuyonote-export" });
  editor.setEditorState(editor.parseEditorState(contentJson));
  // Expand Route-B columns blocks into plain paragraphs (from each column's own
  // EditorState) so their content isn't lost in the Markdown export.
  editor.update(() => {
    const root = $getRoot();
    const blocks = root.getChildren().filter((n) => $isColumnsBlockNode(n));
    for (const block of blocks) {
      const text = (block as ColumnsBlockNode).__cols
        .map((c) => extractColumnText(c))
        .filter(Boolean)
        .join("\n");
      const para = $createParagraphNode();
      if (text) para.append($createTextNode(text));
      block.insertBefore(para);
      block.remove();
    }
  });
  let md = "";
  editor.getEditorState().read(() => {
    md = $convertToMarkdownString(SHUYONOTE_TRANSFORMERS);
  });
  return md;
}

/** Export every page in the active workspace to Markdown files in a chosen folder. */
export async function exportWorkspaceToMarkdown(): Promise<string> {
  const dir = await platform.dialog.open({ directory: true, title: "选择导出目录" });
  if (!dir || Array.isArray(dir)) return "已取消导出";
  const pages = await api.listPages();
  const used = new Set<string>();
  let count = 0;
  for (const p of pages) {
    try {
      const page = await api.getPage(p.id);
      const md = pageContentToMarkdown(page.content_json || "{}");
      const base = sanitizeName(page.title || p.id);
      let name = `${base}.md`;
      if (used.has(name)) name = `${base}-${p.id.slice(0, 6)}.md`;
      used.add(name);
      // Front-matter-ish header so the file is self-describing.
      const head = `<!-- title: ${page.title || "未命名"} · id: ${p.id} -->\n`;
      await api.writeTextFile(`${dir}/${name}`, head + md);
      count++;
    } catch {
      // Skip a page that fails to convert (e.g. malformed JSON).
    }
  }
  return `已导出 ${count}/${pages.length} 个页面到「${dir}」`;
}
