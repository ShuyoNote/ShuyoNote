import {
  createEditor,
  $getRoot,
  $createParagraphNode,
  $createTextNode,
  $isElementNode,
  $isParagraphNode,
  $isDecoratorNode,
  $isLineBreakNode,
  $isTextNode,
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

/**
 * 文件名清洗（`/ \ : * ? " < > |` 与控制字符 ⇒ `_`、去掉首尾点/空格、限长 120）。
 *
 * 导出成 .md 文件与「带附件打成 zip」（`exportMarkdownBundle.ts`）**共用这一份** ——
 * zip 条目名另有更严的一层（额外剥 `..`，防 zip-slip ✗），但那层是**在这份之上**加的，
 * ⛔ 不是另写一份清洗 ✗（两份就会漂）。
 */
export function sanitizeName(name: string): string {
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
 * 收集页面文档 JSON 里**带附件指纹**的图片/视频，按 hash 去重。
 *
 * 三个约定，与发布链路绑在一起：
 *  · 只收 `__hash` 非空的节点 —— 没有指纹就没有字节可传（`community_upload_attachment`
 *    只认 hash），拿 `__src` 猜路径是另一套会漂的口径；
 *  · **解析失败返回 `[]`、不抛** —— 这个函数只用于"清单里说清有几张"，
 *    让它把整个发布入口炸掉是本末倒置（真的解析不了时，正文转换那一步会报错）；
 *  · 按 hash 去重 —— 同一张图在正文里引用两次只该传一次（社区是内容寻址，传两次也是同一份）。
 */
export function pageImageRefs(docJson: string): PageImageRef[] {
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
    // 所以这只在手工/外部产出的页面文档 JSON 上才见得到。
    if ($isElementNode(node)) for (const child of node.getChildren()) collect(child);
  };
  try {
    const editor = createEditor({ nodes: NODES, namespace: "shuyonote-image-refs" });
    editor.setEditorState(editor.parseEditorState(docJson));
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
 * 把一个页面的文档 JSON 转成 Markdown（**纯函数、无副作用**：起一个 headless editor
 * 解析 + 转换，不碰 DOM、不碰文件）。
 *
 * 两处共用这一条转换：工作区导出（`exportWorkspaceToMarkdown`）与「发布到社区」的发布前清单。
 * 各写一份的代价已经在别处付过学费——比如 Route-B 列布局要不要先展开：不展开的话列里的内容
 * 会**整块丢**，而只有一份实现时这个坑只需要修一次。
 *
 * `resolveImage`（可选）：把本地图片引用换成别的地址（发布到社区时换成 `/attachments/<hash>`）。
 * 不传 = 一字不变的老行为（工作区导出就是这一路）。
 */
export function pageContentToMarkdown(docJson: string, resolveImage?: ResolveImage): string {
  const editor = createEditor({ nodes: NODES, namespace: "shuyonote-export" });
  editor.setEditorState(editor.parseEditorState(docJson));
  // Expand Route-B columns blocks into plain paragraphs (from each column's own
  // ⭐ **2026-10-15（owner 实测：导出的 .md 里 mermaid 块没有 ```mermaid 围栏 ✗）**：
  //   真因是**树的形状** ＋ **导出时机**，不是那条 transformer：
  //   ① 实测真页里 mermaid 被包在段落里（`root > paragraph > mermaid`）⇒
  //      `$convertToMarkdownString` 对"段落里的装饰块"**不走**它自己的 `export` ⇒ 裸源码 ✗
  //      （逐字：`## 四、执行框架：五步走` 后面直接跟 `flowchart TB`，一个围栏都没有）；
  //   ② ⚠️ 光"提前把它提到根上"也**没用** ✗ —— Lexical 提交时会把根上的裸装饰节点
  //      **再包回段落**（本文件试过：树里 hoist ＋ `discrete: true`、以及解析前改 JSON，都不行 ✓）。
  //   ⇒ 唯一的形状是 `markdownTransformers.test.ts` 那条绿判据用的那个：
  //      **在同一次 `editor.update` 里**先规整树、**紧接着**在同一份 pending 状态上导出 ✓。
  //   ⚠️ 所以下面三趟（列块展开 → 装饰节点提级 → 导出）**必须在同一个 update 里**，
  //      ⛔ 不许把导出挪到 `editor.getEditorState().read(...)` 里 ✗（那样看到的是提交后的树 ✗）。
  const transformers = resolveImage ? transformersWithImageResolver(resolveImage) : SHUYONOTE_TRANSFORMERS;
  let md = "";
  editor.update(
    () => {
      const root = $getRoot();
      // ① Route-B 列块 → 普通段落（否则列里的内容整块丢 ✗）
      for (const block of root.getChildren().filter((n) => $isColumnsBlockNode(n))) {
        const text = (block as ColumnsBlockNode).__cols
          .map((c) => extractColumnText(c))
          .filter(Boolean)
          .join("\n");
        const para = $createParagraphNode();
        if (text) para.append($createTextNode(text));
        block.insertBefore(para);
        block.remove();
      }
      // ② 段落里的**块级装饰节点**提到段落的位置（判据：实质孩子恰好一个装饰节点；
      //    实质 ＝ 非换行、非空文本 ⇒ `文字＋图片＋文字` 这种行内用法一个字都不动 ✓）
      for (const para of $getRoot().getChildren()) {
        if (!$isParagraphNode(para)) continue;
        const meaningful = para
          .getChildren()
          .filter((k) => !$isLineBreakNode(k) && !($isTextNode(k) && k.getTextContent() === ""));
        if (meaningful.length !== 1 || !$isDecoratorNode(meaningful[0])) continue;
        const only = meaningful[0];
        para.insertBefore(only);
        const rest = para
          .getChildren()
          .filter((k) => !$isLineBreakNode(k) && !($isTextNode(k) && k.getTextContent() === ""));
        if (rest.length === 0) para.remove();
      }
      // ③ 就在这份 pending 状态上导出 ✓
      md = $convertToMarkdownString(transformers);
    },
    { discrete: true },
  );
  return md;
}

/**
 * 一次「导出这一页为 .md」要的字段。
 * ⚠️ 正文那格叫 `docJson`（**文档 JSON 文本**），⛔ 不叫存储列名 ✗ —— 那个键名只许出现在
 * `docContent.ts`（那一层）里；门禁 `check-doc-content-access.mjs` 会把在这边写它的代价算成
 * "新增直接访问"（2026-10-15 实测红过：`exportMarkdown.ts 1 → 3`）。取正文用
 * `docContent.ts::docJsonOfPage(page)` ✓。
 */
export type MarkdownPageInput = {
  id: string;
  title?: string | null;
  /** 文档 JSON 文本（页面正文）；取法见上面那条注释 ✓ */
  docJson: string;
  /**
   * ⭐ 2026-10-17：它在页面树里的**父页 id**（`null`／缺省 ⇒ 顶层）。
   *
   * ⚠️ 只被 `exportMarkdownBundle.ts` 用来**决定 zip 内的目录** ✓ ——
   * 纯 `.md` 导出（`exportPageToMarkdown` / `exportWorkspaceToMarkdown`）**不读它** ✓
   * （那两条保持原样：一条单文件、一条平铺 ✓）。⛔ 缺省不猜父页 ✗。
   */
  parentId?: string | null;
};

/**
 * ⭐ **把当前这一页存成一个 `.md` 文件**（存到哪由用户在保存对话框里选）。
 *
 * 为什么单开一条（而不是让「导出为 Markdown」继续只复制剪贴板 ✗）：
 * owner 2026-10-15 要的是**直接拿到一个文件** —— 剪贴板给不了"带走"这件事。
 * 从此两件事各归各位：**复制**给"我要粘到别处"，**导出**给"我要一个文件" ✓。
 *
 * ⚠️ 转换**必须走** [`pageContentToMarkdown`] ✗ —— 它是全应用唯一那份"页面 JSON → Markdown"，
 * 里面有 Route-B 列块的展开（不展开 ⇒ 列里的内容**整块丢** ✗，这个坑在别处已经付过学费）。
 * ⛔ 不许在这里另写一份 `$convertToMarkdownString` ✗。
 * ⚠️ 文件头那行注释与工作区导出**同一个形状**（`<!-- title: … · id: … -->`）⇒ 两个导出件长得一样 ✓。
 * ⚠️ 两端平台同一份实现：桌面写真实文件（`write_text_file`），Web 触发浏览器下载
 * （`web.ts` 的 `write_text_file` 实现 ✓）—— 所以这里**不**分平台 ✗。
 *
 * @returns 一句给用户的话（取消 ⇒ 明确说"已取消"，⛔ 不假装成功 ✗）
 */
export async function exportPageToMarkdown(page: MarkdownPageInput): Promise<string> {
  const title = page.title || "未命名";
  const path = await platform.dialog.save({
    title: "导出为 Markdown",
    defaultPath: `${sanitizeName(page.title || page.id)}.md`,
    filters: [{ name: "Markdown", extensions: ["md"] }],
  });
  // 用户在对话框里点了取消 ⇒ 一个字节都不写 ✓（也不报成功 ✗）
  if (!path) return "已取消导出";
  const md = pageContentToMarkdown(page.docJson);
  const head = `<!-- title: ${title} · id: ${page.id} -->\n`;
  await api.writeTextFile(path, head + md);
  return `已导出「${title}」到 ${path}`;
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
