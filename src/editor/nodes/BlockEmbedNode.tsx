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
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { api } from "../../lib/api";
import type { BlockInfo } from "../../types";
import { useBlockCache } from "../../store/blockCache";
import { useEditorStore } from "../../store/editor";
import { useNotes } from "../../store/notes";

export type SerializedBlockEmbedNode = Spread<
  { targetId: string },
  SerializedLexicalNode
>;

// Block-level decorator for `{{blockId}}`: a read-only mirror of the target block.
export class BlockEmbedNode extends DecoratorNode<JSX.Element> {
  __blockId: string;

  static getType(): string {
    return "blockembed";
  }

  static clone(node: BlockEmbedNode): BlockEmbedNode {
    return new BlockEmbedNode(node.__blockId, node.__key);
  }

  constructor(blockId: string, key?: NodeKey) {
    super(key);
    this.__blockId = blockId;
  }

  $config() {
    return this.config("blockembed", { extends: DecoratorNode<JSX.Element> });
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const div = document.createElement("div");
    div.className = "editor-block-embed";
    return div;
  }

  updateDOM(): boolean {
    return false;
  }

  decorate(): JSX.Element {
    return <BlockEmbedView blockId={this.__blockId} />;
  }

  exportDOM(_editor: LexicalEditor): DOMExportOutput {
    const element = document.createElement("div");
    element.setAttribute("data-block-embed", this.__blockId);
    element.textContent = `{{${this.__blockId}}}`;
    return { element };
  }

  exportJSON(): SerializedBlockEmbedNode {
    return {
      ...super.exportJSON(),
      type: "blockembed",
      targetId: this.__blockId,
      version: 1,
    };
  }

  static importJSON(serializedNode: SerializedBlockEmbedNode): BlockEmbedNode {
    return $createBlockEmbedNode(serializedNode.targetId);
  }

  isInline(): false {
    return false;
  }
}

export function $createBlockEmbedNode(blockId: string): BlockEmbedNode {
  return $applyNodeReplacement(new BlockEmbedNode(blockId));
}

export function $isBlockEmbedNode(node: LexicalNode | null | undefined): node is BlockEmbedNode {
  return node instanceof BlockEmbedNode;
}

function BlockEmbedView({ blockId }: { blockId: string }) {
  const currentId = useNotes((s) => s.currentId);
  const revision = useBlockCache((s) => s.revision);
  const [info, setInfo] = useState<BlockInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    api
      .resolveBlock(blockId)
      .then(setInfo)
      .catch((e) => setError(String(e)));
  }, [blockId]);

  useEffect(() => {
    load();
  }, [load, revision]);

  const jump = () => {
    useEditorStore.getState().setFocusBlockId(blockId);
    if (info && info.page_id !== currentId) {
      useNotes.getState().openPage(info.page_id);
    }
  };

  if (error) {
    return (
      <div className="block-embed-error">
        嵌入块已失效
        <button
          onClick={(e) => {
            e.stopPropagation();
            load();
          }}
        >
          重试
        </button>
      </div>
    );
  }

  if (!info) {
    return <div className="block-embed-loading">加载中…</div>;
  }

  return (
    <div className="block-embed" onClick={jump} title="点击跳转到原块">
      <div className="block-embed-meta">
        <span className="block-embed-from">嵌入自：{info.page_title || "未命名"}</span>
        <button
          className="block-embed-refresh"
          title="刷新"
          onClick={(e) => {
            e.stopPropagation();
            load();
          }}
        >
          ↻
        </button>
      </div>
      <div className="block-embed-content">{info.content || info.snippet || "(空块)"}</div>
    </div>
  );
}
