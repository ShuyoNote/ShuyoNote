// 声明式视图的宿主渲染逻辑。
// 作者没法写代码绕过这些规则，写错了也不会报错、只会显示成「结果不对」——所以钉住。
import { describe, expect, it } from "vitest";
import type { PageMeta } from "../types";
import { cellText, effectiveColumns, selectViewRows, summaryText, type PluginView } from "./pluginViews";

const NOW = Date.parse("2026-09-10T12:00:00Z");
const day = 86_400_000;

const page = (over: Partial<PageMeta>): PageMeta => ({
  id: over.id ?? "p",
  workspace_id: "w",
  parent_id: null,
  title: "标题",
  icon: "",
  kind: "page",
  sort_order: 0,
  created_at: NOW - 10 * day,
  updated_at: NOW - day,
  deleted_at: null,
  ...over,
});

const view = (over: Partial<PluginView> = {}): PluginView => ({
  id: "v",
  title: "视图",
  query: {},
  columns: ["title"],
  summary: false,
  ...over,
});

describe("selectViewRows", () => {
  it("默认：按更新时间倒序、排除已删除", () => {
    const pages = [
      page({ id: "old", updated_at: NOW - 5 * day }),
      page({ id: "new", updated_at: NOW - day }),
      page({ id: "gone", updated_at: NOW, deleted_at: NOW }),
    ];
    const { rows, total } = selectViewRows(pages, view(), NOW);
    expect(rows.map((r) => r.id)).toEqual(["new", "old"]);
    expect(total).toBe(2);
  });

  it("kind 过滤：any 等于不过滤", () => {
    const pages = [page({ id: "a", kind: "page" }), page({ id: "b", kind: "database" })];
    expect(selectViewRows(pages, view({ query: { kind: "any" } }), NOW).rows).toHaveLength(2);
    expect(selectViewRows(pages, view({ query: { kind: "database" } }), NOW).rows.map((r) => r.id)).toEqual(["b"]);
  });

  it("kind 缺省按 page 处理（老页面没有 kind 字段）", () => {
    const pages = [page({ id: "a", kind: "" })];
    expect(selectViewRows(pages, view({ query: { kind: "page" } }), NOW).rows).toHaveLength(1);
  });

  it("标题包含：大小写不敏感", () => {
    const pages = [page({ id: "a", title: "Weekly Review" }), page({ id: "b", title: "随手记" })];
    expect(selectViewRows(pages, view({ query: { title_contains: "weekly" } }), NOW).rows.map((r) => r.id)).toEqual(["a"]);
  });

  it("最近 N 天：更早的排除掉", () => {
    const pages = [page({ id: "recent", updated_at: NOW - 3 * day }), page({ id: "old", updated_at: NOW - 40 * day })];
    expect(selectViewRows(pages, view({ query: { updated_within_days: 30 } }), NOW).rows.map((r) => r.id)).toEqual(["recent"]);
  });

  it("排序：created_desc / title_asc 都按声明生效", () => {
    const pages = [
      page({ id: "a", title: "乙", created_at: NOW - 5 * day }),
      page({ id: "b", title: "甲", created_at: NOW - day }),
    ];
    expect(selectViewRows(pages, view({ query: { sort: "created_desc" } }), NOW).rows.map((r) => r.id)).toEqual(["b", "a"]);
    expect(selectViewRows(pages, view({ query: { sort: "title_asc" } }), NOW).rows.map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("limit：截断显示但仍回报过滤后的总数（否则用户以为是全部）", () => {
    const pages = Array.from({ length: 30 }, (_, i) => page({ id: `p${i}`, updated_at: NOW - i * day }));
    const { rows, total } = selectViewRows(pages, view({ query: { limit: 10 } }), NOW);
    expect(rows).toHaveLength(10);
    expect(total).toBe(30);
  });

  it("排序/limit 写错时按默认处理，而不是让视图打不开", () => {
    const pages = [page({ id: "a" }), page({ id: "b", updated_at: NOW })];
    const { rows } = selectViewRows(pages, view({ query: { sort: "按心情", limit: -5 } }), NOW);
    expect(rows.map((r) => r.id)).toEqual(["b", "a"]);
    expect(rows).toHaveLength(2);
  });
});

describe("effectiveColumns", () => {
  it("过滤掉宿主不认识的列", () => {
    expect(effectiveColumns(view({ columns: ["title", "不认识的列", "kind"] }))).toEqual(["title", "kind"]);
  });

  it("一个都不认识时保底显示标题（而不是空表）", () => {
    expect(effectiveColumns(view({ columns: ["不认识的列"] }))).toEqual(["title"]);
  });
});

describe("cellText", () => {
  it("按列给出显示文本", () => {
    const p = page({ title: "甲", kind: "database", updated_at: NOW - 3 * day, created_at: NOW - 10 * day });
    expect(cellText(p, "title", NOW)).toBe("甲");
    expect(cellText(p, "kind", NOW)).toBe("database");
    expect(cellText(p, "days_since_update", NOW)).toBe("3 天");
    expect(cellText(p, "title_length", NOW)).toBe("1");
    expect(cellText(p, "updated_at", NOW)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("无标题、无时间都给可读的占位（不是 undefined）", () => {
    const p = page({ title: "", updated_at: 0 });
    expect(cellText(p, "title", NOW)).toBe("（无标题）");
    expect(cellText(p, "updated_at", NOW)).toBe("—");
    expect(cellText(p, "days_since_update", NOW)).toBe("—");
  });
});

describe("summaryText", () => {
  it("说清范围、总数与是否被截断", () => {
    expect(summaryText(30, 10, false, null)).toBe("全部：30 篇，显示前 10 篇");
    expect(summaryText(3, 3, true, 30)).toBe("最近 30 天内更新：3 篇");
  });
});
