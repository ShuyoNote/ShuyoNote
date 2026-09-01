import { describe, expect, it } from "vitest";
import { computeReorder } from "./treeReorder";
import type { PageMeta } from "../types";

function page(id: string, parent: string | null, sort: number): PageMeta {
  return {
    id,
    workspace_id: "ws",
    parent_id: parent,
    title: id,
    icon: "",
    kind: "page",
    sort_order: sort,
    created_at: 0,
    updated_at: 0,
    deleted_at: null,
  };
}

describe("computeReorder", () => {
  const pages = [
    page("root", null, 0),
    page("a", "root", 0),
    page("b", "root", 1),
    page("c", "root", 2),
    page("child", "a", 0),
  ];

  it("nesting inside appends after the target's last child", () => {
    const r = computeReorder(pages, "x", "a", "inside");
    expect(r).toEqual({ parentId: "a", sortOrder: 1 }); // a's last child is sort 0
  });

  it("nesting inside a childless target gives sortOrder 0", () => {
    const r = computeReorder(pages, "x", "b", "inside");
    expect(r).toEqual({ parentId: "b", sortOrder: 0 });
  });

  it("inserting before a sibling uses midpoint order", () => {
    const r = computeReorder(pages, "x", "b", "before");
    expect(r?.parentId).toBe("root");
    expect(r?.sortOrder).toBeCloseTo((1 + 0) / 2); // midpoint between a(0) and b(1)
  });

  it("inserting after the last sibling appends", () => {
    const r = computeReorder(pages, "x", "c", "after");
    expect(r?.parentId).toBe("root");
    expect(r?.sortOrder).toBe(3); // c.sort + 1
  });

  it("dragging onto itself is a no-op", () => {
    expect(computeReorder(pages, "b", "b", "inside")).toBeNull();
    expect(computeReorder(pages, "b", "b", "before")).toBeNull();
  });

  it("missing target returns null", () => {
    expect(computeReorder(pages, "x", "nope", "inside")).toBeNull();
  });
});
