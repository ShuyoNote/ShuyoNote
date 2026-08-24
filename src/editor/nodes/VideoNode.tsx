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

export type SerializedVideoNode = Spread<{ src: string }, SerializedLexicalNode>;

export class VideoNode extends DecoratorNode<JSX.Element> {
  __src: string;

  static getType(): string {
    return "video";
  }

  static clone(node: VideoNode): VideoNode {
    return new VideoNode(node.__src, node.__key);
  }

  constructor(src: string, key?: NodeKey) {
    super(key);
    this.__src = src;
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
    if (!this.__src) return <span className="editor-video editor-image-empty" />;
    return <video src={this.__src} controls className="editor-video" />;
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
    };
  }

  static importJSON(serializedNode: SerializedVideoNode): VideoNode {
    return $createVideoNode(serializedNode.src);
  }

  isInline(): false {
    return false;
  }
}

export function $createVideoNode(src: string): VideoNode {
  return $applyNodeReplacement(new VideoNode(src));
}

export function $isVideoNode(node: LexicalNode | null | undefined): node is VideoNode {
  return node instanceof VideoNode;
}
