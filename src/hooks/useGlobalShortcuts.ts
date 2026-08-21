import { useEffect } from "react";
import { useNotes } from "../store/notes";

// Global keyboard shortcuts. Ignore when the event target is an input/textarea
// (except for the dedicated search input, which Ctrl+Shift+F focuses).
export function useGlobalShortcuts(onToggleView: () => void) {
  const { createPage } = useNotes();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;

      const target = e.target as HTMLElement;
      const inEditable =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);

      const key = e.key.toLowerCase();

      // Ctrl+N: new page.
      if (key === "n" && !inEditable) {
        e.preventDefault();
        createPage(null);
        return;
      }

      // Ctrl+Shift+F: focus search.
      if (key === "f" && e.shiftKey) {
        e.preventDefault();
        const el = document.getElementById("global-search-input");
        el?.focus();
        return;
      }

      // Ctrl+E: cycle notes → board → graph view.
      if (key === "e" && !inEditable) {
        e.preventDefault();
        onToggleView();
        return;
      }
    };

    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [createPage, onToggleView]);
}
