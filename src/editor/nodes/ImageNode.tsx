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

export type SerializedImageNode = Spread<
  {
    src: string;
    altText: string;
    inline?: boolean;
    width?: number | null;
    height?: number | null;
  },
  SerializedLexicalNode
>;

export class ImageNode extends DecoratorNode<JSX.Element> {
  __src: string;
  __altText: string;
  __inline: boolean;
  __width: number | null;
  __height: number | null;

  static getType(): string {
    return "image";
  }

  static clone(node: ImageNode): ImageNode {
    return new ImageNode(
      node.__src,
      node.__altText,
      node.__inline,
      node.__width,
      node.__height,
      node.__key,
    );
  }

  constructor(
    src: string,
    altText = "",
    inline = false,
    width: number | null = null,
    height: number | null = null,
    key?: NodeKey,
  ) {
    super(key);
    this.__src = src;
    this.__altText = altText;
    this.__inline = inline;
    this.__width = width;
    this.__height = height;
  }

  $config() {
    return this.config("image", { extends: DecoratorNode<JSX.Element> });
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const span = document.createElement("span");
    span.className = this.__inline ? "editor-image-container editor-image-inline-container" : "editor-image-container";
    return span;
  }

  updateDOM(): boolean {
    return false;
  }

  decorate(): JSX.Element {
    // Guard: an empty src would make React emit an "empty string passed to src"
    // warning (and the browser may refetch the page). Render nothing and let the
    // editor show an empty line placeholder instead.
    if (!this.__src) return <span className="editor-image editor-image-empty" />;
    const style: CSSProperties = {};
    if (this.__width) style.width = `${this.__width}px`;
    else if (this.__height) style.height = `${this.__height}px`;
    const sized = this.__inline && (this.__width || this.__height) ? " editor-image-sized" : "";
    return (
      <img
        src={this.__src}
        alt={this.__altText}
        className={
          this.__inline ? `editor-image editor-image-inline${sized}` : "editor-image"
        }
        style={style}
        draggable={false}
        onError={(e) => e.currentTarget.classList.add("editor-image-broken")}
        onLoad={(e) => e.currentTarget.classList.remove("editor-image-broken")}
      />
    );
  }

  exportDOM(_editor: LexicalEditor): DOMExportOutput {
    const element = document.createElement("img");
    element.setAttribute("src", this.__src);
    element.setAttribute("alt", this.__altText);
    return { element };
  }

  exportJSON(): SerializedImageNode {
    return {
      ...super.exportJSON(),
      type: "image",
      version: 1,
      src: this.__src,
      altText: this.__altText,
      inline: this.__inline,
      width: this.__width,
      height: this.__height,
    };
  }

  static importJSON(serializedNode: SerializedImageNode): ImageNode {
    return $createImageNode(
      serializedNode.src,
      serializedNode.altText,
      serializedNode.inline ?? false,
      serializedNode.width ?? null,
      serializedNode.height ?? null,
    );
  }

  isInline(): boolean {
    return this.__inline;
  }
}

export function $createImageNode(
  src: string,
  altText = "",
  inline = false,
  width: number | null = null,
  height: number | null = null,
): ImageNode {
  return $applyNodeReplacement(new ImageNode(src, altText, inline, width, height));
}

export function $isImageNode(node: LexicalNode | null | undefined): node is ImageNode {
  return node instanceof ImageNode;
}
