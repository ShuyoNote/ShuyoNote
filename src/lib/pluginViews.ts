import type { PageMeta, PluginSetting } from "../types";

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

/** 查询字段的取值：**字面量**，或指向用户在插件管理里设的那个设置（`{ fromSetting }`）。 */
export type ViewField<T extends string | number> = T | { fromSetting: string };

/**
 * 视图查询（**manifest 里写 camelCase**：`titleContains` / `updatedWithinDays`——
 * 与 `apiVersion` / `fromSetting` 一致。字段名跟着 Rust 侧的 `rename_all = "camelCase"`，
 * 两边任何一边改名字，这条链路都会静默失效，所以 Rust 与这里各有一条测试钉住）。
 */
export interface PluginViewQuery {
  kind?: ViewField<string>;
  titleContains?: ViewField<string>;
  updatedWithinDays?: ViewField<number>;
  sort?: ViewField<string>;
  limit?: ViewField<number>;
}

export interface PluginView {
  id: string;
  title: string;
  query: PluginViewQuery;
  columns: string[];
  summary: boolean;
  /** 开在哪里（manifest `placement`）：`overlay` 浮层 / `rail` 右侧常驻面板。缺省 = overlay。 */
  placement?: string;
}

/** 视图的两种落点：浮层（默认）与右侧常驻面板。 */
export type ViewPlacement = "overlay" | "rail";

/** Rust 侧白名单（`plugins::VIEW_PLACEMENTS`）的镜像；不认识的值一律按 `overlay` 处理。 */
export const VIEW_PLACEMENTS: ViewPlacement[] = ["overlay", "rail"];

/**
 * 这个视图该开在哪里。**默认只有一处**：不认识的值（拼错的 `"sidebar"`、老插件没写）
 * 一律按 `overlay`，与 Rust 侧白名单同口径——声明式插件的原则是"永远打得开"，而浮层是
 * 那个永远成立的形态。校验器已经在作者那边把不认识的值指出来了。
 */
export function viewPlacement(view: { placement?: string }): ViewPlacement {
  const p = (view.placement ?? "").trim();
  return (VIEW_PLACEMENTS as string[]).includes(p) ? (p as ViewPlacement) : "overlay";
}

/**
 * 右侧抽屉的占用键：`插件id::视图id`。
 *
 * 为什么需要它：右侧一次只开一个抽屉（AI / 目录 / 评论 / 插件面板），"当前开的是哪个插件
 * 的哪个视图"必须是一个**可比较的值**——用 id 而不是视图对象，因为视图对象每次刷新
 * （页面列表变化）都可能是新引用，拿对象做相等判断会让面板自己闪掉。
 */
export function viewPlacementKey(pluginId: string, view: { id: string }): string {
  return `${pluginId}::${view.id}`;
}

/** 已解析的查询：字段都是普通值（`resolveView` 的产物）。 */
export interface ResolvedViewQuery {
  kind?: string;
  titleContains?: string;
  updatedWithinDays?: number;
  sort?: string;
  limit?: number;
}

/**
 * 已解析的视图。`selectViewRows` 只接受这个类型——**解析只有一处**（`resolveView`），
 * 类型上就把"忘了先解析"这条路堵掉，而不是靠每个调用点自觉。
 */
export interface ResolvedView extends Omit<PluginView, "query"> {
  query: ResolvedViewQuery;
}

/** 用户设置（后端 `plugin_settings`；`value` 是用户设过的值，没设过为 null）。 */
export type ViewSetting = Pick<PluginSetting, "key" | "type" | "value" | "default" | "options">;

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

/** 宿主支持的 kind 取值（与 Rust 侧 `VIEW_KINDS` 一致）。 */
export const VIEW_KINDS = ["any", "page", "database"] as const;

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

/** 这个视图是否用到了设置（不需要的话就不必读一遍设置再渲染）。 */
export function viewNeedsSettings(view: PluginView): boolean {
  const q = view.query ?? {};
  return [q.kind, q.titleContains, q.updatedWithinDays, q.sort, q.limit].some(
    (f) => typeof f === "object" && f !== null && typeof (f as { fromSetting?: unknown }).fromSetting === "string",
  );
}

