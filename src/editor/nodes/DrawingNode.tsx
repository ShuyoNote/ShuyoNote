import {
  $applyNodeReplacement,
  DecoratorNode,
  type DOMExportOutput,
  type EditorConfig,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from "lexical";
import type { JSX } from "react";
import { Suspense, lazy } from "react";
// Lazy-load Excalidraw so it's not in the first-paint bundle. Only a page that
// actually contains a drawing block pays the (large) cost of loading the scene.
const InlineDrawing = lazy(() => import("../../components/InlineDrawing"));

export type SerializedDrawingNode = Spread<
  {
    /** blob hash of the Excalidraw scene JSON. */
    hash: string | null;
    /** mime of the scene blob (application/json). */
    mime: string | null;
    /** blob hash of the exported PNG thumbnail. */
    thumbHash: string | null;
    thumbMime?: string | null;
    /** extracted text of the scene (indexed into content_text). */
    text: string;
    width?: number | null;
    height?: number | null;
    /** remembered read-only viewport (zoom + scroll), so the embed reopens as the user left it. */
    zoom?: number | null;
    scrollX?: number | null;
    scrollY?: number | null;
  },
  SerializedLexicalNode
>;

export class DrawingNode extends DecoratorNode<JSX.Element> {
  __hash: string | null;
  __mime: string | null;
  __thumbHash: string | null;
  __thumbMime: string | null;
  __text: string;
  __width: number | null;
  __height: number | null;
  __zoom: number | null;
  __scrollX: number | null;
  __scrollY: number | null;

  static getType(): string {
    return "drawing";
  }

  static clone(node: DrawingNode): DrawingNode {
    return new DrawingNode(
      node.__hash,
      node.__mime,
      node.__thumbHash,
      node.__thumbMime,
      node.__text,
      node.__width,
      node.__height,
      node.__zoom,
      node.__scrollX,
      node.__scrollY,
      node.__key,
    );
  }

  constructor(
    hash: string | null = null,
    mime: string | null = null,
    thumbHash: string | null = null,
    thumbMime: string | null = null,
    text = "",
    width: number | null = null,
    height: number | null = null,
    zoom: number | null = null,
    scrollX: number | null = null,
    scrollY: number | null = null,
    key?: NodeKey,
  ) {
    super(key);
    this.__hash = hash;
    this.__mime = mime;
    this.__thumbHash = thumbHash;
    this.__thumbMime = thumbMime;
    this.__text = text;
    this.__width = width;
    this.__height = height;
    this.__zoom = zoom;
    this.__scrollX = scrollX;
    this.__scrollY = scrollY;
  }

  $config() {
    return this.config("drawing", { extends: DecoratorNode<JSX.Element> });
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const span = document.createElement("span");
    span.className = "editor-drawing-container";
    return span;
  }

  updateDOM(): boolean {
    return false;
  }

  setDrawing(patch: Partial<SerializedDrawingNode>): void {
    const writable = this.getWritable();
    if (typeof patch.hash === "string" || patch.hash === null) writable.__hash = patch.hash;
    if (typeof patch.mime === "string" || patch.mime === null) writable.__mime = patch.mime;
    if (typeof patch.thumbHash === "string" || patch.thumbHash === null) writable.__thumbHash = patch.thumbHash;
    if (typeof patch.thumbMime === "string" || patch.thumbMime === null) writable.__thumbMime = patch.thumbMime ?? null;
    if (typeof patch.text === "string") writable.__text = patch.text;
    if (typeof patch.width === "number" || patch.width === null) writable.__width = patch.width;
    if (typeof patch.height === "number" || patch.height === null) writable.__height = patch.height;
    if (typeof patch.zoom === "number" || patch.zoom === null) writable.__zoom = patch.zoom;
    if (typeof patch.scrollX === "number" || patch.scrollX === null) writable.__scrollX = patch.scrollX;
    if (typeof patch.scrollY === "number" || patch.scrollY === null) writable.__scrollY = patch.scrollY;
  }

  // Surface the drawing's scene text so `content_text` (and thus search/backlinks)
  // sees it.
  getTextContent(): string {
    return this.__text;
  }

  decorate(): JSX.Element {
    return (
      <Suspense fallback={<div className="editor-drawing-placeholder">加载绘图…</div>}>
        <InlineDrawing node={this} />
      </Suspense>
    );
  }

  exportDOM(_editor: LexicalEditor): DOMExportOutput {
    const el = document.createElement("div");
    el.textContent = this.__text;
    return { element: el };
  }

  exportJSON(): SerializedDrawingNode {
    return {
      ...super.exportJSON(),
      type: "drawing",
      version: 1,
      hash: this.__hash,
      mime: this.__mime,
      thumbHash: this.__thumbHash,
      thumbMime: this.__thumbMime ?? undefined,
      text: this.__text,
      width: this.__width,
      height: this.__height,
      zoom: this.__zoom,
      scrollX: this.__scrollX,
      scrollY: this.__scrollY,
    };
  }

  static importJSON(serializedNode: SerializedDrawingNode): DrawingNode {
    // `caption` was removed from the drawing feature; it's intentionally ignored on
    // import so older saved docs that carried a caption still load (the text is
    // dropped, scene labels remain).
    return $createDrawingNode(
      serializedNode.hash ?? null,
      serializedNode.mime ?? null,
      serializedNode.thumbHash ?? null,
      serializedNode.thumbMime ?? null,
      serializedNode.text ?? "",
      serializedNode.width ?? null,
      serializedNode.height ?? null,
      serializedNode.zoom ?? null,
      serializedNode.scrollX ?? null,
      serializedNode.scrollY ?? null,
    );
  }
}

export function $createDrawingNode(
  hash: string | null = null,
  mime: string | null = null,
  thumbHash: string | null = null,
  thumbMime: string | null = null,
  text = "",
  width: number | null = null,
  height: number | null = null,
  zoom: number | null = null,
  scrollX: number | null = null,
  scrollY: number | null = null,
): DrawingNode {
  return $applyNodeReplacement(new DrawingNode(hash, mime, thumbHash, thumbMime, text, width, height, zoom, scrollX, scrollY));
}

export function $isDrawingNode(node: LexicalNode | null | undefined): node is DrawingNode {
  return node instanceof DrawingNode;
}
