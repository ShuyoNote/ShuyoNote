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
  },
  SerializedLexicalNode
>;

export class ImageRowNode extends DecoratorNode<JSX.Element> {
  __items: ImageRowItem[];

  static getType(): string {
    return "imageRow";
  }

  static clone(node: ImageRowNode): ImageRowNode {
    return new ImageRowNode(node.__items, node.__key);
  }

  constructor(items: ImageRowItem[] = [], key?: NodeKey) {
    super(key);
    this.__items = items;
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
          return (
            <img
              key={i}
              src={it.src}
              alt={it.alt}
              draggable={false}
              style={style}
              onError={(e) => e.currentTarget.classList.add("editor-image-broken")}
              onLoad={(e) => e.currentTarget.classList.remove("editor-image-broken")}
            />
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
    return {
      ...super.exportJSON(),
      type: "imageRow",
      items: this.__items,
    };
  }

  static importJSON(serializedNode: SerializedImageRowNode): ImageRowNode {
    return $createImageRowNode(serializedNode.items ?? []);
  }

  isInline(): boolean {
    return false;
  }
}

export function $createImageRowNode(items: ImageRowItem[] = []): ImageRowNode {
  return $applyNodeReplacement(new ImageRowNode(items));
}

export function $isImageRowNode(node: LexicalNode | null | undefined): node is ImageRowNode {
  return node instanceof ImageRowNode;
}
