// 能力在**前端（渲染进程）**这一侧的实现。
//
// 插件那一侧的实现是 Rust（`src-tauri/src/plugins.rs` 的 cap_*）；两边消费的是
// **同一份注册表**（capabilities/capabilities.json），所以工具的 id / 描述 / 参数
// schema / 是不是写操作都只有一处定义——这里只负责"怎么在前端真去执行"。
// 门禁（scripts/check-capabilities.mjs）会校验注册表里 `ai:true` 的能力在这里都有实现。
//
// 语义要与插件侧保持一致：省略 pageId 时都用**当前打开的页面**（插件侧由宿主解析，
// 这一侧由 notes store 解析）。

import { codePointLength, sliceByCodePoints } from "../textSnippet";
import { api } from "../api";
import { coverageReportTool, scanLibraryCoverage } from "../libraryCoverage";
import { draftBodyFields, fenceDoc, importMarkdownArgs, pageReadMeta, recordedText, textField } from "../docContent";
import { annotatedWindow, blockEndOffsets, pageRev } from "./pageAnchors";
import { pageJsonFromText } from "../ai/lexical";
import type { DraftResult } from "../ai/types";
import type { CoverageStores } from "../extract/coverageReport";

/** 宿主（AI 宿主）传给适配器的上下文：当前打开的页面 ＋ 派生层 store 的取用口。 */
export interface AdapterContext {
  currentPageId?: string | null;
  /** 「全库索引覆盖报告」要的那对 store（由有平台的那一层注入，见 `AiToolContext.derivedStores`）。 */
  derivedStores?: () => Promise<CoverageStores | undefined>;
}

export type CapabilityAdapter = (
  args: Record<string, unknown>,
  ctx?: AdapterContext,
) => Promise<unknown>;

