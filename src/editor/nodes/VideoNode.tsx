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

export type SerializedVideoNode = Spread<
  { src: string; hash?: string | null; mime?: string | null },
  SerializedLexicalNode
>;

export class VideoNode extends DecoratorNode<JSX.Element> {
  __src: string;
  __hash: string | null;
  __mime: string | null;

  static getType(): string {
    return "video";
  }

  static clone(node: VideoNode): VideoNode {
    return new VideoNode(node.__src, node.__hash, node.__mime, node.__key);
  }

  constructor(src: string, hash: string | null = null, mime: string | null = null, key?: NodeKey) {
    super(key);
    this.__src = src;
    this.__hash = hash;
    this.__mime = mime;
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
    return { element };
  }

  exportJSON(): SerializedVideoNode {
    return {
      ...super.exportJSON(),
      type: "video",
      version: 1,
      src: this.__src,
      hash: this.__hash ?? undefined,
      mime: this.__mime ?? undefined,
    };
  }

  static importJSON(serializedNode: SerializedVideoNode): VideoNode {
    return $createVideoNode(serializedNode.src, serializedNode.hash ?? null, serializedNode.mime ?? null);
  }

  isInline(): false {
    return false;
  }
}

export function $createVideoNode(src: string, hash?: string | null, mime?: string | null): VideoNode {
  return $applyNodeReplacement(new VideoNode(src, hash ?? null, mime ?? null));
}

export function $isVideoNode(node: LexicalNode | null | undefined): node is VideoNode {
  return node instanceof VideoNode;
}
