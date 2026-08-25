// M-A — pure helpers for the Drawing block (Excalidraw). Kept free of
// platform/api/lexical imports so the smoke harness can bundle them.

export interface RawExcalidrawElement {
  type?: string;
  text?: string;
  [k: string]: unknown;
}

/** Collect the text of every Excalidraw text element (labels, sticky notes). */
export function excalidrawText(elements: RawExcalidrawElement[]): string {
  const out: string[] = [];
  for (const el of elements ?? []) {
    if (el && el.type === "text" && typeof el.text === "string" && el.text.trim()) {
      out.push(el.text);
    }
  }
  return out.join(" ");
}

/** Safe-parse a stored Excalidraw scene JSON and return its elements + text. */
export function drawingTextFromJson(json: string): string {
  try {
    const scene = JSON.parse(json || "{}");
    const elements = Array.isArray(scene?.elements) ? scene.elements : [];
    return excalidrawText(elements as RawExcalidrawElement[]);
  } catch {
    return "";
  }
}

/** True when the drawing JSON looks like a scene with at least one element. */
export function drawingHasContent(json: string): boolean {
  try {
    const scene = JSON.parse(json || "{}");
    return Array.isArray(scene?.elements) && scene.elements.length > 0;
  } catch {
    return false;
  }
}
