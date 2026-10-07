// S3 时间复盘页 —— 数据层的判据（纯函数 ✓，不需要浏览器、不需要库）。
//
// 为什么这些必须测：判据 `scripts/check-kb-s3-timeline.mjs` 只能核"声明在不在、口径唯一不唯一"，
// 而这三条的**行为**（两种空态真的分得开／本地日界真的对／窗口真的收得住）只有跑起来才知道 ✓。
import { describe, expect, it } from "vitest";

import type { PageMeta } from "../types";
import {
  TIMELINE_DAY_BUCKET,
  TIMELINE_STATES,
  TIMELINE_WINDOW_DAYS,
  blocksByPageDay,
  blockSummaryOf,
  buildTimeline,
  dayLabelOf,
  timelineStateOf,
} from "./kbTimeline";

const page = (over: Partial<PageMeta>): PageMeta => ({
  id: "p1",
  workspace_id: "w",
  parent_id: null,
  title: "页",
  icon: "",
  kind: "page",
  sort_order: 0,
  created_at: 0,
  updated_at: 0,
  deleted_at: null,
  ...over,
});

// 固定一个「现在」：2026-10-01 12:00（**本地时间** —— 口径是本地 ⇒ 断言也用本地构造 ✓）
const NOW = new Date(2026, 9, 1, 12, 0, 0).getTime();
const at = (y: number, mo: number, d: number, h = 12, mi = 0) =>
  new Date(y, mo - 1, d, h, mi, 0).getTime();

describe("S3 · 两种空态分得开", () => {
  it("没有页面 ⇒ no_pages", () => {
    expect(timelineStateOf([], NOW)).toBe("no_pages");
  });

  it("有页面、但这些天一条活动都没有 ⇒ no_recent_activity", () => {
    const old = page({ updated_at: at(2020, 1, 1), created_at: at(2020, 1, 1) });
    expect(timelineStateOf([old], NOW)).toBe("no_recent_activity");
  });

  it("窗口内有活动 ⇒ null（由调用方去画时间轴）", () => {
    expect(timelineStateOf([page({ updated_at: at(2026, 9, 30) })], NOW)).toBeNull();
  });

  it("两种空态是**两个互异**标识 —— 折成一个用户就分不清「该建页面」还是「该翻旧账」", () => {
    expect(new Set(TIMELINE_STATES).size).toBe(2);
    expect(TIMELINE_STATES[0]).not.toBe(TIMELINE_STATES[1]);
  });

  it("软删的页面不算「有页面」⇒ 全删光之后仍报 no_pages", () => {
    const gone = page({ deleted_at: 1, updated_at: at(2026, 9, 30) });
    expect(timelineStateOf([gone], NOW)).toBe("no_pages");
  });
});

describe("S3 · 时间口径只有一处（本地日界）", () => {
  it("同一本地日的两条并进同一格；跨本地日分开", () => {
    const days = buildTimeline(
      [page({ id: "a", updated_at: at(2026, 9, 30, 9) }), page({ id: "b", updated_at: at(2026, 9, 30, 21) }), page({ id: "c", updated_at: at(2026, 9, 29, 9) })],
      NOW,
    );
    expect(days.map((d) => d.day)).toEqual([TIMELINE_DAY_BUCKET(at(2026, 9, 30)), TIMELINE_DAY_BUCKET(at(2026, 9, 29))]);
    expect(days[0].entries.map((e) => e.id)).toEqual(["b", "a"]); // 同一天内新的在前
  });

  it("本地 23:30 与次日 00:30 分属两天（按 UTC 分桶就会错）", () => {
    expect(TIMELINE_DAY_BUCKET(at(2026, 9, 30, 23, 30))).not.toBe(TIMELINE_DAY_BUCKET(at(2026, 10, 1, 0, 30)));
  });

  it("窗口外的活动不进来", () => {
    const outside = page({ id: "old", updated_at: NOW - (TIMELINE_WINDOW_DAYS + 1) * 86400000 });
    const inside = page({ id: "new", updated_at: NOW - 86400000 });
    expect(buildTimeline([outside, inside], NOW).flatMap((d) => d.entries.map((e) => e.id))).toEqual(["new"]);
  });

  it("窗口起点**含**端点（边界不靠感觉 ✓）", () => {
    const edge = page({ id: "edge", updated_at: NOW - TIMELINE_WINDOW_DAYS * 86400000 });
    expect(buildTimeline([edge], NOW).flatMap((d) => d.entries.map((e) => e.id))).toEqual(["edge"]);
  });

  it("没有更新的页面退回 created_at（不许因为 updated_at 是 0 就消失）", () => {
    const p = page({ id: "c1", created_at: at(2026, 9, 28), updated_at: 0 });
    expect(buildTimeline([p], NOW).flatMap((d) => d.entries.map((e) => e.id))).toEqual(["c1"]);
  });
});

