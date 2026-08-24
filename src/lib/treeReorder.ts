// Pure drag-reorder math for the sidebar page tree (no React/DOM deps, unit-testable).
import type { PageMeta } from "../types";

// Compute the target { parentId, sortOrder } for a completed drag.
// zone "inside" nests the dragged node as a child of the target (appended after its
// last child); "before"/"after" insert it as a sibling (midpoint sort order).
export function computeReorder(
  pages: PageMeta[],
  dragId: string,
  targetId: string,
  zone: "before" | "after" | "inside",
): { parentId: string | null; sortOrder: number } | null {
  if (dragId === targetId) return null;
  const target = pages.find((p) => p.id === targetId);
  if (!target) return null;
  if (zone === "inside") {
    const children = pages
      .filter((p) => p.parent_id === targetId && p.id !== dragId)
      .sort((a, b) => a.sort_order - b.sort_order || a.created_at - b.created_at);
    const sortOrder = children.length ? (children[children.length - 1].sort_order ?? 0) + 1 : 0;
    return { parentId: targetId, sortOrder };
  }
  const insertAfter = zone === "after";
  const siblings = pages
    .filter((p) => p.parent_id === target.parent_id && p.id !== dragId)
    .sort((a, b) => a.sort_order - b.sort_order || a.created_at - b.created_at);
  const targetIdx = siblings.findIndex((s) => s.id === targetId);
  let sortOrder: number;
  if (insertAfter) {
    const next = siblings[targetIdx + 1];
    sortOrder = next ? (target.sort_order + next.sort_order) / 2 : target.sort_order + 1;
  } else {
    const prev = siblings[targetIdx - 1];
    sortOrder = prev ? (prev.sort_order + target.sort_order) / 2 : target.sort_order - 1;
  }
  return { parentId: target.parent_id, sortOrder };
}
