import { DecoratorNode, type EditorConfig, type LexicalEditor, type NodeKey, type SerializedLexicalNode, type Spread } from "lexical";
import { useEffect, useRef, useState } from "react";
import { $getNodeByKey } from "lexical";
import { toast } from "../../store/toast";

const KEYWORDS = new Set([
  "if","else","for","while","do","switch","case","break","continue","return","void","int","char",
  "float","double","long","short","bool","true","false","null","const","let","var","function",
  "class","struct","enum","import","export","from","new","delete","this","static","public","private",
  "protected","try","catch","throw","finally","extends","implements","interface","type","namespace",
  "using","def","print","printf","scanf","main","async","await","in","of","not","and","or",
]);
const STR = /^('(?:\\.|[^'])*'|"(?:\\.|[^"])*")/;

function highlightHtml(text: string, _lang: string): string {
  const esc = escapeHtml(text);
  // 逐字符扫描，为 注释/字符串/数字/关键字/函数 包裹 token span。
  let out = "";
  const s = esc;
  let i = 0;
  while (i < s.length) {
    const rest = s.slice(i);
    // 行注释
    if (rest.startsWith("//")) {
      const end = rest.indexOf("\n");
      const c = end === -1 ? rest : rest.slice(0, end);
      out += `<span class="tok-comment">${c}</span>`;
      i += c.length;
      continue;
    }
    // 注释 /* ... */
    if (rest.startsWith("/*")) {
      const end = rest.indexOf("*/");
      const c = end === -1 ? rest : rest.slice(0, end + 2);
      out += `<span class="tok-comment">${c}</span>`;
      i += c.length;
      continue;
    }
    // 字符串
    const m = rest.match(STR);
    if (m) {
      out += `<span class="tok-string">${m[0]}</span>`;
      i += m[0].length;
      continue;
    }
    // 数字
    const num = /^\d+(\.\d+)?/.exec(rest);
    if (num) {
      out += `<span class="tok-number">${num[0]}</span>`;
      i += num[0].length;
      continue;
    }
    // 单词（可能关键字或函数）
    const word = /^[A-Za-z_]\w*/.exec(rest);
    if (word) {
      const w = word[0];
      const nextChar = s[i + w.length];
      if (KEYWORDS.has(w)) {
        out += `<span class="tok-keyword">${w}</span>`;
      } else if (nextChar === "(") {
        out += `<span class="tok-func">${w}</span>`;
      } else {
        out += `<span class="tok-plain">${w}</span>`;
      }
      i += w.length;
      continue;
    }
    out += s[i];
    i += 1;
  }
  return out;
}

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
      <div className="codeblock-lines" aria-hidden>
        {Array.from({ length: lines }, (_, i) => i + 1).join("\n")}
      </div>
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
