// P3-② 数据库块的**接线层**（2026-09-23，macOS 侧）：把纯函数 `databaseTextOf` 的结果接进
// 「正文文本」那条既有入口。
//
// ## 这一格缺的是什么（方案 P3-② 的原文）
//
// 数据库页的正文只由编辑器语义派生（`contentText.ts::deriveContentText` 走 Lexical），而**列 / 行 / 规则
// 根本不进那份输入** ⇒ 派生出来只能是空：搜「状态=进行中」这类**行内容**搜不到那一页。
// ⇒ 修法是**补一份来源**（不是改派生实现）：数据库视图那一侧已经握有 `columns/rows`，按同一套纪律
// （见 `docContent.ts::refreshPageTextIfStale` 的注释）算一遍交回去，由那一层与库里比、**不同才写**。
//
// ## 三条纪律（与 `refreshPageTextIfStale` 同一份，接线侧一条都不许绕）
//
//   ① **只动正文文本** —— 走 `api.refreshPageText`（Rust `refresh_page_text` / Web `refreshPageTextIfStale`），
//      **不写内容 JSON、不动 `dirty`、不动 `updated_at`**。这一条是这格最贵的坑：标脏会被当成用户编辑推上去。
//   ② **空库不写**（`databaseTextOf` 空库返回空串 ⇒ 这里返回 `false`，一次写库都没有）。
//   ③ **规则由调用方渲染成人话**（`databaseTextOf` 的决定 2）：本文件只把视图的筛选/排序拼成短句，
//      **不去理解视图 config 的 JSON 方言**。
//
// ⚠️ 边界（与 P3-① 同源，写在这里免得被读成"全量覆盖"）：**存量数据库页要重新打开一次**才会有新正文
// （本层的触发点就是"打开数据库页"）；没有做批量重算入口。

import { databaseTextOf } from "./databaseText";
import type { AttrDef, DatabaseRow } from "../types";

/** 这一层需要的那一个副作用（注入进来 ⇒ 判据里可以做桩，不需要真数据库）。 */
export interface DatabaseTextRefreshDeps {
  /** 只动正文文本的那条入口（`api.refreshPageText`）。 */
  refresh: (pageId: string, text: string) => unknown;
}

/** 视图侧手上有的那点东西（只用得到这两个字段，所以不 import 整个 `DatabaseQuery`）。 */
export interface DatabaseTextQueryLike {
  columns: readonly AttrDef[];
  rows: readonly DatabaseRow[];
}

/**
 * 纯函数：数据库页这一轮**该写什么正文**。空库 ⇒ `null`（调用方据此**不写**）。
 *
 * 为什么不在这里直接调 `databaseTextOf` 再判空：那会把"该不该写"的判断散进组件里，
 * 而它恰恰是判据要钉住的一条（空库不写、超限要说）。
 */
export function databasePageText(
  query: DatabaseTextQueryLike,
  opts: { title?: string; rules?: readonly string[]; maxRows?: number } = {},
): string | null {
  const { text } = databaseTextOf({
    ...(opts.title ? { title: opts.title } : {}),
    columns: query.columns,
    rows: query.rows,
    ...(opts.rules && opts.rules.length > 0 ? { rules: opts.rules } : {}),
    ...(opts.maxRows !== undefined ? { maxRows: opts.maxRows } : {}),
  });
  return text === "" ? null : text;
}

/**
 * 纯函数：把视图的筛选 / 排序 / 视图名拼成**人读**的规则短句（`databaseTextOf` 的 `rules` 入参）。
 *
 * 口径：没有筛选也没有排序 ⇒ **空数组**（不写"规则：无"这种噪声）；只写当前**生效**的那几条。
 */
export function databaseRulesText(opts: {
  filter?: string;
  sort?: { key: string; dir: 1 | -1 } | null;
  viewName?: string;
}): string[] {
  const out: string[] = [];
  const view = (opts.viewName ?? "").trim();
  if (view) out.push(`视图：${view}`);
  const filter = (opts.filter ?? "").trim();
  if (filter) out.push(`筛选：${filter}`);
  if (opts.sort?.key) out.push(`排序：${opts.sort.key} ${opts.sort.dir === -1 ? "降序" : "升序"}`);
  return out;
}

/**
 * 接线本体：算一遍 → 非空才交给那条入口。返回**是否真的写回**（空库/无变化 ⇒ `false`）。
 *
 * ⚠️ 「无变化 ⇒ false」由**被调用的那一层**决定（它自己读库里那份比）—— 本层不做第二次比较，
 * 否则同一件事有两处口径（而其中一处迟早会漏掉"顺手清待重建标记"那一步）。
 */
export async function refreshDatabasePageText(
  deps: DatabaseTextRefreshDeps,
  pageId: string,
  query: DatabaseTextQueryLike,
  opts: { title?: string; rules?: readonly string[]; maxRows?: number } = {},
): Promise<boolean> {
  const text = databasePageText(query, opts);
  if (text === null) return false;
  await deps.refresh(pageId, text);
  return true;
}
