// 数据库块 → 可检索正文的**纯函数**（「全库 AI 覆盖」方案 P3-② 的纯函数半）。
//
// ## 为什么单独一个文件、以及为什么**只做纯函数**
//
// 方案 P3 那格缺的是"**列名 ＋ 行 ＋ 规则**进正文文本列"（`loc` ＝ 行 id）。接线那半在
// `DatabaseView.tsx` / 页面正文派生链（`contentText.ts` → `docContent.ts::refreshPageTextIfStale`；⚠️ 2026-09-23 订正：旧注里写的 `writeContentTextIfChanged` 在仓里**不存在**，是名字在扩散）里，
// **归属是那两个文件的作者**；本文件只提供可单测的纯函数 ＋ 判据，接线怎么做由他们定
// （工作单见方案 P3 末尾，2026-09-22）。
//
// ## 三条刻意写下来的设计决定
//
//  1. **不发明"行 ref"的内联方言**：正文里只放**人读**的列/行文本；行的 `page_id` 通过返回值
//     `rowRefs` 交给接线侧 —— 要不要挂 `[[标题]]`（已有的页面链接字面量）或别的回链形态，由他们定。
//     本仓已经吃过"两处各自发明一套口径"的亏（§15.9 归一化、`depsCatalog` 的注释漂移）。
//  2. **"规则"由调用方渲染成人话**（`rules`）：视图的 `config` 是 JSON 方言，本函数**不认识也不猜**——
//     猜等于在这儿固化了第二套视图语义。
//  3. **空库返回空串**（不是"数据库：无行"这类占位）：接线侧据此**不写**正文，与
//     `refreshPageTextIfStale`「不同才写」的口径一致；截断则**必须明说**（与抽取层"不完整要标注"同源）。
//
// 纯文本、无 markdown 标记（与 §15.3-3 以及页面正文的既有口径一致）。

import type { AttrDef, DatabaseRow } from "../types";

/** 选择型列的候选值也属于"规则"的一部分（用户按它筛，AI 也该看得见）。 */
const SELECT_TYPES = new Set(["select", "multi_select"]);

/** 默认单次进正文的行数上限：那是**正文列**，不是数据导出（大库不许把整张表灌进去）。 */
export const DEFAULT_MAX_ROWS = 200;

export interface DatabaseTextInput {
  /** 数据库页标题（可省；省了就不写"数据库：…"那一行）。 */
  title?: string;
  columns: readonly AttrDef[];
  rows: readonly DatabaseRow[];
  /** 视图规则（筛选/排序/汇总）的**人读**描述，由调用方渲染。 */
  rules?: readonly string[];
  /** 进正文的行数上限（默认 `DEFAULT_MAX_ROWS`）。 */
  maxRows?: number;
}

export interface DatabaseTextResult {
  /** 进正文列的纯文本。**空库 ⇒ 空串**（调用方据此不写）。 */
  text: string;
  /** 每行的 (page_id, 标题) —— 接线侧要挂回链时用它；本函数不发明内联方言。 */
  rowRefs: { pageId: string; title: string }[];
  /** 因上限被截掉的行数（0 ＝ 没截）。>0 时正文里**明说**。 */
  truncated: number;
}

/** 单元格值 → 人读文本（空值 ⇒ `""`，由调用方决定跳过）。 */
function cellText(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : raw === undefined || raw === null ? "" : String(raw).trim();
}

/** 列 → **裸列名**（行内单元格用这个：`状态＝进行中`，不能把选项表也塞进每一行）。 */
function columnName(col: AttrDef): string {
  return cellText(col?.name) || cellText(col?.attr_type) || "列";
}

/** 列 → 列头描述：`状态（选项：待办、进行中）`；普通列就是列名。**只用在「列：」那一行。** */
function columnLabel(col: AttrDef): string {
  const name = columnName(col);
  const opts = Array.isArray(col?.options) ? col.options.map(cellText).filter(Boolean) : [];
  if (SELECT_TYPES.has(String(col?.attr_type ?? "")) && opts.length > 0) return `${name}（选项：${opts.join("、")}）`;
  return name;
}

/**
 * 把一次数据库查询结果（列 ＋ 行 ＋ 规则）渲染成可检索的纯文本。
 *
 * **确定性**：同一份输入 ⇒ 逐字相同的输出。列的顺序**只按 `columns` 的顺序**（不依赖 `values` 的键序，
 * 对象键序不是契约）；行的顺序**按给定顺序**（查询已经在服务端定序，本函数不重排 —— 重排会让"同一页
 * 两次保存产生不同正文"）。
 */
export function databaseTextOf(input: DatabaseTextInput): DatabaseTextResult {
  const columns = input?.columns ?? [];
  const rows = input?.rows ?? [];
  const maxRows = Math.max(0, Number(input?.maxRows ?? DEFAULT_MAX_ROWS));
  const lines: string[] = [];

  const title = cellText(input?.title);
  if (title) lines.push(`数据库：${title}`);

  const colLabels = columns.map(columnLabel).filter(Boolean);
  if (colLabels.length > 0) lines.push(`列：${colLabels.join("｜")}`);

  const rules = (input?.rules ?? []).map(cellText).filter(Boolean);
  if (rules.length > 0) lines.push(`规则：${rules.join("；")}`);

  // ★ 空库 ⇒ **空串**：让接线侧据此不写正文（而不是写一行"无行"占位）。
  if (rows.length === 0) return { text: "", rowRefs: [], truncated: 0 };

  const kept = rows.slice(0, maxRows);
  const truncated = rows.length - kept.length;

  const rowLines: string[] = [];
  const rowRefs: { pageId: string; title: string }[] = [];
  for (const row of kept) {
    const rowTitle = cellText(row?.title) || "未命名";
    rowRefs.push({ pageId: String(row?.page_id ?? ""), title: rowTitle });
    const cells: string[] = [];
    for (const col of columns) {
      const v = cellText(row?.values?.[col?.id ?? ""]);
      if (!v) continue; // 空值不进正文（省噪声；"没填"与"填了空"不区分 —— 这一格本就没有语义）
      cells.push(`${columnName(col)}＝${v}`);
    }
    rowLines.push(cells.length > 0 ? `${rowTitle}：${cells.join("、")}` : rowTitle);
  }
  lines.push(`行：`);
  lines.push(...rowLines);
  if (truncated > 0) {
    // 截断必须**明说**（与覆盖度那条口径同源：不说就等于让人以为抽全了）
    lines.push(`（另有 ${truncated} 行未进正文：超过单次上限 ${maxRows} 行）`);
  }

  return { text: lines.join("\n"), rowRefs, truncated };
}
