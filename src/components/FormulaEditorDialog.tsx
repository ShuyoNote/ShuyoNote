// M26 公式 —— Notion 风格的公式编辑器弹窗. Each category tab (αβ / ÷× / ≤≥ / xₐ /
// ↑↓ / H₂O) opens a dropdown symbol panel; the LaTeX input accepts typing and
// paste/drag of a formula image. Ctrl+Enter commits. Rendered on the app.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useFormulaEditorStore } from "../store/formulaEditor";

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
    label: "运算",
    tabSym: "÷×",
    items: [
      { sym: "+", latex: "+" }, { sym: "−", latex: "-" }, { sym: "×", latex: "\\times" },
      { sym: "÷", latex: "\\div" }, { sym: "±", latex: "\\pm" }, { sym: "√", latex: "\\sqrt{}" },
      { sym: "∑", latex: "\\sum_{}^{}" }, { sym: "∏", latex: "\\prod_{}^{}" },
      { sym: "∫", latex: "\\int_{}^{}" }, { sym: "∂", latex: "\\partial" }, { sym: "∞", latex: "\\infty" },
    ],
  },
  {
    label: "关系",
    tabSym: "≤≥",
    items: [
      { sym: "=", latex: "=" }, { sym: "≠", latex: "\\neq" }, { sym: "<", latex: "<" },
      { sym: ">", latex: ">" }, { sym: "≤", latex: "\\leq" }, { sym: "≥", latex: "\\geq" },
      { sym: "≈", latex: "\\approx" }, { sym: "≡", latex: "\\equiv" }, { sym: "∝", latex: "\\propto" },
    ],
  },
  {
    label: "上下标",
    tabSym: "xₐ",
    items: [
      { sym: "x²", latex: "^{2}" }, { sym: "xₙ", latex: "_{n}" },
      { sym: "x̄", latex: "\\bar{x}" }, { sym: "x̂", latex: "\\hat{x}" },
      { sym: "x⃗", latex: "\\vec{x}" }, { sym: "ᵗ", latex: "^{T}" },
    ],
  },
  {
    label: "箭头",
    tabSym: "↑↓",
    items: [
      { sym: "→", latex: "\\to" }, { sym: "←", latex: "\\gets" }, { sym: "↑", latex: "\\uparrow" },
      { sym: "↓", latex: "\\downarrow" }, { sym: "↔", latex: "\\leftrightarrow" },
      { sym: "⇄", latex: "\\rightleftarrows" }, { sym: "⇒", latex: "\\Rightarrow" },
      { sym: "⇔", latex: "\\Leftrightarrow" }, { sym: "⇑", latex: "\\Uparrow" }, { sym: "⇓", latex: "\\Downarrow" },
    ],
  },
  {
    label: "化学",
    tabSym: "H₂O",
    items: [
      { sym: "H₂O", latex: "\\mathrm{H_2O}" }, { sym: "CO₂", latex: "\\mathrm{CO_2}" },
      { sym: "Na⁺", latex: "\\mathrm{Na^+}" }, { sym: "→ 上/下", latex: "\\xrightarrow{\\text{text above}}\\text{text below}" },
      { sym: "x⁻", latex: "x^{-}" }, { sym: "k²", latex: "k^{2}" },
    ],
  },
];

export function FormulaEditorDialog() {
  const { open, initial, original, anchor, livePreview, onCommit, close } = useFormulaEditorStore();
  const [latex, setLatex] = useState("");
  const [openCat, setOpenCat] = useState<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
  };

  if (!open) return null;

  // Position the dialog right below its anchor block (clamped to the viewport);
  // fall back to centered when there's no anchor (e.g. inserting a new formula).
  const anchorStyle = anchor
    ? {
        top: anchor.top + 8,
        left: Math.min(Math.max(anchor.left, 8), window.innerWidth - 620 - 8),
      }
    : null;

  return createPortal(
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
                onClick={() => setOpenCat((v) => (v === i ? null : i))}
                title={cat.label}
              >
                {cat.tabSym} <span className="formula-caret">▾</span>
              </button>
              {i === openCat && (
                <div className="formula-dropdown" onClick={(e) => e.stopPropagation()}>
                  {cat.items.map((it) => (
                    <button key={it.latex + it.sym} className="formula-dropdown-item" onClick={() => pick(it.latex)} title={it.latex}>
                      {it.sym}
                    </button>
                  ))}
                </div>
              )}
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
          rows={3}
          placeholder="输入文本 或 粘贴/拖入公式图片"
        />

        <div className="formula-editor-foot">
          <div className="formula-foot-left">
            <button className="formula-icon-btn" title="识别图片中的公式" aria-label="识别图片中的公式">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect x="3" y="3" width="18" height="18" rx="3" />
                <circle cx="8.5" cy="8.5" r="1.6" />
                <path d="M21 15l-4.5-4.5L7 20" />
              </svg>
            </button>
            <button className="formula-icon-btn" title="识别手写公式" aria-label="识别手写公式">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
              </svg>
            </button>
          </div>
          <div className="formula-foot-right">
            <span className="formula-foot-hint">Ctrl + Enter</span>
            <button className="formula-btn formula-btn-primary" onClick={commit} disabled={!latex.trim()}>
              确定
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
