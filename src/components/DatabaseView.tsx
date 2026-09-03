import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { tagColor } from "../lib/tagColor";
import { useNotes } from "../store/notes";
import { toast } from "../store/toast";
import { printDoc } from "../lib/print";
import type { AttrDef, DatabaseQuery, DatabaseRow, DbViewMeta } from "../types";
import {
  TableIcon,
  GalleryIcon,
  BoardIcon,
  ListIcon,
  CalendarIcon,
  TimelineIcon,
  DirectoryIcon,
} from "./icons";

const TYPES = ["text", "number", "date", "checkbox", "select", "multi", "tag", "ref", "formula", "rollup"] as const;
const TYPE_LABELS: Record<string, string> = {
  text: "文本",
  number: "数字",
  date: "日期",
  checkbox: "布尔",
  select: "单选",
  multi: "多选",
  tag: "标签",
  ref: "引用",
  formula: "公式",
  rollup: "统计",
};

// Safe arithmetic evaluator (numbers + - * / ( ) only; no `eval`).
function safeArith(expr: string): number {
  const tokens = expr.match(/\d+\.?\d*|[+\-*/()]/g) ?? [];
  let i = 0;
  const parseFactor = (): number => {
    const t = tokens[i++];
    if (t === "(") {
      const v = parseExpr();
      tokens[i++];
      return v;
    }
    const n = parseFloat(t);
    return isNaN(n) ? 0 : n;
  };
  const parseTerm = (): number => {
    let v = parseFactor();
    while (tokens[i] === "*" || tokens[i] === "/") {
      const op = tokens[i++];
      const r = parseFactor();
      v = op === "*" ? v * r : (r === 0 ? 0 : v / r);
    }
    return v;
  };
  const parseExpr = (): number => {
    let v = parseTerm();
    while (tokens[i] === "+" || tokens[i] === "-") {
      const op = tokens[i++];
      const r = parseTerm();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  };
  try {
    return parseExpr();
  } catch {
    return 0;
  }
}

// Compute a formula column's value from the row's other column values (by name).
function computeFormula(expr: string, values: Record<string, string>, columns: AttrDef[]): string {
  let s = expr;
  const order = [...columns].sort((a, b) => b.name.length - a.name.length);
  for (const col of order) {
    if (col.attr_type === "formula" || !col.name) continue;
    const num = parseFloat(values[col.id] ?? "");
    s = s.split(col.name).join(isNaN(num) ? "0" : String(num));
  }
  const v = safeArith(s);
  return Number.isFinite(v) ? String(Math.round(v * 100) / 100) : "—";
}

// Compute a rollup column's value: aggregate `col` over target-db rows whose
// `ref` column points to the current page. config = {ref, db, col, fn}.
function computeRollup(
  configStr: string,
  currentPageId: string,
  target: { rows: DatabaseRow[]; colId: string; refId: string } | null,
): string {
  if (!target) return "—";
  let cfg: any = {};
  try {
    cfg = JSON.parse(configStr);
  } catch {
    return "—";
  }
  const targetColId = target.colId;
  const refId = target.refId;
  const matched = target.rows.filter((r) =>
    (r.values[refId] ?? "").includes(currentPageId),
  );
  const fn = cfg.fn ?? "count";
  if (fn === "count") return String(matched.length);
  const nums = matched
    .map((r) => parseFloat(r.values[targetColId] ?? ""))
    .filter((n) => !isNaN(n));
  if (nums.length === 0) return "—";
  const sum = nums.reduce((a, b) => a + b, 0);
  if (fn === "avg") return String(Math.round((sum / nums.length) * 100) / 100);
  return String(Math.round(sum * 100) / 100);
}

export function DatabaseView({ pageId, title }: { pageId: string; title: string }) {
  const { openPage, pages } = useNotes();
  const [query, setQuery] = useState<DatabaseQuery | null>(null);
  const [attrs, setAttrs] = useState<AttrDef[]>([]);
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const [addingCol, setAddingCol] = useState(false);
  const addColPanelRef = useRef<HTMLDivElement>(null);
  const optionsPanelRef = useRef<HTMLDivElement>(null);
  const [boardGroupOpen, setBoardGroupOpen] = useState(false);
  const boardGroupPanelRef = useRef<HTMLDivElement>(null);
  const [sortMenuKey, setSortMenuKey] = useState<string | null>(null);
  const sortMenuPanelRef = useRef<HTMLDivElement>(null);
  const viewsWrapRef = useRef<HTMLDivElement>(null);
  const ruleWrapRef = useRef<HTMLDivElement>(null);
  const [viewType, setViewType] = useState<
    "table" | "gallery" | "board" | "list" | "calendar" | "timeline" | "directory" | "gantt"
  >("table");
  const [boardGroupAttr, setBoardGroupAttr] = useState<string | null>(null);
  const [boardDragOver, setBoardDragOver] = useState<string | null>(null);
  // 甘特图左侧(标题/负责人/日期)列宽，可拖拽调整。
  const [ganttMetaW, setGanttMetaW] = useState(430);
  const ganttResizeRef = useRef<{ sx: number; sw: number } | null>(null);
  const [calMonth, setCalMonth] = useState(() => {
    const d = new Date();
    return { y: d.getFullYear(), m: d.getMonth() };
  });
  const [editingOptionsCol, setEditingOptionsCol] = useState<string | null>(null);
  const [optionsText, setOptionsText] = useState("");
  const [views, setViews] = useState<DbViewMeta[]>([]);
  const [viewsPop, setViewsPop] = useState(false);
  const [viewName, setViewName] = useState("");
  const [ruleOpen, setRuleOpen] = useState(false);
  const [ruleCol, setRuleCol] = useState("");
  const [ruleValue, setRuleValue] = useState("");
  const [refTitles, setRefTitles] = useState<Record<string, string>>({});
  const [rollupTargets, setRollupTargets] = useState<
    Record<string, { rows: DatabaseRow[]; colId: string; refId: string } | null>
  >({});

  // Load target-db rows for `rollup` columns (cross-db aggregation).
  useEffect(() => {
    const rollupCols = (query?.columns ?? []).filter((c) => c.attr_type === "rollup");
    if (rollupCols.length === 0) {
      setRollupTargets({});
      return;
    }
    let cancelled = false;
    (async () => {
      const out: Record<string, { rows: DatabaseRow[]; colId: string; refId: string } | null> = {};
      for (const col of rollupCols) {
        let cfg: any = {};
        try {
          cfg = JSON.parse(col.options[0] ?? "{}");
        } catch {
          cfg = {};
        }
        if (!cfg.db) {
          out[col.id] = null;
          continue;
        }
        const targetPage = pages.find((p) => p.kind === "database" && p.title === cfg.db);
        if (!targetPage) {
          out[col.id] = null;
          continue;
        }
        try {
          const q = await api.queryDatabase(targetPage.id);
          const colId = q.columns.find((c) => c.name === cfg.col)?.id ?? "";
          const refId = q.columns.find((c) => c.name === cfg.ref)?.id ?? "";
          out[col.id] = { rows: q.rows, colId, refId };
        } catch {
          out[col.id] = null;
        }
      }
      if (!cancelled) setRollupTargets(out);
    })();
    return () => {
      cancelled = true;
    };
  }, [query, pages]);

  // Resolve `ref` column values (`p:<id>`) to target titles for clickable display.
  useEffect(() => {
    const refCols = (query?.columns ?? []).filter((c) => c.attr_type === "ref");
    if (refCols.length === 0) {
      setRefTitles({});
      return;
    }
    const values: string[] = [];
    for (const r of query?.rows ?? []) {
      for (const col of refCols) {
        const v = r.values[col.id] ?? "";
        if (v) values.push(v);
      }
    }
    if (values.length === 0) {
      setRefTitles({});
      return;
    }
    api
      .resolveRefs(values)
      .then(setRefTitles)
      .catch(() => {});
  }, [query]);

  const loadViews = () => {
    api.listDbViews(pageId).then(setViews).catch(() => {});
  };
  useEffect(loadViews, [pageId]);

  const applyView = (v: DbViewMeta) => {
    let cfg: any = {};
    try {
      cfg = JSON.parse(v.config);
    } catch {
      /* ignore */
    }
    setViewType(v.view_type as Parameters<typeof setViewType>[0]);
    setFilter(cfg.filter ?? "");
    setSort(cfg.sort ?? null);
    setBoardGroupAttr(cfg.board_group_attr ?? null);
    setViewsPop(false);
  };
  const saveCurrentView = async () => {
    const name = viewName.trim() || `视图 ${views.length + 1}`;
    const config = JSON.stringify({ filter, sort, board_group_attr: boardGroupAttr });
    try {
      await api.saveDbView({ db_page_id: pageId, name, view_type: viewType, config });
      setViewName("");
      loadViews();
    } catch (e) {
      toast(`保存视图失败：${e}`, "error");
    }
  };
  const delView = async (v: DbViewMeta) => {
    await api.deleteDbView(v.id);
    loadViews();
  };

  const ruleCols = useMemo(
    () =>
      (query?.columns ?? []).filter(
        (c) => c.attr_type === "select" || c.attr_type === "multi" || c.attr_type === "tag",
      ),
    [query],
  );
  const applyRule = async () => {
    const col = ruleCols.find((c) => c.id === ruleCol);
    const rule =
      col && ruleValue.trim()
        ? JSON.stringify({ prop: { name: col.name, value: ruleValue.trim() } })
        : "{}";
    try {
      await api.setDbRule(pageId, rule);
      load();
      setRuleOpen(false);
    } catch (e) {
      toast(`保存规则失败：${e}`, "error");
    }
  };
  const clearRule = async () => {
    await api.setDbRule(pageId, "{}");
    load();
    setRuleOpen(false);
  };

  const openRef = (v: string) => {
    if (v.startsWith("p:")) {
      const id = v.slice(2);
      if (id) openPage(id);
    }
  };

  const load = () => {
    api.queryDatabase(pageId).then(setQuery).catch((e) => toast(String(e), "error"));
    api.listAttrDefs().then(setAttrs).catch(() => {});
  };
  useEffect(load, [pageId]);

  // Close the add-column / options / board-group / sort / views / rule panels when
  // clicking outside them (a single consistent "click background to close" behavior).
  useEffect(() => {
    if (!addingCol && !editingOptionsCol && !boardGroupOpen && !sortMenuKey && !viewsPop && !ruleOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (addColPanelRef.current?.contains(t)) return;
      if (optionsPanelRef.current?.contains(t)) return;
      if (boardGroupPanelRef.current?.contains(t)) return;
      if (sortMenuPanelRef.current?.contains(t)) return;
      if (viewsWrapRef.current?.contains(t)) return;
      if (ruleWrapRef.current?.contains(t)) return;
      setAddingCol(false);
      setEditingOptionsCol(null);
      setBoardGroupOpen(false);
      setSortMenuKey(null);
      setViewsPop(false);
      setRuleOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [addingCol, editingOptionsCol, boardGroupOpen, sortMenuKey, viewsPop, ruleOpen]);

  // Only one floating panel is open at a time; opening one clears the rest.
  const closeDbPanels = () => {
    setAddingCol(false);
    setEditingOptionsCol(null);
    setSortMenuKey(null);
    setBoardGroupOpen(false);
  };
  const toggleAddCol = () => {
    if (addingCol) {
      setAddingCol(false);
    } else {
      closeDbPanels();
      setAddingCol(true);
    }
  };
  const toggleBoardGroup = () => {
    if (boardGroupOpen) {
      setBoardGroupOpen(false);
    } else {
      closeDbPanels();
      setBoardGroupOpen(true);
    }
  };
  const toggleSortMenu = (key: string) => {
    if (sortMenuKey === key) {
      setSortMenuKey(null);
    } else {
      closeDbPanels();
      setSortMenuKey(key);
    }
  };

  const setCell = async (rowPageId: string, attrId: string, value: string) => {
    setQuery(
      (q) =>
        q && {
          ...q,
          rows: q.rows.map((r) =>
            r.page_id === rowPageId ? { ...r, values: { ...r.values, [attrId]: value } } : r,
          ),
        },
    );
    try {
      await api.setPageProp({ page_id: rowPageId, attr_id: attrId, value });
    } catch (e) {
      toast(`保存失败：${e}`, "error");
    }
  };

  const addColumn = async (attrId: string) => {
    try {
      const columns = await api.addDbColumn(pageId, attrId);
      setQuery((q) => q && { ...q, columns });
    } catch (e) {
      toast(`添加列失败：${e}`, "error");
    }
  };

  const removeColumn = async (attrId: string) => {
    try {
      const columns = await api.removeDbColumn(pageId, attrId);
      setQuery((q) => q && { ...q, columns });
    } catch (e) {
      toast(`移除列失败：${e}`, "error");
    }
  };

  const createAndAddColumn = async (name: string, type: string, options: string[]) => {
    try {
      const attr = await api.createAttr({ name, attr_type: type, options });
      setAttrs((as) => [...as, attr]);
      await addColumn(attr.id);
    } catch (e) {
      toast(`新建列失败：${e}`, "error");
    }
  };

  const openOptionsEditor = (c: AttrDef) => {
    closeDbPanels();
    setEditingOptionsCol(c.id);
    setOptionsText(c.options.join(", "));
  };

  const saveOptions = async (attrId: string) => {
    const options = optionsText.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    try {
      const updated = await api.updateAttr({ id: attrId, options });
      setQuery((q) => q && { ...q, columns: q.columns.map((c) => (c.id === attrId ? updated : c)) });
      setAttrs((as) => as.map((a) => (a.id === attrId ? updated : a)));
      setEditingOptionsCol(null);
    } catch (e) {
      toast(`更新选项失败：${e}`, "error");
    }
  };

  const rows = useMemo(() => {
    if (!query) return [];
    let rs = query.rows;
    if (filter.trim()) {
      const f = filter.trim().toLowerCase();
      rs = rs.filter((r) => r.title.toLowerCase().includes(f));
    }
    if (sort) {
      const { key, dir } = sort;
      rs = [...rs].sort((a, b) => {
        if (key === "__title") {
          return (a.title || "").localeCompare(b.title || "", "zh") * dir;
        }
        const col = query.columns.find((c) => c.id === key);
        const av = a.values[key] ?? "";
        const bv = b.values[key] ?? "";
        if (col?.attr_type === "number") {
          return ((parseFloat(av) || 0) - (parseFloat(bv) || 0)) * dir;
        }
        return av.localeCompare(bv, "zh") * dir;
      });
    }
    return rs;
  }, [query, filter, sort]);

  // Dashboard aggregation: per-select-attribute value counts + number sums/averages.
  const summary = useMemo(() => {
    if (!query) return [];
    const items: {
      kind: "select" | "number";
      name: string;
      values?: { v: string; n: number }[];
      sum?: number;
      count?: number;
      avg?: number;
    }[] = [];
    for (const col of query.columns) {
      if (col.attr_type === "select") {
        const counts = new Map<string, number>();
        for (const r of rows) {
          const v = r.values[col.id] ?? "";
          if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
        }
        if (counts.size > 0) {
          items.push({
            kind: "select",
            name: col.name,
            values: [...counts.entries()].map(([v, n]) => ({ v, n })),
          });
        }
      } else if (col.attr_type === "number") {
        let sum = 0;
        let count = 0;
        for (const r of rows) {
          const n = parseFloat(r.values[col.id] ?? "");
          if (!Number.isNaN(n)) {
            sum += n;
            count++;
          }
        }
        if (count > 0) {
          items.push({ kind: "number", name: col.name, sum, count, avg: sum / count });
        }
      }
    }
    return items;
  }, [query, rows]);

  const availableAttrs = useMemo(() => {
    if (!query) return attrs;
    const used = new Set(query.columns.map((c) => c.id));
    return attrs.filter((a) => !used.has(a.id));
  }, [attrs, query]);

  const selectColumns = useMemo(
    () => (query ? query.columns.filter((c) => c.attr_type === "select") : []),
    [query],
  );
  const boardAttr = selectColumns.find((c) => c.id === boardGroupAttr) ?? selectColumns[0] ?? null;

  const boardGroups = useMemo(() => {
    if (!boardAttr) {
      return [{ id: "__none", name: "未设置", rows }];
    }
    const groups = boardAttr.options.map((o) => ({ id: o, name: o, rows: [] as DatabaseRow[] }));
    const unset = { id: "__none", name: "未设置", rows: [] as DatabaseRow[] };
    for (const r of rows) {
      const v = r.values[boardAttr.id] ?? "";
      const g = groups.find((g) => g.id === v);
      if (g) g.rows.push(r);
      else unset.rows.push(r);
    }
    return [...groups, unset];
  }, [boardAttr, rows]);

  const moveBoardCard = async (pageId: string, colId: string) => {
    if (!boardAttr) return;
    try {
      if (colId === "__none") await api.removePageProp(pageId, boardAttr.id);
      else await api.setPageProp({ page_id: pageId, attr_id: boardAttr.id, value: colId });
      setBoardDragOver(null);
      load();
    } catch (e) {
      toast(`移动失败：${e}`, "error");
    }
  };

  const dateCol = query?.columns.find((c) => c.attr_type === "date") ?? null;

  const directoryTree = useMemo(() => {
    const map = new Map<string, { id: string; title: string; children: any[] }>();
    const inRows = new Set(rows.map((r) => r.page_id));
    for (const p of pages) {
      if (inRows.has(p.id)) map.set(p.id, { id: p.id, title: p.title, children: [] as any[] });
    }
    const roots: { id: string; title: string; children: any[] }[] = [];
    for (const p of pages) {
      const node = map.get(p.id);
      if (!node) continue;
      const parent = p.parent_id ? map.get(p.parent_id) : null;
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    return roots;
  }, [pages, rows]);

  const pad2 = (n: number) => String(n).padStart(2, "0");
  const calendarCells = useMemo(() => {
    const first = new Date(calMonth.y, calMonth.m, 1);
    const last = new Date(calMonth.y, calMonth.m + 1, 0);
    const cells: { key: string; day: number | null; rows: DatabaseRow[] }[] = [];
    for (let i = 0; i < first.getDay(); i++) cells.push({ key: "b" + i, day: null, rows: [] });
    for (let d = 1; d <= last.getDate(); d++) cells.push({ key: "d" + d, day: d, rows: [] });
    const byDate = new Map<string, DatabaseRow[]>();
    if (dateCol) {
      for (const r of rows) {
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(r.values[dateCol.id] ?? "");
        if (m) {
          const key = `${m[1]}-${m[2]}-${m[3]}`;
          const arr = byDate.get(key) ?? [];
          arr.push(r);
          byDate.set(key, arr);
        }
      }
    }
    for (const cell of cells) {
      if (cell.day !== null) {
        const key = `${calMonth.y}-${pad2(calMonth.m + 1)}-${pad2(cell.day)}`;
        cell.rows = byDate.get(key) ?? [];
      }
    }
    return cells;
  }, [calMonth, rows, dateCol]);

  const timelineRows = useMemo(() => {
    if (!dateCol) return [];
    return [...rows].sort((a, b) =>
      (a.values[dateCol.id] ?? "").localeCompare(b.values[dateCol.id] ?? ""),
    );
  }, [rows, dateCol]);

  // 甘特图：用 date 列——第一个=起始、第二个=结束（无第二个则单点）。计算日期范围 + 每行条。
  const gantt = useMemo(() => {
    const dateCols = query?.columns.filter((c) => c.attr_type === "date") ?? [];
    if (dateCols.length === 0 || !query) return null;
    // 支持「计划/实际」两组：4 个 date 列 → 计划=前2、实际=后2；仅 2 个则只有计划。
    const planStartCol = dateCols[0];
    const planEndCol = dateCols[1] ?? null;
    const actStartCol = dateCols.length >= 4 ? dateCols[2] : null;
    const actEndCol = dateCols.length >= 4 ? dateCols[3] ?? dateCols[2] : null;
    const hasActual = !!actStartCol;
    const parseD = (s: string | undefined): Date | null => {
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s ?? "");
      return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
    };
    const items = rows
      .map((r) => {
        const planS = parseD(r.values[planStartCol.id] as string);
        if (!planS) return null;
        const planE = parseD(planEndCol ? (r.values[planEndCol.id] as string) : undefined);
        const plan = { start: planS, end: planE && planE >= planS ? planE : planS };
        let actual: { start: Date; end: Date } | null = null;
        if (hasActual) {
          const actS = parseD(r.values[actStartCol.id] as string);
          if (actS) {
            const actE = parseD(actEndCol ? (r.values[actEndCol.id] as string) : undefined);
            actual = { start: actS, end: actE && actE >= actS ? actE : actS };
          }
        }
        return { row: r, title: r.title || "未命名", plan, actual };
      })
      .filter(Boolean) as { row: DatabaseRow; title: string; plan: { start: Date; end: Date }; actual: { start: Date; end: Date } | null }[];
    if (items.length === 0) return null;
    let min = items[0].plan.start;
    let max = items[0].plan.end;
    const consider = (it: { plan: { start: Date; end: Date }; actual: { start: Date; end: Date } | null }) => {
      if (it.plan.start < min) min = it.plan.start;
      if (it.plan.end > max) max = it.plan.end;
      if (it.actual) {
        if (it.actual.start < min) min = it.actual.start;
        if (it.actual.end > max) max = it.actual.end;
      }
    };
    for (const it of items) consider(it);
    // 日期范围精确贴合数据 + 前后各 2 天边距（完全随数据自适应，不强制对齐周）。
    const dateOnly = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
    min = dateOnly(min); min.setDate(min.getDate() - 2);
    max = dateOnly(max); max.setDate(max.getDate() + 2);
    const totalDays = Math.max(1, Math.round((max.getTime() - min.getTime()) / 86400000) + 1);
    // 自适应日期刻度：跨度 ≤ 12 天显示每天日期；更大则隔 7 天(每周首)——避免
    // 小跨度只露首格(9/1)、大跨度挤成一团。
    const step = totalDays <= 12 ? 1 : 7;
    const cols: string[] = [];
    for (let i = 0; i < totalDays; i++) {
      const d = new Date(min.getTime() + i * 86400000);
      cols.push(i % step === 0 ? `${d.getMonth() + 1}/${d.getDate()}` : "");
    }
    const statusCol = query?.columns.find((c) => c.attr_type === "select") ?? null;
    const today = new Date();
    const todayIdx = Math.round((today.getTime() - min.getTime()) / 86400000);
    return { items, min, max, totalDays, cols, statusCol, todayIdx, hasActual, planStartCol, planEndCol, actStartCol, actEndCol };
  }, [rows, query]);

  if (!query) {
    return <div className="database-view database-empty">加载中…</div>;
  }

  // Export the current (filtered) database view to the system print dialog
  // ("Save as PDF"). Reuses the page PDF helper but renders a data table.
  const exportPdf = () => {
    const cell = (col: AttrDef, r: DatabaseRow) => {
      if (col.attr_type === "formula") {
        return computeFormula(col.options[0] ?? "", r.values, query.columns);
      }
      if (col.attr_type === "rollup") {
        return computeRollup(col.options[0] ?? "", r.page_id, rollupTargets[col.id] ?? null);
      }
      const v = r.values[col.id] ?? "";
      if (col.attr_type === "ref") return refTitles[v] ?? v;
      return v;
    };
    const ths = ["页面", ...query.columns.map((c) => c.name || TYPE_LABELS[c.attr_type] || c.attr_type)]
      .map((h) => `<th>${h}</th>`)
      .join("");
    const trs = rows
      .map(
        (r) =>
          `<tr><td><strong>${r.title || "未命名"}</strong></td>${query.columns
            .map((c) => `<td>${cell(c, r)}</td>`)
            .join("")}</tr>`,
      )
      .join("");
    const body = `<h1>${title || "数据库"}</h1><div class="db-count">共 ${rows.length} 行</div><table><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`;
    printDoc(body, { title });
  };

  return (
    <div className="database-view">
      <div className="database-head">
        <h1 className="database-title">{title || "数据库"}</h1>
        <input
          className="database-filter"
          placeholder="筛选页面…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <div className="db-view-switch">
          <button
            className={viewType === "table" ? "db-view-active" : ""}
            onClick={() => setViewType("table")}
          >
            <TableIcon width={15} height={15} />
            <span>表格</span>
          </button>
          <button
            className={viewType === "gallery" ? "db-view-active" : ""}
            onClick={() => setViewType("gallery")}
          >
            <GalleryIcon width={15} height={15} />
            <span>画廊</span>
          </button>
          <button
            className={viewType === "board" ? "db-view-active" : ""}
            onClick={() => setViewType("board")}
          >
            <BoardIcon width={15} height={15} />
            <span>看板</span>
          </button>
          <button
            className={viewType === "list" ? "db-view-active" : ""}
            onClick={() => setViewType("list")}
          >
            <ListIcon width={15} height={15} />
            <span>列表</span>
          </button>
          <button
            className={viewType === "calendar" ? "db-view-active" : ""}
            onClick={() => setViewType("calendar")}
          >
            <CalendarIcon width={15} height={15} />
            <span>日历</span>
          </button>
          <button
            className={viewType === "timeline" ? "db-view-active" : ""}
            onClick={() => setViewType("timeline")}
          >
            <TimelineIcon width={15} height={15} />
            <span>时间轴</span>
          </button>
          <button
            className={viewType === "directory" ? "db-view-active" : ""}
            onClick={() => setViewType("directory")}
          >
            <DirectoryIcon width={15} height={15} />
            <span>目录</span>
          </button>
          <button
            className={viewType === "gantt" ? "db-view-active" : ""}
            onClick={() => setViewType("gantt")}
            title="甘特图"
          >
            <TimelineIcon width={15} height={15} />
            <span>甘特图</span>
          </button>
        </div>
        <div className="db-actions">
          <button className="db-views-btn" onClick={exportPdf} title="导出为 PDF（打印 → 另存为 PDF）">
            <span>⤓</span> PDF
          </button>
          <div className="db-views-wrap" ref={viewsWrapRef}>
            <button className="db-views-btn" onClick={() => setViewsPop((v) => !v)}>
              视图{views.length > 0 ? ` (${views.length})` : ""} ▾
            </button>
            {viewsPop && (
              <div className="db-views-pop">
                <div className="db-views-title">已保存视图</div>
                {views.length === 0 ? (
                  <div className="db-views-empty">暂无保存视图</div>
                ) : (
                  views.map((v) => (
                    <div key={v.id} className="db-views-item">
                      <button className="db-views-item-main" onClick={() => applyView(v)}>
                        {v.name}
                      </button>
                      <button
                        className="db-views-item-del"
                        title="删除视图"
                        onClick={() => delView(v)}
                      >
                        ×
                      </button>
                    </div>
                  ))
                )}
                <div className="db-views-save-row">
                  <input
                    className="db-views-input"
                    placeholder="视图名"
                    value={viewName}
                    onChange={(e) => setViewName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") saveCurrentView();
                    }}
                  />
                  <button onClick={saveCurrentView}>保存当前</button>
                </div>
              </div>
            )}
          </div>
          <div className="db-rule-wrap" ref={ruleWrapRef}>
            <button className="db-views-btn" onClick={() => setRuleOpen((v) => !v)} title="成员规则">
              规则 <span className="db-rule-glyph">∿</span>
            </button>
            {ruleOpen && (
              <div className="db-views-pop db-rule-pop">
                <div className="db-views-title">成员规则（按属性自动收页）</div>
                <select
                  className="db-rule-select"
                  value={ruleCol}
                  onChange={(e) => setRuleCol(e.target.value)}
                >
                  <option value="">— 选择属性列 —</option>
                  {ruleCols.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <input
                  className="db-views-input"
                  placeholder="匹配值（如 进行中）"
                  value={ruleValue}
                  onChange={(e) => setRuleValue(e.target.value)}
                />
              <div className="db-rule-actions">
                <button onClick={applyRule}>应用规则</button>
                <button onClick={clearRule}>清除</button>
              </div>
            </div>
          )}
        </div>
        </div>
        <span className="database-count">{rows.length} 条</span>
      </div>

      {summary.length > 0 && (
        <div className="db-summary">
          {summary.map((item) => (
            <div key={item.name} className="db-summary-item">
              <span className="db-summary-name">{item.name}</span>
              {item.kind === "select"
                ? item.values!.map(({ v, n }) => (
                    <span
                      key={v}
                      className="db-summary-chip"
                      style={{ background: tagColor(v).soft, color: tagColor(v).solid }}
                    >
                      {v} × {n}
                    </span>
                  ))
                : (
                    <span className="db-summary-value">
                      合计 {item.sum} · 均值 {item.avg!.toFixed(1)}
                    </span>
                  )}
            </div>
          ))}
        </div>
      )}

      {viewType === "table" ? (
        <div className="database-table-wrap">
          <table className="database-table">
            <thead>
              <tr>
                <th
                  className={`db-th ${sort?.key === "__title" ? "db-th-sorted" : ""}`}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => toggleSortMenu("__title")}
                  title="排序"
                >
                  页面{sort?.key === "__title" ? (sort.dir === 1 ? " ↑" : " ↓") : ""}
                </th>
                {query.columns.map((c) => (
                  <th
                    key={c.id}
                    className={`db-th ${sort?.key === c.id ? "db-th-sorted" : ""}`}
                    title={TYPE_LABELS[c.attr_type] ?? c.attr_type}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={() => toggleSortMenu(c.id)}
                  >
                    <span className="db-th-name">
                      {c.name}
                      {sort?.key === c.id ? (sort.dir === 1 ? " ↑" : " ↓") : ""}
                    </span>
                    {(c.attr_type === "select" || c.attr_type === "multi") && (
                      <button
                        className="db-col-options"
                        title="编辑选项"
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          openOptionsEditor(c);
                        }}
                      >
                        ⚙
                      </button>
                    )}
                    <button
                      className="db-col-remove"
                      title="移除列"
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        removeColumn(c.id);
                      }}
                    >
                      ×
                    </button>
                  </th>
                ))}
                <th className="db-th db-th-add">
                  <button
                    className="db-add-col"
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={toggleAddCol}
                  >
                    ＋ 列
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.page_id}>
                  <td className="db-cell db-cell-title">
                    <button className="db-title" onClick={() => openPage(r.page_id)}>
                      {r.title || "未命名"}
                    </button>
                  </td>
                  {query.columns.map((c) => (
                    <td key={c.id} className="db-cell">
                      {c.attr_type === "formula" ? (
                        <span className="db-formula">
                          {computeFormula(c.options[0] ?? "", r.values, query.columns)}
                        </span>
                      ) : c.attr_type === "rollup" ? (
                        <span className="db-formula">
                          {computeRollup(c.options[0] ?? "", r.page_id, rollupTargets[c.id] ?? null)}
                        </span>
                      ) : c.attr_type === "ref" ? (
                        <RefCell value={r.values[c.id] ?? ""} titles={refTitles} onOpen={openRef} />
                      ) : (
                        <DbCellEditor
                          attr={c}
                          value={r.values[c.id] ?? ""}
                          onChange={(v) => setCell(r.page_id, c.id, v)}
                        />
                      )}
                    </td>
                  ))}
                  <td className="db-cell db-cell-empty" />
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td className="db-empty" colSpan={query.columns.length + 2}>
                    {query.columns.length === 0 ? "点击「＋ 列」添加属性列" : "无匹配页面"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      ) : viewType === "board" ? (
        <div className="db-board">
          <div className="db-board-toolbar">
            <label className="db-board-label">分组字段</label>
            <div className="db-board-group" ref={boardGroupPanelRef}>
              <button
                className="db-board-select"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={toggleBoardGroup}
              >
                {boardAttr?.name ?? "请选择"}
                <span className="db-select-caret">▾</span>
              </button>
              {boardGroupOpen && (
                <div className="db-add-col-panel db-pop-panel">
                  <div className="db-add-col-title">
                    分组字段
                    <button
                      className="db-panel-close"
                      onClick={() => setBoardGroupOpen(false)}
                      title="关闭"
                    >
                      ×
                    </button>
                  </div>
                  {selectColumns.map((c) => (
                    <button
                      key={c.id}
                      className={`db-add-col-item ${boardGroupAttr === c.id ? "db-item-active" : ""}`}
                      onClick={() => {
                        setBoardGroupAttr(c.id);
                        setBoardGroupOpen(false);
                      }}
                    >
                      <span>{c.name}</span>
                    </button>
                  ))}
                  {selectColumns.length === 0 && (
                    <div className="db-add-col-empty">需先添加 select 类型列</div>
                  )}
                </div>
              )}
            </div>
            {selectColumns.length === 0 && (
              <span className="db-board-hint">需先添加 select 类型列</span>
            )}
          </div>
          <div className="db-board-columns">
            {boardGroups.map((g) => (
              <div
                key={g.id}
                className={`db-board-col ${boardDragOver === g.id ? "db-board-col-over" : ""}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setBoardDragOver(g.id);
                }}
                onDragLeave={() => setBoardDragOver((v) => (v === g.id ? null : v))}
                onDrop={(e) => {
                  e.preventDefault();
                  const pageId = e.dataTransfer.getData("text/plain");
                  if (pageId) moveBoardCard(pageId, g.id);
                }}
              >
                <div className="db-board-col-header">
                  <span className="db-board-dot" style={{ background: tagColor(g.name).solid }} />
                  <span className="db-board-col-name">{g.name}</span>
                  <span className="db-board-col-count">{g.rows.length}</span>
                </div>
                <div className="db-board-col-body">
                  {g.rows.map((r) => (
                    <div
                      key={r.page_id}
                      className="db-board-card"
                      draggable
                      onDragStart={(e) => e.dataTransfer.setData("text/plain", r.page_id)}
                      onClick={() => openPage(r.page_id)}
                    >
                      {r.title || "未命名"}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : viewType === "list" ? (
        <div className="db-list">
          {rows.map((r) => (
            <div key={r.page_id} className="db-list-item" onClick={() => openPage(r.page_id)}>
              <span className="db-list-title">{r.title || "未命名"}</span>
              <span className="db-list-props">
                {query.columns.slice(0, 3).map((c) => {
                  const v = r.values[c.id];
                  return v ? (
                    <span key={c.id} className="db-list-prop">
                      {c.name}: {v}
                    </span>
                  ) : null;
                })}
              </span>
            </div>
          ))}
          {rows.length === 0 && <div className="db-empty">无匹配页面</div>}
        </div>
      ) : viewType === "calendar" ? (
        <div className="db-cal">
          <div className="db-cal-toolbar">
            <button
              onClick={() => setCalMonth((s) => (s.m === 0 ? { y: s.y - 1, m: 11 } : { y: s.y, m: s.m - 1 }))}
            >
              ‹
            </button>
            <span className="db-cal-title">
              {calMonth.y} 年 {calMonth.m + 1} 月
            </span>
            <button
              onClick={() => setCalMonth((s) => (s.m === 11 ? { y: s.y + 1, m: 0 } : { y: s.y, m: s.m + 1 }))}
            >
              ›
            </button>
            {!dateCol && <span className="db-cal-hint">需先添加 date 类型列</span>}
          </div>
          <div className="db-cal-grid">
            {calendarCells.map((cell) => (
              <div key={cell.key} className={`db-cal-cell ${cell.day === null ? "db-cal-empty" : ""}`}>
                {cell.day !== null && <span className="db-cal-day">{cell.day}</span>}
                {cell.rows.map((r) => (
                  <button key={r.page_id} className="db-cal-event" onClick={() => openPage(r.page_id)}>
                    {r.title || "未命名"}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      ) : viewType === "timeline" ? (
        <div className="db-timeline">
          {timelineRows.map((r) => (
            <div key={r.page_id} className="db-timeline-item">
              <span className="db-timeline-date">{dateCol ? r.values[dateCol.id] : ""}</span>
              <button className="db-timeline-title" onClick={() => openPage(r.page_id)}>
                {r.title || "未命名"}
              </button>
            </div>
          ))}
          {!dateCol && <div className="db-empty">需先添加 date 类型列</div>}
        </div>
      ) : viewType === "gantt" ? (
        gantt ? (
          <div className="db-gantt">
            <div className="db-gantt-head">
              <div className="db-gantt-rowlabel" style={{ width: ganttMetaW }}>
                任务
                <span className="db-gantt-resize-hint">拖动调宽</span>
                <span
                  className="db-gantt-resize"
                  title="拖动调整标题列宽"
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    ganttResizeRef.current = { sx: e.clientX, sw: ganttMetaW };
                    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
                  }}
                  onPointerMove={(e) => {
                    if (!ganttResizeRef.current) return;
                    const w = Math.max(160, Math.min(720, ganttResizeRef.current.sw + (e.clientX - ganttResizeRef.current.sx)));
                    setGanttMetaW(w);
                  }}
                  onPointerUp={() => {
                    ganttResizeRef.current = null;
                  }}
                />
              </div>
              <div className="db-gantt-axis">
                {gantt.cols.map((c, i) => (
                  <div key={i} className="db-gantt-axis-cell">{c}</div>
                ))}
              </div>
            </div>
            {gantt.items.map((it) => {
              const fmtIso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
              const lane = (label: string, start: Date, end: Date, color: string, laneClass: string, key: string, sCol: string | null, eCol: string | null) => (
                <div key={key} className={`db-gantt-row${laneClass ? " " + laneClass : ""}`}>
                  <div className="db-gantt-meta" style={{ width: ganttMetaW }}>
                    <span className="db-gantt-name" onClick={() => openPage(it.row.page_id)}>{label}</span>
                    {gantt.statusCol && (
                      <select
                        className="db-gantt-owner db-gantt-owner-select"
                        value={it.row.values[gantt.statusCol.id] ?? ""}
                        onChange={(e) => setCell(it.row.page_id, gantt.statusCol!.id, e.target.value)}
                      >
                        <option value="">—</option>
                        {gantt.statusCol.options.map((o) => (
                          <option key={o} value={o}>{o}</option>
                        ))}
                      </select>
                    )}
                    {sCol && (
                      <DateField value={fmtIso(start)} onChange={(v) => setCell(it.row.page_id, sCol, v)} />
                    )}
                    {eCol && (
                      <DateField value={fmtIso(end)} onChange={(v) => setCell(it.row.page_id, eCol, v)} />
                    )}
                  </div>
                  <div className="db-gantt-track">
                    {Array.from({ length: gantt.totalDays }).map((_, di) => {
                      const l = (start.getTime() - gantt.min.getTime()) / 86400000;
                      const w = (end.getTime() - start.getTime()) / 86400000 + 1;
                      const on = di >= l && di < l + w;
                      return (
                        <span
                          key={di}
                          className={`db-gantt-cell${on ? " on" : ""}`}
                          style={{ ...(on ? { background: color } : {}) }}
                          title={`${it.title}（${start.toISOString().slice(0, 10)} ~ ${end.toISOString().slice(0, 10)}）`}
                        />
                      );
                    })}
                  </div>
                </div>
              );
              const lanes = [lane(it.title, it.plan.start, it.plan.end, "#f59e0b", "db-gantt-lane-plan", `lk-${it.row.page_id}`, gantt.planStartCol?.id ?? null, gantt.planEndCol?.id ?? null)];
              if (gantt.hasActual && it.actual) {
                lanes.push(lane("", it.actual.start, it.actual.end, "#fbbf24", "db-gantt-lane-actual", `la-${it.row.page_id}`, gantt.actStartCol?.id ?? null, gantt.actEndCol?.id ?? null));
              }
              return <Fragment key={it.row.page_id}>{lanes}</Fragment>;
            })}
          </div>
        ) : (
          <div className="db-empty">需先添加 date 类型列</div>
        )
      ) : viewType === "directory" ? (
        <div className="db-directory">
          {directoryTree.map((n) => (
            <DirectoryNode key={n.id} node={n} openPage={openPage} />
          ))}
          {directoryTree.length === 0 && <div className="db-empty">无匹配页面</div>}
        </div>
      ) : (
        <div className="db-gallery">
          {rows.map((r) => {
            const firstSelect = query.columns
              .filter((c) => c.attr_type === "select" && (r.values[c.id] ?? "") !== "")
              .map((c) => ({ value: r.values[c.id] }))[0];
            return (
              <div key={r.page_id} className="db-gallery-card" onClick={() => openPage(r.page_id)}>
                <div className="db-gallery-title">{r.title || "未命名"}</div>
                {firstSelect && (
                  <span
                    className="db-gallery-badge"
                    style={{
                      background: tagColor(firstSelect.value).soft,
                      color: tagColor(firstSelect.value).solid,
                    }}
                  >
                    {firstSelect.value}
                  </span>
                )}
              </div>
            );
          })}
          {rows.length === 0 && <div className="db-empty">无匹配页面</div>}
        </div>
      )}

      {addingCol && (
        <div ref={addColPanelRef} className="db-add-col-panel">
          <div className="db-add-col-title">
            添加列
            <button className="db-panel-close" onClick={() => setAddingCol(false)} title="关闭">
              ×
            </button>
          </div>
          {availableAttrs.map((a) => (
            <button
              key={a.id}
              className="db-add-col-item"
              onClick={() => {
                addColumn(a.id);
                setAddingCol(false);
              }}
            >
              <span>{a.name}</span>
              <span className="db-add-col-type">{TYPE_LABELS[a.attr_type] ?? a.attr_type}</span>
            </button>
          ))}
          {availableAttrs.length === 0 && <div className="db-add-col-empty">暂无可用属性</div>}
          <DbNewAttr
            onCreate={(name, type, options) => {
              createAndAddColumn(name, type, options);
              setAddingCol(false);
            }}
          />
        </div>
      )}

      {editingOptionsCol && (
        <div ref={optionsPanelRef} className="db-add-col-panel">
          <div className="db-add-col-title">
            编辑选项（逗号分隔）
            <button className="db-panel-close" onClick={() => setEditingOptionsCol(null)} title="关闭">
              ×
            </button>
          </div>
          <input
            className="db-input db-options-input"
            value={optionsText}
            onChange={(e) => setOptionsText(e.target.value)}
            placeholder="选项，逗号分隔"
          />
          <div className="db-options-actions">
            <button className="db-new-attr-btn" onClick={() => saveOptions(editingOptionsCol)}>
              保存
            </button>
            <button className="db-options-cancel" onClick={() => setEditingOptionsCol(null)}>
              取消
            </button>
          </div>
        </div>
      )}

      {sortMenuKey && (
        <div ref={sortMenuPanelRef} className="db-add-col-panel db-pop-panel">
          <div className="db-add-col-title">
            排序：
            {sortMenuKey === "__title"
              ? "页面"
              : query.columns.find((c) => c.id === sortMenuKey)?.name ?? ""}
            <button className="db-panel-close" onClick={() => setSortMenuKey(null)} title="关闭">
              ×
            </button>
          </div>
          <button
            className={`db-add-col-item ${sort?.key === sortMenuKey && sort?.dir === 1 ? "db-item-active" : ""}`}
            onClick={() => {
              setSort({ key: sortMenuKey, dir: 1 });
              setSortMenuKey(null);
            }}
          >
            <span>升序</span>
            <span className="db-sort-caret">↑</span>
          </button>
          <button
            className={`db-add-col-item ${sort?.key === sortMenuKey && sort?.dir === -1 ? "db-item-active" : ""}`}
            onClick={() => {
              setSort({ key: sortMenuKey, dir: -1 });
              setSortMenuKey(null);
            }}
          >
            <span>降序</span>
            <span className="db-sort-caret">↓</span>
          </button>
          {sort?.key === sortMenuKey && (
            <button
              className="db-add-col-item"
              onClick={() => {
                setSort(null);
                setSortMenuKey(null);
              }}
            >
              <span>取消排序</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function RefCell({
  value,
  titles,
  onOpen,
}: {
  value: string;
  titles: Record<string, string>;
  onOpen: (v: string) => void;
}) {
  if (!value) return <span className="db-cell-muted">—</span>;
  return (
    <button className="db-ref" title="打开引用页面" onClick={() => onOpen(value)}>
      {titles[value] ?? value}
    </button>
  );
}

// 甘特图日期编辑：text 直接输入 + 📅 按钮弹原生日期选择器。
function DateField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const pickerRef = useRef<HTMLInputElement>(null);
  return (
    <span className="db-gantt-date">
      <input
        type="text"
        className="db-gantt-date-input"
        placeholder="YYYY-MM-DD"
        defaultValue={/^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : ""}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        className="db-gantt-date-pick"
        title="选择日期"
        onClick={() => pickerRef.current?.showPicker?.()}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <rect x="3" y="5" width="18" height="16" rx="2" />
          <path d="M3 9h18M8 3v4M16 3v4" />
        </svg>
      </button>
      <input
        ref={pickerRef}
        type="date"
        tabIndex={-1}
        className="db-gantt-date-picker"
        value={/^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : ""}
        onChange={(e) => onChange(e.target.value)}
      />
    </span>
  );
}

function DbCellEditor({
  attr,
  value,
  onChange,
}: {
  attr: AttrDef;
  value: string;
  onChange: (v: string) => void;
}) {
  if (attr.attr_type === "checkbox") {
    return (
      <input
        type="checkbox"
        className="db-checkbox"
        checked={value === "true"}
        onChange={(e) => onChange(e.target.checked ? "true" : "false")}
      />
    );
  }
  if (attr.attr_type === "select") {
    return (
      <select className="db-input" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        {attr.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }
  if (attr.attr_type === "date") {
    // 日期选择器（不用手动输 YYYY-MM-DD）。
    return (
      <input
        type="date"
        className="db-input"
        value={/^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : ""}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <input
      className="db-input"
      value={value}
      placeholder="—"
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function DbNewAttr({
  onCreate,
}: {
  onCreate: (name: string, type: string, options: string[]) => void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<string>("text");
  const [options, setOptions] = useState("");
  const needsOptions = type === "select" || type === "multi";
  const needsFormula = type === "formula";
  const needsRollup = type === "rollup";

  const commit = () => {
    if (!name.trim()) return;
    const opts = needsOptions
      ? options.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
      : needsFormula || needsRollup
        ? [options.trim()]
        : [];
    onCreate(name.trim(), type, opts);
  };

  return (
    <div className="db-new-attr">
      <input
        className="db-input"
        placeholder="新属性名"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && commit()}
      />
      <select className="db-input" value={type} onChange={(e) => setType(e.target.value)}>
        {TYPES.map((t) => (
          <option key={t} value={t}>
            {TYPE_LABELS[t]}
          </option>
        ))}
      </select>
      {needsOptions && (
        <input
          className="db-input"
          placeholder="选项，逗号分隔"
          value={options}
          onChange={(e) => setOptions(e.target.value)}
        />
      )}
      {needsFormula && (
        <input
          className="db-input"
          placeholder="公式，如 数量*单价 或 总分/人数"
          value={options}
          onChange={(e) => setOptions(e.target.value)}
        />
      )}
      {needsRollup && (
        <textarea
          className="db-input db-input-rollup"
          placeholder='统计配置 JSON，如 {"ref":"专题","db":"项目库","col":"工时","fn":"sum"}'
          value={options}
          onChange={(e) => setOptions(e.target.value)}
        />
      )}
      <button className="db-new-attr-btn" onClick={commit}>
        新建
      </button>
    </div>
  );
}

function DirectoryNode({
  node,
  openPage,
  depth = 0,
}: {
  node: { id: string; title: string; children: any[] };
  openPage: (id: string) => void;
  depth?: number;
}) {
  return (
    <div className="db-dir-item" style={{ paddingLeft: depth * 16 }}>
      <button className="db-dir-title" onClick={() => openPage(node.id)}>
        {node.title || "未命名"}
      </button>
      {node.children.map((c) => (
        <DirectoryNode key={c.id} node={c} openPage={openPage} depth={depth + 1} />
      ))}
    </div>
  );
}
