import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  type ElementFormatType,
  type ElementNode,
} from "lexical";
import { $createHeadingNode, $createQuoteNode } from "@lexical/rich-text";
import { $createHorizontalRuleNode } from "@lexical/react/LexicalHorizontalRuleNode";
import { $createListNode, $createListItemNode } from "@lexical/list";
import { $createLinkNode } from "@lexical/link";
import { $createCodeNode } from "@lexical/code";
import { $createTableCellNode, $createTableNode, $createTableRowNode } from "@lexical/table";
import { $createImageNode } from "./nodes/ImageNode";

// Direct HTML → Lexical import (used when an imported document contains HTML).
// Walks the parsed DOM and builds real Lexical nodes one-to-one so structure is
// preserved (no Markdown round-trip loss). Pure Markdown (no '<') still goes
// through $convertFromMarkdownString.

type Fmt = "bold" | "italic" | "underline" | "strikethrough" | "code";

function textOf(n: Node): string {
  return (n.textContent ?? "").replace(/\u00a0/g, " ");
}

function inlineFmt(el: Element, target: ElementNode, fmt: Fmt) {
  for (const c of Array.from(el.childNodes)) {
    if (c.nodeType === Node.TEXT_NODE) {
      const t = $createTextNode(textOf(c));
      t.toggleFormat(fmt);
      target.append(t);
    } else if (c.nodeType === Node.ELEMENT_NODE) {
      // Preserve nesting by re-applying the format on nested inline runs.
      applyInlineFmt(c as Element, target, fmt);
    }
  }
}

function applyInlineFmt(el: Element, target: ElementNode, fmt: Fmt) {
  for (const c of Array.from(el.childNodes)) {
    if (c.nodeType === Node.TEXT_NODE) {
      const t = $createTextNode(textOf(c));
      t.toggleFormat(fmt);
      target.append(t);
    } else if (c.nodeType === Node.ELEMENT_NODE) {
      applyInlineFmt(c as Element, target, fmt);
    }
  }
}

function appendInline(node: Node, target: ElementNode) {
  if (node.nodeType === Node.TEXT_NODE) {
    const t = textOf(node);
    if (t) target.append($createTextNode(t));
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case "strong":
    case "b":
      inlineFmt(el, target, "bold");
      return;
    case "em":
    case "i":
      inlineFmt(el, target, "italic");
      return;
    case "u":
      inlineFmt(el, target, "underline");
      return;
    case "del":
    case "s":
      inlineFmt(el, target, "strikethrough");
      return;
    case "code":
      inlineFmt(el, target, "code");
      return;
    case "a": {
      const link = $createLinkNode(el.getAttribute("href") ?? "");
      for (const c of Array.from(el.childNodes)) appendInline(c, link);
      target.append(link);
      return;
    }
    case "br":
      target.append($createLineBreakNode());
      return;
    case "span":
    case "font":
    case "mark":
    case "small":
    case "sub":
    case "sup":
      for (const c of Array.from(el.childNodes)) appendInline(c, target);
      return;
    default: {
      const t = textOf(el);
      if (t) target.append($createTextNode(t));
    }
  }
}

function renderImg(el: Element, target: ElementNode) {
  const w = el.getAttribute("width");
  const h = el.getAttribute("height");
  target.append(
    $createImageNode(
      el.getAttribute("src") ?? "",
      el.getAttribute("alt") ?? "",
      false,
      w ? +w : null,
      h ? +h : null,
    ),
  );
}

function renderImgInline(el: Element, target: ElementNode) {
  const w = el.getAttribute("width");
  const h = el.getAttribute("height");
  target.append(
    $createImageNode(
      el.getAttribute("src") ?? "",
      el.getAttribute("alt") ?? "",
      true,
      w ? +w : null,
      h ? +h : null,
    ),
  );
}

// Apply the HTML `align` attribute to a Lexical block node so a centered
// `<p align="center">`/`<h1 align="center">` keeps its alignment.
function applyAlign(el: Element, node: ElementNode) {
  const a = (el.getAttribute("align") || el.getAttribute("data-align") || "").toLowerCase();
  if (a === "center" || a === "left" || a === "right" || a === "justify") {
    node.setFormat(a as ElementFormatType);
  }
}

