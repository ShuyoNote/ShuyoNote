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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { useEditorStore } from "../../store/editor";
import { detectMermaidSyntax, mermaidSyntaxOptions } from "../../lib/mermaid";
import { useResolvedTheme } from "../../store/theme";
import { toast } from "../../store/toast";
import { blockIdOf, blockRevOf, withBlockId, withBlockRev } from "./blockIdHelpers";

export type SerializedMermaidNode = Spread<
  {
    src: string;
    syntax?: string;
    blockId?: string;
    blockRev?: number;
  },
  SerializedLexicalNode
>;

let mermaidReady = false;
// Shared across MermaidView instances: the theme mermaid was last initialised with.
const mermaidThemeRef = { current: "" };

export class MermaidNode extends DecoratorNode<JSX.Element> {
  __src: string;
  __syntax: string;
  /** 块身份（只有**顶层块**才有）。 */
  __blockId: string;
  /** 声明式块版本（Lamport）；`null` = 没有/不认识这个字段。 */
  __blockRev: number | null;

  static getType(): string {
    return "mermaid";
  }

  static clone(node: MermaidNode): MermaidNode {
    return new MermaidNode(node.__src, node.__syntax, node.__blockId, node.__key, node.__blockRev);
  }

  constructor(src = "", syntax = "", blockId = "", key?: NodeKey, blockRev: number | null = null) {
    super(key);
    this.__src = src;
    this.__syntax = syntax || detectMermaidSyntax(src);
    this.__blockId = blockId;
    this.__blockRev = blockRev;
  }

  afterCloneFrom(prevNode: this): void {
    super.afterCloneFrom(prevNode);
    this.__blockId = (prevNode as MermaidNode).__blockId;
    this.__blockRev = (prevNode as MermaidNode).__blockRev;
  }

  getBlockId(): string {
    return this.__blockId;
  }

  setBlockId(blockId: string): void {
    const writable = this.getWritable();
    writable.__blockId = blockId;
  }

  getBlockRev(): number | null {
    return this.__blockRev;
  }

  setBlockRev(blockRev: number | null): void {
    const writable = this.getWritable();
    writable.__blockRev = blockRev;
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
    return withBlockRev(
      withBlockId(
        {
          ...super.exportJSON(),
          type: "mermaid",
          version: 1,
          src: this.__src,
          syntax: this.__syntax,
        },
        this.__blockId,
      ),
      this.__blockRev,
    );
  }

