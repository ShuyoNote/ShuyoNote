// M26 公式 —— Notion 风格的公式编辑器弹窗. Each category tab (αβ / ÷× / ≤≥ / xₐ /
// ↑↓ / H₂O) opens a dropdown symbol panel; the LaTeX input accepts typing and
// paste/drag of a formula image. Ctrl+Enter commits. Rendered on the app.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useFormulaEditorStore } from "../store/formulaEditor";
import { useAiStore } from "../store/ai";
import type { ProviderConfig } from "../lib/ai/llm";
import { recognizeFormulaImage, fileToDataUrl } from "../lib/ai/formulaVision";
import { tryConsume } from "../lib/ai/gate";
import { FormulaHandwritePad } from "./FormulaHandwritePad";

type Sym = { sym: string; latex: string };

// Greek letters (lowercase then uppercase), shown under the αβ tab.
const GREEK: string[] = [
  "α", "β", "γ", "δ", "ε", "ζ", "η", "θ", "ϑ", "ι", "κ",
  "λ", "μ", "ν", "ξ", "π", "ϱ", "σ", "τ", "υ", "φ", "χ", "ψ", "ω",
  "Γ", "Δ", "Θ", "Λ", "Ξ", "Π", "Σ", "Υ", "Φ", "Ψ", "Ω",
];

// Category tabs, each → { label, tabSym, items } (tabs match the Notion bar).
const CATEGORIES: { label: string; tabSym: string; items: Sym[] }[] = [
  {
    label: "希腊字母",
    tabSym: "αβ",
    items: GREEK.map((g) => ({ sym: g, latex: g })),
  },
  {
    label: "运算符",
    tabSym: "÷×",
    items: [
      { sym: "+", latex: "+" }, { sym: "−", latex: "-" }, { sym: "×", latex: "\\times" },
      { sym: "÷", latex: "\\div" }, { sym: "±", latex: "\\pm" }, { sym: "∓", latex: "\\mp" },
      { sym: "·", latex: "\\cdot" }, { sym: "∗", latex: "\\ast" }, { sym: "∘", latex: "\\circ" },
      { sym: "√", latex: "\\sqrt{}" }, { sym: "∛", latex: "\\sqrt[3]{}" },
      { sym: "∑", latex: "\\sum_{}^{}" }, { sym: "∏", latex: "\\prod_{}^{}" },
      { sym: "∫", latex: "\\int_{}^{}" }, { sym: "∮", latex: "\\oint" },
      { sym: "∂", latex: "\\partial" }, { sym: "∇", latex: "\\nabla" }, { sym: "∞", latex: "\\infty" },
      { sym: "≅", latex: "\\cong" }, { sym: "≃", latex: "\\simeq" }, { sym: "≌", latex: "\\backsimeq" },
    ],
  },
  {
    label: "关系运算符",
    tabSym: "≤≥",
    items: [
      { sym: "=", latex: "=" }, { sym: "≠", latex: "\\neq" }, { sym: "<", latex: "<" },
      { sym: ">", latex: ">" }, { sym: "≤", latex: "\\leq" }, { sym: "≥", latex: "\\geq" },
      { sym: "≪", latex: "\\ll" }, { sym: "≫", latex: "\\gg" }, { sym: "≈", latex: "\\approx" },
      { sym: "≡", latex: "\\equiv" }, { sym: "∝", latex: "\\propto" }, { sym: "∼", latex: "\\sim" },
      { sym: "≃", latex: "\\simeq" }, { sym: "≅", latex: "\\cong" }, { sym: "∓", latex: "\\mp" },
      { sym: "≺", latex: "\\prec" }, { sym: "≻", latex: "\\succ" }, { sym: "⊂", latex: "\\subset" },
      { sym: "⊃", latex: "\\supset" }, { sym: "∈", latex: "\\in" }, { sym: "∉", latex: "\\notin" },
    ],
  },
  {
    label: "式子",
    tabSym: "x²",
    items: [
      { sym: "x²", latex: "^{2}" }, { sym: "xᵏ", latex: "^{k}" }, { sym: "xₙ", latex: "_{n}" },
      { sym: "xᵢ", latex: "_{i}" }, { sym: "√x", latex: "\\sqrt{x}" },
      { sym: "n!", latex: "n!" }, { sym: "x̄", latex: "\\bar{x}" }, { sym: "x̂", latex: "\\hat{x}" },
      { sym: "x̃", latex: "\\tilde{x}" }, { sym: "x⃗", latex: "\\vec{x}" },
      { sym: "a/b", latex: "\\frac{a}{b}" }, { sym: "∑ᵢ", latex: "\\sum_{i}" },
      { sym: "lim", latex: "\\lim_{x \\to \\infty}" }, { sym: "df/dx", latex: "\\frac{df}{dx}" },
      { sym: "∂", latex: "\\partial" }, { sym: "Δ", latex: "\\Delta" },
    ],
  },
  {
    label: "箭头",
    tabSym: "↑↓",
    items: [
      { sym: "→", latex: "\\to" }, { sym: "←", latex: "\\gets" }, { sym: "↑", latex: "\\uparrow" },
      { sym: "↓", latex: "\\downarrow" }, { sym: "↔", latex: "\\leftrightarrow" },
      { sym: "⇐", latex: "\\Leftarrow" }, { sym: "⇒", latex: "\\Rightarrow" },
      { sym: "⇔", latex: "\\Leftrightarrow" }, { sym: "↦", latex: "\\mapsto" },
      { sym: "⇄", latex: "\\rightleftarrows" }, { sym: "⇆", latex: "\\leftrightarrows" },
      { sym: "⇑", latex: "\\Uparrow" }, { sym: "⇓", latex: "\\Downarrow" },
      { sym: "⟵", latex: "\\longleftarrow" }, { sym: "⟶", latex: "\\longrightarrow" },
      { sym: "⟷", latex: "\\longleftrightarrow" }, { sym: "⇀", latex: "\\rightharpoonup" },
      { sym: "⇁", latex: "\\rightharpoondown" },
    ],
  },
  {
    label: "化学",
    tabSym: "H₂O",
    items: [
      { sym: "H₂O", latex: "\\mathrm{H_2O}" }, { sym: "CO₂", latex: "\\mathrm{CO_2}" },
      { sym: "Na⁺", latex: "\\mathrm{Na^+}" }, { sym: "Cl⁻", latex: "\\mathrm{Cl^-}" },
      { sym: "±", latex: "\\pm" }, { sym: "Ca²⁺", latex: "\\mathrm{Ca^{2+}}" },
      { sym: "→", latex: "\\rightarrow" }, { sym: "⇌", latex: "\\rightleftharpoons" },
      { sym: "ΔH", latex: "\\Delta H" }, { sym: "x⁻", latex: "x^{-}" },
    ],
  },
];