function renderTable(el: Element, target: ElementNode) {
  const tbl = $createTableNode();
  for (const tr of Array.from(el.querySelectorAll("tr"))) {
    const row = $createTableRowNode();
    for (const cell of Array.from(tr.querySelectorAll("th, td"))) {
      const tc = $createTableCellNode();
      const p = $createParagraphNode();
      for (const c of Array.from(cell.childNodes)) appendInline(c, p);
      tc.append(p);
      row.append(tc);
    }
    tbl.append(row);
  }
  target.append(tbl);
}

function isImg(n: Node): boolean {
  return n.nodeType === Node.ELEMENT_NODE && (n as Element).tagName.toLowerCase() === "img";
}

function renderInlineBlock(el: Element, target: ElementNode) {
  const align = el.getAttribute("align") || el.getAttribute("data-align") || "";
  const children = Array.from(el.childNodes);
  const meaningful = children.filter(
    (c) =>
      c.nodeType === Node.ELEMENT_NODE ||
      (c.nodeType === Node.TEXT_NODE && (c.textContent ?? "").trim() !== ""),
  );
  const imgCount = meaningful.filter(isImg).length;
  const onlyImage = imgCount > 0 && meaningful.every(isImg);

  // A lone, non-aligned block image (e.g. a pasted screenshot) stays a block
  // image. Multiple <img> inside <p align="center"> (shield badges) or any
  // aligned container become INLINE images in a single aligned paragraph so the
  // row renders horizontally and centers as a group.
  if (!align && onlyImage && imgCount === 1) {
    renderImg(meaningful[0] as Element, target);
    return;
  }

  const current = $createParagraphNode();
  for (const c of children) {
    if (isImg(c)) {
      renderImgInline(c as Element, current);
    } else if (c.nodeType === Node.ELEMENT_NODE && (c as Element).tagName.toLowerCase() === "br") {
      current.append($createLineBreakNode());
    } else {
      appendInline(c, current);
    }
  }
  if (align) applyAlign(el, current);
  target.append(current);
}

function renderBlock(el: Element, target: ElementNode) {
  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      const h = $createHeadingNode(
        `h${tag[1]}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6",
      );
      for (const c of Array.from(el.childNodes)) appendInline(c, h);
      applyAlign(el, h);
      target.append(h);
      return;
    }
    case "p":
    case "div":
    case "section":
    case "article":
    case "header":
    case "footer":
    case "main":
    case "aside":
      renderInlineBlock(el, target);
      return;
    case "ul":
    case "ol": {
      const list = $createListNode(tag === "ol" ? "number" : "bullet");
      for (const li of Array.from(el.children)) {
        const item = $createListItemNode();
        const p = $createParagraphNode();
        for (const c of Array.from(li.childNodes)) appendInline(c, p);
        item.append(p);
        list.append(item);
      }
      target.append(list);
      return;
    }
    case "blockquote": {
      const q = $createQuoteNode();
      for (const c of Array.from(el.childNodes)) appendInline(c, q);
      target.append(q);
      return;
    }
    case "pre": {
      const code = $createCodeNode();
      code.append($createTextNode(el.textContent ?? ""));
      target.append(code);
      return;
    }
    case "hr":
      target.append($createHorizontalRuleNode());
      return;
    case "img":
      renderImg(el, target);
      return;
    case "table":
      renderTable(el, target);
      return;
    default: {
      const p = $createParagraphNode();
      for (const c of Array.from(el.childNodes)) appendInline(c, p);
      target.append(p);
    }
  }
}

// Append the HTML content as Lexical nodes to `root`. Must be called inside
// editor.update().
export function $importHtml(html: string, root: ElementNode) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const child of Array.from(doc.body.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      const t = textOf(child).replace(/\s+/g, " ").trim();
      if (t) {
        const p = $createParagraphNode();
        p.append($createTextNode(t));
        root.append(p);
      }
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      renderBlock(child as Element, root);
    }
  }
}
