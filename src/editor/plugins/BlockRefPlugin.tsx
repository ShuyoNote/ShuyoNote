import { useEffect, useRef, useState } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { api } from "../../lib/api";
import type { BlockInfo } from "../../types";
import { useEditorStore } from "../../store/editor";
import { useNotes } from "../../store/notes";
import { toast } from "../../store/toast";

// Makes `((blockId))` block references clickable (jump to the source block) and
// hoverable (preview card). Uses capture-phase listeners so clicking never
// moves the caret into the reference text.
export function BlockRefPlugin({ pageId }: { pageId: string }) {
  const [editor] = useLexicalComposerContext();
  const [preview, setPreview] = useState<{ x: number; y: number; info: BlockInfo } | null>(null);
  const hoverTimer = useRef<number | null>(null);

  useEffect(() => {
    const root = editor.getRootElement();
    if (!root) return;

    const targetOf = (e: MouseEvent): HTMLElement | null =>
      (e.target as HTMLElement).closest?.("[data-block-ref]") as HTMLElement | null;

    const onMouseDown = (e: MouseEvent) => {
      if (!targetOf(e)) return;
      e.preventDefault();
      e.stopPropagation();
    };

    const onClick = (e: MouseEvent) => {
      const target = targetOf(e);
      if (!target) return;
      const blockId = target.getAttribute("data-block-ref");
      if (!blockId) return;
      e.preventDefault();
      e.stopPropagation();
      jumpToBlock(blockId, pageId);
    };

    const onMouseOver = (e: MouseEvent) => {
      const target = targetOf(e);
      if (!target) return;
      const blockId = target.getAttribute("data-block-ref");
      if (!blockId) return;
      if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
      hoverTimer.current = window.setTimeout(async () => {
        try {
          const info = await api.resolveBlock(blockId);
          const rect = target.getBoundingClientRect();
          setPreview({ x: rect.left, y: rect.bottom + 6, info });
        } catch {
          // target no longer resolvable — no preview
        }
      }, 320);
    };

    const onMouseOut = (e: MouseEvent) => {
      if (!targetOf(e)) return;
      if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
      setPreview(null);
    };

    root.addEventListener("mousedown", onMouseDown, true);
    root.addEventListener("click", onClick, true);
    root.addEventListener("mouseover", onMouseOver);
    root.addEventListener("mouseout", onMouseOut);
    return () => {
      root.removeEventListener("mousedown", onMouseDown, true);
      root.removeEventListener("click", onClick, true);
      root.removeEventListener("mouseover", onMouseOver);
      root.removeEventListener("mouseout", onMouseOut);
      if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
    };
  }, [editor, pageId]);

  if (!preview) return null;
  return (
    <div
      className="block-ref-preview"
      style={{ position: "fixed", top: preview.y, left: preview.x }}
    >
      <div className="block-ref-preview-title">{preview.info.page_title || "未命名"}</div>
      <div className="block-ref-preview-snippet">{preview.info.snippet}</div>
    </div>
  );
}

async function jumpToBlock(blockId: string, currentPageId: string) {
  try {
    const info = await api.resolveBlock(blockId);
    useEditorStore.getState().setFocusBlockId(blockId);
    if (info.page_id !== currentPageId) {
      await useNotes.getState().openPage(info.page_id);
    }
  } catch (e) {
    toast(`无法跳转：${e}`, "error");
  }
}
