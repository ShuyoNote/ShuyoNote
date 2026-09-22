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
import { blockIdOf, blockRevOf, withBlockId, withBlockRev } from "./blockIdHelpers";

export type SerializedBlockEmbedNode = Spread<
  { targetId: string; blockId?: string; blockRev?: number },
  SerializedLexicalNode
>;

// Block-level decorator for `{{blockId}}`: a read-only mirror of the target block.
export class BlockEmbedNode extends DecoratorNode<JSX.Element> {
  /** ⚠️ **被引用的目标块**（序列化成 `targetId`）—— 这个名字在本类里**不是**"自己的身份" */
  __blockId: string;
  /**
   * **自己的**块身份。⚠️ 字段名**故意**不叫 `__blockId`：本类里 `__blockId` 已经被"引用目标"占用
   * （`BlockRefNode` 同理）。序列化出去的字段仍是标准的 `blockId`（= 身份），两者不冲突。
   * 只有**顶层块**才有身份（见 docs/plans/2026-09-18-crdt-block-id-ownership.md）。
   */
  __selfBlockId: string;
  /** 声明式块版本（Lamport）；`null` = 没有/不认识这个字段。 */
  __blockRev: number | null;

  static getType(): string {
    return "blockembed";
  }

  static clone(node: BlockEmbedNode): BlockEmbedNode {
    return new BlockEmbedNode(node.__blockId, node.__selfBlockId, node.__key, node.__blockRev);
  }

  constructor(blockId: string, selfBlockId = "", key?: NodeKey, blockRev: number | null = null) {
    super(key);
    this.__blockId = blockId;
    this.__selfBlockId = selfBlockId;
    this.__blockRev = blockRev;
  }

  afterCloneFrom(prevNode: this): void {
    super.afterCloneFrom(prevNode);
    const prev = prevNode as BlockEmbedNode;
    this.__blockId = prev.__blockId;
    this.__selfBlockId = prev.__selfBlockId;
    this.__blockRev = prev.__blockRev;
  }

  getBlockId(): string {
    return this.__selfBlockId;
  }

  setBlockId(selfBlockId: string): void {
    const writable = this.getWritable();
    writable.__selfBlockId = selfBlockId;
  }

  getBlockRev(): number | null {
    return this.__blockRev;
  }

  setBlockRev(blockRev: number | null): void {
    const writable = this.getWritable();
    writable.__blockRev = blockRev;
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
    return withBlockRev(
      withBlockId(
        {
          ...super.exportJSON(),
          type: "blockembed",
          targetId: this.__blockId,
          version: 1,
        },
        this.__selfBlockId,
      ),
      this.__blockRev,
    );
  }

  static importJSON(serializedNode: SerializedBlockEmbedNode): BlockEmbedNode {
    return $createBlockEmbedNode(serializedNode.targetId, blockIdOf(serializedNode), blockRevOf(serializedNode));
  }

  isInline(): false {
    return false;
  }
}

export function $createBlockEmbedNode(
  blockId: string,
  selfBlockId?: string,
  blockRev: number | null = null,
): BlockEmbedNode {
  return $applyNodeReplacement(new BlockEmbedNode(blockId, selfBlockId ?? "", undefined, blockRev));
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
