// M23.4 — pure helper: extract searchable text from an Excalidraw scene so the
// drawing block's `content_text` (and thus search/backlinks) sees its labels.
// Kept free of platform/excalidraw imports so the smoke harness can bundle it.

export interface ExcalidrawSceneElementLike {
  type?: string;
  text?: string;
  [k: string]: unknown;
}

/** Collect the text of every Excalidraw text element (labels, notes). */
export function excalidrawSceneText(elements: ExcalidrawSceneElementLike[]): string {
  const out: string[] = [];
  for (const el of elements ?? []) {
    if (el && el.type === "text" && typeof el.text === "string" && el.text.trim()) {
      out.push(el.text);
    }
  }
  return out.join(" ");
}

/** True when a scene has at least one drawable element (non-deleted). */
export function excalidrawSceneHasContent(elements: ExcalidrawSceneElementLike[]): boolean {
  return (elements ?? []).some((e) => e && e.isDeleted !== true);
}
