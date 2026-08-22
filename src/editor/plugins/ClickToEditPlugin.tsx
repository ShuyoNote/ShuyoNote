import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $createParagraphNode, $getRoot, $isElementNode, type LexicalNode } from "lexical";
import { useBlockSelection } from "../../store/blockSelection";

// Clicking a blank area of the page view (gaps between blocks or below the
// content) places the caret in the nearest block instead of being a no-op.
export function ClickToEditPlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    const rootEl = editor.getRootElement();
    const shell = rootEl?.parentElement ?? null;
    if (!rootEl || !shell) return;

    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      // Only handle blank clicks: directly on the contenteditable or the scroll
      // shell (margins / gaps / empty area below), never on block content or
      // popovers, where the browser already positions the caret.
      if (target !== rootEl && target !== shell) return;
      // Don't disturb an active block selection (multi-select via ⋮⋮ handle).
      if (useBlockSelection.getState().keys.length > 0) return;
      e.preventDefault();
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
          // Empty editor: create a paragraph and put the caret there.
          const p = $createParagraphNode();
          root.append(p);
          p.selectStart();
        }
      });

      editor.focus();
    };

    rootEl.addEventListener("mousedown", onMouseDown);
    shell.addEventListener("mousedown", onMouseDown);
    return () => {
      rootEl.removeEventListener("mousedown", onMouseDown);
      shell.removeEventListener("mousedown", onMouseDown);
    };
  }, [editor]);

  return null;
}