describe("S3 · 一天的说法（只比 day 串，不另算日界）", () => {
  it("今天 / 昨天 / 具体日期", () => {
    expect(dayLabelOf(TIMELINE_DAY_BUCKET(NOW), NOW)).toEqual({ kind: "today" });
    expect(dayLabelOf(TIMELINE_DAY_BUCKET(at(2026, 9, 30, 23, 59)), NOW)).toEqual({ kind: "yesterday" });
    expect(dayLabelOf(TIMELINE_DAY_BUCKET(at(2026, 9, 20)), NOW)).toEqual({ kind: "date", month: 9, day: 20 });
  });
});

describe("S3 · 活动明细（种类 ＋ 每日汇总）", () => {
  it("这一笔就是它被建出来的那一刻 ⇒ 新建；建得更早、当天才改 ⇒ 改过", () => {
    const born = page({ id: "born", created_at: at(2026, 9, 30, 10), updated_at: at(2026, 9, 30, 10) });
    const later = page({ id: "later", created_at: at(2026, 8, 1, 10), updated_at: at(2026, 9, 30, 11) });
    const [day] = buildTimeline([born, later], NOW);
    const kinds = new Map(day.entries.map((e) => [e.id, e.kind]));
    expect(kinds.get("born")).toBe("created");
    expect(kinds.get("later")).toBe("edited");
  });

  it("⚠️ 「三个月前建、今天改」不算今天新建（拿 created_at 在不在窗口里判就会错）", () => {
    const p = page({ id: "old-born", created_at: at(2026, 6, 1), updated_at: NOW - 60_000 });
    const [day] = buildTimeline([p], NOW);
    expect(day.entries[0].kind).toBe("edited");
    expect(day.created).toBe(0);
    expect(day.edited).toBe(1);
  });

  it("每日汇总：新建几篇 / 改过几篇（同一天内新的在前）", () => {
    const pages = [
      page({ id: "n1", created_at: at(2026, 9, 30, 9), updated_at: at(2026, 9, 30, 9) }),
      page({ id: "n2", created_at: at(2026, 9, 30, 10), updated_at: at(2026, 9, 30, 10) }),
      page({ id: "e1", created_at: at(2026, 8, 1), updated_at: at(2026, 9, 30, 11) }),
    ];
    const [day] = buildTimeline(pages, NOW);
    expect([day.created, day.edited]).toEqual([2, 1]);
    expect(day.entries.map((e) => e.id)).toEqual(["e1", "n2", "n1"]);
  });

  it("没有 updated_at 的老页面按建的那天算，且算「新建」", () => {
    const legacy = page({ id: "legacy", created_at: at(2026, 9, 29), updated_at: 0 });
    const [day] = buildTimeline([legacy], NOW);
    expect(day.entries[0].kind).toBe("created");
    expect(day.day).toBe(TIMELINE_DAY_BUCKET(at(2026, 9, 29)));
  });

  it("汇总与明细必须一致（不许两处各算一遍）", () => {
    const pages = [
      page({ id: "a", created_at: at(2026, 9, 30, 8), updated_at: at(2026, 9, 30, 8) }),
      page({ id: "b", created_at: at(2026, 9, 1), updated_at: at(2026, 9, 30, 12) }),
      page({ id: "c", created_at: at(2026, 9, 30, 13), updated_at: at(2026, 9, 30, 13) }),
    ];
    const [day] = buildTimeline(pages, NOW);
    expect(day.created).toBe(day.entries.filter((e) => e.kind === "created").length);
    expect(day.edited).toBe(day.entries.filter((e) => e.kind === "edited").length);
  });

  it("跨天的明细：两天各自汇总，不互相串", () => {
    const pages = [
      page({ id: "today-new", created_at: at(2026, 9, 30, 9), updated_at: at(2026, 9, 30, 9) }),
      page({ id: "yesterday-edit", created_at: at(2026, 9, 1), updated_at: at(2026, 9, 29, 9) }),
    ];
    const days = buildTimeline(pages, NOW);
    expect(days.map((d) => [d.day, d.created, d.edited])).toEqual([
      [TIMELINE_DAY_BUCKET(at(2026, 9, 30)), 1, 0],
      [TIMELINE_DAY_BUCKET(at(2026, 9, 29)), 0, 1],
    ]);
  });
});

