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
import type { CSSProperties, JSX } from "react";
import { blockIdOf, withBlockId } from "./blockIdHelpers";

// A horizontal row of images (e.g. a GitHub README's <p align="center"> shield
// badges). Lexical's inline DecoratorNode images don't flow in a paragraph in
// this editor, so a group of sibling <img> gets its own flex-row node that lays
// them out side by side, centered.

export interface ImageRowItem {
  src: string;
  alt: string;
  width?: number | null;
  height?: number | null;
}

export type SerializedImageRowNode = Spread<
  {
    items: ImageRowItem[];
    blockId?: string;
  },
  SerializedLexicalNode
>;

export class ImageRowNode extends DecoratorNode<JSX.Element> {
  __items: ImageRowItem[];
  /** 块身份（只有**顶层块**才有）。 */
  __blockId: string;

  static getType(): string {
    return "imageRow";
  }

  static clone(node: ImageRowNode): ImageRowNode {
    return new ImageRowNode(node.__items, node.__blockId, node.__key);
  }

  constructor(items: ImageRowItem[] = [], blockId = "", key?: NodeKey) {
    super(key);
    this.__items = items;
    this.__blockId = blockId;
  }

  afterCloneFrom(prevNode: this): void {
    super.afterCloneFrom(prevNode);
    this.__blockId = (prevNode as ImageRowNode).__blockId;
  }

  getBlockId(): string {
    return this.__blockId;
  }

  setBlockId(blockId: string): void {
    const writable = this.getWritable();
    writable.__blockId = blockId;
  }

  $config() {
    return this.config("imageRow", { extends: DecoratorNode<JSX.Element> });
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const div = document.createElement("div");
    div.className = "editor-image-row";
    return div;
  }

  updateDOM(): boolean {
    return false;
  }

  decorate(): JSX.Element {
    return (
      <div className="editor-image-row">
        {this.__items.map((it, i) => {
          const style: CSSProperties = {};
          if (it.width) style.width = `${it.width}px`;
          else if (it.height) style.height = `${it.height}px`;
          return it.src ? (
            <img
              key={i}
              src={it.src}
              alt={it.alt}
              draggable={false}
              style={style}
              onError={(e) => e.currentTarget.classList.add("editor-image-broken")}
              onLoad={(e) => e.currentTarget.classList.remove("editor-image-broken")}
            />
          ) : (
            <span key={i} className="editor-image editor-image-empty" />
          );
        })}
      </div>
    );
  }

  exportDOM(_editor: LexicalEditor): DOMExportOutput {
    const figure = document.createElement("div");
    for (const it of this.__items) {
      const img = document.createElement("img");
      img.setAttribute("src", it.src);
      img.setAttribute("alt", it.alt);
      figure.appendChild(img);
    }
    return { element: figure };
  }

  exportJSON(): SerializedImageRowNode {
    return withBlockId(
      {
        ...super.exportJSON(),
        type: "imageRow",
        items: this.__items,
      },
      this.__blockId,
    );
  }

  static importJSON(serializedNode: SerializedImageRowNode): ImageRowNode {
    return $createImageRowNode(serializedNode.items ?? [], blockIdOf(serializedNode));
  }

  isInline(): boolean {
    return false;
  }
}

export function $createImageRowNode(items: ImageRowItem[] = [], blockId = ""): ImageRowNode {
  return $applyNodeReplacement(new ImageRowNode(items, blockId));
}

export function $isImageRowNode(node: LexicalNode | null | undefined): node is ImageRowNode {
  return node instanceof ImageRowNode;
}
