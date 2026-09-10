import type { PageMeta } from "../types";

/**
 * 声明式视图的**宿主渲染逻辑**（M11.9）。
 *
 * 声明式插件是零代码的：查询、排序、列格式化全部由宿主做，插件只交一份声明。所以这些
 * 规则必须**可预期且可测**——作者没法自己写代码绕过，写错了也不会报错，只会显示成
 * 「结果不对」，那种错最难查。这里把它抽成纯函数就是为了钉住它。
 *
 * 与 Rust 侧白名单（`VIEW_COLUMNS` / `VIEW_SORTS` / `VIEW_KINDS`）保持一致；不认识的值
 * 一律按默认处理（而不是抛错）：插件装上去不该因为一个拼错的列名就整个视图打不开——
 * 校验器会明确告诉作者哪个值不认识。
 */

export interface PluginViewQuery {
  kind?: string;
  title_contains?: string;
  updated_within_days?: number;
  sort?: string;
  limit?: number;
}

export interface PluginView {
  id: string;
  title: string;
  query: PluginViewQuery;
  columns: string[];
  summary: boolean;
}

/** 宿主支持的列（键 → 表头）。 */
export const VIEW_COLUMNS: { key: string; title: string }[] = [
  { key: "title", title: "标题" },
  { key: "kind", title: "类型" },
  { key: "updated_at", title: "更新时间" },
  { key: "created_at", title: "创建时间" },
  { key: "days_since_update", title: "距上次更新" },
  { key: "title_length", title: "标题长度" },
];

export const VIEW_SORTS = ["updated_desc", "created_desc", "title_asc", "title_desc"] as const;

const DAY = 86_400_000;

function fmtDate(ms: number): string {
  if (!ms) return "—";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 一行的某一列显示成什么（表头由 `VIEW_COLUMNS` 给）。 */
export function cellText(page: PageMeta, column: string, now = Date.now()): string {
  switch (column) {
    case "title":
      return page.title || "（无标题）";
    case "kind":
      return page.kind || "page";
    case "updated_at":
      return fmtDate(page.updated_at);
    case "created_at":
      return fmtDate(page.created_at);
    case "days_since_update":
      return page.updated_at ? `${Math.floor((now - page.updated_at) / DAY)} 天` : "—";
    case "title_length":
      return String((page.title || "").length);
    default:
      return "";
  }
}

/** 作者声明的列 → 实际渲染的列（过滤掉宿主不认识的，且保底有标题列）。 */
export function effectiveColumns(view: PluginView): string[] {
  const known = view.columns.filter((c) => VIEW_COLUMNS.some((k) => k.key === c));
  return known.length > 0 ? known : ["title"];
}

/**
 * 按声明查询页面。返回 { rows, total }：
 * `total` 是**过滤后、截断前**的数量，用于汇总行（"共 N 篇，显示前 M 篇"）——
 * 只报显示条数会让用户以为是全部。
 */
export function selectViewRows(
  pages: PageMeta[],
  view: PluginView,
  now = Date.now(),
): { rows: PageMeta[]; total: number } {
  const q = view.query ?? {};
  const kind = q.kind && q.kind !== "any" ? q.kind : null;
  const contains = (q.title_contains ?? "").trim().toLowerCase();
  const withinDays = typeof q.updated_within_days === "number" && q.updated_within_days > 0 ? q.updated_within_days : null;

  let filtered = pages.filter((p) => {
    if (p.deleted_at) return false; // 已删除的页面不该出现在任何视图里
    if (kind && (p.kind || "page") !== kind) return false;
    if (contains && !(p.title || "").toLowerCase().includes(contains)) return false;
    if (withinDays !== null && (!p.updated_at || now - p.updated_at > withinDays * DAY)) return false;
    return true;
  });

  const sort = VIEW_SORTS.includes(q.sort as (typeof VIEW_SORTS)[number]) ? q.sort : "updated_desc";
  filtered = [...filtered].sort((a, b) => {
    switch (sort) {
      case "created_desc":
        return b.created_at - a.created_at;
      case "title_asc":
        return (a.title || "").localeCompare(b.title || "", "zh");
      case "title_desc":
        return (b.title || "").localeCompare(a.title || "", "zh");
      default:
        return b.updated_at - a.updated_at;
    }
  });

  const limit = typeof q.limit === "number" && q.limit > 0 ? Math.min(q.limit, 500) : 50;
  return { rows: filtered.slice(0, limit), total: filtered.length };
}

/** 顶部汇总行（声明 `summary: true` 时显示）。 */
export function summaryText(total: number, shown: number, hasRecentFilter: boolean, recentDays: number | null): string {
  const scope = hasRecentFilter && recentDays ? `最近 ${recentDays} 天内更新` : "全部";
  const tail = total > shown ? `，显示前 ${shown} 篇` : "";
  return `${scope}：${total} 篇${tail}`;
}