  static importJSON(serializedNode: SerializedMermaidNode): MermaidNode {
    return $createMermaidNode(
      serializedNode.src ?? "",
      serializedNode.syntax ?? "",
      blockIdOf(serializedNode),
      blockRevOf(serializedNode),
    );
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

// ── 看图那几条（缩放 / 下载 / 全屏）──────────────────────────────────────────────
// 2026-10-05（owner 给了一张参考图："参考这个实现，包括功能"）：图块要像看图器那样能用。

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;
const ZOOM_STEP = 1.25;
const clampZoom = (z: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

/**
 * SVG 标记里的**自然像素尺寸**。为什么不能直接量 DOM：mermaid 默认 `useMaxWidth: true`
 * ⇒ 它把 `width="100%"`，真实尺寸只在 `viewBox`（备选：`width`/`height` 属性）里 ⇒ 读标记最省事、
 * 也不受"此刻缩放了多少"影响（量 DOM 会把自己量进去，变成循环）。
 */
function intrinsicSize(svgMarkup: string): { w: number; h: number } {
  const vb = /viewBox="([-\d.]+)[,\s]+([-\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)"/.exec(svgMarkup);
  if (vb) return { w: Number(vb[3]), h: Number(vb[4]) };
  const w = /\bwidth="([\d.]+)/.exec(svgMarkup);
  const h = /\bheight="([\d.]+)/.exec(svgMarkup);
  return { w: w ? Number(w[1]) : 0, h: h ? Number(h[1]) : 0 };
}

/** 落盘用：`<a download>`（桌面 WebView 与浏览器都吃这一套，且**不新增任何平台命令**）。 */
function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** 文件名里的时间戳（本地时间，分钟级）：同一页连按两次不会互相盖掉。 */
function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
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
  // ⭐ 2026-10-05：看图器那套状态 —— 图表/代码两个页签、缩放、是否全屏。
  const [tab, setTab] = useState<"chart" | "code">("chart");
  const [zoom, setZoom] = useState(1);
  const [isFull, setIsFull] = useState(false);
  const [editSrc, setEditSrc] = useState(src);
  const [editSyntax, setEditSyntax] = useState(syntax || detectMermaidSyntax(src));
  const renderSeq = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const resolved = useResolvedTheme(); // re-render mermaid when the theme changes
  const mermaidTheme: "dark" | "default" = resolved === "dark" ? "dark" : "default";
  const size = useMemo(() => intrinsicSize(svg), [svg]);

  // Render mermaid lazily (code-split) whenever src/syntax theme change.
  useEffect(() => {
    const seq = ++renderSeq.current;
    // ⚠️ 2026-10-05 修：这里原先写的是 `!editing` ⇒ **只读视图永远不渲染**（`editing` 是"正在编辑"
    //   这个本地状态，初始 false）⇒ 打开页面看到的是「（空白图形）」，`svg` 永远为空 ✗。
    //   owner 实测三次报"看不到图"，这是第三层（前两层：节点没入口 / CRDT 文档没迁移）。
    //   正确口径：**有源文且不在编辑态**才渲染；进入编辑态时清掉（此时渲染的是 textarea）。
    if (!src.trim() || editing) {
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
            flowchart: { htmlLabels: false, curve: "basis" },
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

  // ── 缩放 ─────────────────────────────────────────────────────────────────────
  // 口径："缩放乘的是**适应后的尺寸**"。实现靠 CSS `calc(min(100%, 自然宽) * zoom)`（见 JSX）——
  // 这样窄图按自然宽、宽图先缩到块宽，再整体乘 zoom，**不需要量 DOM**（量 DOM 会把自己量进去）。
  const zoomIn = useCallback(() => setZoom((z) => clampZoom(z * ZOOM_STEP)), []);
  const zoomOut = useCallback(() => setZoom((z) => clampZoom(z / ZOOM_STEP)), []);
  const resetZoom = useCallback(() => setZoom(1), []);

  // ── 全屏 ─────────────────────────────────────────────────────────────────────
  // ⚠️ 用**浏览器 Fullscreen API**，不是自建浮层：Esc/Android 返回键由 WebView 自己管 ⇒
  //    不需要进 `overlayStack`（那条路是给"应用自建的浮层"用的，见 `check-overlay-registry`）。
  //    用不了就**如实报**（不假装），不做 CSS 兜底 —— 兜底会变成一层"返回键关不掉"的浮层 ✗。
  useEffect(() => {
    const onChange = () => setIsFull(document.fullscreenElement === rootRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = useCallback(async () => {
    const el = rootRef.current;
    if (!el) return;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        return;
      }
      if (typeof el.requestFullscreen !== "function") throw new Error("这个 WebView 不支持全屏");
      await el.requestFullscreen();
    } catch (e) {
      toast(`全屏用不了：${e instanceof Error ? e.message : String(e)}`, "info");
    }
  }, []);

  // ── 下载 ─────────────────────────────────────────────────────────────────────
  // PNG（2×）为主：贴进文档/幻灯片不糊；**导出不了就退回落盘 SVG**（矢量、保真），并说清原因。
  // 底色铺白：mermaid 的 SVG 是透明底，贴进深色文档会看不清。
  const download = useCallback(async () => {
    const svgEl = rootRef.current?.querySelector("svg");
    if (!svgEl) return;
    const w = size.w > 0 ? size.w : 1200;
    const h = size.h > 0 ? size.h : 800;
    const clone = svgEl.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("width", String(w));
    clone.setAttribute("height", String(h));
    const xml = new XMLSerializer().serializeToString(clone);
    const svgBlob = new Blob([xml], { type: "image/svg+xml;charset=utf-8" });
    const name = `mermaid-${stamp()}`;
    const scale = 2;
    try {
      const url = URL.createObjectURL(svgBlob);
      try {
        const img = new Image();
        await new Promise<void>((res, rej) => {
          img.onload = () => res();
          img.onerror = () => rej(new Error("SVG 没被载入"));
          img.src = url;
        });
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(w * scale);
        canvas.height = Math.round(h * scale);
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("拿不到 canvas 2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const png = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
        if (!png) throw new Error("canvas.toBlob 给了 null");
        saveBlob(png, `${name}.png`);
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch (e) {
      saveBlob(svgBlob, `${name}.svg`);
      toast(`PNG 导出失败（${e instanceof Error ? e.message : String(e)}）⇒ 已改存 SVG（矢量、保真）`, "info");
    }
  }, [size]);

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
    <div className="editor-mermaid" ref={rootRef} onClick={(e) => e.stopPropagation()}>
      {/* ⭐ 2026-10-05：顶栏 = 左边「图表/代码」页签 ＋ 语法标签，右边 缩放/下载/全屏/编辑。
          整条**悬停才出现**（owner 前两条要求的延续）；全屏时强制显示（那时鼠标不一定在块上）。
          ⛔ 别把它做成 `*-overlay` / `*-popover` 类名 —— 这不是应用自建浮层（见下面全屏那段注释）。 */}
      <div className="editor-mermaid-bar">
        <div className="editor-mermaid-tabs" role="tablist" aria-label="mermaid 视图">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "chart"}
            className={`editor-mermaid-tab${tab === "chart" ? " is-on" : ""}`}
            onClick={() => setTab("chart")}
          >
            图表
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "code"}
            className={`editor-mermaid-tab${tab === "code" ? " is-on" : ""}`}
            onClick={() => setTab("code")}
          >
            代码
          </button>
        </div>
        <span className="editor-mermaid-syntax-label">{syntax || detectMermaidSyntax(src)}</span>
        <div className="editor-mermaid-tools">
          <button
            type="button"
            className="editor-mermaid-tool"
            title="缩小"
            aria-label="缩小"
            onClick={zoomOut}
            disabled={zoom <= ZOOM_MIN}
          >
            −
          </button>
          <button
            type="button"
            className="editor-mermaid-tool"
            title="放大"
            aria-label="放大"
            onClick={zoomIn}
            disabled={zoom >= ZOOM_MAX}
          >
            ＋
          </button>
          <button
            type="button"
            className={`editor-mermaid-tool is-zoom${zoom === 1 ? "" : " is-set"}`}
            title="恢复 100%"
            onClick={resetZoom}
          >
            {Math.round(zoom * 100)}%
          </button>
          <span className="editor-mermaid-sep" aria-hidden="true" />
          <button
            type="button"
            className="editor-mermaid-tool"
            title="下载图片（PNG 2×；导出不了就存 SVG）"
            // 「代码」页里没有 SVG 可导 ⇒ 禁用（比"点了没反应"诚实）
            disabled={tab !== "chart" || !svg}
            onClick={() => void download()}
          >
            下载
          </button>
          <button
            type="button"
            className="editor-mermaid-tool"
            title={isFull ? "退出全屏（Esc）" : "全屏（Esc 退出）"}
            onClick={() => void toggleFullscreen()}
          >
            {isFull ? "退出全屏" : "全屏"}
          </button>
          <button type="button" className="editor-mermaid-tool" title="编辑源文本" onClick={startEdit}>
            编辑
          </button>
        </div>
      </div>

      {tab === "code" ? (
        // 代码页只**看**：改源文走「编辑」（那条路带语法选择与保存/取消，不在这里重复一套）。
        <pre className="editor-mermaid-code">{src}</pre>
      ) : (
        <div className="editor-mermaid-render">
          {svg ? (
            <div
              className="editor-mermaid-svg"
              // 缩放乘的是"适应后的尺寸"：`min(100%, 自然宽) * zoom`（自然宽读不到就退回百分比）。
              style={{
                width:
                  size.w > 0
                    ? `calc(min(100%, ${size.w}px) * ${zoom})`
                    : `${Math.round(zoom * 100)}%`,
              }}
              dangerouslySetInnerHTML={{ __html: svg }}
            />
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
      )}
    </div>
  );
}

export function $createMermaidNode(src = "", syntax = "", blockId = "", blockRev: number | null = null): MermaidNode {
  return $applyNodeReplacement(new MermaidNode(src, syntax, blockId, undefined, blockRev));
}

export function $isMermaidNode(node: LexicalNode | null | undefined): node is MermaidNode {
  return node instanceof MermaidNode;
}

// Re-export for the caller's edit flow.
export { $getMermaidNode as getMermaidNode };
