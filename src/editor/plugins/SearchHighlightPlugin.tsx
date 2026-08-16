import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";

// Highlight search matches inside the editor using the CSS Custom Highlight API.
// This is purely presentational: it never mutates Lexical node state.
export function SearchHighlightPlugin({ query }: { query: string }) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    const root = editor.getRootElement();
    if (!root) return;
    const q = query.trim();
    if (!q) return;

    // Wait for the editor to reconcile content into the DOM.
    const t = setTimeout(() => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const ranges: Range[] = [];
      const lower = q.toLowerCase();
      let node: Text | null;
      while ((node = walker.nextNode() as Text | null)) {
        const text = node.nodeValue || "";
        if (!text) continue;
        const lowerText = text.toLowerCase();
        let idx = lowerText.indexOf(lower);
        while (idx !== -1) {
          const range = document.createRange();
          range.setStart(node, idx);
          range.setEnd(node, idx + q.length);
          ranges.push(range);
          idx = lowerText.indexOf(lower, idx + q.length);
        }
      }

      if (ranges.length === 0) return;

      // Scroll to first match.
      const firstRect = ranges[0].getBoundingClientRect();
      if (firstRect.top < 0 || firstRect.top > window.innerHeight) {
        ranges[0].startContainer.parentElement?.scrollIntoView({
          block: "center",
          behavior: "smooth",
        });
      }

      // @ts-ignore — CSS Custom Highlight API (Chromium/WebView2).
      const Highlight = window.Highlight;
      if (typeof Highlight !== "undefined" && window.CSS?.highlights) {
        // @ts-ignore
        const hl = new Highlight(...ranges);
        // @ts-ignore
        window.CSS.highlights.set("shuyo-search", hl);
      }
    }, 100);

    return () => {
      clearTimeout(t);
      // @ts-ignore
      window.CSS?.highlights?.delete?.("shuyo-search");
    };
  }, [editor, query]);

  return null;
}
