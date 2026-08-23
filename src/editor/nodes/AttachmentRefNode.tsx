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
import { openPath } from "@tauri-apps/plugin-opener";
import type { JSX } from "react";

export type SerializedAttachmentRefNode = Spread<
  {
    attachmentId: string;
    name: string;
    size: number;
    mime: string;
    hash: string;
    path: string;
  },
  SerializedLexicalNode
>;

function formatSize(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function FileGlyph({ mime }: { mime: string }) {
  // Monoline SVG glyph (anti-AI-slop: no emoji-as-icon); color hints at type.
  if (mime.startsWith("image/")) {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <path d="M21 15l-5-5-5 5-3-3-5 5" />
      </svg>
    );
  }
  if (mime.startsWith("video/") || mime.startsWith("audio/")) {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M10 9l5 3-5 3z" />
      </svg>
    );
  }
  if (mime === "application/pdf") {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
        <path d="M14 3v6h6" />
      </svg>
    );
  }
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <path d="M14 3v6h6" />
    </svg>
  );
}

export class AttachmentRefNode extends DecoratorNode<JSX.Element> {
  __attachmentId: string;
  __name: string;
  __size: number;
  __mime: string;
  __hash: string;
  __path: string;

  static getType(): string {
    return "attachment-ref";
  }

  static clone(node: AttachmentRefNode): AttachmentRefNode {
    return new AttachmentRefNode(
      node.__attachmentId,
      node.__name,
      node.__size,
      node.__mime,
      node.__hash,
      node.__path,
      node.__key,
    );
  }

  constructor(
    attachmentId: string,
    name: string,
    size: number,
    mime = "",
    hash = "",
    path = "",
    key?: NodeKey,
  ) {
    super(key);
    this.__attachmentId = attachmentId;
    this.__name = name;
    this.__size = size;
    this.__mime = mime;
    this.__hash = hash;
    this.__path = path;
  }

  $config() {
    return this.config("attachment-ref", { extends: DecoratorNode<JSX.Element> });
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const span = document.createElement("span");
    span.className = "editor-attachment-ref-container";
    return span;
  }

  updateDOM(): boolean {
    return false;
  }

  decorate(): JSX.Element {
    const open = () => {
      if (this.__path) {
        void openPath(this.__path);
      }
    };
    return (
      <span
        className="editor-attachment-ref"
        title={`${this.__name} · ${formatSize(this.__size)}`}
        onClick={open}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            open();
          }
        }}
        role="button"
        tabIndex={0}
      >
        <span className="editor-file-glyph">
          <FileGlyph mime={this.__mime} />
        </span>
        <span className="editor-file-info">
          <span className="editor-file-name">{this.__name || "未命名文件"}</span>
          <span className="editor-file-meta">{formatSize(this.__size)}</span>
        </span>
        <span className="editor-file-open" aria-hidden>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            <path d="M15 3h6v6" />
            <path d="M10 14L21 3" />
          </svg>
        </span>
      </span>
    );
  }

  exportDOM(_editor: LexicalEditor): DOMExportOutput {
    const element = document.createElement("span");
    element.className = "editor-attachment-ref";
    element.textContent = this.__name || "文件";
    return { element };
  }

  exportJSON(): SerializedAttachmentRefNode {
    return {
      ...super.exportJSON(),
      type: "attachment-ref",
      version: 1,
      attachmentId: this.__attachmentId,
      name: this.__name,
      size: this.__size,
      mime: this.__mime,
      hash: this.__hash,
      path: this.__path,
    };
  }

  static importJSON(serializedNode: SerializedAttachmentRefNode): AttachmentRefNode {
    return $createAttachmentRefNode(
      serializedNode.attachmentId,
      serializedNode.name,
      serializedNode.size ?? 0,
      serializedNode.mime ?? "",
      serializedNode.hash ?? "",
      serializedNode.path ?? "",
    );
  }

  isInline(): false {
    return false;
  }
}

export function $createAttachmentRefNode(
  attachmentId: string,
  name: string,
  size = 0,
  mime = "",
  hash = "",
  path = "",
): AttachmentRefNode {
  return $applyNodeReplacement(
    new AttachmentRefNode(attachmentId, name, size, mime, hash, path),
  );
}

export function $isAttachmentRefNode(node: LexicalNode | null | undefined): node is AttachmentRefNode {
  return node instanceof AttachmentRefNode;
}
