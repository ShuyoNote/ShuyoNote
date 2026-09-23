// 判据：P3-② 接线层（`databaseTextForPage.ts`）—— **它自己的行为** ＋ **接线确实接上了**。
//
// 后者是重点：这一格最容易的坏法不是"算错"，而是"**接线掉了**"—— 算法与判据都绿，而正文列永远是旧值。
// 所以这里除了纯函数判据，还有一条**源码级**接线判据（组件必须调这一个入口，且只走那条只动正文的 API）。
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  databasePageText,
  databaseRulesText,
  refreshDatabasePageText,
} from "./databaseTextForPage";
import type { AttrDef, DatabaseRow } from "../types";

const columns: AttrDef[] = [
  { id: "c1", name: "状态", attr_type: "select" },
  { id: "c2", name: "负责人", attr_type: "text" },
] as AttrDef[];

const rows: DatabaseRow[] = [
  { page_id: "p1", title: "审批流", values: { c1: "进行中", c2: "小马" } },
  { page_id: "p2", title: "发布流", values: { c1: "已完成", c2: "小周" } },
];

describe("databasePageText：该不该写、写什么", () => {
  it("有行 ⇒ 给出文本（含列名与行内容）", () => {
    const text = databasePageText({ columns, rows });
    expect(text).toBeTruthy();
    expect(text!).toContain("状态");
    expect(text!).toContain("进行中");
  });

  it("★ 空库 ⇒ `null`（调用方据此**不写** —— 一次写库都没有）", () => {
    expect(databasePageText({ columns, rows: [] })).toBeNull();
    expect(databasePageText({ columns: [], rows: [] })).toBeNull();
  });

  it("确定性：同数据两次一样", () => {
    expect(databasePageText({ columns, rows })).toBe(databasePageText({ columns, rows }));
  });

  it("title / rules 只在给了的时候进正文（不给就不多那一行）", () => {
    const bare = databasePageText({ columns, rows })!;
    const withTitle = databasePageText({ columns, rows }, { title: "项目库" })!;
    expect(withTitle).toContain("项目库");
    expect(bare).not.toContain("项目库");
    const withRules = databasePageText({ columns, rows }, { rules: ["筛选：状态=进行中"] })!;
    expect(withRules).toContain("筛选：状态=进行中");
  });
});

describe("databaseRulesText：规则短句（纯函数，不猜视图 config）", () => {
  it("都没有 ⇒ 空数组（不写「规则：无」这种噪声）", () => {
    expect(databaseRulesText({})).toEqual([]);
    expect(databaseRulesText({ filter: "  ", sort: null, viewName: "" })).toEqual([]);
  });

  it("有筛选/排序/视图名 ⇒ 各出一条人读短句", () => {
    expect(databaseRulesText({ filter: "状态=进行中" })).toEqual(["筛选：状态=进行中"]);
    expect(databaseRulesText({ sort: { key: "负责人", dir: -1 } })).toEqual(["排序：负责人 降序"]);
    expect(databaseRulesText({ viewName: "本周", filter: "状态=进行中", sort: { key: "负责人", dir: 1 } })).toEqual([
      "视图：本周",
      "筛选：状态=进行中",
      "排序：负责人 升序",
    ]);
  });
});

describe("refreshDatabasePageText：接线本体（注入 refresh 做桩）", () => {
  it("★ 有行 ⇒ 调一次那条入口，且**只**调它（没有第二个副作用）", async () => {
    const calls: { pageId: string; text: string }[] = [];
    const wrote = await refreshDatabasePageText(
      { refresh: (pageId, text) => calls.push({ pageId, text }) },
      "db1",
      { columns, rows },
    );
    expect(wrote).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].pageId).toBe("db1");
    expect(calls[0].text).toContain("进行中");
  });

  it("★ 空库 ⇒ **一次都不调**，返回 false", async () => {
    let called = 0;
    const wrote = await refreshDatabasePageText({ refresh: () => (called += 1) }, "db1", { columns, rows: [] });
    expect(wrote).toBe(false);
    expect(called).toBe(0);
  });
});

describe("★ 接线判据（源码级）：DatabaseView 真的接了这一个入口", () => {
  const src = readFileSync(join(process.cwd(), "src/components/DatabaseView.tsx"), "utf8");

  it("数据库视图 import 了接线层，并在加载后调用它", () => {
    expect(src).toMatch(/from "\.\.\/lib\/databaseTextForPage"/);
    expect(src).toMatch(/refreshDatabasePageText\(/);
  });

  it("★ 走的是**只动正文文本**的那条 API（`api.refreshPageText`），不是别的内容写入路径", () => {
    expect(src).toMatch(/api\.refreshPageText\(/);
    // 反面：这一格里**不许**出现"保存页面内容"那条（那会连内容 JSON 一起写、并标脏）
    expect(src).not.toMatch(/api\.(savePage|writeContent)\(/);
  });
});

describe("★ 路由判据（源码级）：`refresh_page_text` 在**两个平台**都指向那条「只动正文」的实现", () => {
  const rust = readFileSync(join(process.cwd(), "src-tauri/src/commands.rs"), "utf8");
  const web = readFileSync(join(process.cwd(), "src/lib/platform/web.ts"), "utf8");

  it("Rust 入口 ⇒ `doc_content::refresh_page_text_if_stale`（不另写一条会标脏的 UPDATE）", () => {
    expect(rust).toMatch(/refresh_page_text[\s\S]{0,200}doc_content::refresh_page_text_if_stale/);
    expect(rust).not.toMatch(/refresh_page_text[\s\S]{0,200}dirty = 1/);
  });

  it("Web 入口 ⇒ `refreshPageTextIfStale`（同一条语义）", () => {
    expect(web).toMatch(/refresh_page_text[\s\S]{0,300}refreshPageTextIfStale/);
  });
});
