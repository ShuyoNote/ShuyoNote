import { useEffect } from "react";
import { useNotes } from "../store/notes";
import { useEditorStore } from "../store/editor";
import { useActivity } from "../store/activity";

// Global keyboard shortcuts. Ignore when the event target is an input/textarea
// (except for the dedicated search input, which Ctrl+Shift+F focuses).

/** 这次按键是否应该「开合侧栏」：Ctrl/⌘+B，且不在编辑中。
 *
 *  抽成纯函数是为了能单测：编辑器里 Ctrl/⌘+B 是**加粗**（Lexical
 *  RichTextPlugin 自带），守卫一旦写错，用户想加粗却把侧栏收了起来——
 *  这种回归在界面上几乎不会被发现。 */
export function isSidebarToggleKey(e: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  inEditable?: boolean;
}): boolean {
  if (e.inEditable) return false;
  if (e.shiftKey) return false;
  if (!(e.ctrlKey || e.metaKey)) return false;
  return (e.key || "").toLowerCase() === "b";
}

export function useGlobalShortcuts(onToggleView: () => void) {
  const { createPage } = useNotes();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;

      const target = e.target as HTMLElement;
      const inEditable =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);

      const key = (e.key || "").toLowerCase();

      // M25 — keyboard-shortcuts overlay. `Ctrl+/` works everywhere; `?` (Shift+/)
      // only when not typing (so typing "?" in the editor still works).
      if (mod && key === "/") {
        e.preventDefault();
        useEditorStore.getState().openShortcuts();
        return;
      }
      if (!mod && e.key === "?" && !inEditable) {
        e.preventDefault();
        useEditorStore.getState().openShortcuts();
        return;
      }
      if (!mod) return;

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

      // Ctrl/Cmd+B: 开合左侧栏（VS Code 习惯）。编辑器内不拦截（见上方注释）。
      if (isSidebarToggleKey({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey, inEditable })) {
        e.preventDefault();
        useActivity.getState().toggleSidebar();
        return;
      }
    };

    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [createPage, onToggleView]);
}
