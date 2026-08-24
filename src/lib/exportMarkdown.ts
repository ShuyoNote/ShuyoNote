import { createEditor } from "lexical";
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
import { ImageNode } from "../editor/nodes/ImageNode";
import { ImageRowNode } from "../editor/nodes/ImageRowNode";
import { VideoNode } from "../editor/nodes/VideoNode";
import { BlockRefNode } from "../editor/nodes/BlockRefNode";
import { BlockEmbedNode } from "../editor/nodes/BlockEmbedNode";
import { AttachmentRefNode } from "../editor/nodes/AttachmentRefNode";

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
  ImageNode,
  ImageRowNode,
  VideoNode,
  BlockRefNode,
  BlockEmbedNode,
  AttachmentRefNode,
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

/** Export every page in the active workspace to Markdown files in a chosen folder. */
export async function exportWorkspaceToMarkdown(): Promise<string> {
  const dir = await platform.dialog.open({ directory: true, title: "选择导出目录" });
  if (!dir || Array.isArray(dir)) return "已取消导出";
  const pages = await api.listPages();
  const editor = createEditor({ nodes: NODES, namespace: "shuyonote-export" });
  const used = new Set<string>();
  let count = 0;
  for (const p of pages) {
    try {
      const page = await api.getPage(p.id);
      const json = page.content_json || "{}";
      editor.setEditorState(editor.parseEditorState(json));
      let md = "";
      editor.getEditorState().read(() => {
        md = $convertToMarkdownString(SHUYONOTE_TRANSFORMERS);
      });
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
