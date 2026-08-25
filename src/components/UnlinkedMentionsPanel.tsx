import { useState } from "react";
import { $getRoot, $isTextNode } from "lexical";
import { useNotes } from "../store/notes";
import { useEditorStore } from "../store/editor";
import { findUnlinkedMentions } from "../lib/mention";

// M19.1 — Unlinked Mentions: detect other page titles that appear as plain text
// in the current page (not yet wrapped in [[ ]]) and offer one-click linking.
// Sits below the backlinks panel in the note view; auto-updates as the page saves.
export function UnlinkedMentionsPanel() {
  const notes = useNotes();
  const [open, setOpen] = useState(false);
  const current = notes.current;
  if (!current || current.kind !== "page") return null;
  const titles = notes.pages.filter((p) => p.kind === "page" && p.id !== current.id).map((p) => p.title);
  const mentions = findUnlinkedMentions(current.content_text, titles, current.title);
  if (mentions.length === 0) return null;

  // Wrap the first bare occurrence of `title` in the live editor with [[title]].
  const link = (title: string) => {
    const editor = useEditorStore.getState().editor;
    if (!editor) return;
    editor.update(() => {
      const stack: any[] = [...$getRoot().getChildren()];
      while (stack.length) {
        const node = stack.pop();
        if ($isTextNode(node)) {
          const text = node.getTextContent();
          const idx = text.includes(title) ? text.indexOf(title) : -1;
          if (idx >= 0) {
            const before = text.slice(Math.max(0, idx - 2), idx);
            const after = text.slice(idx + title.length, idx + title.length + 2);
            if (before !== "[[" && after !== "]]") {
              node.spliceText(idx, idx + title.length, `[[${title}]]`);
              return;
            }
          }
        }
        if (node.getChildren) node.getChildren().forEach((c: unknown) => stack.push(c));
      }
    });
  };

  return (
    <details
      className="unlinked-mentions"
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className="unlinked-mentions-summary">未链接提及（{mentions.length}）</summary>
      <div className="unlinked-mentions-list">
        {mentions.map((m) => (
          <div key={m.title} className="unlinked-mention">
            <span className="unlinked-mention-title">「{m.title}」</span>
            <span className="unlinked-mention-desc">以纯文本出现，可转为链接</span>
            <button className="unlinked-mention-link" onClick={() => link(m.title)}>
              改为链接
            </button>
          </div>
        ))}
      </div>
    </details>
  );
}
