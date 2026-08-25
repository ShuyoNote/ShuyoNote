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
import { MediaResolver } from "./MediaResolver";
import { useEditorStore } from "../../store/editor";

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
  }

  // Surface the drawing's text so `content_text` (and thus search/backlinks) sees it.
  getTextContent(): string {
    return this.__text;
  }

  decorate(): JSX.Element {
    const edit = () => {
      useEditorStore.getState().openDrawingEdit({
        nodeKey: this.getKey(),
        hash: this.__hash,
        mime: this.__mime,
        text: this.__text,
      });
    };
    const style: React.CSSProperties = {};
    if (this.__width) style.width = `${this.__width}px`;
    else if (this.__height) style.height = `${this.__height}px`;

    return (
      <div className="editor-drawing">
        <div className="editor-drawing-canvas">
          {this.__thumbHash ? (
            <MediaResolver
              hash={this.__thumbHash}
              mime={this.__thumbMime ?? "image/png"}
              render={(url) =>
                url ? (
                  <img src={url} className="editor-drawing-img" style={style} alt="绘图" draggable={false} />
                ) : (
                  <span className="editor-drawing-placeholder">（绘图缩略图不可用）</span>
                )
              }
            />
          ) : (
            <span className="editor-drawing-placeholder">
              {this.__text ? this.__text : "（空白绘图）"}
            </span>
          )}
        </div>
        <div className="editor-drawing-toolbar">
          <button
            className="editor-drawing-btn"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              edit();
            }}
          >
            {this.__thumbHash ? "编辑绘图" : "点击绘制/编辑"}
          </button>
        </div>
      </div>
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
    };
  }

  static importJSON(serializedNode: SerializedDrawingNode): DrawingNode {
    return $createDrawingNode(
      serializedNode.hash ?? null,
      serializedNode.mime ?? null,
      serializedNode.thumbHash ?? null,
      serializedNode.thumbMime ?? null,
      serializedNode.text ?? "",
      serializedNode.width ?? null,
      serializedNode.height ?? null,
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
): DrawingNode {
  return $applyNodeReplacement(new DrawingNode(hash, mime, thumbHash, thumbMime, text, width, height));
}

export function $isDrawingNode(node: LexicalNode | null | undefined): node is DrawingNode {
  return node instanceof DrawingNode;
}
