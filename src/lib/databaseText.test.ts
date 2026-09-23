// `databaseTextOf` 的判据 —— 对着方案 P3 工作单里那几条"建议判据"写。
//
// 这一格为什么值得判：它要做的是**把数据库页的行灌进正文列**（否则"找出所有状态=进行中"这类问题
// 在检索面上根本无据可查）。而正文列一旦写坏，症状是"搜不到"或"搜到噪声"，两种都不会报错。
import { describe, expect, it } from "vitest";

import { DEFAULT_MAX_ROWS, databaseTextOf } from "./databaseText";
import type { AttrDef, DatabaseRow } from "../types";

const col = (id: string, name: string, attr_type = "text", options: string[] = []): AttrDef => ({
  id,
  name,
  attr_type,
  options,
});
const row = (page_id: string, title: string, values: Record<string, string>): DatabaseRow => ({ page_id, title, values });

const COLUMNS = [col("c1", "状态", "select", ["待办", "进行中", "已完成"]), col("c2", "负责人")];
const ROWS = [
  row("p1", "季度计划", { c1: "进行中", c2: "张三" }),
  row("p2", "年度复盘", { c1: "待办", c2: "李四" }),
];

describe("databaseTextOf：列 / 行 / 规则进正文", () => {
  it("列名与选择型列的**选项**都进正文；行的标题与值也进", () => {
    const r = databaseTextOf({ title: "任务库", columns: COLUMNS, rows: ROWS, rules: ["筛选 状态＝进行中"] });
    expect(r.text).toContain("数据库：任务库");
    expect(r.text).toContain("状态（选项：待办、进行中、已完成）");
    expect(r.text).toContain("负责人");
    expect(r.text).toContain("季度计划：状态＝进行中、负责人＝张三");
    expect(r.text).toContain("规则：筛选 状态＝进行中");
  });

  it("★ **只包含给定的行**（不许编造）：给 2 行，第 3 个标题不许出现，且行 ref 数 = 行数", () => {
    const r = databaseTextOf({ columns: COLUMNS, rows: ROWS });
    expect(r.text).not.toContain("不存在的行");
    expect(r.rowRefs).toEqual([
      { pageId: "p1", title: "季度计划" },
      { pageId: "p2", title: "年度复盘" },
    ]);
  });

  it("列的呈现顺序**只按 `columns`**，不依赖 `values` 的键序（对象键序不是契约）", () => {
    // values 的键序故意与 columns 相反
    const reversed = [row("p1", "A", { c2: "李四", c1: "待办" })];
    const r = databaseTextOf({ columns: COLUMNS, rows: reversed });
    expect(r.text).toContain("A：状态＝待办、负责人＝李四"); // 状态 在前
  });

  it("空值列**跳过**（不写 `＝` 空壳，省噪声）", () => {
    const r = databaseTextOf({ columns: COLUMNS, rows: [row("p1", "半填", { c1: "进行中" })] });
    expect(r.text).toContain("半填：状态＝进行中");
    expect(r.text).not.toMatch(/负责人＝\s*(\n|$)/);
  });

  it("没给标题 ⇒ 不写「数据库：…」那一行（不凭空造标题）", () => {
    const r = databaseTextOf({ columns: COLUMNS, rows: ROWS });
    expect(r.text.startsWith("数据库：")).toBe(false);
    expect(r.text).toContain("列：");
  });
});

describe("databaseTextOf：空库与截断 —— 两条都是「不许含糊」", () => {
  it("★ 空库 ⇒ **空串**（让接线侧据此不写正文；不许糊一个「数据库：无行」占位）", () => {
    const r = databaseTextOf({ title: "空库", columns: COLUMNS, rows: [] });
    expect(r.text).toBe("");
    expect(r.rowRefs).toEqual([]);
    expect(r.truncated).toBe(0);
  });

  it("★ 超过上限 ⇒ 截断，且正文里**明说**还剩多少行没进（不说就等于让人以为抽全了）", () => {
    const many = Array.from({ length: 5 }, (_, i) => row(`p${i}`, `第${i + 1}行`, { c1: "待办" }));
    const r = databaseTextOf({ columns: COLUMNS, rows: many, maxRows: 2 });
    expect(r.truncated).toBe(3);
    expect(r.rowRefs).toHaveLength(2);
    expect(r.text).toContain("第1行");
    expect(r.text).toContain("第2行");
    expect(r.text).not.toContain("第3行");
    expect(r.text).toContain("另有 3 行未进正文");
    expect(r.text).toContain("2");
  });

  it("默认上限是个正数（不是 0 —— 0 会让所有数据库页的正文都变成空）", () => {
    expect(DEFAULT_MAX_ROWS).toBeGreaterThan(0);
  });
});

describe("databaseTextOf：确定性与纯函数性", () => {
  it("★ 同一份输入跑两次 ⇒ **逐字相同**（不一致的正文会让「谁最后保存」决定索引长什么样）", () => {
    const a = databaseTextOf({ title: "T", columns: COLUMNS, rows: ROWS, rules: ["r"] });
    const b = databaseTextOf({ title: "T", columns: COLUMNS, rows: ROWS, rules: ["r"] });
    expect(a.text).toBe(b.text);
  });

  it("★ 不改动入参（接线后它坐在保存路径上，动入参等于悄悄改用户数据）", () => {
    const columns = [col("c1", "状态", "select", ["待办"])];
    const rows = [row("p1", "A", { c1: "待办" })];
    const snapshot = JSON.stringify({ columns, rows });
    databaseTextOf({ title: "T", columns, rows, rules: ["x"] });
    expect(JSON.stringify({ columns, rows })).toBe(snapshot);
  });

  it("脏输入不许抛（列/行给了 undefined 也要能返回）", () => {
    expect(() => databaseTextOf({ columns: [], rows: [] })).not.toThrow();
    expect(
      databaseTextOf({ columns: [{} as AttrDef], rows: [{ page_id: "", title: "", values: {} } as DatabaseRow] }).text,
    ).toContain("行");
  });
});
