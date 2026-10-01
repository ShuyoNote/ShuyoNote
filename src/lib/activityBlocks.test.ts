// S3 第三片 · Web 侧那一半（与桌面 `src-tauri/src/activity.rs` 逐条对应 ✓）。
//
// 第一条判据读的是**同一份跨语言夹具** `tests/activity-parity.json`（桌面侧在 `activity.rs` 里
// 用 `include_str!` 读它 ✓）⇒ 两侧断同一组期望值 ⇒ 语义相等是**传递**出来的 ✓。
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { docJsonOfPayload } from "./docContent";
import {
  activityFeedOf,
  changedBlocks,
  changedBlocksBetweenPayloads,
  titleOfPayload,
} from "./activityBlocks";

interface FixtureCase {
  name: string;
  prev: unknown;
  next: unknown;
  expect: { blockId: string; kind: string }[];
}
const FIXTURE = JSON.parse(
  readFileSync(join(process.cwd(), "tests", "activity-parity.json"), "utf8"),
) as { cases: FixtureCase[] };

/** 一个顶层块（`rev` 可缺 ⇒ 老客户端产物 ✓）。 */
const blk = (id: string | null, rev: number | null, text: string) => ({
  type: "paragraph",
  ...(id === null ? {} : { blockId: id }),
  ...(rev === null ? {} : { blockRev: rev }),
  children: [{ type: "text", text }],
});
const doc = (...blocks: unknown[]) => ({ root: { children: blocks } });
const payloadOf = (content: unknown, title = "页", id = "p1") =>
  JSON.stringify({ id, title, content_json: JSON.stringify(content) });

describe("S3 第三片 · 与共享夹具一致（桌面侧读同一份）", () => {
  it("夹具形状：note 在 ＋ 至少两条用例", () => {
    expect(FIXTURE.cases.length).toBeGreaterThanOrEqual(2);
  });

  it("每条用例的块级差异与夹具期望逐条相等（含顺序约定）", () => {
    const bad: string[] = [];
    for (const c of FIXTURE.cases) {
      const got = changedBlocks(
        c.prev === null ? undefined : JSON.stringify(c.prev),
        JSON.stringify(c.next),
      );
      const want = c.expect.map((e) => ({ blockId: e.blockId, kind: e.kind }));
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        bad.push(`「${c.name}」：Web=${JSON.stringify(got)} 期望=${JSON.stringify(want)}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("S3 第三片 · 载荷与活动行", () => {
  it("载荷提取：content_json 是字符串／对象都收；没有就 undefined；坏 JSON 不抛", () => {
    expect(docJsonOfPayload('{"id":"p1","content_json":"{\\"root\\":{}}" }')).toBe('{"root":{}}');
    expect(docJsonOfPayload('{"content_json":{"root":{}}}')).toBe('{"root":{}}');
    expect(docJsonOfPayload('{"id":"p1"}')).toBeUndefined();
    expect(docJsonOfPayload("不是 JSON")).toBeUndefined();
  });

  it("标题：读得到就用，读不到给空串（不因为标题读不到就整条丢掉）", () => {
    expect(titleOfPayload(payloadOf(doc(blk("b1", 1, "甲")), "周报"))).toBe("周报");
    expect(titleOfPayload("不是 JSON")).toBe("");
  });

  it("载荷级差异：坏载荷 ⇒ 不报也不抛", () => {
    expect(changedBlocksBetweenPayloads(undefined, "不是 JSON")).toEqual([]);
  });

  it("活动行：同一页两条 upsert ⇒ 第二条给出差异；delete 那条没有块级明细", () => {
    const rows = [
      { entity_id: "p1", op: "upsert", payload: payloadOf(doc(blk("b1", 1, "甲"))), updated_at: 1000 },
      { entity_id: "p1", op: "upsert", payload: payloadOf(doc(blk("b1", 2, "甲改了"))), updated_at: 2000 },
      { entity_id: "p1", op: "delete", payload: null, updated_at: 3000 },
    ];
    const feed = activityFeedOf(rows);
    expect(feed.map((e) => e.op)).toEqual(["upsert", "upsert", "delete"]);
    expect(feed[0].changes).toEqual([{ blockId: "b1", kind: "added" }]);
    expect(feed[1].changes).toEqual([{ blockId: "b1", kind: "edited" }]);
    expect(feed[2].changes).toEqual([]);
    expect(feed[1]).toMatchObject({ pageId: "p1", title: "页", atMs: 2000 });
  });

  it("不同页的 upsert 不互相串（上一条载荷按页各记各的）", () => {
    const rows = [
      { entity_id: "p1", op: "upsert", payload: payloadOf(doc(blk("a1", 1, "甲")), "页一", "p1"), updated_at: 1 },
      { entity_id: "p2", op: "upsert", payload: payloadOf(doc(blk("b1", 1, "乙")), "页二", "p2"), updated_at: 2 },
    ];
    const feed = activityFeedOf(rows);
    expect(feed[1].changes).toEqual([{ blockId: "b1", kind: "added" }]);
  });
});