describe("S3 第三片 · 块级明细挂到「页 ＋ 天」", () => {
  it("汇总就是三个数（新增／改过／删掉）", () => {
    expect(
      blockSummaryOf([
        { blockId: "a", kind: "added", label: "" },
        { blockId: "b", kind: "edited", label: "" },
        { blockId: "c", kind: "added", label: "" },
        { blockId: "d", kind: "removed", label: "" },
      ]),
    ).toEqual({ added: 2, edited: 1, removed: 1 });
    expect(blockSummaryOf([])).toEqual({ added: 0, edited: 0, removed: 0 });
  });

  it("同一页同一天改了几次 ⇒ 明细**并起来**（后者覆盖前者就会少报 ✗）", () => {
    const day = () => "2026-10-01";
    const ev = (pageId: string, kind: "added" | "edited" | "removed", n: number) => ({
      pageId,
      title: "",
      atMs: n,
      op: "upsert",
      changes: [{ blockId: `b${n}`, kind, label: "" }],
    });
    const m = blocksByPageDay([ev("p1", "added", 1), ev("p1", "edited", 2)], day);
    expect(m.get("p1@2026-10-01")?.map((c) => c.kind)).toEqual(["added", "edited"]);
  });

  it("没有明细的事件不产生键；不同页／不同天各自一把键（键由**唯一**那处口径算）", () => {
    const day = (atMs: number) => (atMs < 1000 ? "d1" : "d2");
    const ev = (pageId: string, atMs: number) => ({
      pageId,
      title: "",
      atMs,
      op: "upsert",
      changes: [{ blockId: "b", kind: "edited" as const, label: "" }],
    });
    const m = blocksByPageDay([ev("p1", 10), ev("p2", 10), ev("p1", 2000), { ...ev("p3", 10), changes: [] }], day);
    expect([...m.keys()].sort()).toEqual(["p1@d1", "p1@d2", "p2@d1"]);
  });

  it('★ 只收「页」：目录 / 数据库不进复盘（点了也打不开 —— 实测报「该节点不是页面」✗）', () => {
    const a = page({ id: "p1", title: "一篇笔记", created_at: at(2026, 10, 7, 10, 0), updated_at: at(2026, 10, 7, 10, 0) });
    const folder = page({ id: "f1", title: "一个目录", kind: "folder", created_at: at(2026, 10, 7, 9, 0), updated_at: at(2026, 10, 7, 9, 0) });
    const db = page({ id: "d1", title: "一个数据库", kind: "database", created_at: at(2026, 10, 7, 8, 0), updated_at: at(2026, 10, 7, 8, 0) });
    const ids = buildTimeline([a, folder, db], NOW).flatMap((d) => d.entries.map((e) => e.id));
    expect(ids).toEqual(["p1"]);
  });
});