export function FormulaEditorDialog() {
  const { open, initial, original, anchor, livePreview, onCommit, close } = useFormulaEditorStore();
  const [latex, setLatex] = useState("");
  const [openCat, setOpenCat] = useState<number | null>(null);
  const [catAnchor, setCatAnchor] = useState<{ left: number; top: number } | null>(null);
  const [recognizing, setRecognizing] = useState(false);
  const [recognizeError, setRecognizeError] = useState<string | null>(null);
  const [handwriteOpen, setHandwriteOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Sync initial when opened.
  useEffect(() => {
    if (open) {
      setLatex(initial);
      setOpenCat(null);
      // Sync the page formula block to the initial value on open.
      if (initial) livePreview?.(initial);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initial]);

  // Live-preview every keystroke onto the editor's formula block.
  useEffect(() => {
    if (open) livePreview?.(latex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latex]);

  // Focus the textarea on open.
  useEffect(() => {
    if (open) textareaRef.current?.focus();
  }, [open]);

  const commit = () => {
    const v = latex.trim();
    if (!v) return;
    onCommit?.(v);
    close();
  };

  const cancel = () => {
    // Restore the block's original value, then close.
    if (original) livePreview?.(original);
    close();
  };

  // Ctrl+Enter commits.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  };

  const insert = (text: string) => {
    const el = textareaRef.current;
    if (!el) {
      setLatex((v) => v + text);
      return;
    }
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const next = el.value.slice(0, start) + text + el.value.slice(end);
    setLatex(next);
    requestAnimationFrame(() => {
      const pos = start + text.length;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  // Close the dropdown when clicking a symbol.
  const pick = (text: string) => {
    insert(text);
    setOpenCat(null);
    setCatAnchor(null);
  };

  // Clicking anywhere outside the dropdown closes it (it's now a body portal).
  useEffect(() => {
    if (openCat === null) return;
    const onDoc = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && el.closest(".formula-dropdown")) return;
      if (el && el.closest(".formula-toolbar-tab")) return;
      setOpenCat(null);
      setCatAnchor(null);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [openCat]);

  // Build a ProviderConfig from the AI store (validated enabled).
  const providerConfig = (): ProviderConfig | null => {
    const c = useAiStore.getState().config;
    if (!c.enabled) return null;
    return { provider: c.provider, baseUrl: c.baseUrl, model: c.model, apiKey: c.apiKey };
  };

  // Run a vision recognition on a data URL and insert the LaTeX at the caret.
  const recognize = async (dataUrl: string) => {
    const cfg = providerConfig();
    if (!cfg) {
      setRecognizeError("请先在 AI 设置中配置并启用支持图像的模型。");
      return;
    }
    const gate = tryConsume("vision");
    if (!gate.ok) {
      setRecognizeError(gate.message);
      return;
    }
    setRecognizing(true);
    setRecognizeError(null);
    try {
      const res = await recognizeFormulaImage(cfg, dataUrl);
      if (res.latex) {
        insert(res.latex);
        if (textareaRef.current) textareaRef.current.focus();
      } else {
        setRecognizeError(res.message ?? "识别失败，请重试。");
      }
    } catch (e) {
      setRecognizeError(`识别失败：${String((e as Error)?.message ?? e)}`);
    } finally {
      setRecognizing(false);
    }
  };

  // Pick a formula image file and recognize it.
  const recognizeFromFile = async (file: File | null | undefined) => {
    if (!file) return;
    try {
      const dataUrl = await fileToDataUrl(file);
      await recognize(dataUrl);
    } catch {
      setRecognizeError("读取图片失败。");
    }
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    recognizeFromFile(e.target.files?.[0]);
    e.target.value = "";
  };

  // Paste / drag a formula image onto the textarea → recognize.
  const onPaste = (e: React.ClipboardEvent) => {
    const item = Array.from(e.clipboardData.items).find((i) => i.type.startsWith("image/"));
    if (item) {
      e.preventDefault();
      const file = item.getAsFile();
      if (file) recognizeFromFile(file);
    }
  };
  const onDrop = (e: React.DragEvent) => {
    const file = Array.from(e.dataTransfer.files).find((f) => f.type.startsWith("image/"));
    if (file) {
      e.preventDefault();
      recognizeFromFile(file);
    }
  };

  if (!open) return null;

  // Position the dialog just BELOW its anchor block (clamped to the viewport);
  // fall back to centered when there's no anchor (e.g. inserting a new formula).
  const anchorStyle = anchor
    ? {
        top: anchor.top + 8,
        left: Math.min(Math.max(anchor.left, 8), window.innerWidth - 620 - 8),
      }
    : null;

  return (
    <>
      {createPortal(
        <div
          className="formula-editor-overlay"
          onMouseDown={(e) => e.target === e.currentTarget && cancel()}
        >
          <div
            className="formula-editor"
            style={anchorStyle ? { position: "absolute", ...anchorStyle } : undefined}
            onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Category tabs → dropdown symbol panel */}
        <div className="formula-toolbar">
          {CATEGORIES.map((cat, i) => (
            <div key={cat.label} className="formula-cat-wrap">
              <button
                className={`formula-toolbar-tab ${i === openCat ? "active" : ""}`}
                onClick={(e) => {
                  if (openCat === i) {
                    setOpenCat(null);
                    setCatAnchor(null);
                  } else {
                    const r = e.currentTarget.getBoundingClientRect();
                    setCatAnchor({ left: r.left, top: r.top });
                    setOpenCat(i);
                  }
                }}
                title={cat.label}
              >
                {cat.tabSym} <span className="formula-caret">▾</span>
              </button>
            </div>
          ))}
          <div className="formula-toolbar-right">
            <a className="formula-toolbar-help" href="https://katex.org/docs/supported.html" target="_blank" rel="noreferrer">
              ? 了解如何使用数学公式
            </a>
          </div>
        </div>

        {/* Main input */}
        <textarea
          ref={textareaRef}
          className="formula-input"
          value={latex}
          onChange={(e) => setLatex(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onDrop={onDrop}
          rows={3}
          placeholder="输入文本 或 粘贴/拖入公式图片"
        />

        {recognizing && <div className="formula-reco-status">正在识别公式…</div>}
        {recognizeError && <div className="formula-reco-error">{recognizeError}</div>}

        <div className="formula-editor-foot">
          <div className="formula-foot-left">
            <button className="formula-icon-btn" title="识别图片中的公式" aria-label="识别图片中的公式" onClick={() => fileInputRef.current?.click()} disabled={recognizing}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect x="3" y="3" width="18" height="18" rx="3" />
                <circle cx="8.5" cy="8.5" r="1.6" />
                <path d="M21 15l-4.5-4.5L7 20" />
              </svg>
            </button>
            <button className="formula-icon-btn" title="识别手写公式" aria-label="识别手写公式" onClick={() => setHandwriteOpen(true)} disabled={recognizing}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
              </svg>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              style={{ display: "none" }}
              onChange={handleFileInput}
            />
          </div>
          <div className="formula-foot-right">
            <span className="formula-foot-hint">Ctrl + Enter</span>
            <button className="formula-btn formula-btn-primary" onClick={commit} disabled={!latex.trim() || recognizing}>
              确定
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )}
      {openCat !== null && catAnchor && CATEGORIES[openCat] && (
        createPortal(
          <div
            className="formula-dropdown"
            style={{ left: catAnchor.left, top: catAnchor.top }}
            onClick={(e) => e.stopPropagation()}
          >
            {CATEGORIES[openCat].items.map((it) => (
              <button key={it.latex + it.sym} className="formula-dropdown-item" onClick={() => pick(it.latex)} title={it.latex}>
                {it.sym}
              </button>
            ))}
          </div>,
          document.body,
        )
      )}
      {handwriteOpen && (
        <FormulaHandwritePad
          onCommit={(dataUrl) => {
            setHandwriteOpen(false);
            void recognize(dataUrl);
          }}
          onCancel={() => setHandwriteOpen(false)}
        />
      )}
    </>
  );
}