import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { usePdfReader } from "../../store/pdfReader";

// M24 — re-open the PDF reader at the annotated page when a `pdf://` reference
// (PdfRefNode) is clicked in the editor. Mirrors BlockRefPlugin (capture-phase so
// clicking never moves the caret into the link).
export function PdfRefPlugin() {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    const root = editor.getRootElement();
    if (!root) return;

    const targetOf = (e: MouseEvent): HTMLElement | null =>
      (e.target as HTMLElement).closest?.("[data-pdf-ref]") as HTMLElement | null;

    const onMouseDown = (e: MouseEvent) => {
      if (!targetOf(e)) return;
      e.preventDefault();
      e.stopPropagation();
    };

    const onClick = (e: MouseEvent) => {
      const target = targetOf(e);
      if (!target) return;
      const val = target.getAttribute("data-pdf-ref");
      if (!val) return;
      e.preventDefault();
      e.stopPropagation();
      const colon = val.indexOf(":");
      const attachmentId = colon >= 0 ? val.slice(0, colon) : val;
      const pageIndex = colon >= 0 ? Number(val.slice(colon + 1)) : 0;
      void usePdfReader.getState().openPdf(attachmentId, "", Number.isFinite(pageIndex) ? pageIndex : 0);
    };

    root.addEventListener("mousedown", onMouseDown, true);
    root.addEventListener("click", onClick, true);
    return () => {
      root.removeEventListener("mousedown", onMouseDown, true);
      root.removeEventListener("click", onClick, true);
    };
  }, [editor]);
  return null;
}
