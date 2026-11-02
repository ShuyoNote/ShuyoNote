import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $createParagraphNode, $getRoot, $isElementNode, type LexicalNode } from "lexical";
import { useBlockSelection } from "../../store/blockSelection";
import { isBlockGestureExcluded } from "../blockGestures";

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
/** 表格单元格：**空单元格也是文字区**（点它要落光标），⛔ 不许当成"空白安全区"起框选 ✗。 */
const CELL_TAGS = new Set(["TD", "TH"]);

/**
 * ⭐ **2026-10-28（owner：「表格的空单元格，鼠标不能点击聚焦输入？」）**：**空单元格 ⇒ 不是框选安全区** ✗ ——
 *
 * 来由（真机）：点在空单元格上时这里判"没有可见文字 ⇒ 空白安全区" ⇒ `onMouseDown` 里
 * `e.preventDefault()` **把浏览器落光标那一步抢掉了** ✗；抬鼠标时那段"最近块落光标"找的是
 * **顶层块**（表格本身），不是**格子里** ⇒ 用户看到的就是"点了没反应、打不了字"✗。
 * ⇒ 单元格（`td/th`）一律交给浏览器/Lexical 原生处理 ✓（它们本来就是可编辑文字区）。
 */
export function isSafeMarqueeTarget(t: EventTarget | null): boolean {
  if (!(t instanceof Node)) return false;
  if (t.nodeType === Node.TEXT_NODE) return false; // on a glyph → normal text selection
  const el = t as HTMLElement;
  // ⭐ 只要点在**单元格里**（含格内空段落/内边距）⇒ 一律不是框选安全区 ✓
  if (el.closest("td,th")) return false;
  const block = el.closest(BLOCK_TAGS);
  if (block) {
    // ⭐ 单元格里**永远不是**框选安全区（空也算文字区）✓
    if (CELL_TAGS.has(block.tagName)) return false;
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
      // ⭐ 2026-10-06（owner：「拖拽调整表格列宽时，同时触发了块选操作」）：
      //    这里原来是一份**手抄**的排除清单，**漏了 `.table-resize-handle`** ✗ ⇒
      //    列宽手柄往往落在**空单元格**里 ⇒ 下面 `isSafeMarqueeTarget` 判它"空白安全区" ✓
      //    ⇒ **拖列宽变成了拉选框**（拖多远选中几块，「已选 1 块」就是这么来的 ✓）。
      //    ⛔ 清单现在只有一份：`editor/blockGestures.ts` ✓（改一处、所有块手势同时生效 ✓）。
      if (isBlockGestureExcluded(e.target)) return;
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
