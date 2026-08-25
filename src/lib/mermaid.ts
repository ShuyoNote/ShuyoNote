// M-B — pure helpers for the mermaid diagram block. Kept free of platform/api
// imports so the smoke harness can bundle them. mermaid itself is loaded lazily
// by the renderer (not here).

const SYNONYMS: Record<string, string> = {
  graph: "flowchart",
  flowchart: "flowchart",
  sequencediagram: "sequence",
  classdiagram: "class",
  statediagram: "state",
  erdiagram: "er",
  gantt: "gantt",
  pie: "pie",
  journey: "journey",
  mindmap: "mindmap",
  timeline: "timeline",
  quadrantchart: "quadrant",
  requirementdiagram: "requirement",
  sankey: "sankey",
  gitgraph: "gitgraph",
  xychart: "xychart",
  block: "block",
  packet: "packet",
  kanban: "kanban",
};

/** Detect the mermaid diagram type from the first meaningful source keyword. */
export function detectMermaidSyntax(src: string): string {
  const first = String(src ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("%%")) ?? "";
  const word = first.split(/[\s({]+/)[0] ?? "";
  const key = word.replace(/[-_]/g, "").toLowerCase();
  return SYNONYMS[key] ?? (key || "flowchart");
}

/** True when the source looks renderable (has a body after the directive). */
export function mermaidRenderable(src: string): boolean {
  const body = String(src ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("%%"));
  return body.length >= 2;
}

/** Suggested syntax options for the mermaid block's selector. */
export function mermaidSyntaxOptions(): string[] {
  return ["flowchart", "sequence", "class", "state", "er", "mindmap", "timeline", "kanban", "gantt", "pie"];
}
