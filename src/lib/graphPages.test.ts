// 判据：「图里哪些节点算内容页」这条规则 —— **两个视图共用一处，且行为对**。
//   owner 2026-10-08：先拍「知识地图里面不显示目录名称」，再拍「关系图**一起**滤掉」✓。
//
// 三类断言：
//   ① 纯行为：只滤 `folder`（`database` 与**缺省 kind** 都留着 ⇒ ⛔ 不许因为认不出就藏东西）；
//   ② 边跟着端点走：目录被滤掉后**不留悬空线**；
//   ③ **源码形状**：`GraphView.tsx` 与 `kbMap.ts` 都 import 这一处，且**都不再**各写一份
//      `kind … "folder"` —— 这条挡的是"两份规则各自漂移"（本仓最贵的一课：一条判据被抄了 7 份 ✓）。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { GraphEdge, GraphPage } from "../types";
import { contentPages, edgesWithin, isContentPage } from "./graphPages";

/** ⚠️ ESM 里没有 `__dirname`（本文件第一次就栽在这：collect 阶段直接 "no tests" ✗）；
 *  口径照 `lib/ai/libraryMap.test.ts` 的 `HERE` ✓（那里也是"读真源码"的静态断言 ✓）。 */
const HERE = dirname(fileURLToPath(import.meta.url));

const page = (id: string, kind?: string): GraphPage => ({ id, title: id, tags: [], props: [], ...(kind ? { kind } : {}) });
const edge = (source: string, target: string): GraphEdge => ({ source, target, kind: "link" });

describe("内容页的判定：只滤目录", () => {
  it("`folder` 不是内容页；`page` / `database` / **缺省 kind** 都是", () => {
    expect(isContentPage(page("f", "folder"))).toBe(false);
    expect(isContentPage(page("p", "page"))).toBe(true);
    expect(isContentPage(page("db", "database"))).toBe(true);
    expect(isContentPage(page("legacy"))).toBe(true); // ⛔ 认不出 ⇒ 当页面（藏东西比多画一个坏 ✗）
  });

  it("`contentPages` 只丢目录，且**保持原顺序**", () => {
    const out = contentPages([page("a", "page"), page("f", "folder"), page("db", "database"), page("l")]);
    expect(out.map((p) => p.id)).toEqual(["a", "db", "l"]);
  });

  it("全目录 ⇒ 空（视图据此说「没有可画的页面」，而不是画一堆目录 ✗）", () => {
    expect(contentPages([page("f1", "folder"), page("f2", "folder")])).toEqual([]);
  });
});

describe("边跟着端点走（目录滤掉后不留悬空线）", () => {
  it("指向目录的边被丢，两端都在集合里的边留下", () => {
    const kept = new Set(["a", "b"]);
    expect(edgesWithin([edge("f", "a"), edge("a", "b"), edge("b", "f")], kept)).toEqual([edge("a", "b")]);
  });

  it("空集合 ⇒ 一条边都不留", () => {
    expect(edgesWithin([edge("a", "b")], new Set())).toEqual([]);
  });
});

describe("⭐ 两个视图**共用这一处**（⛔ 不许各写一份）", () => {
  const src = (rel: string) => readFileSync(join(HERE, rel), "utf8");
  /**
   * 抹掉注释再找 —— ⚠️ 本文件第一版**没抹**，于是把 `GraphView.tsx` 里那句
   * 「两边各写一份 `kind !== "folder"` 必然漂移」的**注释**当成了违规 ✗（判据假红）。
   * 同一条教训本仓记过：**讲解规则的注释不该被判违规**（`check-kb-s4-map` 就是为这个才剥注释的 ✓）。
   */
  const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

  it("关系图与知识地图都 import 这一处", () => {
    expect(src("../components/GraphView.tsx")).toContain('from "../lib/graphPages"');
    expect(src("./kbMap.ts")).toContain('from "./graphPages"');
  });

  it("⛔ 两边都不许再各写一份 `kind … folder` 的判断（那正是两份规则会漂移的写法）", () => {
    for (const rel of ["../components/GraphView.tsx", "./kbMap.ts"]) {
      const text = code(src(rel));
      // 允许出现 `kind`（如类型字段）与 `folder`（如文案），但不许它们出现在同一句判断里
      expect(/kind\s*(?:\)|\s)*(?:!==|===)\s*["']folder["']/.test(text), `${rel} 里又自己写了一份目录判断 ✗`).toBe(false);
      expect(/["']folder["']\s*(?:!==|===)\s*\w*\.?kind/.test(text), `${rel} 里又自己写了一份目录判断 ✗`).toBe(false);
    }
  });
});
