import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $createParagraphNode, $getRoot, $isElementNode, type LexicalNode } from "lexical";
import { useBlockSelection } from "../../store/blockSelection";

// Blank-area interactions. The drag marquee (box-select) is only armed when the
// mousedown lands on a non-text, non-block "safe" zone (page background / shell /
// contenteditable root), so normal text selection is never hijacked. A plain
// click (<6px) on that zone places the caret in the nearest block.
//
// Text selection stays the top priority. A mousedown that lands on a text glyph
// (a Text node) OR inside a text-bearing block is left entirely to the browser.
// A mousedown on a genuinely blank target — the page background / contenteditable
// root / margins, or an empty block with no visible text — arms the marquee.
const BLOCK_TAGS = "p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,td,th";

function isSafeMarqueeTarget(t: EventTarget | null): boolean {
  if (!(t instanceof Node)) return false;
  if (t.nodeType === Node.TEXT_NODE) return false; // on a glyph → normal text selection
  const el = t as HTMLElement;
  const block = el.closest(BLOCK_TAGS);
  if (block) {
    // Inside a block: if it has visible text, it's a 文字区 → text selection.
    // An empty block (no text) is still blank → marquee allowed.
    if ((block.textContent || "").trim().length > 0) return false;
  }
  if (!el.closest(".editor-content, .editor-shell")) return false; // must be in the editor
  return true;
}

export function ClickToEditPlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    const rootEl = editor.getRootElement();
    const shell = rootEl?.parentElement ?? null;
    if (!rootEl || !shell) return;

    let downStart: { x: number; y: number } | null = null;
    let boxEl: HTMLDivElement | null = null;
    let selecting = false;

    const createBox = () => {
      boxEl = document.createElement("div");
      boxEl.className = "block-box-select";
      document.body.appendChild(boxEl);
    };
    const removeBox = () => {
      if (boxEl) {
        boxEl.remove();
        boxEl = null;
      }
    };

    const getKeysInRect = (l: number, t: number, w: number, h: number): string[] => {
      const keys: string[] = [];
      editor.getEditorState().read(() => {
        const right = l + w;
        const bottom = t + h;
        for (const child of $getRoot().getChildren()) {
          const el = editor.getElementByKey(child.getKey());
          if (!el) continue;
          const b = el.getBoundingClientRect();
          if (b.left < right && b.right > l && b.top < bottom && b.bottom > t) {
            keys.push(child.getKey());
          }
        }
      });
      return keys;
    };

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (target.closest(".block-handle, .block-grip-menu, .block-selection-bar, .tag-picker, .slash-menu, .selection-toolbar")) return;
      if (!target.closest(".editor-content, .editor-shell")) return;
      // Only arm the marquee from a non-text target (element/blank — not a glyph).
      if (!isSafeMarqueeTarget(e.target)) return;
      if (useBlockSelection.getState().selectMode) return; // select-mode handled elsewhere
      e.preventDefault(); // stop the browser's native caret/text selection during a marquee drag
      downStart = { x: e.clientX, y: e.clientY };
      selecting = false;
      createBox();
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!downStart || !boxEl) return;
      const dx = e.clientX - downStart.x;
      const dy = e.clientY - downStart.y;
      if (!selecting && dx * dx + dy * dy < 36) return; // <6px = click
      selecting = true;
      const l = Math.min(downStart.x, e.clientX);
      const t = Math.min(downStart.y, e.clientY);
      const w = Math.abs(dx);
      const h = Math.abs(dy);
      boxEl.style.left = `${l}px`;
      boxEl.style.top = `${t}px`;
      boxEl.style.width = `${w}px`;
      boxEl.style.height = `${h}px`;
      const keys = getKeysInRect(l, t, w, h);
      if (keys.length > 0) useBlockSelection.getState().setKeys(keys);
    };

    const onMouseUp = (e: MouseEvent) => {
      if (!downStart || !boxEl) return;
      const wasSelect = selecting;
      removeBox();
      downStart = null;
      selecting = false;
      if (wasSelect) return; // box-select done (blocks highlighted)
      if (useBlockSelection.getState().selectMode) return;
      // Plain blank click → place the caret in the nearest block.
      if (useBlockSelection.getState().keys.length > 0) return;
      const y = e.clientY;
      editor.update(() => {
        const root = $getRoot();
        const blocks = root.getChildren();
        let best: { node: LexicalNode; centerY: number } | undefined;
        for (const b of blocks) {
          const el = editor.getElementByKey(b.getKey());
          if (!el) continue;
          const r = el.getBoundingClientRect();
          const center = r.top + r.height / 2;
          if (!best || Math.abs(y - center) < Math.abs(y - best.centerY)) {
            best = { node: b, centerY: center };
          }
        }
        if (best && $isElementNode(best.node)) {
          if (y < best.centerY) best.node.selectStart();
          else best.node.selectEnd();
        } else {
          const p = $createParagraphNode();
          root.append(p);
          p.selectStart();
        }
      });
      editor.focus();
    };

    rootEl.addEventListener("mousedown", onMouseDown);
    shell.addEventListener("mousedown", onMouseDown);
    document.addEventListener("mousemove", onMouseMove, true);
    document.addEventListener("mouseup", onMouseUp, true);
    return () => {
      rootEl.removeEventListener("mousedown", onMouseDown);
      shell.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("mousemove", onMouseMove, true);
      document.removeEventListener("mouseup", onMouseUp, true);
    };
  }, [editor]);

  return null;
}
