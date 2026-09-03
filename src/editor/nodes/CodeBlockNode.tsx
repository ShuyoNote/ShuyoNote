import { DecoratorNode, type EditorConfig, type LexicalEditor, type NodeKey, type SerializedLexicalNode, type Spread } from "lexical";
import { useEffect, useRef, useState } from "react";
import { $getNodeByKey } from "lexical";
import { toast } from "../../store/toast";

export type SerializedCodeBlock = Spread<{ text: string; lang: string }, SerializedLexicalNode>;

export class CodeBlockNode extends DecoratorNode<JSX.Element> {
  __text: string;
  __lang: string;

  static getType(): string {
    return "code";
  }

  static clone(node: CodeBlockNode): CodeBlockNode {
    return new CodeBlockNode(node.__text, node.__lang, node.__key);
  }

  static importJSON(serialized: SerializedCodeBlock): CodeBlockNode {
    const text = serialized.text ?? childrenText((serialized as any).children);
    return $createCodeBlockNode(text, serialized.lang ?? "javascript");
  }

  exportJSON(): SerializedCodeBlock {
    return { ...super.exportJSON(), type: "code", text: this.__text, lang: this.__lang, version: 1 };
  }

  constructor(text = "", lang = "javascript", key?: NodeKey) {
    super(key);
    this.__text = text;
    this.__lang = lang;
  }

  getTextContent(): string {
    return this.__text;
  }
  getLanguage(): string {
    return this.__lang;
  }
  setText(v: string): void {
    const w = this.getWritable();
    w.__text = v;
  }
  setLang(l: string): void {
    const w = this.getWritable();
    w.__lang = l;
  }

  createDOM(_: EditorConfig): HTMLElement {
    const el = document.createElement("div");
    el.className = "editor-codeblock-node";
    el.style.position = "relative";
    return el;
  }
  updateDOM(_: unknown, __: HTMLElement): boolean {
    return false;
  }
  createDecorator(editor: LexicalEditor): JSX.Element {
    return <CodeBlockView nodeKey={this.getKey()} editor={editor} />;
  }
}

function childrenText(children: any[] | undefined): string {
  if (!Array.isArray(children)) return "";
  return children
    .map((c) => (typeof c?.text === "string" ? c.text : childrenText(c?.children)))
    .join("");
}

export function $createCodeBlockNode(text = "", lang = "javascript", key?: NodeKey): CodeBlockNode {
  return new CodeBlockNode(text, lang, key);
}

function highlightHtml(text: string, lang: string): string {
  const Prism = (window as any).Prism;
  if (!Prism) return escapeHtml(text);
  const grammar = Prism.languages?.[lang] || Prism.languages?.javascript || Prism.languages?.markup;
  if (!grammar) return escapeHtml(text);
  try {
    return Prism.highlight(text, grammar, lang);
  } catch {
    return escapeHtml(text);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const LANGS = [
  "plain", "javascript", "typescript", "python", "java", "c", "cpp", "csharp",
  "go", "rust", "json", "html", "css", "sql", "bash", "markdown", "yaml", "xml",
];

function CodeBlockView({ nodeKey, editor }: { nodeKey: string; editor: LexicalEditor }) {
  const [state, setState] = useState<{ text: string; lang: string }>({ text: "", lang: "javascript" });
  const preRef = useRef<HTMLPreElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const read = () => {
      const n = editor.getEditorState().read(() => $getNodeByKey(nodeKey) as CodeBlockNode | null);
      if (n) setState({ text: n.__text, lang: n.__lang });
    };
    read();
    const un = editor.registerUpdateListener(() => read());
    return un;
  }, [editor, nodeKey]);

  const onChange = (v: string) => {
    editor.update(() => {
      const n = $getNodeByKey(nodeKey) as CodeBlockNode | null;
      n?.setText(v);
    });
  };
  const onLang = (l: string) => {
    editor.update(() => {
      const n = $getNodeByKey(nodeKey) as CodeBlockNode | null;
      n?.setLang(l);
    });
  };

  const lines = state.text ? state.text.match(/\n/g)!.length + 1 : 1;
  const syncScroll = () => {
    if (preRef.current && taRef.current) preRef.current.scrollTop = taRef.current.scrollTop;
  };

  return (
    <div className="codeblock-view">
      <pre ref={preRef} className="codeblock-highlight" aria-hidden dangerouslySetInnerHTML={{ __html: highlightHtml(state.text, state.lang) }} />
      <textarea
        ref={taRef}
        className="codeblock-input"
        value={state.text}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onScroll={syncScroll}
        rows={lines}
      />
      <div className="codeblock-tools">
        <select
          className="editor-code-lang"
          value={state.lang}
          onChange={(e) => onLang(e.target.value)}
          title="切换语言"
        >
          {LANGS.map((l) => (
            <option key={l} value={l}>{l}</option>
          ))}
        </select>
        <button
          className="editor-code-copy"
          onClick={() => navigator.clipboard.writeText(state.text).then(() => toast("已复制代码", "success")).catch(() => toast("复制失败", "error"))}
        >
          复制
        </button>
      </div>
    </div>
  );
}