// 与 web.ts 的 uid() 同形（本地一份，避免把平台内部实现拖进能力层）。
function makeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `blk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function draft(key: string, summary: string, payload: unknown): DraftResult {
  return { draft: true, key, summary, payload };
}

/**
 * 数值型参数的取值口径：**只认整数（或能解析成整数的字符串），其余一律回落默认值**。
 *
 * 这是照着 Rust 侧逐字对齐的 —— `plugins.rs` 的 `arg_i64`：
 *
 * ```rust
 * args.get(name).and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))).unwrap_or(default)
 * ```
 *
 * 于是三件事必须一致：① `0` 与负数**是合法值**（要取默认值的是"非法值"，不是"假值"）——
 * 写 `Number(x) || d` 会把 `0` 当成没传（这轮在四个适配器上各犯了一遍）；
 * ② 小数**回落默认值**（Rust 的 `as_i64()` 对 `2.5` 拿不到值）—— 取地板会在 `limit: 2.5` 时
 * 变成 TS 2 / 桌面 200；③ 数字字符串可以（`"7"` ⇒ 7，与 Rust 的 `parse()` 一致，含前置 `+`）。
 */
function intOr(v: unknown, d: number): number {
  if (typeof v === "number") return Number.isSafeInteger(v) ? v : d;
  if (typeof v === "string" && /^[+-]?\d+$/.test(v)) {
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : d;
  }
  return d;
}

/**
 * 数值型参数的**统一读法**：`取值（只认整数，见 intOr）→ 夹取到 [min, max]`。
 * 与 Rust 侧的 `arg_i64("<名>", 默认)` ＋ `limit.clamp(min, max)` 是同一套口径。
 *
 * 为什么必须收成一处（2026-09-18）：这轮对着注册表核对时，同一个坑在**四个适配器**上各犯了一遍 ——
 * 写成 `args.limit > 0 ? … : 默认` 或 `typeof args.limit === "number" ? … : 默认`，
 * 于是 `limit=0` 在 TS 侧被当成"没传"、在 Rust 侧被 `clamp(1,·)` 夹到 1
 * （`files.search` 10 vs 1、`files.read` 200 vs 1、`pages.get` 6000 vs 1…）。
 * 这类分歧两边都能跑、都返回合理结果，只能靠"三处摆一起"或机器判据发现；
 * 各自写一遍就一定会再犯，所以这里只留一个实现。
 */
function intArg(
  args: Record<string, unknown>,
  name: string,
  def: number,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  return Math.min(max, Math.max(min, intOr(args[name], def)));
}

/**
 * 布尔参数的统一读法（与 Rust 侧 `arg_bool` 同一口径）：真布尔 / `"true"`·`"false"`·`"1"`·`"0"`
 * / 数字（非 0 为真）都认，其它回落默认值。
 *
 * 为什么认字符串：插件 shim 由生成器按 `String(...)` 传布尔 ⇒ 插件写 `false` 时收到的是 `"false"`；
 * 不认它的话"显式关"与"没传"在两条路径上是同一个结果（默认 true 时尤其看不出来）。
 */
function boolArg(args: Record<string, unknown>, name: string, def: boolean): boolean {
  const v = args[name];
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true" || s === "1") return true;
    if (s === "false" || s === "0") return false;
  }
  if (typeof v === "number") return v !== 0;
  return def;
}

/**
 * 省略 pageId 时用当前打开的页面（与插件侧同一语义：**宿主解析**，插件不用自己猜）。
 *
 * 当前页来自宿主传进来的 ctx —— 这里**刻意不导入 UI store**：能力层要保持薄，
 * 一旦它依赖 store，就会把整条 UI 依赖链（编辑器/公式/katex…）拖进 AI 能力层。
 */
function targetPage(args: Record<string, unknown>, ctx?: AdapterContext): string {
  const given = String(args.pageId ?? "");
  if (given) return given;
  return ctx?.currentPageId ?? "";
}

/**
 * `pages.get` 单次返回正文的**上限**（字，按码点）。与 Rust 侧 `MAX_PAGE_TEXT_LIMIT` 一致，
 * 也与 `capabilities/capabilities.json` 里 `limit` 的 desc 一致。
 *
 * ⚠️ 这个上限本身是既有行为（防止一页几万字把模型上下文撑爆），**没有改**。
 * 改的是"截断时**说不说**"以及"**能不能往下翻**"——见 `pages.get` 实现里的注释。
 */
const PAGE_TEXT_LIMIT = 6000;
const MAX_PAGE_TEXT_LIMIT = 20_000;

/**
 * `blocks.list` 的 `limit` 默认值与上限，**必须与 Rust 侧一致**
 * （`cap_blocks_list`: `limit.clamp(1, 500)`，注册表 `default: 100`）。
 * 两侧不一致的症状很隐蔽：同一个页面在 Web 与桌面返回的块数不同，而调用方无从察觉。
 */
const BLOCKS_LIMIT_DEFAULT = 100;
const BLOCKS_LIMIT_MAX = 500;

/** `pages.search` 的 `limit` 默认值与上限：与注册表 `default: 8`、Rust `limit.clamp(1, 100)` 一致。 */
const SEARCH_LIMIT_DEFAULT = 8;
const SEARCH_LIMIT_MAX = 100;

/**
 * `pages.list` 的 `limit` 默认值与上限：注册表 `default: 50`、Rust `cap_pages_list` 的 `clamp(1, 200)`。
 * ⚠️ 这是**外部 agent 的发现通路**（搜索之外唯一能看到"这个空间有什么"的工具）⇒ 排序口径也必须一致：
 * 按 `updated_at` 倒序，不是侧栏树的 `sort_order/created_at` 顺序。
 */
const PAGES_LIST_LIMIT_DEFAULT = 50;
const PAGES_LIST_LIMIT_MAX = 200;

/** `files.search` 的 `limit`：注册表 `default: 10`、Rust `cap_files_search` 的 `clamp(1, 100)`。 */
const FILES_SEARCH_LIMIT_DEFAULT = 10;
const FILES_SEARCH_LIMIT_MAX = 100;

/**
 * `files.read` 的 `offset`/`limit`：注册表 `default: 0 / 200`，
 * Rust `cap_files_read` 的 `offset.max(0)` ＋ `limit.clamp(1, MAX_ATT_TEXT_LIMIT=1000)`。
 */
const FILES_READ_LIMIT_DEFAULT = 200;
const FILES_READ_LIMIT_MAX = 1000;

// ═══════════════════════════════════════════════════════════════════════════════
// B1b（2026-10-29）：`db.schema` / `db.rows` 的**应用内 AI 面**这一侧
//
// ⚠️ 口径的**权威实现在 Rust**（`src-tauri/src/database.rs` 的 `parse_row_filters` /
//    `query_db_rows`）：那边把 where 编成参数化 SQL、LIMIT/OFFSET 也在 SQL 里。这一侧没有
//    SQL 口（命令面是 `queryDatabase(dbPageId)`，返回全部行），所以这里按**逐字相同的语义**
//    在内存里做同一件事（未知字段/坏操作符/in 非数组 ⇒ 同样 `invalid_args` 并点名第几条）。
//    ⛔ 改一侧必须改另一侧 —— 两边给出不同答案而都不报错，正是本仓最忌的形状。
// ═══════════════════════════════════════════════════════════════════════════════

/** `db.rows` 的 `limit` 默认值与上限（注册表 `default: 100`、Rust `clamp(1, 500)`）。 */
const DB_ROWS_LIMIT_DEFAULT = 100;
const DB_ROWS_LIMIT_MAX = 500;
/** `db.rows` 响应体上限（与 Rust `MAX_DB_ROWS_BYTES` 同一个数：矩阵 §7「文本 ≤200 KB/次」）。 */
const DB_ROWS_MAX_BYTES = 200 * 1024;
/** `where` 操作符白名单（与 Rust `FilterOp` 同一个集合；矩阵 §4.4）。 */
const DB_WHERE_OPS = ["=", "!=", ">", ">=", "<", "<=", "in", "contains", "is_null"] as const;

type DbColumn = { id: string; name: string; attr_type: string };
type DbRowFilter = {
  colId: string;
  op: string;
  value: string;
  values: string[];
  numeric: boolean;
};

/** 标量 → 原始值字符串（与 Rust `scalar_text` 同口径）。 */
function dbScalarText(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  return null;
}

function dbJsonKind(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return "数组";
  switch (typeof v) {
    case "boolean":
      return "布尔";
    case "number":
      return "数字";
    case "string":
      return "字符串";
    default:
      return "对象";
  }
}

/** where 解析＋**按列校验**（未知字段 / 坏操作符 / in 非数组 ⇒ 人话 invalid_args，点名第几条）。 */
function parseDbWhere(
  whereArg: unknown,
  columns: DbColumn[],
): { filters: DbRowFilter[] } | { error: string } {
  if (whereArg === undefined || whereArg === null) return { filters: [] };
  if (!Array.isArray(whereArg)) {
    return { error: "invalid_args: where 必须是数组（[{field,op,value?}, …]，多条之间是 AND）" };
  }
  const filters: DbRowFilter[] = [];
  for (let i = 0; i < whereArg.length; i++) {
    const item = whereArg[i];
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return { error: `invalid_args: where[${i}] 必须是对象（{field,op,value?}），收到 ${dbJsonKind(item)}` };
    }
    const obj = item as Record<string, unknown>;
    const field = String(obj.field ?? "").trim();
    if (!field) {
      return { error: `invalid_args: where[${i}] 缺 field（列 id 或列名；先用 db.schema 看这个库有哪些列）` };
    }
    const op = String(obj.op ?? "").trim();
    if (!op) {
      return { error: `invalid_args: where[${i}] 缺 op（白名单：${DB_WHERE_OPS.join(" ")}）` };
    }
    if (!(DB_WHERE_OPS as readonly string[]).includes(op)) {
      return { error: `invalid_args: where[${i}] 的操作符「${op}」不在白名单（${DB_WHERE_OPS.join(" ")}）` };
    }
    // 列解析：**id 优先，其次列名**（与 Rust 逐字同口径）。
    const col = columns.find((c) => c.id === field) ?? columns.find((c) => c.name === field);
    if (!col) {
      return {
        error: `invalid_args: where[${i}] 的字段「${field}」不是这个库的列 —— 先用 db.schema 看列（id 或列名都接受；列名必须与实际名字完全一致）`,
      };
    }
    let value = "";
    const values: string[] = [];
    if (op === "is_null") {
      // is_null 不需要 value（给了也不看）
    } else if (op === "in") {
      if (obj.value === undefined) {
        return { error: `invalid_args: where[${i}] 的 in 需要 value 数组` };
      }
      if (!Array.isArray(obj.value)) {
        return { error: `invalid_args: where[${i}] 的 in 的 value 必须是**数组**（收到 ${dbJsonKind(obj.value)}）` };
      }
      if (obj.value.length === 0) {
        return { error: `invalid_args: where[${i}] 的 in 的 value 是空数组 —— 它永远匹配不到任何行；要不就别加这条` };
      }
      for (const it of obj.value) {
        const t = dbScalarText(it);
        if (t === null) {
          return {
            error: `invalid_args: where[${i}] 的 in 的数组元素必须是字符串/数字/布尔（收到 ${dbJsonKind(it)}）`,
          };
        }
        values.push(t);
      }
    } else {
      if (obj.value === undefined) {
        return { error: `invalid_args: where[${i}] 的「${op}」需要 value` };
      }
      const t = dbScalarText(obj.value);
      if (t === null) {
        return { error: `invalid_args: where[${i}] 的 value 必须是字符串/数字/布尔（收到 ${dbJsonKind(obj.value)}）` };
      }
      value = t;
    }
    filters.push({ colId: col.id, op, value, values, numeric: col.attr_type === "number" });
  }
  return { filters };
}

/** 解析后的数值（与 SQL `CAST(x AS REAL)` / 界面 `parseFloat` 同口径：非数字 ⇒ 0）。 */
function dbNumeric(raw: string): number {
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : 0;
}

/** 行值（缺失 = 空串，与 Rust `COALESCE(expr, '')` 同口径）。 */
function dbRawValue(row: { values: Record<string, string> }, colId: string): string {
  return row.values[colId] ?? "";
}

/** 一行是否满足全部 where（AND；与 Rust 生成的 SQL 同一个语义）。 */
function dbRowMatches(row: { values: Record<string, string> }, filters: DbRowFilter[]): boolean {
  for (const f of filters) {
    const raw = dbRawValue(row, f.colId);
    switch (f.op) {
      case "=":
        if (raw !== f.value) return false;
        break;
      case "!=":
        if (raw === f.value) return false;
        break;
      case ">":
      case ">=":
      case "<":
      case "<=": {
        // 数值列按数值比，其余按文本序（与 SQL 侧同一分支）。
        const a = f.numeric ? dbNumeric(raw) : raw;
        const b = f.numeric ? dbNumeric(f.value) : f.value;
        const ok =
          f.op === ">" ? a > b : f.op === ">=" ? a >= b : f.op === "<" ? a < b : a <= b;
        if (!ok) return false;
        break;
      }
      case "in": {
        const a = f.numeric ? dbNumeric(raw) : raw;
        const hit = f.values.some((v) => (f.numeric ? dbNumeric(v) === a : v === a));
        if (!hit) return false;
        break;
      }
      case "contains":
        if (!raw.includes(f.value)) return false;
        break;
      case "is_null":
        if (raw !== "") return false;
        break;
      default:
        return false;
    }
  }
  return true;
}

/** 视图配置里的标题过滤（与界面同口径：逗号 = OR、空格 = AND）。 */
function dbTitleFilterGroups(raw: string): string[][] {
  const key = raw.trim().toLowerCase();
  if (!key) return [];
  return key
    .split(/[，,]/)
    .map((g) => g.split(/\s+/).filter(Boolean))
    .filter((g) => g.length > 0);
}

/** 视图的标题过滤（`DatabaseView.tsx` 的 `rows` useMemo 逐字同口径）。 */
function dbPassesViewFilter(title: string, rawFilter: string): boolean {
  const groups = dbTitleFilterGroups(rawFilter);
  if (groups.length === 0) return true;
  const t = title.toLowerCase();
  return groups.some((g) => g.every((k) => t.includes(k)));
}

/** 视图的排序（与界面同口径：`__title` 或列 id；数值列按数值，其余 `localeCompare("zh")`）。 */
function dbSortRows(
  rows: { id: string; title: string; values: Record<string, string> }[],
  columns: DbColumn[],
  cfg: { key: string; dir: number },
): { id: string; title: string; values: Record<string, string> }[] {
  const { key, dir } = cfg;
  if (!key) return rows;
  const col = columns.find((c) => c.id === key);
  if (key !== "__title" && !col) return rows; // 界面同样：认不出的列 ⇒ 等于没排序
  return [...rows].sort((a, b) => {
    if (key === "__title") return String(a.title ?? "").localeCompare(String(b.title ?? ""), "zh") * dir;
    const av = dbRawValue(a, key);
    const bv = dbRawValue(b, key);
    if (col?.attr_type === "number") return (dbNumeric(av) - dbNumeric(bv)) * dir;
    return av.localeCompare(bv, "zh") * dir;
  });
}

/** 读视图配置里的 `{filter, sort}`（坏 JSON ⇒ 两项都没有，与界面一致）。 */
function dbViewCfg(config: string): { filter: string; sort: { key: string; dir: number } | null } {
  try {
    const cfg = JSON.parse(config) as Record<string, unknown>;
    const filter = typeof cfg.filter === "string" ? cfg.filter : "";
    const s = cfg.sort as { key?: unknown; dir?: unknown } | undefined;
    const key = typeof s?.key === "string" ? s.key.trim() : "";
    const dir = typeof s?.dir === "number" && s.dir < 0 ? -1 : 1;
    return { filter, sort: key ? { key, dir } : null };
  } catch {
    return { filter: "", sort: null };
  }
}

/** 跨空间的诚实回话（应用内 AI 没有跨空间数据库命令；⛔ 不静默回落当前空间）。 */
async function dbSpaceUnsupported(spaceId: string, what: string): Promise<{ ok: false; error: string } | null> {
  if (!spaceId) return null;
  const active = await api.getActiveWorkspaceId();
  if (spaceId === active) return null;
  return {
    ok: false,
    error: `应用内 AI 暂不支持跨空间${what}（命令面没有这一条）；外部接入请用「只读（全部空间）」档`,
  };
}

export const FRONTEND_ADAPTERS: Record<string, CapabilityAdapter> = {
  // ⭐ 2026-10-17：`pages.list` 进 AI/MCP 面 —— 外部 agent 以前**只能搜索**，
  // 搜不到就等于"库里没有"（没有第二条发现通路）。排序口径与 Rust 侧 `cap_pages_list` 一致：
  // `updated_at` 倒序（`api.listPages` 给的是侧栏树的 `sort_order/created_at` 顺序，别直接用）。
  "pages.list": async (args) => {
    const limit = intArg(args, "limit", PAGES_LIST_LIMIT_DEFAULT, 1, PAGES_LIST_LIMIT_MAX);
    // ⭐ 2026-10-18：`spaceId` —— 指定别的空间时走 `listWorkspacePages`（只读、不动活动空间 ✓）；
    //   不指定就是本空间那一条（`api.listPages`）。排序/字段两边一致。
    const spaceId = String(args.spaceId ?? "").trim();
    const rows = spaceId ? await api.listWorkspacePages(spaceId) : await api.listPages();
    const sorted = [...rows].sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
    return {
      ok: true,
      pages: sorted.slice(0, limit).map((p) => ({
        id: p.id,
        title: p.title,
        created_at: p.created_at,
        updated_at: p.updated_at,
      })),
    };
  },

  "pages.search": async (args) => {
    const query = String(args.q ?? "");
    // ⚠️ 默认值与上限**必须与注册表和 Rust 侧逐值相同**（`check-capabilities` 会比对注册表
    // 与 Rust 的字面默认值）。这里原先默认 8 却不夹取，而 Rust 是 `limit.clamp(1, 100)`：
    // 传 `limit: 999` 时 Web 与桌面拿到的条数就不一样了。
    const limit = intArg(args, "limit", SEARCH_LIMIT_DEFAULT, 1, SEARCH_LIMIT_MAX);
    if (!query) return { ok: false, error: "pages.search 需要 q" };
    const spaceId = String(args.spaceId ?? "").trim();
    if (!spaceId) {
      const rows = await api.search(query, limit, false);
      return { ok: true, pages: rows.map((r) => ({ id: r.id, title: r.title, snippet: r.snippet })) };
    }
    // ⭐ 2026-10-18：指定了空间 ⇒ 走**全空间**检索再按 `workspace_id` 筛（命令面没有"只搜某一个
    // 非活动空间"的入口）。候选集给到 200（`search` 的上限），筛完再截 limit —— 否则跨空间那一路
    // 会因为"每空间平分 limit"而少给。
    const all = await api.search(query, 200, true);
    const rows = all.filter((r) => r.workspace_id === spaceId).slice(0, limit);
    return { ok: true, pages: rows.map((r) => ({ id: r.id, title: r.title, snippet: r.snippet })) };
  },

  // ⭐ B1a（2026-10-29）：`page.current` 进 AI/MCP 面。与 `pages.get` **同口径**（整页窗口截到上限、
  //   块锚点、`rev`）；「当前页」由宿主 ctx 给（UI store 不进这一层，见 targetPage 的注释）。
  //   ⚠️ 没有打开的页面 ⇒ **如实**回 `opened:false`，⛔ 不拿"最近改过的一页"冒充（那会让 AI
  //   对着错误的页面总结）。插件面那条 ABI 不变（仍返回原始内容字符串，见 Rust `cap_page_current`）。
  "page.current": async (args, ctx) => {
    const id = ctx?.currentPageId ?? "";
    if (!id) {
      return {
        ok: true,
        opened: false,
        note: "当前没有打开的页面 —— 要读具体页面请先用 pages.list 发现 id、再用 pages.get 读。",
      };
    }
    let p: Awaited<ReturnType<typeof api.getPage>> | null = null;
    try {
      p = await api.getPage(id);
    } catch {
      p = null; // 页面不在了 / 不是页面节点（get_page 对非页面如实拒）⇒ 下面如实回 opened:false
    }
    if (!p) {
      return {
        ok: true,
        opened: false,
        note: `当前页 ${id} 读不到（可能已删除或不是页面节点）—— 请用 pages.list 重新发现。`,
      };
    }
    const includeAnchors = boolArg(args, "includeAnchors", true);
    const raw = recordedText(p);
    const total = codePointLength(raw);
    const meta = pageReadMeta(p);
    const rev = await pageRev(meta.updatedAt, meta.docJson);
    const text =
      includeAnchors && meta.docJson !== null
        ? annotatedWindow(raw, blockEndOffsets(meta.docJson, raw), 0, MAX_PAGE_TEXT_LIMIT)
        : sliceByCodePoints(raw, 0, MAX_PAGE_TEXT_LIMIT);
    return {
      ok: true,
      opened: true,
      page: {
        id: p.id,
        title: p.title,
        ...textField(text),
        kind: p.kind,
        chars_total: total,
        truncated: total > MAX_PAGE_TEXT_LIMIT,
        ...(rev ? { rev } : {}),
      },
    };
  },

  // ⭐ B1a（2026-10-29）：本空间未删除**节点数**（与 pages.list 同一集合：文件夹/数据库也算一个）——
  //   判据要求 `pages_count == listPages.length` ⇒ 直接数同一份清单，⛔ 不另写一遍口径。
  "pages.count": async (args) => {
    const spaceId = String(args.spaceId ?? "").trim();
    const rows = spaceId ? await api.listWorkspacePages(spaceId) : await api.listPages();
    return { ok: true, count: rows.length };
  },

  // ⭐ B1a：整棵空间树。与 Rust `cap_pages_tree` **同一集合、同一顺序**（`listPages` 已是
  //   sort_order → created_at 的树顺序）—— 这里只做映射，⛔ 不再二次排序（否则 Web 与桌面两种树）。
  "pages.tree": async (args) => {
    const spaceId = String(args.spaceId ?? "").trim();
    const limit = intArg(args, "limit", 2000, 1, 2000);
    const rows = spaceId ? await api.listWorkspacePages(spaceId) : await api.listPages();
    const target = spaceId || (await api.getActiveWorkspaceId());
    const spaceName = target
      ? (await api.listWorkspaces()).find((s) => s.id === target)?.name ?? ""
      : "";
    const nodes = rows.slice(0, limit).map((p) => ({
      id: p.id,
      title: p.title,
      kind: p.kind,
      parentId: p.parent_id ?? null,
      order: p.sort_order ?? 0,
    }));
    return {
      ok: true,
      spaceId: target,
      spaceName,
      nodes,
      total: rows.length,
      truncated: nodes.length < rows.length,
    };
  },

  // ⭐ B1a：标签清单（字段与 Rust `cap_tags_list` 一致）。⚠️ 命令面只有 `list_tags`（本空间）⇒
  //   给了**别的**空间就如实说不支持，⛔ 不静默回落当前空间（那会让调用方以为读到的是那个空间）。
  "tags.list": async (args) => {
    const spaceId = String(args.spaceId ?? "").trim();
    if (spaceId) {
      const active = await api.getActiveWorkspaceId();
      if (spaceId !== active) {
        return {
          ok: false,
          error: "应用内 AI 暂不支持跨空间列标签（命令面没有这一条）；外部接入请用「只读（全部空间）」档",
        };
      }
    }
    const tags = await api.listTags();
    return { ok: true, tags: tags.map((t) => ({ id: t.id, name: t.name, page_count: t.page_count ?? 0 })) };
  },

  // ⭐ B1a：属性定义（Rust 侧返回字段叫 `type`，TS 侧类型名是 `attr_type` ⇒ 只在这里换名）
  "properties.list": async (args) => {
    const spaceId = String(args.spaceId ?? "").trim();
    if (spaceId) {
      const active = await api.getActiveWorkspaceId();
      if (spaceId !== active) {
        return {
          ok: false,
          error: "应用内 AI 暂不支持跨空间列属性定义（命令面没有这一条）；外部接入请用「只读（全部空间）」档",
        };
      }
    }
    const defs = await api.listAttrDefs();
    return { ok: true, properties: defs.map((d) => ({ id: d.id, name: d.name, type: d.attr_type })) };
  },

  // ⭐ B1b（2026-10-29）：数据库结构（列/视图/关系列）。与 Rust `cap_db_schema` **同一份数据**：
  //   列走 `getDbColumns`、视图走 `listDbViews`（UI 用的就是这两条命令）⇒ 名字/顺序/类型对得上。
  //   公式/汇总列只**标明**（isFormula/isRollup），⛔ 不计算（矩阵 §13.2-6）。
  "db.schema": async (args) => {
    const pageId = String(args.pageId ?? "").trim();
    if (!pageId) return { ok: false, error: "invalid_args: 缺少参数 pageId（数据库页 id）" };
    const spaceId = String(args.spaceId ?? "").trim();
    const unsupported = await dbSpaceUnsupported(spaceId, "读数据库结构");
    if (unsupported) return unsupported;
    // 页面必须真的存在、且是**数据库**（命令面不会替我们校验 ⇒ 不校验就会把"空列"当成"空库"）。
    const pages = await api.listPages();
    const page = pages.find((p) => p.id === pageId);
    if (!page) {
      return {
        ok: false,
        error: `invalid_args: 找不到页面「${pageId}」（可能已删除，或 id 不是本空间的）—— 先用 pages.tree / pages.list 确认`,
      };
    }
    if (page.kind !== "database") {
      return {
        ok: false,
        error: `invalid_args: pageId「${pageId}」不是数据库页（kind=${page.kind}）—— 本应用的数据库是 kind=database 的页面节点；先用 pages.tree 找到它`,
      };
    }
    const [columns, views] = await Promise.all([api.getDbColumns(pageId), api.listDbViews(pageId)]);
    return {
      ok: true,
      pageId,
      spaceId: spaceId || (await api.getActiveWorkspaceId()),
      views: views.map((v) => ({ id: v.id, name: v.name, type: v.view_type })),
      columns: columns.map((c) => ({
        id: c.id,
        name: c.name,
        type: c.attr_type,
        ...(c.attr_type === "formula" ? { isFormula: true } : {}),
        ...(c.attr_type === "rollup" ? { isRollup: true } : {}),
      })),
      relations: columns
        .filter((c) => c.attr_type === "ref")
        .map((c) => ({ id: c.id, name: c.name, type: c.attr_type })),
    };
  },

  // ⭐ B1b（2026-10-29）：数据库行（**只给原始值**，⛔ 不重算公式/汇总）。
  //   ⚠️ 这一侧的「权威实现」在 Rust（SQL 侧过滤＋分页）；这里按逐字相同的语义在内存里做，
  //   因为应用内 AI 的命令面只有 `queryDatabase(dbPageId)`（返回全部行）。两边必须同步改。
  "db.rows": async (args) => {
    const pageId = String(args.pageId ?? "").trim();
    if (!pageId) return { ok: false, error: "invalid_args: 缺少参数 pageId（数据库页 id）" };
    const spaceId = String(args.spaceId ?? "").trim();
    const unsupported = await dbSpaceUnsupported(spaceId, "读数据库行");
    if (unsupported) return unsupported;
    const limit = intArg(args, "limit", DB_ROWS_LIMIT_DEFAULT, 1, DB_ROWS_LIMIT_MAX);
    const offset = Math.max(0, intOr(args.offset, 0));
    const pages = await api.listPages();
    const page = pages.find((p) => p.id === pageId);
    if (!page) {
      return {
        ok: false,
        error: `invalid_args: 找不到页面「${pageId}」（可能已删除，或 id 不是本空间的）—— 先用 pages.tree / pages.list 确认`,
      };
    }
    if (page.kind !== "database") {
      return {
        ok: false,
        error: `invalid_args: pageId「${pageId}」不是数据库页（kind=${page.kind}）—— 本应用的数据库是 kind=database 的页面节点`,
      };
    }
    const q = await api.queryDatabase(pageId);
    const columns: DbColumn[] = q.columns.map((c) => ({ id: c.id, name: c.name, attr_type: c.attr_type }));
    const parsed = parseDbWhere(args.where, columns);
    if ("error" in parsed) return { ok: false, error: parsed.error };

    // 视图：必须是**这个库**的视图（认不出就明确拒，⛔ 不静默当成"没有视图"）。
    let viewCfg: { filter: string; sort: { key: string; dir: number } | null } = { filter: "", sort: null };
    const viewId = String(args.viewId ?? "").trim();
    if (viewId) {
      const views = await api.listDbViews(pageId);
      const v = views.find((x) => x.id === viewId);
      if (!v) {
        return { ok: false, error: `invalid_args: viewId「${viewId}」不是这个库的视图 —— 先用 db.schema 看 views` };
      }
      viewCfg = dbViewCfg(v.config);
    }

    let rows = q.rows
      .filter((r) => dbRowMatches({ values: r.values }, parsed.filters))
      .map((r) => ({ id: r.page_id, title: r.title, values: r.values }));
    if (viewCfg.filter) rows = rows.filter((r) => dbPassesViewFilter(r.title, viewCfg.filter));
    if (viewCfg.sort) rows = dbSortRows(rows, columns, viewCfg.sort);

    const total = rows.length;
    const available = Math.max(0, total - offset);
    const slice = rows.slice(offset, offset + limit).map((r) => ({ id: r.id, values: r.values }));
    let truncated = slice.length < available;
    const note =
      "values 是**原始值**（数据库里存的字符串），本工具**不重算公式/汇总** —— " +
      "可能与界面里显示的计算值不同；`truncated:true` 表示本次没给全（调 limit/offset 翻页，或缩小 where）。";
    let body = {
      ok: true,
      pageId,
      spaceId: spaceId || (await api.getActiveWorkspaceId()),
      total,
      returned: slice.length,
      rows: slice,
      truncated,
      note,
    };
    const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
    if (bytes(body) > DB_ROWS_MAX_BYTES) {
      while (body.rows.length > 0) {
        body.rows.pop();
        body.returned = body.rows.length;
        body.truncated = true;
        if (bytes(body) <= DB_ROWS_MAX_BYTES) break;
      }
    }
    return body;
  },

  "pages.get": async (args) => {
    const spaceId = typeof args.spaceId === "string" ? args.spaceId.trim() : "";
    if (spaceId) return { ok: false, error: "应用内 AI 面不提供跨空间写（spaceId 仅外部 MCP 面支持）" };
    const id = String(args.id ?? "");
    if (!id) return { ok: false, error: "pages.get 需要 id" };
    const p = await api.getPage(id);
    if (!p) return { ok: false, error: `未找到页面 ${id}` };

    // ⚠️ **这里刻意不再 `trim()`**（2026-09-18 改）。原因不是洁癖，是分页一旦存在，
    // 窗口的"起点"就必须是**同一个固定字符串**：
    //   · 桌面路径（Rust `cap_pages_get`）切的是库里原始的正文列；
    //   · 这里若先 trim，`offset=6000` 在两条路径上指向的**不是同一个字符**
    //     ⇒ 调用方按同一条规则翻页会漏字/重字，而这种错**只在正文首尾有空白时**才出现（极难发现）。
    // 返回忠实原文也顺带满足"截断不改写文本"的既有原则（见下）。
    const raw = recordedText(p);
    const total = codePointLength(raw); // 按码点计数，emoji 不会被算成 2
    // ⚠️ **别用 `|| 默认值`**：`limit=0` 是 falsy，会被换成 6000，而 Rust 侧 `limit.clamp(1, ·)`
    // 给的是 1 ⇒ 同一个调用在两条路径上返回 6000 字与 1 字。这类"边界差一个"的坑靠 `Number.isFinite` 判。
    const offset = intArg(args, "offset", 0, 0);
    const limit = intArg(args, "limit", PAGE_TEXT_LIMIT, 1, MAX_PAGE_TEXT_LIMIT);
    const window = sliceByCodePoints(raw, offset, limit);
    // ⚠️ `returned` / `truncated` / note 里的字数**一律量正文窗口**，不含锚点行：
    // 锚点是我们加的注释，不该被算成"用户读到了几个字"，否则翻页口径（offset+returned）就变了。
    const returned = codePointLength(window);
    // `truncated` 的含义是"**还没读完**"（窗口没够到正文末尾），而不是"这页太长"：
    // 翻到最后一页时它必须是 false，否则模型会以为还有内容、无限翻下去。
    const truncated = offset + returned < total;

    // ⭐ P1 读面（2026-10-29）：**块锚点**（默认开）＋ `rev`（乐观并发令牌，不受开关影响）。
    //   · 锚点只插在本次窗口里 ⇒ 分页截断时不会给没返回的块加锚点；
    //   · 关掉开关 ⇒ 正文**逐字节**等于旧行为（读面省 token 的通道）；
    //   · `rev` 的两样输入只经 `docContent` 那一层取（落盘列名别处不许碰，见 `check-doc-content-access`）。
    const includeAnchors = boolArg(args, "includeAnchors", true);
    const meta = pageReadMeta(p);
    const rev = await pageRev(meta.updatedAt, meta.docJson);
    const text =
      includeAnchors && meta.docJson !== null
        ? annotatedWindow(raw, blockEndOffsets(meta.docJson, raw), offset, limit)
        : window;

    // ⚠️ **"成功"不等于"读全了"** —— 与抽取层的 `ExtractCoverage` 同一条原则（方案 §15.10）。
    // 原先截断后只在末尾补一个 `…`，有两个问题：
    //  ① **有歧义**：原文本身可能就以省略号结尾，模型分不清哪个是我们加的；
    //  ② **没信号**：模型看到 6000 字会以为"这就是整页"，然后自信地总结一个片段。
    // ⇒ 现在**不再改写文本**（返回的就是原文的忠实窗口），截断与否由**显式字段**说明，
    //    并且**直接告诉模型下一步该做什么**（否则它拿到"已截断"也不知道怎么办）。
    const parts: string[] = [];
    if (truncated) {
      parts.push(
        `内容已截断：该页正文共 ${total} 字，本次返回第 ${offset + 1}~${offset + returned} 字。` +
          `**不要据此以为读完了整页**；继续读取请再调 pages.get 并传 offset=${offset + returned}` +
          `（也可先 pages.search 定位相关段落，再用 blocks.list 逐块读）。`,
      );
    } else if (offset > 0) {
      // 翻到末尾时也要有明确信号，否则模型分不清"读完了"和"传错 offset 拿到空串"。
      parts.push(`本次返回第 ${offset + 1}~${offset + returned} 字，已到正文末尾（共 ${total} 字）。`);
    }
    return {
      ok: true,
      page: {
        id: p.id,
        title: p.title,
        ...textField(text),
        truncated,
        chars_total: total,
        offset,
        limit,
        chars_returned: returned,
        ...(rev ? { rev } : {}),
        ...(parts.length ? { note: parts.join("") } : {}),
      },
    };
  },

  // ⚠️ 这条适配器原本与注册表**有两处分歧**（2026-09-18 对着注册表查出并修掉）：
  //  ① 注册表声明 `pageId` **可选**（"省略 = 当前打开的页面"），这里却当必填直接报错 ——
  //     桌面路径（Rust `cap_blocks_list` → `target_page_or_current`）是支持省略的
  //     ⇒ 同一段插件代码在桌面能用、在 Web 报错。改成与 `backlinks.list` 一样走 `targetPage(args, ctx)`。
  //  ② 注册表声明 `limit`（默认 100），这里**根本没读** ⇒ Web 上"传了也没用"，
  //     而 Rust 侧 `limit.clamp(1,500).take(limit)` 是兑现的 ⇒ 两条路径返回的块数可能不同。
  // 这类"注册表承诺、某一侧不兑现"的分歧**没有任何编译期信号**，只能靠机器判据守
  // （`check-capabilities` 现在会检查两侧都读了声明的参数）。
  "blocks.list": async (args, ctx) => {
    const spaceId = typeof args.spaceId === "string" ? args.spaceId.trim() : "";
    if (spaceId) return { ok: false, error: "应用内 AI 面不提供跨空间写（spaceId 仅外部 MCP 面支持）" };
    const pageId = targetPage(args, ctx);
    if (!pageId) return { ok: false, error: "blocks.list 需要 pageId（省略时需要一个当前打开的页面）" };
    const limit = intArg(args, "limit", BLOCKS_LIMIT_DEFAULT, 1, BLOCKS_LIMIT_MAX);
    const blocks = await api.getPageBlocks(pageId);
    return { ok: true, blocks: blocks.slice(0, limit).map((b) => ({ blockId: b.block_id, text: b.text })) };
  },

  "backlinks.list": async (args, ctx) => {
    const pageId = targetPage(args, ctx);
    if (!pageId) return { ok: false, error: "backlinks.list 需要 pageId" };
    const links = await api.getBacklinks(pageId);
    return { ok: true, backlinks: links.map((l) => ({ id: l.id, title: l.title })) };
  },

  "files.list": async (args, ctx) => {
    const spaceId = typeof args.spaceId === "string" ? args.spaceId.trim() : "";
    if (spaceId) {
      return { ok: false, error: "应用内 AI 面只读当前空间（跨空间 spaceId 仅外部 MCP 面支持）" };
    }
    const pageId = targetPage(args, ctx);
    if (!pageId) return { ok: false, error: "files.list 需要 pageId" };
    const files = await api.listPageAttachments(pageId);
    return {
      ok: true,
      files: files.map((f) => ({ id: f.id, name: f.name, mime: f.mime, size: f.size })),
    };
  },

  "files.search": async (args) => {
    const spaceId = typeof args.spaceId === "string" ? args.spaceId.trim() : "";
    if (spaceId) {
      return { ok: false, error: "应用内 AI 面只读当前空间（跨空间 spaceId 仅外部 MCP 面支持）" };
    }
    const query = String(args.query ?? "").trim();
    if (!query) return { ok: false, error: "files.search 需要 query" };
    const limit = intArg(args, "limit", FILES_SEARCH_LIMIT_DEFAULT, 1, FILES_SEARCH_LIMIT_MAX);
    const hits = await api.searchChunks(query, limit);
    // 原样透出（pageId/attId/loc 就是回链三件套）：这一层**不加工**，
    // 免得 AI 与插件看到两种形状 —— 加工（拼标题、去重）属于调用方的展示逻辑。
    return { ok: true, hits };
  },

  "files.read": async (args) => {
    const spaceId = typeof args.spaceId === "string" ? args.spaceId.trim() : "";
    if (spaceId) {
      return { ok: false, error: "应用内 AI 面只读当前空间（跨空间 spaceId 仅外部 MCP 面支持）" };
    }
    const id = String(args.id ?? "");
    if (!id) return { ok: false, error: "files.read 需要 id" };
    const offset = intArg(args, "offset", 0, 0);
    const limit = intArg(args, "limit", FILES_READ_LIMIT_DEFAULT, 1, FILES_READ_LIMIT_MAX);
    const page = await api.readAttachmentText(id, offset, limit);
    // ⚠️ **不存在**（null）与**还没抽过**（segments 空）必须分开回话：
    //    合成一种，AI 就会把"还没索引"读成"文件里没有相关内容" —— 与 §15.10 用 ExtractCoverage
    //    防的是同一件事，只是发生在 AI 工具面。
    if (page === null) return { ok: true, file: null };
    return {
      ok: true,
      file: {
        id,
        segments: page.segments.map((r) => ({ extractor: r.extractor, kind: r.kind, text: r.text, loc: r.loc })),
        total: page.total,
        truncated: page.truncated,
        ...(page.segments.length === 0
          ? {
              note:
                "该附件没有派生文本：可能没有抽取器认领这种格式、抽取失败、或还没跑过抽取。" +
                "**不要**据此断言文件里没有相关内容。",
            }
          : {}),
      },
    };
  },

  // ⭐ B1c（2026-10-29）：版本快照 / 回收站 / 附件元数据（只读）＋ 导出/下载句柄。
  //   ⚠️ 句柄类的**唯一实现**在 Rust（`mcp_blobs`：单次/TTL 120s/绑会话）；前端没有"造句柄"的通道
  //   ⇒ `files.download` / `blobs.fetch` 在应用内面**如实报不可用**（⛔ 不发明一个前端句柄，
  //   那种句柄 blobs.fetch 兑换不了）。插件面走 Rust dispatch，句柄是真的。
  "versions.list": async (args) => {
    const spaceId = typeof args.spaceId === "string" ? args.spaceId.trim() : "";
    if (spaceId) {
      return { ok: false, error: "应用内 AI 面只读当前空间（跨空间 spaceId 仅外部 MCP 面支持）" };
    }
    const pageId = String(args.pageId ?? "").trim();
    if (!pageId) return { ok: false, error: "versions.list 需要 pageId" };
    const limit = intArg(args, "limit", 50, 1, 200);
    const rows = await api.listVersions(pageId);
    return {
      ok: true,
      versions: rows.slice(0, limit).map((v) => ({ versionId: v.id, at: v.created_at, title: v.title })),
    };
  },

  "version.get": async (args) => {
    const spaceId = typeof args.spaceId === "string" ? args.spaceId.trim() : "";
    if (spaceId) {
      return { ok: false, error: "应用内 AI 面只读当前空间（跨空间 spaceId 仅外部 MCP 面支持）" };
    }
    const pageId = String(args.pageId ?? "").trim();
    const versionId = String(args.versionId ?? "").trim();
    if (!pageId || !versionId) return { ok: false, error: "version.get 需要 pageId 与 versionId" };
    const offset = intArg(args, "offset", 0, 0);
    const limit = intArg(args, "limit", 6000, 1, 20000);
    // `includeAnchors` 在这里**不适用**（命令面只给纯文本、没有结构化块）—— 但要读这个参数：
    // 让调用方知道"我传了 true 却没拿到锚点"是有原因的，而不是工具悄悄违约。
    const includeAnchors = boolArg(args, "includeAnchors", true);
    const rows = await api.listVersions(pageId);
    const v = rows.find((x) => x.id === versionId);
    if (!v) return { ok: false, error: `not_found: 页面 ${pageId} 没有版本 ${versionId}` };
    const raw = recordedText(v);
    const total = codePointLength(raw);
    const window = sliceByCodePoints(raw, offset, limit);
    return {
      ok: true,
      version: {
        pageId,
        versionId,
        at: v.created_at,
        title: v.title,
        ...textField(window),
        chars_total: total,
        offset,
        limit,
        ...(includeAnchors
          ? { note: "应用内面拿不到版本的结构化正文 ⇒ 块锚点只有外部/插件面给得出（这里不带锚点行）" }
          : {}),
      },
    };
  },

  "trash.list": async (args) => {
    const spaceId = String(args.spaceId ?? "").trim();
    const limit = intArg(args, "limit", 50, 1, 200);
    if (spaceId) {
      const active = await api.getActiveWorkspaceId();
      if (spaceId !== active) {
        return {
          ok: false,
          error: "应用内 AI 暂不支持跨空间列回收站（命令面没有这一条）；外部接入请用「只读（全部空间）」档",
        };
      }
    }
    const rows = await api.listDeleted();
    return {
      ok: true,
      pages: rows.slice(0, limit).map((p) => ({ pageId: p.id, title: p.title, deletedAt: p.deleted_at ?? 0 })),
    };
  },

  "files.stat": async (args) => {
    const spaceIdArg = typeof args.spaceId === "string" ? args.spaceId.trim() : "";
    if (spaceIdArg) {
      return { ok: false, error: "应用内 AI 面只读当前空间（跨空间 spaceId 仅外部 MCP 面支持）" };
    }
    const attId = String(args.attId ?? "").trim();
    if (!attId) return { ok: false, error: "files.stat 需要 attId" };
    const a = await api.getAttachment(attId);
    if (!a) return { ok: false, error: `not_found: 附件 ${attId} 不存在` };
    const spaceId = await api.getActiveWorkspaceId();
    return {
      ok: true,
      file: {
        attId: a.id,
        // ⚠️ `get_attachment` 不返回 pageId（命令契约里没有这个字段）⇒ 如实给 null，⛔ 不编一个。
        pageId: null,
        name: a.name,
        mime: a.mime,
        size: a.size,
        sha256: a.hash,
        spaceId,
      },
    };
  },

  "files.extract_status": async (args) => {
    const spaceIdArg = typeof args.spaceId === "string" ? args.spaceId.trim() : "";
    if (spaceIdArg) {
      return { ok: false, error: "应用内 AI 面只读当前空间（跨空间 spaceId 仅外部 MCP 面支持）" };
    }
    const attId = String(args.attId ?? "").trim();
    if (!attId) return { ok: false, error: "files.extract_status 需要 attId" };
    // limit=1 只借它拿 total 与 coverage（段内容不要）
    const page = await api.readAttachmentText(attId, 0, 1);
    if (!page) return { ok: false, error: `not_found: 附件 ${attId} 不存在` };
    const a = await api.getAttachment(attId);
    return {
      ok: true,
      status: {
        attId,
        name: a?.name ?? "",
        extracted: page.total > 0,
        segments: page.total,
        extractors: (page.coverage ?? []).map((c) => ({ extractor: c.extractor, coverage: c.coverage })),
        note: "coverage 是抽取器报的**原始覆盖度**：空串/空数组 = 未知，⛔ 不许读成「完整」；extracted:false 只说明还没抽过。",
      },
    };
  },

  "files.list_orphan": async (args) => {
    const spaceId = typeof args.spaceId === "string" ? args.spaceId.trim() : "";
    if (spaceId) {
      return { ok: false, error: "应用内 AI 面只读当前空间（跨空间 spaceId 仅外部 MCP 面支持）" };
    }
    const limit = intArg(args, "limit", 50, 1, 200);
    const offset = intArg(args, "offset", 0, 0);
    // `listPageAttachments(null)` 就是 `page_id IS NULL`（与 Rust 侧同一条 SQL 的过滤条件）
    const rows = await api.listPageAttachments(null);
    return {
      ok: true,
      files: rows.slice(offset, offset + limit).map((a) => ({
        attId: a.id,
        name: a.name,
        mime: a.mime,
        size: a.size,
        sha256: a.hash,
        createdAt: a.created_at ?? 0,
      })),
      total: rows.length,
    };
  },

  "files.download": async (args) => {
    const spaceId = typeof args.spaceId === "string" ? args.spaceId.trim() : "";
    if (spaceId) {
      return { ok: false, error: "应用内 AI 面只读当前空间（跨空间 spaceId 仅外部 MCP 面支持）" };
    }
    const attId = String(args.attId ?? "").trim();
    if (!attId) return { ok: false, error: "files.download 需要 attId" };
    return {
      ok: false,
      error:
        "应用内 AI 面不提供下载句柄（句柄表在 Rust 侧、绑定外部/插件会话）—— " +
        "要读附件文本用 files.read；要原文件请在文件管理里另存。外部接入用 files_download + blobs_fetch。",
    };
  },

  "blobs.fetch": async (args) => {
    const handle = String(args.handle ?? "").trim();
    if (!handle) return { ok: false, error: "blobs.fetch 需要 handle" };
    return {
      ok: false,
      error:
        "应用内 AI 面没有句柄通道（句柄只能由外部接入/插件面兑换，本面也造不出来）—— " +
        "外部接入请调 blobs_fetch；应用内要落文件请用文件管理的另存/导出。",
    };
  },

  /**
   * `coverage.report` —— 实现在 TS（抽取器注册表那一侧），**外部/插件面经 Rust→前端桥**取同一份输出。
   *
   * 为什么必须只有一份：报告要判"**没人认领这种格式**（`no_extractor`）"，而"谁认领什么格式"
   * 的唯一事实源是 TS 侧的抽取器注册表（`extract/registry.ts`）。Rust 侧再长一份就是两份实现，
   * 而它们的漂移**不会报错** ⇒ 2026-10-29（B3）起由桥把这一份结果搬给 MCP 面（⛔ 不复制逻辑）。
   * ⇒ 这里**复用**现成的三层：`ctx.derivedStores()`（配对 store）→ `scanLibraryCoverage`（取材）
   * → `coverageReportTool`（形状），一行新逻辑都不写。
   *
   * ⚠️ **store 是 `ctx` 注入的，不是这里 `import { platform }`**：这层会被 `smoke-web` 的
   * AI 核心包静态打包，而那个包只装纯逻辑 —— 见 `AiToolContext.derivedStores` 的注释。
   * ⚠️ `spaceId`（B3）：报告是**当前空间**的派生层口径 ⇒ 只接受当前空间，给别的空间明确 `bad_args`
   * （⛔ 不假装支持跨空间，也不静默回落）。
   */
  "coverage.report": async (args, ctx) => {
    const spaceId = String(args.spaceId ?? "").trim();
    if (spaceId) {
      const active = await api.getActiveWorkspaceId();
      if (spaceId !== active) {
        return {
          ok: false,
          error: "bad_args: 覆盖率报告只覆盖当前空间（跨空间未接）—— 省略 spaceId 即当前空间",
        };
      }
    }
    const getStores = ctx?.derivedStores;
    if (!getStores) {
      return { ok: false, error: "这条路径没有派生层存储，索引覆盖报告不可用（桌面版/已启用本地库才有）" };
    }
    const stores: CoverageStores | undefined = await getStores();
    if (!stores) return { ok: false, error: "这个平台没有派生层存储，索引覆盖报告不可用" };
    return coverageReportTool(await scanLibraryCoverage(stores));
  },

  // ⭐ B3：导出类 —— **句柄表在 Rust 侧、只服务外部/插件面**；应用内 AI 面没有句柄通道
  //   （与 `files.download` / `blobs.fetch` 同一条诚实边界）。参数仍逐条读（⛔ 不许"声明了不读"）。
  "export.markdown": async (args) => {
    const pageId = String(args.pageId ?? "").trim();
    const spaceId = String(args.spaceId ?? "").trim();
    const target = pageId ? `页面 ${pageId}` : spaceId ? `空间 ${spaceId}` : "（未指定目标）";
    return {
      ok: false,
      error:
        `应用内 AI 面不提供导出句柄（${target}）—— 句柄表在 Rust 侧、绑定外部/插件会话；` +
        "要文件请用文件管理的导出入口，外部接入用 export_markdown + blobs_fetch。",
    };
  },

  "export.docpackage": async (args) => {
    const spaceId = typeof args.spaceId === "string" ? args.spaceId.trim() : "";
    if (spaceId) return { ok: false, error: "应用内 AI 面不提供跨空间导出（spaceId 仅外部 MCP 面支持）" };
    const pageId = String(args.pageId ?? "").trim();
    if (!pageId) return { ok: false, error: "export.docpackage 需要 pageId" };
    return {
      ok: false,
      error:
        "应用内 AI 面不提供导出句柄（.shuyodoc）—— 句柄表在 Rust 侧、绑定外部/插件会话；" +
        "要文件请用页面右键「导出为 .shuyodoc」，外部接入用 export_docpackage + blobs_fetch。",
    };
  },

  "pages.create": async (args) => {
    const spaceId = typeof args.spaceId === "string" ? args.spaceId.trim() : "";
    if (spaceId) return { ok: false, error: "应用内 AI 面不提供跨空间写（spaceId 仅外部 MCP 面支持）" };
    const title = String(args.title ?? "").trim();
    if (!title) return { ok: false, error: "pages.create 需要 title" };
    const dryRun = args.dryRun === true;
    const clientRequestId = typeof args.clientRequestId === "string" ? args.clientRequestId : "";
    if (dryRun) {
      return { ok: true, dryRun: true, would: { kind: "create_page", title }, clientRequestId };
    }
    // ⭐ R166：带 `fence` ⇒ **一整块** code 块 ✓（⛔ 不拆块 ✗）
    const fence = typeof args.fence === "string" && args.fence ? args.fence : null;
    const body = fence
      ? fenceDoc(fence, String(args.content ?? ""), makeId)
      : pageJsonFromText(String(args.content ?? ""), makeId);
    const parentId = typeof args.parentId === "string" && args.parentId ? args.parentId : null;
    return draft(`create_page:${title}`, `新建页面「${title}」`, {
      kind: "create_page",
      args: { parent_id: parentId, title, ...draftBodyFields(body) },
    });
  },

  // ⭐ R167：整篇 Markdown 导入（一次写完 ✓）—— 能力面只做**轻守卫**与组参 ✓，
  // 真正的 md→块解析在落库层（应用自己的导入路径 ✓）—— 避免把编辑器整张图拖进这个包 ✗
  "pages.importMarkdown": async (args) => {
    const title = String(args.title ?? "").trim();
    if (!title) return { ok: false, error: "pages.importMarkdown 需要 title" };
    const dryRun = args.dryRun === true;
    const clientRequestId = typeof args.clientRequestId === "string" ? args.clientRequestId : "";
    if (dryRun) {
      return { ok: true, dryRun: true, would: { kind: "create_page", title, markdown: true }, clientRequestId };
    }
    const built = importMarkdownArgs(title, String(args.markdown ?? ""), typeof args.parentId === "string" && args.parentId ? args.parentId : null);
    if (!built.ok) return { ok: false, error: built.error };
    return draft(`import_markdown:${title}`, `导入 Markdown 新建页面「${title}」`, {
      kind: "create_page",
      args: built.args,
    });
  },

  // ⭐ pages.update（2026-10-17）：**整页替换**已有页面 —— 与 Rust `cap_pages_update` 同一语义：
  //   只产出草稿、不落库；正文只做轻守卫（空/超限），md→块的解析留给落库层（`ai/apply.ts` ✓）。
  //   ⚠️ 目标页 id 必填（Rust 侧 `arg_str("id")?` ✓），不走"当前页"回落。
  "pages.update": async (args) => {
    const spaceId = typeof args.spaceId === "string" ? args.spaceId.trim() : "";
    if (spaceId) return { ok: false, error: "应用内 AI 面不提供跨空间写（spaceId 仅外部 MCP 面支持）" };
    const id = String(args.id ?? "").trim();
    if (!id) return { ok: false, error: "pages.update 需要 id" };
    const expectedRev = typeof args.expectedRev === "string" ? args.expectedRev : "";
    const dryRun = args.dryRun === true;
    const clientRequestId = typeof args.clientRequestId === "string" ? args.clientRequestId : "";
    if (dryRun) {
      return { ok: true, dryRun: true, would: { kind: "update_page", pageId: id, expectedRev }, clientRequestId };
    }
    const markdown = typeof args.markdown === "string" ? args.markdown : "";
    const content = typeof args.content === "string" ? args.content : "";
    const title = typeof args.title === "string" && args.title.trim() ? args.title.trim() : null;
    if (!markdown.trim() && !content.trim()) {
      return { ok: false, error: "pages.update 需要 markdown 或 content 之一" };
    }
    const bodyLen = Math.max(markdown.length, content.length);
    if (bodyLen > 200 * 1024) {
      return { ok: false, error: "pages.update 的新正文超过 200KB 上限，请拆分后再更新" };
    }
    const body = markdown.trim() ? { markdown } : { plain: content };
    return draft(`update_page:${id}`, `更新页面 ${id}（整页替换）`, {
      kind: "update_page",
      pageId: id,
      title,
      expectedRev,
      clientRequestId,
      ...body,
    });
  },

  // ⭐ spaces.list / spaces.switch（2026-10-17）：MCP / AI 宿主都要能看见并切换空间。
  //   list：只读两跳（listWorkspaces + active id）；switch：只产出草稿，真正切换走 store（唯一实现）。
  // ⭐ UX-①（2026-10-30）：drafts.status / audit.tail —— 本机 MCP 面的闭环读数；
  //   应用内 AI 面没有"草稿状态表/本会话审计"这条通道 ⇒ 如实说不可用（⛔ 不编造）。
  "drafts.status": async (args) => {
    const draftId = String(args.draftId ?? "").trim();
    if (!draftId) return { ok: false, error: "drafts.status 需要 draftId" };
    return { ok: false, error: "应用内 AI 面不提供 MCP 草稿状态（draftId 只在外部门户/插件面生成）" };
  },

  "audit.tail": async (args) => {
    const onlyWrites = args.onlyWrites === true;
    const raw = Number(args.limit ?? 20);
    const limit = Number.isFinite(raw) ? Math.max(1, Math.min(100, Math.trunc(raw))) : 20;
    return { ok: false, error: `应用内 AI 面不提供 MCP 审计环（limit=${limit}${onlyWrites ? "，仅写" : ""} 只在外部门户/插件面可用）` };
  },

  // ⭐ UX-②：模板清单（应用内面也走同一份 listTemplates）
  "templates.list": async () => {
    const rows = await api.listTemplates();
    return { ok: true, templates: rows.map((t) => ({ templateId: t.id, name: t.name, title: t.name })) };
  },

  // ⭐ UX-③：当前空间（应用内面也走同一份 spaces/list 数据源）
  "space.current": async () => {
    const [spaces, active, pages] = await Promise.all([
      api.listWorkspaces(),
      api.getActiveWorkspaceId(),
      api.listPages(),
    ]);
    const hit = spaces.find((s) => s.id === active);
    return { ok: true, spaceId: active, name: hit?.name ?? "", pageCount: pages.length };
  },

  // ⭐ UX-⑤：新名（旧名 pages.importMarkdown 保留，同一能力、行为一致）
  "pages.import_markdown": async (args) => {
    const title = String(args.title ?? "").trim();
    const dryRun = args.dryRun === true;
    const clientRequestId = typeof args.clientRequestId === "string" ? args.clientRequestId : "";
    if (!title) return { ok: false, error: "pages.import_markdown 需要 title" };
    if (dryRun) return { ok: true, dryRun: true, would: { kind: "create_page", title, markdown: true }, clientRequestId };
    const built = importMarkdownArgs(title, String(args.markdown ?? ""), typeof args.parentId === "string" && args.parentId ? args.parentId : null);
    if (!built.ok) return { ok: false, error: built.error };
    return draft(`import_markdown:${title}`, `导入 Markdown 新建页面「${title}」`, { kind: "create_page", args: built.args });
  },

  // ⭐ UX-⑦：导出拆名（旧 export.markdown 保留）
  "export.page_markdown": async (args) => {
    const pageId = String(args.pageId ?? "").trim();
    const spaceId = String(args.spaceId ?? "").trim();
    if (!pageId) return { ok: false, error: "export.page_markdown 需要 pageId" };
    if (spaceId) return { ok: false, error: "export.page_markdown 只接受 pageId（整空间请用 export_space_markdown）" };
    return { ok: false, error: "应用内 AI 面不提供导出句柄 —— 要文件请用文件管理的导出入口；外部接入用 export_page_markdown + blobs_fetch。" };
  },

  "export.space_markdown": async (args) => {
    const spaceId = String(args.spaceId ?? "").trim();
    const pageId = String(args.pageId ?? "").trim();
    if (pageId) return { ok: false, error: "export.space_markdown 只接受 spaceId（单页请用 export_page_markdown）" };
    return { ok: false, error: `应用内 AI 面不提供导出句柄（空间 ${spaceId || "当前"}）—— 外部接入用 export_space_markdown + blobs_fetch。` };
  },

  // ⭐ P2：页级增量（应用内面没有跨页 updated_at 扫描的宿主接口 ⇒ 如实说不可用）
  "pages.changes_since": async (args) => {
    const since = args.since;
    const limit = Number(args.limit ?? 50);
    const spaceId = typeof args.spaceId === "string" ? args.spaceId.trim() : "";
    if (since === undefined || since === null || since === "") return { ok: false, error: "pages.changes_since 需要 since" };
    return { ok: false, error: `应用内 AI 面不提供页级增量扫描（since=${String(since)}, limit=${limit}${spaceId ? ", spaceId=" + spaceId : ""}）—— 外部 MCP 面可用` };
  },

  "spaces.list": async () => {
    const [spaces, active] = await Promise.all([api.listWorkspaces(), api.getActiveWorkspaceId()]);
    return {
      ok: true,
      active,
      spaces: spaces.map((s) => ({ id: s.id, name: s.name })),
    };
  },

  "spaces.switch": async (args) => {
    const id = typeof args.id === "string" ? args.id.trim() : "";
    const name = typeof args.name === "string" ? args.name.trim() : "";
    if (!id && !name) return { ok: false, error: "spaces.switch 需要 id 或 name 之一" };
    const spaces = await api.listWorkspaces();
    let target: { id: string; name: string } | null = null;
    if (id) {
      target = spaces.find((s) => s.id === id) ?? null;
    } else {
      const hits = spaces.filter((s) => s.name === name);
      if (hits.length > 1) {
        return { ok: false, error: `有 ${hits.length} 个空间都叫「${name}」，请改用 id` };
      }
      target = hits[0] ?? null;
    }
    if (!target) return { ok: false, error: "找不到目标空间（可先调 spaces.list）" };
    return draft(`switch_space:${target.id}`, `切换空间到「${target.name}」`, {
      kind: "switch_space",
      spaceId: target.id,
      name: target.name,
    });
  },

  "blocks.append": async (args, ctx) => {
    const spaceId = typeof args.spaceId === "string" ? args.spaceId.trim() : "";
    if (spaceId) return { ok: false, error: "应用内 AI 面不提供跨空间写（spaceId 仅外部 MCP 面支持）" };
    const pageId = targetPage(args, ctx);
    const text = String(args.text ?? "").trim();
    if (!pageId) return { ok: false, error: "blocks.append 需要 pageId" };
    if (!text) return { ok: false, error: "blocks.append 需要 text" };
    const expectedRev = typeof args.expectedRev === "string" ? args.expectedRev : "";
    const dryRun = args.dryRun === true;
    const clientRequestId = typeof args.clientRequestId === "string" ? args.clientRequestId : "";
    if (dryRun) {
      return { ok: true, dryRun: true, would: { kind: "append_block", pageId, expectedRev }, clientRequestId };
    }
    return draft(
      `append_block:${pageId}:${text.slice(0, 24)}`,
      `向页面追加 ${text.split("\n").filter((s) => s.trim()).length} 个段落`,
      { kind: "append_block", pageId, text, fence: args.fence ?? null, expectedRev, clientRequestId },
    );
  },
  // ⭐ B2-块（2026-10-29）：块级写 —— 全部草稿确认；正文转换仍只在前端那一份（apply.ts）。
  "blocks.patch": async (args) => {
    const blockId = String(args.blockId ?? "").trim();
    const markdown = typeof args.markdown === "string" ? args.markdown : "";
    const text = typeof args.text === "string" ? args.text : "";
    const expectedRev = typeof args.expectedRev === "string" ? args.expectedRev : "";
    const spaceId = typeof args.spaceId === "string" ? args.spaceId.trim() : "";
    const dryRun = args.dryRun === true;
    const clientRequestId = typeof args.clientRequestId === "string" ? args.clientRequestId : "";
    if (!blockId) return { ok: false, error: "blocks.patch 需要 blockId" };
    if (!markdown.trim() && !text.trim()) return { ok: false, error: "blocks.patch 需要 markdown 或 text" };
    if (dryRun) return { ok: true, dryRun: true, applied: false, would: { kind: "blocks_patch", blockId, expectedRev }, clientRequestId, spaceId };
    return draft(`blocks_patch:${blockId}`, `替换块 ${blockId}`, {
      kind: "blocks_patch",
      blockId,
      markdown: markdown.trim() ? markdown : undefined,
      plain: markdown.trim() ? undefined : text,
      expectedRev,
      clientRequestId,
      spaceId,
    });
  },

  "blocks.insert": async (args) => {
    const pageId = String(args.pageId ?? "").trim();
    const afterBlockId = typeof args.afterBlockId === "string" && args.afterBlockId ? args.afterBlockId : null;
    const markdown = typeof args.markdown === "string" ? args.markdown : "";
    const text = typeof args.text === "string" ? args.text : "";
    const expectedRev = typeof args.expectedRev === "string" ? args.expectedRev : "";
    const spaceId = typeof args.spaceId === "string" ? args.spaceId.trim() : "";
    const dryRun = args.dryRun === true;
    const clientRequestId = typeof args.clientRequestId === "string" ? args.clientRequestId : "";
    if (!pageId && !afterBlockId) return { ok: false, error: "blocks.insert 需要 pageId 或 afterBlockId" };
    if (!markdown.trim() && !text.trim()) return { ok: false, error: "blocks.insert 需要 markdown 或 text" };
    const newBlockId = `blk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    if (dryRun) return { ok: true, dryRun: true, applied: false, newBlockId, would: { kind: "blocks_insert", pageId, afterBlockId, expectedRev }, clientRequestId, spaceId };
    return draft(`blocks_insert:${pageId || afterBlockId}`, `在页面插入块`, {
      kind: "blocks_insert",
      pageId,
      afterBlockId,
      newBlockId,
      markdown: markdown.trim() ? markdown : undefined,
      plain: markdown.trim() ? undefined : text,
      expectedRev,
      clientRequestId,
      spaceId,
    });
  },

  "blocks.delete": async (args) => {
    const blockId = String(args.blockId ?? "").trim();
    const expectedRev = typeof args.expectedRev === "string" ? args.expectedRev : "";
    const spaceId = typeof args.spaceId === "string" ? args.spaceId.trim() : "";
    const dryRun = args.dryRun === true;
    const clientRequestId = typeof args.clientRequestId === "string" ? args.clientRequestId : "";
    if (!blockId) return { ok: false, error: "blocks.delete 需要 blockId" };
    if (dryRun) return { ok: true, dryRun: true, applied: false, would: { kind: "blocks_delete", blockId, expectedRev }, clientRequestId, spaceId };
    return draft(`blocks_delete:${blockId}`, `删除块 ${blockId}`, {
      kind: "blocks_delete",
      blockId,
      expectedRev,
      clientRequestId,
      spaceId,
    });
  },
  // ⭐ B2-附件与模板（2026-10-29）：全部草稿确认
  "files.move": async (args) => {
    const attId = String(args.attId ?? "").trim();
    const toPageId = String(args.toPageId ?? "").trim();
    const expectedSha = typeof args.expectedSha === "string" ? args.expectedSha : "";
    const spaceId = typeof args.spaceId === "string" ? args.spaceId.trim() : "";
    const dryRun = args.dryRun === true;
    const clientRequestId = typeof args.clientRequestId === "string" ? args.clientRequestId : "";
    if (!attId || !toPageId) return { ok: false, error: "files.move 需要 attId 与 toPageId" };
    if (dryRun) return { ok: true, dryRun: true, would: { kind: "move_attachment", attId, toPageId, expectedSha }, clientRequestId, spaceId };
    return draft(`move_attachment:${attId}`, `移动附件 ${attId}`, { kind: "move_attachment", attId, toPageId, expectedSha, clientRequestId, spaceId });
  },

  "files.rename": async (args) => {
    const attId = String(args.attId ?? "").trim();
    const name = String(args.name ?? "").trim();
    const expectedSha = typeof args.expectedSha === "string" ? args.expectedSha : "";
    const spaceId = typeof args.spaceId === "string" ? args.spaceId.trim() : "";
    const dryRun = args.dryRun === true;
    const clientRequestId = typeof args.clientRequestId === "string" ? args.clientRequestId : "";
    if (!attId || !name) return { ok: false, error: "files.rename 需要 attId 与 name" };
    if (dryRun) return { ok: true, dryRun: true, would: { kind: "rename_attachment", attId, name }, clientRequestId, spaceId };
    return draft(`rename_attachment:${attId}`, `把附件改名为「${name}」`, { kind: "rename_attachment", attId, name, expectedSha, clientRequestId, spaceId });
  },

  "files.delete": async (args) => {
    const attId = String(args.attId ?? "").trim();
    const expectedSha = typeof args.expectedSha === "string" ? args.expectedSha : "";
    const spaceId = typeof args.spaceId === "string" ? args.spaceId.trim() : "";
    const dryRun = args.dryRun === true;
    const clientRequestId = typeof args.clientRequestId === "string" ? args.clientRequestId : "";
    if (!attId) return { ok: false, error: "files.delete 需要 attId" };
    if (dryRun) return { ok: true, dryRun: true, would: { kind: "delete_attachment", attId, expectedSha }, clientRequestId, spaceId };
    return draft(`delete_attachment:${attId}`, `删除附件 ${attId}`, { kind: "delete_attachment", attId, expectedSha, clientRequestId, spaceId });
  },

  "templates.apply": async (args) => {
    const templateId = String(args.templateId ?? "").trim();
    const parentId = typeof args.parentId === "string" && args.parentId ? args.parentId : null;
    const spaceId = typeof args.spaceId === "string" ? args.spaceId.trim() : "";
    const dryRun = args.dryRun === true;
    const clientRequestId = typeof args.clientRequestId === "string" ? args.clientRequestId : "";
    if (!templateId) return { ok: false, error: "templates.apply 需要 templateId" };
    if (dryRun) return { ok: true, dryRun: true, would: { kind: "apply_template", templateId, parentId }, clientRequestId, spaceId };
    return draft(`apply_template:${templateId}`, `用模板 ${templateId} 新建页面`, { kind: "apply_template", templateId, parentId, clientRequestId, spaceId });
  },
  // ⭐ B2-补遗-1（2026-10-29）：受控上传通道（用户选文件）＋ 导入文档包 ＋ 附件 detach
  "files.upload_to_page": async (args) => {
    const pageId = String(args.pageId ?? "").trim();
    const name = typeof args.name === "string" ? args.name : "";
    const spaceId = typeof args.spaceId === "string" ? args.spaceId.trim() : "";
    const dryRun = args.dryRun === true;
    const clientRequestId = typeof args.clientRequestId === "string" ? args.clientRequestId : "";
    if (!pageId) return { ok: false, error: "files.upload_to_page 需要 pageId" };
    if (dryRun) return { ok: true, dryRun: true, would: { kind: "upload_attachment", pageId, nameHint: name || null }, clientRequestId, spaceId };
    return draft(`upload_attachment:${pageId}`, `上传附件到页面（需要你亲自选文件）`, { kind: "upload_attachment", pageId, nameHint: name || null, clientRequestId, spaceId });
  },

  "import.docpackage": async (args) => {
    const parentId = typeof args.parentId === "string" && args.parentId ? args.parentId : null;
    const spaceId = typeof args.spaceId === "string" ? args.spaceId.trim() : "";
    const dryRun = args.dryRun === true;
    const clientRequestId = typeof args.clientRequestId === "string" ? args.clientRequestId : "";
    if (dryRun) return { ok: true, dryRun: true, would: { kind: "import_docpackage", parentId }, clientRequestId, spaceId };
    return draft("import_docpackage", "导入 .shuyodoc（需要你亲自选文件；永远新建）", { kind: "import_docpackage", parentId, clientRequestId, spaceId });
  },

  "files.detach": async (args) => {
    const attId = String(args.attId ?? "").trim();
    const spaceId = typeof args.spaceId === "string" ? args.spaceId.trim() : "";
    const dryRun = args.dryRun === true;
    const clientRequestId = typeof args.clientRequestId === "string" ? args.clientRequestId : "";
    if (!attId) return { ok: false, error: "files.detach 需要 attId" };
    if (dryRun) return { ok: true, dryRun: true, would: { kind: "detach_attachment", attId }, clientRequestId, spaceId };
    return draft(`detach_attachment:${attId}`, `把附件从页面摘除（保留文件）`, { kind: "detach_attachment", attId, clientRequestId, spaceId });
  },
  // ⭐ B2-补遗-2（2026-10-29）：数据库行写入/删除（只简单表格原始列；行=子页面）
  "db.rows_write": async (args) => {
    const pageId = String(args.pageId ?? "").trim();
    const rows = Array.isArray(args.rows) ? args.rows : [];
    const expectedRev = typeof args.expectedRev === "string" ? args.expectedRev : "";
    const spaceId = typeof args.spaceId === "string" ? args.spaceId.trim() : "";
    const dryRun = args.dryRun === true;
    const clientRequestId = typeof args.clientRequestId === "string" ? args.clientRequestId : "";
    if (!pageId || rows.length === 0) return { ok: false, error: "db.rows_write 需要 pageId 与非空 rows" };
    if (dryRun) return { ok: true, dryRun: true, applied: false, would: { kind: "db_rows_write", pageId, rows, expectedRev }, clientRequestId, spaceId };
    return draft(`db_rows_write:${pageId}`, `数据库行写入（${rows.length} 行草稿）`, { kind: "db_rows_write", pageId, rows, expectedRev, clientRequestId, spaceId });
  },

  "db.rows_delete": async (args) => {
    const pageId = String(args.pageId ?? "").trim();
    const rowIds = Array.isArray(args.rowIds) ? args.rowIds : [];
    const expectedRev = typeof args.expectedRev === "string" ? args.expectedRev : "";
    const spaceId = typeof args.spaceId === "string" ? args.spaceId.trim() : "";
    const dryRun = args.dryRun === true;
    const clientRequestId = typeof args.clientRequestId === "string" ? args.clientRequestId : "";
    if (!pageId || rowIds.length === 0) return { ok: false, error: "db.rows_delete 需要 pageId 与非空 rowIds" };
    if (dryRun) return { ok: true, dryRun: true, applied: false, would: { kind: "db_rows_delete", pageId, rowIds, expectedRev }, clientRequestId, spaceId };
    return draft(`db_rows_delete:${pageId}`, `删除数据库行（${rowIds.length} 行草稿）`, { kind: "db_rows_delete", pageId, rowIds, expectedRev, clientRequestId, spaceId });
  },




  // ⭐ B2-结构（2026-10-29）：节点/文件夹/回收站/回退/标签移除/属性去掉。
  //   全部返回**草稿**（落库只有 ai/apply.ts 一处）；dryRun 只回"会做什么"、不生成草稿。
  "folders.create": async (args) => {
    const spaceId = typeof args.spaceId === "string" ? args.spaceId.trim() : "";
    const title = String(args.title ?? "").trim();
    const parentId = typeof args.parentId === "string" && args.parentId ? args.parentId : null;
    const dryRun = args.dryRun === true;
    const clientRequestId = typeof args.clientRequestId === "string" ? args.clientRequestId : "";
    if (!title) return { ok: false, error: "folders.create 需要 title" };
    if (dryRun) return { ok: true, dryRun: true, would: { kind: "create_folder", title, parentId }, clientRequestId, spaceId };
    return draft(`create_folder:${parentId ?? "root"}:${title}`, `新建文件夹「${title}」`, {
      kind: "create_folder",
      title,
      parent_id: parentId,
      clientRequestId,
      spaceId,
    });
  },

  "nodes.move": async (args) => {
    const spaceId = typeof args.spaceId === "string" ? args.spaceId.trim() : "";
    const id = String(args.id ?? "").trim();
    const newParentId = typeof args.newParentId === "string" && args.newParentId ? args.newParentId : null;
    const sortOrder = Number.isFinite(Number(args.sortOrder)) ? Number(args.sortOrder) : 0;
    const expectedRev = typeof args.expectedRev === "string" ? args.expectedRev : "";
    const dryRun = args.dryRun === true;
    const clientRequestId = typeof args.clientRequestId === "string" ? args.clientRequestId : "";
    if (!id) return { ok: false, error: "nodes.move 需要 id" };
    if (dryRun) {
      return { ok: true, dryRun: true, would: { kind: "move_node", id, newParentId, sortOrder, expectedRev }, clientRequestId, spaceId };
    }
    return draft(`move_node:${id}`, `移动节点 ${id}`, {
      kind: "move_node",
      id,
      newParentId,
      sortOrder,
      expectedRev,
      clientRequestId,
      spaceId,
    });
  },

  "nodes.rename": async (args) => {
    const spaceId = typeof args.spaceId === "string" ? args.spaceId.trim() : "";
    const id = String(args.id ?? "").trim();
    const title = String(args.title ?? "").trim();
    const expectedRev = typeof args.expectedRev === "string" ? args.expectedRev : "";
    const dryRun = args.dryRun === true;
    const clientRequestId = typeof args.clientRequestId === "string" ? args.clientRequestId : "";
    if (!id || !title) return { ok: false, error: "nodes.rename 需要 id 和 title" };
    if (dryRun) return { ok: true, dryRun: true, would: { kind: "rename_node", id, title, expectedRev }, clientRequestId, spaceId };
    return draft(`rename_node:${id}`, `把节点 ${id} 改名为「${title}」`, {
      kind: "rename_node",
      id,
      title,
      expectedRev,
      clientRequestId,
      spaceId,
    });
  },

  "nodes.delete": async (args) => {
    const spaceId = typeof args.spaceId === "string" ? args.spaceId.trim() : "";
    const id = String(args.id ?? "").trim();
    const expectedRev = typeof args.expectedRev === "string" ? args.expectedRev : "";
    const dryRun = args.dryRun === true;
    const clientRequestId = typeof args.clientRequestId === "string" ? args.clientRequestId : "";
    if (!id) return { ok: false, error: "nodes.delete 需要 id" };
    if (dryRun) return { ok: true, dryRun: true, would: { kind: "delete_node", id, expectedRev }, clientRequestId, spaceId };
    return draft(`delete_node:${id}`, `删除节点 ${id}（移入回收站，可恢复）`, {
      kind: "delete_node",
      id,
      expectedRev,
      clientRequestId,
      spaceId,
    });
  },

  "trash.restore": async (args) => {
    const spaceId = typeof args.spaceId === "string" ? args.spaceId.trim() : "";
    const id = String(args.id ?? "").trim();
    const dryRun = args.dryRun === true;
    const clientRequestId = typeof args.clientRequestId === "string" ? args.clientRequestId : "";
    if (!id) return { ok: false, error: "trash.restore 需要 id" };
    if (dryRun) return { ok: true, dryRun: true, would: { kind: "restore_page", id }, clientRequestId, spaceId };
    return draft(`restore_page:${id}`, `从回收站恢复 ${id}`, {
      kind: "restore_page",
      id,
      clientRequestId,
      spaceId,
    });
  },

  "pages.revert": async (args) => {
    const spaceId = typeof args.spaceId === "string" ? args.spaceId.trim() : "";
    const pageId = String(args.pageId ?? "").trim();
    const versionId = String(args.versionId ?? "").trim();
    const expectedRev = typeof args.expectedRev === "string" ? args.expectedRev : "";
    const dryRun = args.dryRun === true;
    const clientRequestId = typeof args.clientRequestId === "string" ? args.clientRequestId : "";
    if (!pageId || !versionId) return { ok: false, error: "pages.revert 需要 pageId 和 versionId" };
    if (dryRun) {
      return { ok: true, dryRun: true, would: { kind: "revert_page", pageId, versionId, expectedRev }, clientRequestId, spaceId };
    }
    return draft(`revert_page:${pageId}:${versionId}`, `把页面 ${pageId} 回退到版本 ${versionId}`, {
      kind: "revert_page",
      pageId,
      versionId,
      expectedRev,
      clientRequestId,
      spaceId,
    });
  },

  "tags.add": async (args, ctx) => {
    const spaceId = typeof args.spaceId === "string" ? args.spaceId.trim() : "";
    const pageId = targetPage(args, ctx);
    const name = String(args.name ?? "").trim();
    const expectedRev = typeof args.expectedRev === "string" ? args.expectedRev : "";
    const dryRun = args.dryRun === true;
    const clientRequestId = typeof args.clientRequestId === "string" ? args.clientRequestId : "";
    if (!pageId || !name) return { ok: false, error: "tags.add 需要 name（与 pageId/当前页）" };
    if (dryRun) return { ok: true, dryRun: true, would: { kind: "add_tag", pageId, name, expectedRev }, clientRequestId, spaceId };
    return draft(`add_tag:${pageId}:${name}`, `给页面加标签「${name}」`, {
      kind: "add_tag",
      pageId,
      name,
      expectedRev,
      clientRequestId,
      spaceId,
    });
  },

  "tags.remove": async (args, ctx) => {
    const spaceId = typeof args.spaceId === "string" ? args.spaceId.trim() : "";
    const pageId = targetPage(args, ctx);
    const name = String(args.name ?? "").trim();
    const expectedRev = typeof args.expectedRev === "string" ? args.expectedRev : "";
    const dryRun = args.dryRun === true;
    const clientRequestId = typeof args.clientRequestId === "string" ? args.clientRequestId : "";
    if (!pageId || !name) return { ok: false, error: "tags.remove 需要 name（与 pageId/当前页）" };
    if (dryRun) return { ok: true, dryRun: true, would: { kind: "remove_tag", pageId, name, expectedRev }, clientRequestId, spaceId };
    return draft(`remove_tag:${pageId}:${name}`, `从页面移除标签「${name}」`, {
      kind: "remove_tag",
      pageId,
      name,
      expectedRev,
      clientRequestId,
      spaceId,
    });
  },

  "properties.set": async (args, ctx) => {
    const spaceId = typeof args.spaceId === "string" ? args.spaceId.trim() : "";
    const pageId = targetPage(args, ctx);
    const attrId = String(args.attrId ?? "").trim();
    const value = String(args.value ?? "");
    const expectedRev = typeof args.expectedRev === "string" ? args.expectedRev : "";
    const dryRun = args.dryRun === true;
    const clientRequestId = typeof args.clientRequestId === "string" ? args.clientRequestId : "";
    if (!pageId || !attrId) return { ok: false, error: "properties.set 需要 attrId（与 pageId/当前页）" };
    if (dryRun) {
      return { ok: true, dryRun: true, would: { kind: "set_page_prop", pageId, attrId, value, expectedRev }, clientRequestId, spaceId };
    }
    return draft(`set_page_prop:${pageId}:${attrId}`, `给页面设置属性 ${attrId} = ${value}`, {
      kind: "set_page_prop",
      pageId,
      attrId,
      value,
      expectedRev,
      clientRequestId,
      spaceId,
    });
  },

  "properties.unset": async (args, ctx) => {
    const spaceId = typeof args.spaceId === "string" ? args.spaceId.trim() : "";
    const pageId = targetPage(args, ctx);
    const attrId = String(args.attrId ?? "").trim();
    const expectedRev = typeof args.expectedRev === "string" ? args.expectedRev : "";
    const dryRun = args.dryRun === true;
    const clientRequestId = typeof args.clientRequestId === "string" ? args.clientRequestId : "";
    if (!pageId || !attrId) return { ok: false, error: "properties.unset 需要 attrId（与 pageId/当前页）" };
    if (dryRun) {
      return { ok: true, dryRun: true, would: { kind: "unset_page_prop", pageId, attrId, expectedRev }, clientRequestId, spaceId };
    }
    return draft(`unset_page_prop:${pageId}:${attrId}`, `去掉页面的属性 ${attrId}`, {
      kind: "unset_page_prop",
      pageId,
      attrId,
      expectedRev,
      clientRequestId,
      spaceId,
    });
  },
};
