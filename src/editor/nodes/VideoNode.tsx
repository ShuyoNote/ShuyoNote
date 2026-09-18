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
import { EXPORT_HASH_ATTR, EXPORT_MIME_ATTR } from "../../lib/exportInline";
import { blockIdOf, withBlockId } from "./blockIdHelpers";

export type SerializedVideoNode = Spread<
  { src: string; hash?: string | null; mime?: string | null; blockId?: string },
  SerializedLexicalNode
>;

export class VideoNode extends DecoratorNode<JSX.Element> {
  __src: string;
  __hash: string | null;
  __mime: string | null;
  /** 块身份（只有**顶层块**才有；行内/嵌套实例不给）。 */
  __blockId: string;

  static getType(): string {
    return "video";
  }

  static clone(node: VideoNode): VideoNode {
    return new VideoNode(node.__src, node.__hash, node.__mime, node.__blockId, node.__key);
  }

  constructor(src: string, hash: string | null = null, mime: string | null = null, blockId = "", key?: NodeKey) {
    super(key);
    this.__src = src;
    this.__hash = hash;
    this.__mime = mime;
    this.__blockId = blockId;
  }

  afterCloneFrom(prevNode: this): void {
    super.afterCloneFrom(prevNode);
    this.__blockId = (prevNode as VideoNode).__blockId;
  }

  getBlockId(): string {
    return this.__blockId;
  }

  setBlockId(blockId: string): void {
    const writable = this.getWritable();
    writable.__blockId = blockId;
  }

  $config() {
    return this.config("video", { extends: DecoratorNode<JSX.Element> });
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const span = document.createElement("span");
    span.className = "editor-video-container";
    return span;
  }

  updateDOM(): boolean {
    return false;
  }

  decorate(): JSX.Element {
    return (
      <MediaResolver
        hash={this.__hash}
        mime={this.__mime}
        src={this.__src}
        render={(url) =>
          url ? (
            <video src={url} controls className="editor-video" />
          ) : (
            <span className="editor-video editor-image-empty" />
          )
        }
      />
    );
  }

  exportDOM(_editor: LexicalEditor): DOMExportOutput {
    const element = document.createElement("video");
    element.setAttribute("src", this.__src);
    element.setAttribute("controls", "true");
    // 与 ImageNode 同理：`__src` 是应用专有 URL，导出时必须内联（见 lib/exportInline）。
    if (this.__hash) {
      element.setAttribute(EXPORT_HASH_ATTR, this.__hash);
      if (this.__mime) element.setAttribute(EXPORT_MIME_ATTR, this.__mime);
    }
    return { element };
  }

  exportJSON(): SerializedVideoNode {
    return withBlockId(
      {
        ...super.exportJSON(),
        type: "video",
        version: 1,
        src: this.__src,
        hash: this.__hash ?? undefined,
        mime: this.__mime ?? undefined,
      },
      this.__blockId,
    );
  }

  static importJSON(serializedNode: SerializedVideoNode): VideoNode {
    return $createVideoNode(
      serializedNode.src,
      serializedNode.hash ?? null,
      serializedNode.mime ?? null,
      blockIdOf(serializedNode),
    );
  }

  isInline(): false {
    return false;
  }
}

export function $createVideoNode(
  src: string,
  hash?: string | null,
  mime?: string | null,
  blockId?: string,
): VideoNode {
  return $applyNodeReplacement(new VideoNode(src, hash ?? null, mime ?? null, blockId ?? ""));
}

export function $isVideoNode(node: LexicalNode | null | undefined): node is VideoNode {
  return node instanceof VideoNode;
}
