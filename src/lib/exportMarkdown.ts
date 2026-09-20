import {
  createEditor,
  $getRoot,
  $createParagraphNode,
  $createTextNode,
  $isElementNode,
  type LexicalNode,
} from "lexical";
import {
  $convertToMarkdownString,
  type ElementTransformer,
  type Transformer,
} from "@lexical/markdown";
import { platform } from "./platform";
import { api } from "./api";
import { IMAGE, SHUYONOTE_TRANSFORMERS } from "../editor/markdownTransformers";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import { ListNode, ListItemNode } from "@lexical/list";
import { CodeNode, CodeHighlightNode } from "@lexical/code";
import { LinkNode } from "@lexical/link";
import { HorizontalRuleNode } from "@lexical/react/LexicalHorizontalRuleNode";
import { TableNode, TableCellNode, TableRowNode } from "@lexical/table";
import { CalloutNode } from "../editor/nodes/CalloutNode";
import { ColumnsBlockNode, $isColumnsBlockNode } from "../editor/nodes/ColumnsBlockNode";
import { ImageNode, $isImageNode } from "../editor/nodes/ImageNode";
import { ImageRowNode } from "../editor/nodes/ImageRowNode";
import { VideoNode, $isVideoNode } from "../editor/nodes/VideoNode";
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
 * 正文里的**一张本地附件引用**（走内容寻址：`__hash` 是附件 sha256）。
 *
 * 为什么 `kind` 分 image/video 而不是只给 hash：社区附件白名单只有
 * png/jpeg/gif/webp/pdf/zip（按魔数判），**视频传不上去**——发布前清单必须能说出
 * "这 M 个发不出去"，这个判断只能由"节点是哪种"给出，光看 hash 看不出来。
 */
export interface PageImageRef {
  /** 本机附件的 sha256（也是 `community_upload_attachment` 的入参）。 */
  hash: string;
  mime: string;
  kind: "image" | "video";
}

/**
 * 收集 `content_json` 里**带附件指纹**的图片/视频，按 hash 去重。
 *
 * 三个约定，与发布链路绑在一起：
 *  · 只收 `__hash` 非空的节点 —— 没有指纹就没有字节可传（`community_upload_attachment`
 *    只认 hash），拿 `__src` 猜路径是另一套会漂的口径；
 *  · **解析失败返回 `[]`、不抛** —— 这个函数只用于"清单里说清有几张"，
 *    让它把整个发布入口炸掉是本末倒置（真的解析不了时，正文转换那一步会报错）；
 *  · 按 hash 去重 —— 同一张图在正文里引用两次只该传一次（社区是内容寻址，传两次也是同一份）。
 */
export function pageImageRefs(contentJson: string): PageImageRef[] {
  const out: PageImageRef[] = [];
  const seen = new Set<string>();
  const collect = (node: LexicalNode) => {
    if ($isImageNode(node) || $isVideoNode(node)) {
      const hash = node.__hash ?? "";
      if (hash && !seen.has(hash)) {
        seen.add(hash);
        out.push({ hash, mime: node.__mime ?? "", kind: $isImageNode(node) ? "image" : "video" });
      }
    }
    // 容器节点继续往下走：图片可能在段落里，也可能在引用/列表/表格单元格里。
    //
    // ⚠️ 已知的"多收"：`$convertToMarkdownString` 只对**顶层节点**跑 element transformer
    // （`$exportChildren` 遇到 DecoratorNode 只取 `getTextContent()`），所以**非顶层**的图片
    // 在 Markdown 里本来就整块丢 —— 这里却会收进 refs。两个方向里选"多收"：多传一张是无害的
    // （内容寻址，传两次也是同一份），漏传就是社区上一篇缺图的文章且没人知道。
    // 真实的图片都是顶层块（插入走 `blockUtils.ts::$getInsertTargetBlock`，停在 root 边界），
    // 所以这只在手工/外部产出的 `content_json` 上才见得到。
    if ($isElementNode(node)) for (const child of node.getChildren()) collect(child);
  };
  try {
    const editor = createEditor({ nodes: NODES, namespace: "shuyonote-image-refs" });
    editor.setEditorState(editor.parseEditorState(contentJson));
    editor.getEditorState().read(() => {
      for (const child of $getRoot().getChildren()) collect(child);
    });
  } catch {
    return [];
  }
  return out;
}

/**
 * 把本地引用换成社区地址的回调：给 `(hash, mime, src)`，回一个地址（空串 = 换不了、用回 `src`）。
 *
 * `mime` 与 `src` 一起给，是因为调用方可能要按类型分流（比如视频不传）；只给 hash
 * 会逼每个调用方自己去查一遍附件表。
 */
export type ResolveImage = (hash: string, mime: string, src: string) => string;

/**
 * 复制一份 `SHUYONOTE_TRANSFORMERS`，**只换掉 `IMAGE` 那一项**。
 *
 * 为什么是"就地复制一份"而不是改那个模块级数组：这个函数有两个调用点（工作区导出、
 * 发布到社区），模块级可变状态会让两者互相污染——先跑的那次把 exporter 改了，
 * 后跑的那次（没传回调）就悄悄带上社区的地址。复制一份是"每调用一份，
 * 谁也别动谁的"。
 */
function transformersWithImageResolver(resolveImage: ResolveImage): Transformer[] {
  return SHUYONOTE_TRANSFORMERS.map((t) => {
    if (t !== IMAGE) return t;
    const base = t as ElementTransformer;
    return {
      ...base,
      export: (node: LexicalNode) => {
        // 没有 `resolveImage` 那一路照旧（见下面的调用点）：同一个 exporter 只在
        // "有指纹 + 回调给了非空地址"时改地址，其余一律保持 `__src`。
        if (!$isImageNode(node)) return null;
        const hash = node.__hash ?? "";
        const url = hash ? resolveImage(hash, node.__mime ?? "", node.__src) : "";
        return `![${node.__altText || ""}](${url || node.__src})`;
      },
    };
  });
}

/**
 * 把一个页面的 `content_json` 转成 Markdown（**纯函数、无副作用**：起一个 headless editor
 * 解析 + 转换，不碰 DOM、不碰文件）。
 *
 * 两处共用这一条转换：工作区导出（`exportWorkspaceToMarkdown`）与「发布到社区」的发布前清单。
 * 各写一份的代价已经在别处付过学费——比如 Route-B 列布局要不要先展开：不展开的话列里的内容
 * 会**整块丢**，而只有一份实现时这个坑只需要修一次。
 *
 * `resolveImage`（可选）：把本地图片引用换成别的地址（发布到社区时换成 `/attachments/<hash>`）。
 * 不传 = 一字不变的老行为（工作区导出就是这一路）。
 */
export function pageContentToMarkdown(contentJson: string, resolveImage?: ResolveImage): string {
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
  const transformers = resolveImage ? transformersWithImageResolver(resolveImage) : SHUYONOTE_TRANSFORMERS;
  editor.getEditorState().read(() => {
    md = $convertToMarkdownString(transformers);
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