/**
 * 把一个字段的原始取值解析成普通值。
 *
 * 规则（三条，都可预期）：
 * 1. **字面量直接用**（并且仍然要过该字段的类型检查——`"limit": "x"` 这种形态根本进不来，
 *    加载器会拒载，见校验器）；
 * 2. **`{ fromSetting }`** 取用户设过的值，没设过取该设置声明的 `default`；
 * 3. 两者都没有、或者值不可用（不是数字、不在白名单）→ **按"没给"处理**（即宿主的默认
 *    行为），绝不抛错——插件声明的数据不该让面板打不开。这类问题由校验器在作者那边指出。
 *
 * 默认值**只有一处**（设置声明里的 `default`）：不在这里再放一个，两个默认值必然会漂。
 */
function rawValue(field: unknown, settings: ViewSetting[]): string | number | undefined {
  if (typeof field === "string" || typeof field === "number") return field;
  if (typeof field !== "object" || field === null) return undefined;
  const key = (field as { fromSetting?: unknown }).fromSetting;
  if (typeof key !== "string") return undefined;
  const setting = settings.find((s) => s.key === key);
  if (!setting) return undefined;
  const value = setting.value ?? setting.default;
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number" || typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  return undefined;
}

function numeric(field: unknown, settings: ViewSetting[]): number | undefined {
  const v = rawValue(field, settings);
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function text(field: unknown, settings: ViewSetting[]): string | undefined {
  const v = rawValue(field, settings);
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return undefined;
}

/**
 * 解析视图的查询：把 `{ fromSetting }` 换成用户设的值。
 *
 * 三条规则（与 Rust 侧 `check_view_params` 是同一套判断的两端，作者文档 §4.9 有表）：
 * - **不认识的值一律按"没给"处理**（即宿主默认行为）——包括 `kind` / `sort` 的白名单外取值：
 *   这一个和旧行为不同（旧代码会把白名单外的 `kind` 当作过滤条件、结果是一张空表），改成
 *   与文档承诺一致："写错的值不会让视图打不开，只是那一项按默认处理"。
 * - **默认值只有一处**：设置声明里的 `default`（这里不再放第二个）。
 * - **不修改入参**（返回新的 view）：视图声明来自插件列表、多处共用，就地改会把"某个用户的
 *   设置"写进所有人的视图里。
 */
export function resolveView(view: PluginView, settings: ViewSetting[] = []): ResolvedView {
  const q = view.query ?? {};
  const query: ResolvedViewQuery = {};
  const kind = text(q.kind, settings);
  if (kind && VIEW_KINDS.includes(kind as (typeof VIEW_KINDS)[number])) query.kind = kind;
  const contains = text(q.titleContains, settings);
  if (contains && contains.trim()) query.titleContains = contains;
  const days = numeric(q.updatedWithinDays, settings);
  if (days !== undefined && days > 0) query.updatedWithinDays = Math.trunc(days);
  const sort = text(q.sort, settings);
  if (sort && VIEW_SORTS.includes(sort as (typeof VIEW_SORTS)[number])) query.sort = sort;
  const limit = numeric(q.limit, settings);
  if (limit !== undefined && limit > 0) query.limit = Math.trunc(limit);
  return { ...view, query };
}

/**
 * 按声明查询页面。返回 { rows, total }：
 * `total` 是**过滤后、截断前**的数量，用于汇总行（"共 N 篇，显示前 M 篇"）——
 * 只报显示条数会让用户以为是全部。
 *
 * 入参必须是**已解析**的视图（先过 `resolveView`）：`{ fromSetting }` 那种形态在这里
 * 一律不认得，直接算"没给"——把解析放在唯一一处，避免每个调用点各写一遍。
 */
export function selectViewRows(
  pages: PageMeta[],
  view: ResolvedView,
  now = Date.now(),
): { rows: PageMeta[]; total: number } {
  const q = view.query;
  const kind = q.kind && q.kind !== "any" ? q.kind : null;
  const contains = (q.titleContains ?? "").trim().toLowerCase();
  const withinDays = typeof q.updatedWithinDays === "number" && q.updatedWithinDays > 0 ? q.updatedWithinDays : null;

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
