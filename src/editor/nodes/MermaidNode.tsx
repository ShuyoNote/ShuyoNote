import {
  $applyNodeReplacement,
  $getNodeByKey,
  DecoratorNode,
  type DOMExportOutput,
  type EditorConfig,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from "lexical";
import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { useEditorStore } from "../../store/editor";
import { detectMermaidSyntax, mermaidSyntaxOptions } from "../../lib/mermaid";
import { useResolvedTheme } from "../../store/theme";

export type SerializedMermaidNode = Spread<
  {
    src: string;
    syntax?: string;
  },
  SerializedLexicalNode
>;

let mermaidReady = false;
// Shared across MermaidView instances: the theme mermaid was last initialised with.
const mermaidThemeRef = { current: "" };

export class MermaidNode extends DecoratorNode<JSX.Element> {
  __src: string;
  __syntax: string;

  static getType(): string {
    return "mermaid";
  }

  static clone(node: MermaidNode): MermaidNode {
    return new MermaidNode(node.__src, node.__syntax, node.__key);
  }

  constructor(src = "", syntax = "", key?: NodeKey) {
    super(key);
    this.__src = src;
    this.__syntax = syntax || detectMermaidSyntax(src);
  }

  $config() {
    return this.config("mermaid", { extends: DecoratorNode<JSX.Element> });
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const span = document.createElement("span");
    span.className = "editor-mermaid-container";
    return span;
  }

  updateDOM(): boolean {
    return false;
  }

  setMermaid(src: string, syntax?: string): void {
    const writable = this.getWritable();
    writable.__src = src;
    writable.__syntax = syntax || detectMermaidSyntax(src);
  }

  // Surface the source so the page's content_text (search/backlinks) sees it.
  getTextContent(): string {
    return this.__src;
  }

  decorate(): JSX.Element {
    return (
      <MermaidView
        src={this.__src}
        syntax={this.__syntax}
        node={this}
      />
    );
  }

  exportDOM(_editor: LexicalEditor): DOMExportOutput {
    const el = document.createElement("pre");
    el.textContent = this.__src;
    return { element: el };
  }

  exportJSON(): SerializedMermaidNode {
    return {
      ...super.exportJSON(),
      type: "mermaid",
      version: 1,
      src: this.__src,
      syntax: this.__syntax,
    };
  }

  static importJSON(serializedNode: SerializedMermaidNode): MermaidNode {
    return $createMermaidNode(serializedNode.src ?? "", serializedNode.syntax ?? "");
  }
}

function $getMermaidNode(key: NodeKey): MermaidNode | null {
  // Resolve a MermaidNode by key from the active editor (inside update/read).
  try {
    const editor = useEditorStore.getState().editor;
    if (!editor) return null;
    let out: MermaidNode | null = null;
    editor.getEditorState().read(() => {
      const n = $getNodeByKey(key);
      if (n && $isMermaidNode(n)) out = n;
    });
    return out;
  } catch {
    return null;
  }
}

function MermaidView({
  src,
  syntax,
  node,
}: {
  src: string;
  syntax: string;
  node: MermaidNode;
}) {
  const [svg, setSvg] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editSrc, setEditSrc] = useState(src);
  const [editSyntax, setEditSyntax] = useState(syntax || detectMermaidSyntax(src));
  const renderSeq = useRef(0);
  const resolved = useResolvedTheme(); // re-render mermaid when the theme changes
  const mermaidTheme: "dark" | "default" = resolved === "dark" ? "dark" : "default";

  // Render mermaid lazily (code-split) whenever src/syntax theme change.
  useEffect(() => {
    const seq = ++renderSeq.current;
    if (!src.trim() || !editing) {
      setSvg("");
      setError(null);
      return;
    }
    async function render() {
      try {
        const mod = await import("mermaid");
        const mermaid = mod.default;
        if (!mermaidReady || mermaidThemeRef.current !== mermaidTheme) {
          mermaid.initialize({
            startOnLoad: false,
            theme: mermaidTheme,
            securityLevel: "loose",
            flowchart: { htmlLabels: true, curve: "basis", useMaxWidth: false },
          });
          mermaidReady = true;
          mermaidThemeRef.current = mermaidTheme;
        }
        const id = `sn-${Math.random().toString(36).slice(2, 10)}`;
        const { svg: out } = await mermaid.render(id, src);
        if (seq !== renderSeq.current) return;
        setSvg(out);
        setError(null);
      } catch (e) {
        if (seq !== renderSeq.current) return;
        setSvg("");
        setError(String(e));
      }
    }
    render();
  }, [src, editing, mermaidTheme]);

  const startEdit = useCallback(() => {
    setEditSrc(src);
    setEditSyntax(syntax || detectMermaidSyntax(src));
    setEditing(true);
  }, [src, syntax]);

  const commit = useCallback(() => {
    const editor = useEditorStore.getState().editor;
    if (editor) {
      editor.update(() => node.setMermaid(editSrc.trim(), editSyntax));
    }
    setEditing(false);
  }, [editSrc, editSyntax, node]);

  const cancel = useCallback(() => {
    setEditing(false);
  }, []);

  if (editing) {
    return (
      <div className="editor-mermaid" onClick={(e) => e.stopPropagation()}>
        <textarea
          className="editor-mermaid-input"
          value={editSrc}
          onChange={(e) => setEditSrc(e.target.value)}
          rows={6}
          placeholder={"graph TD\n  A-->B"}
        />
        <div className="editor-mermaid-toolbar">
          <select
            className="editor-mermaid-syntax"
            value={editSyntax}
            onChange={(e) => setEditSyntax(e.target.value)}
          >
            {mermaidSyntaxOptions().map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <button className="editor-mermaid-btn" onClick={commit}>
            保存
          </button>
          <button className="editor-mermaid-btn" onClick={cancel}>
            取消
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="editor-mermaid" onClick={(e) => e.stopPropagation()}>
      <div className="editor-mermaid-render">
        {svg ? (
          <div className="editor-mermaid-svg" dangerouslySetInnerHTML={{ __html: svg }} />
        ) : error ? (
          <div className="editor-mermaid-err">
            <span>渲染失败：{error}</span>
            <button className="editor-mermaid-btn" onClick={startEdit}>
              编辑源文本
            </button>
          </div>
        ) : (
          <span className="editor-mermaid-placeholder">（空白图形）</span>
        )}
      </div>
      <div className="editor-mermaid-toolbar">
        <span className="editor-mermaid-syntax-label">{syntax || detectMermaidSyntax(src)}</span>
        <button className="editor-mermaid-btn" onClick={startEdit}>
          编辑
        </button>
      </div>
    </div>
  );
}

export function $createMermaidNode(src = "", syntax = ""): MermaidNode {
  return $applyNodeReplacement(new MermaidNode(src, syntax));
}

export function $isMermaidNode(node: LexicalNode | null | undefined): node is MermaidNode {
  return node instanceof MermaidNode;
}

// Re-export for the caller's edit flow.
export { $getMermaidNode as getMermaidNode };
