// 划词查词 —— 编辑器内划词 ⇒ 释义浮层（第一期，owner 2026-10-09 拍"只做应用内划词"）。
//
// ## 为什么是"应用内"而不是"系统级"（这一条决定了本文件长什么样）
//
// owner 已拍：**只做应用内划词** ⇒ 这里用 **Lexical 的原生选区**（`$getSelection()`）
// ＋ `window.getSelection().getRangeAt(0).getBoundingClientRect()` 定位，
// ⛔ **不引** `monio`／`selection` 那两个 crate、⛔ 不要任何辅助功能授权、⛔ 不装系统钩子。
// 形状照 `SelectionToolbarPlugin.tsx`（同一个仓里已经在跑的那条路）。
//
// ## 与 `SelectionToolbarPlugin` 的两点不同（都是必须的）
//
// 1. **慢一步查**（`SETTLE_MS`）：拖选过程中选区每帧都在变，若每帧打一次 IPC，
//    一次划词会发几十条命令。所以"选区停下来"才查。
// 2. **带序号丢弃**（`seq`）：查是异步的；期间选区又变了 ⇒ 旧结果必须丢掉，
//    否则浮层会显示**上一个词**的释义（用户看到的会是一个"错位的释义"——比空白更坏）。
//
// ## 样式为什么不进 `App.css`
//
// 本片写域不含共享样式文件 ⇒ 样式**内联**（只取既有主题变量 `--surface/--border/--text*`，
// 不新增色值 ⇒ 深色模式自动正确）。要接设计系统时再把它挪进样式表（那不是本片的事）。
//
// ## 本期**不做**（如实记下，别当成"已做"）
//
// · ⛔ 术语卡片／词汇笔记（owner 拍：不用属性数据库建卡片；那是后续期）
// · ⛔ AI 解释那条接线（评估文档 §5 的第 ④ 期）—— 所以浮层里"走 AI"只**标注**，
//   不放一个按下去什么都不发生的假按钮（那正是本仓最防的"看起来有、其实没有"）
// · ⛔ 代码块/公式等特殊节点内的选区不加白名单（查一次无副作用，只会如实说"未收录"）

import { useEffect, useRef, useState } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getSelection, $isRangeSelection } from "lexical";
import { platform } from "../../lib/platform";
import { lookupWord, presentOutcome, type LookupPresentation } from "../../lib/dictionary/lookup";

/** 选区停下来多久才去查（拖选防抖）。 */
const SETTLE_MS = 220;
/** 浮层宽度（同时用于视口内夹取）。 */
const CARD_WIDTH = 340;

interface CardState {
  top: number;
  left: number;
  view: LookupPresentation;
}

/** 标签按 tone 给（"未收录"与"词典未就绪"是两件不同的事，⛔ 不许写成同一句）。 */
function toneLabel(view: LookupPresentation): string {
  switch (view.tone) {
    case "found":
      return "";
    case "miss":
      return "未收录";
    case "unavailable":
      return "词典未就绪";
  }
}

export function DictionaryLookupPlugin() {
  const [editor] = useLexicalComposerContext();
  const [card, setCard] = useState<CardState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 单调递增的请求号：异步结果回来时若已经不是最新一次 ⇒ 丢弃。 */
  const seq = useRef(0);
  const cardRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const cancel = () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
    const unsubscribe = editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        const selection = $getSelection();
        // 只在"有真实选中"时工作：折叠选区/非范围选区一律当没有。
        if (!$isRangeSelection(selection) || selection.isCollapsed()) {
          cancel();
          seq.current++;
          setCard(null);
          return;
        }
        const text = selection.getTextContent();
        const dom = window.getSelection();
        if (!dom || dom.rangeCount === 0) {
          cancel();
          seq.current++;
          setCard(null);
          return;
        }
        const rect = dom.getRangeAt(0).getBoundingClientRect();
        const left = Math.max(
          CARD_WIDTH / 2 + 8,
          Math.min(rect.left + rect.width / 2, window.innerWidth - CARD_WIDTH / 2 - 8),
        );
        const top = Math.min(rect.bottom + 8, window.innerHeight - 24);
        cancel();
        const mine = ++seq.current;
        timer.current = setTimeout(() => {
          void lookupWord(platform.executor, text).then((outcome) => {
            if (mine !== seq.current) return; // 选区又变了 ⇒ 这一次已经过期
            setCard({ top, left, view: presentOutcome(outcome) });
          });
        }, SETTLE_MS);
      });
    });
    return () => {
      unsubscribe();
      cancel();
    };
  }, [editor]);

  // 关掉它：Esc / 点浮层外面。
  // ⚠️ 这里**故意不**登记 `useOverlayLayer`：与 `.link-popover`／`.block-insert-popover`
  // 同一族 —— 编辑器内联浮层（Lexical 插件自己的 state，随编辑器卸载），不接管返回键。
  // 豁免原文见 `scripts/check-overlay-registry.mjs` 的 `EXEMPT_COMPONENTS`。
  useEffect(() => {
    if (!card) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCard(null);
    };
    const onDown = (e: MouseEvent) => {
      const el = cardRef.current;
      if (el && !el.contains(e.target as Node)) setCard(null);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [card]);

  if (!card) return null;

  const { view } = card;
  const label = toneLabel(view);
  return (
    <div
      ref={cardRef}
      className="dict-popover"
      // 浮层自己的点击不许把编辑器选区弄丢（否则点"×"的瞬间就查不到了）。
      onMouseDown={(e) => e.preventDefault()}
      style={{
        position: "fixed",
        top: card.top,
        left: card.left,
        transform: "translateX(-50%)",
        width: CARD_WIDTH,
        maxHeight: "min(320px, 55vh)",
        overflowY: "auto",
        zIndex: 60,
        textAlign: "left",
        padding: "10px 12px",
        fontSize: 13,
        lineHeight: 1.6,
        background: "var(--surface, #fff)",
        color: "var(--text, #1f2328)",
        border: "1px solid var(--border, #e5e8ee)",
        borderRadius: "var(--radius-md, 8px)",
        boxShadow: "0 8px 24px rgba(0, 0, 0, 0.16)",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <strong style={{ fontSize: 14 }}>{view.title}</strong>
        {view.meta && <span style={{ color: "var(--text-faint, #8f959e)", fontSize: 12 }}>{view.meta}</span>}
        {label && (
          <span
            style={{
              fontSize: 11,
              color: "var(--text-dim, #646a73)",
              border: "1px solid var(--border, #e5e8ee)",
              borderRadius: 4,
              padding: "0 4px",
              whiteSpace: "nowrap",
            }}
          >
            {label}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          title="关闭"
          onClick={() => setCard(null)}
          style={{
            border: "none",
            background: "transparent",
            color: "var(--text-faint, #8f959e)",
            cursor: "pointer",
            fontSize: 14,
            lineHeight: 1,
            padding: 2,
          }}
        >
          ✕
        </button>
      </div>
      <div style={{ marginTop: 4, whiteSpace: "pre-wrap" }}>{view.body}</div>
      {view.aiHint && (
        <div style={{ marginTop: 6, fontSize: 11, color: "var(--text-faint, #8f959e)" }}>
          {view.tone === "unavailable"
            ? "本地词典未就绪 ⇒ 上面那句是如实读数，不是释义。"
            : "本地词典没有这条 ⇒ 可走 AI 解释（本期只做本地词典，AI 那条还没接线）。"}
        </div>
      )}
    </div>
  );
}
