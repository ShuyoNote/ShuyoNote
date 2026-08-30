// M19/Wiki — an inline, clickable `[[Page Title]]` wiki link inside the editor.
//
// It renders `[[标题]]` as a link-styled inline element that, when clicked,
// opens the matching page in the app. It extends `TextNode` so it participates
// in normal text flow and, crucially, keeps serializing its `text` back to the
// literal `[[标题]]` — so `content_text` (search / backlinks / wiki export /
// `guide.ts` blockText) stays intact and unchanged.
import {
  $applyNodeReplacement,
  TextNode,
  type EditorConfig,
  type NodeKey,
  type SerializedTextNode,
  type Spread,
} from "lexical";
import { useNotes } from "../../store/notes";

export type SerializedPageLinkNode = Spread<
  { pageTitle: string; type: string; version: number },
  SerializedTextNode
>;

function openPageByTitle(title: string) {
  const notes = useNotes.getState();
  const target = notes.pages.find((p) => (p.title || "") === title);
  if (target) void notes.openPage(target.id);
}

export class PageLinkNode extends TextNode {
  __pageTitle: string;

  static getType(): string {
    return "page-link";
  }

  static clone(node: PageLinkNode): PageLinkNode {
    return new PageLinkNode(node.__text, node.__pageTitle, node.__key);
  }

  constructor(text: string, pageTitle: string, key?: NodeKey) {
    super(text, key);
    this.__pageTitle = pageTitle;
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const span = document.createElement("span");
    span.className = "editor-page-link";
    span.setAttribute("data-page-link", this.__pageTitle);
    span.setAttribute("role", "link");
    span.setAttribute("tabindex", "0");
    // Show a friendly label ([[标题|别名]] → 别名; else title) but keep the
    // node's `text` as the literal `[[标题]]` for content_text compatibility.
    const raw = this.getTextContent(); // e.g. [[标题]] or [[标题|别名]]
    const m = raw.match(/^\[\[([^\]|#]+)(?:\|([^\]|#]*))?(?:#([^\]]*))?\]\]$/);
    const label = m ? (m[2] || m[1]).trim() : raw;
    span.textContent = label;
    span.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openPageByTitle(this.__pageTitle);
    });
    span.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openPageByTitle(this.__pageTitle);
      }
    });
    return span;
  }

  updateDOM(_prevNode: PageLinkNode, dom: HTMLElement): boolean {
    dom.setAttribute("data-page-link", this.__pageTitle);
    return true;
  }

  exportJSON(): SerializedPageLinkNode {
    return {
      ...super.exportJSON(),
      type: "page-link",
      version: 1,
      pageTitle: this.__pageTitle,
    };
  }

  static importJSON(serializedNode: SerializedPageLinkNode): PageLinkNode {
    // `text` (from TextNode super) already holds the literal [[…]]; ensure it.
    const text = serializedNode.text || `[[${serializedNode.pageTitle}]]`;
    const node = $createPageLinkNode(text, serializedNode.pageTitle);
    node.setFormat(serializedNode.format);
    node.setDetail(serializedNode.detail);
    node.setMode(serializedNode.mode);
    node.setStyle(serializedNode.style);
    return node;
  }
}

export function $createPageLinkNode(text: string, pageTitle: string): PageLinkNode {
  // Normalize so the node's text always round-trips to [[…]] for search/backlinks.
  const safeText = text.startsWith("[[") ? text : `[[${pageTitle}]]`;
  return $applyNodeReplacement(new PageLinkNode(safeText, pageTitle));
}

export function $isPageLinkNode(node: unknown): node is PageLinkNode {
  return node instanceof PageLinkNode;
}
