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
import { MediaResolver } from "./MediaResolver";
import { EXPORT_HASH_ATTR, EXPORT_MIME_ATTR } from "../../lib/exportInline";
import { blockIdOf, withBlockId } from "./blockIdHelpers";

export type SerializedImageNode = Spread<
  {
    src: string;
    altText: string;
    inline?: boolean;
    width?: number | null;
    height?: number | null;
    hash?: string | null;
    mime?: string | null;
    blockId?: string;
  },
  SerializedLexicalNode
>;

export class ImageNode extends DecoratorNode<JSX.Element> {
  __src: string;
  __altText: string;
  __inline: boolean;
  __width: number | null;
  __height: number | null;
  __hash: string | null;
  __mime: string | null;
  /** 块身份（只有**顶层块**才有；行内图片 `inline=true` 与嵌套实例都不给）。 */
  __blockId: string;

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
      node.__hash,
      node.__mime,
      node.__blockId,
      node.__key,
    );
  }

  constructor(
    src: string,
    altText = "",
    inline = false,
    width: number | null = null,
    height: number | null = null,
    hash: string | null = null,
    mime: string | null = null,
    blockId = "",
    key?: NodeKey,
  ) {
    super(key);
    this.__src = src;
    this.__altText = altText;
    this.__inline = inline;
    this.__width = width;
    this.__height = height;
    this.__hash = hash;
    this.__mime = mime;
    this.__blockId = blockId;
  }

  afterCloneFrom(prevNode: this): void {
    super.afterCloneFrom(prevNode);
    this.__blockId = (prevNode as ImageNode).__blockId;
  }

  getBlockId(): string {
    return this.__blockId;
  }

  setBlockId(blockId: string): void {
    const writable = this.getWritable();
    writable.__blockId = blockId;
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
    const style: CSSProperties = {};
    if (this.__width) style.width = `${this.__width}px`;
    else if (this.__height) style.height = `${this.__height}px`;
    const sized = this.__inline && (this.__width || this.__height) ? " editor-image-sized" : "";
    return (
      <MediaResolver
        hash={this.__hash}
        mime={this.__mime}
        src={this.__src}
        render={(url) =>
          url ? (
            <img
              src={url}
              alt={this.__altText}
              className={
                this.__inline ? `editor-image editor-image-inline${sized}` : "editor-image"
              }
              style={style}
              draggable={false}
              onError={(e) => e.currentTarget.classList.add("editor-image-broken")}
              onLoad={(e) => e.currentTarget.classList.remove("editor-image-broken")}
            />
          ) : (
            <span className="editor-image editor-image-empty" />
          )
        }
      />
    );
  }

  exportDOM(_editor: LexicalEditor): DOMExportOutput {
    const element = document.createElement("img");
    element.setAttribute("src", this.__src);
    element.setAttribute("alt", this.__altText);
    // ⚠️ 只写 `__src` 是不够的：桌面端它是 `attachment://localhost/…`（应用专有协议），
    // Web 端是裸文件路径——**离开应用都不是有效 URL**，所以导出的 HTML/PDF 里图片是空的。
    // 这里留下"这份图是内容寻址附件"的线索，由 `lib/exportInline` 统一读字节 → 内联 data: URL
    // （它是异步的，而 exportDOM 必须同步，所以不能在这里直接读）。
    if (this.__hash) {
      element.setAttribute(EXPORT_HASH_ATTR, this.__hash);
      if (this.__mime) element.setAttribute(EXPORT_MIME_ATTR, this.__mime);
    }
    return { element };
  }

  exportJSON(): SerializedImageNode {
    return withBlockId(
      {
        ...super.exportJSON(),
        type: "image",
        version: 1,
        src: this.__src,
        altText: this.__altText,
        inline: this.__inline,
        width: this.__width,
        height: this.__height,
        hash: this.__hash ?? undefined,
        mime: this.__mime ?? undefined,
      },
      this.__blockId,
    );
  }

  static importJSON(serializedNode: SerializedImageNode): ImageNode {
    return $createImageNode(
      serializedNode.src,
      serializedNode.altText,
      serializedNode.inline ?? false,
      serializedNode.width ?? null,
      serializedNode.height ?? null,
      serializedNode.hash ?? null,
      serializedNode.mime ?? null,
      blockIdOf(serializedNode),
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
  hash?: string | null,
  mime?: string | null,
  blockId?: string,
): ImageNode {
  return $applyNodeReplacement(
    new ImageNode(src, altText, inline, width, height, hash, mime, blockId ?? ""),
  );
}

export function $isImageNode(node: LexicalNode | null | undefined): node is ImageNode {
  return node instanceof ImageNode;
}
