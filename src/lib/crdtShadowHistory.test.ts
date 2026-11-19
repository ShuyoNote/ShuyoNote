// ⭐ P3-3a 第四小步（task-67）：影子观测历史的记录/裁剪/摘要纯函数判据。
import { describe, expect, it } from "vitest";
import type { ShadowRowsResult } from "./crdtShadow";
import {
  SHADOW_HISTORY_DAYS,
  dayRecordFromSummary,
  parseShadowHistory,
  recordShadowDay,
  shadowDateKey,
  shadowHistoryCopyText,
  summarizeShadowHistory,
  validateShadowDayRecord,
  type ShadowDayRecord,
} from "./crdtShadowHistory";

const rows = (patch: Partial<ShadowRowsResult>): ShadowRowsResult => ({
  total: 0,
  withState: 0,
  equal: 0,
  differ: 0,
  uncomparable: 0,
  differPageIds: [],
  ...patch,
});

const rec = (date: string, differ = 0): ShadowDayRecord => ({
  date,
  total: 3,
  withState: 3,
  equal: 3 - differ,
  differ,
  uncomparable: 0,
});

const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12, 0, 0);

describe("crdtShadowHistory：记录", () => {
  it("⓪ 差异分类随摘要落库；旧记录没有这两列也照样解析（P0-1b）", () => {
    const split = dayRecordFromSummary(
      rows({ total: 3, withState: 3, equal: 1, differ: 2, differPending: 1, differUnexplained: 1 }),
      at(2026, 11, 9),
    );
    expect(split).toMatchObject({ differ: 2, differPending: 1, differUnexplained: 1 });
    // 旧记录（没有分类字段）⇒ 解析保留，不判坏。
    const parsed = parseShadowHistory(JSON.stringify([rec("2026-11-01", 1)]));
    expect(parsed.records.map((r) => r.date)).toEqual(["2026-11-01"]);
    // 分类之和超过 differ ⇒ 坏记录。
    expect(
      validateShadowDayRecord({ ...rec("2026-11-02", 1), differPending: 1, differUnexplained: 1 }),
    ).toContain("超过");
  });

  it("同一天只留最新一次（覆盖，不累加）", () => {
    let list = recordShadowDay([], rows({ total: 3, withState: 2, equal: 2, differ: 1 }), at(2026, 11, 9));
    expect(list).toHaveLength(1);
    expect(list[0].differ).toBe(1);
    list = recordShadowDay(list, rows({ total: 3, withState: 3, equal: 3, differ: 0 }), at(2026, 11, 9));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ date: "2026-11-09", total: 3, withState: 3, equal: 3, differ: 0 });
  });

  it("按日期升序，只留最近 7 天（旧的天被裁掉）", () => {
    let list: ShadowDayRecord[] = [];
    for (let i = 1; i <= 10; i += 1) {
      list = recordShadowDay(list, rows({ total: 1 }), at(2026, 11, i));
    }
    expect(list).toHaveLength(SHADOW_HISTORY_DAYS);
    expect(list.map((r) => r.date)).toEqual([
      "2026-11-04",
      "2026-11-05",
      "2026-11-06",
      "2026-11-07",
      "2026-11-08",
      "2026-11-09",
      "2026-11-10",
    ]);
    // 乱序输入也会排序。
    expect(recordShadowDay([rec("2026-11-09")], rows({}), at(2026, 11, 1)).map((r) => r.date)).toEqual([
      "2026-11-01",
      "2026-11-09",
    ]);
  });

  it("坏记录丢弃并给原因；不猜格式", () => {
    const list = recordShadowDay(
      [rec("2026-11-01"), { ...rec("2026-11-02"), total: -1 } as ShadowDayRecord],
      rows({ total: 2 }),
      at(2026, 11, 9),
    );
    expect(list.map((r) => r.date)).toEqual(["2026-11-01", "2026-11-09"]);
    const parsed = parseShadowHistory(
      JSON.stringify([
        rec("2026-11-01"),
        "not-object",
        { ...rec("2026-11-02"), date: "2026-02-30" },
        { ...rec("2026-11-03"), total: 1.5 },
      ]),
    );
    expect(parsed.records.map((r) => r.date)).toEqual(["2026-11-01"]);
    expect(parsed.dropped).toBe(3);
    expect(parsed.reasons.join("\n")).toContain("日期非法");
    expect(parsed.reasons.join("\n")).toContain("计数非法");
    // 日期键是本地日历。
    expect(shadowDateKey(at(2026, 1, 2))).toBe("2026-01-02");
    expect(validateShadowDayRecord(rec("2026-11-09"))).toBeNull();
  });

  it("坏 JSON / 非数组 ⇒ 空表 + 原因；空内容 ⇒ 空表无原因", () => {
    expect(parseShadowHistory("not json")).toMatchObject({ records: [], reasons: ["历史不是合法 JSON"] });
    expect(parseShadowHistory('{"a":1}')).toMatchObject({ records: [], reasons: ["历史不是数组"] });
    expect(parseShadowHistory(null)).toMatchObject({ records: [], dropped: 0 });
    expect(parseShadowHistory("  ")).toMatchObject({ records: [], dropped: 0 });
  });
});

describe("crdtShadowHistory：摘要", () => {
  it("空/未知/坏历史 ⇒ unknown 文案（⛔ 不假装无记录）", () => {
    expect(summarizeShadowHistory(null)).toMatchObject({ unknown: true, days: 0 });
    expect(summarizeShadowHistory(null).text).toContain("未知");
    expect(summarizeShadowHistory(undefined).text).toContain("未知");
    expect(summarizeShadowHistory([])).toMatchObject({ unknown: false, days: 0, tone: "muted" });
    expect(summarizeShadowHistory([]).text).toContain("无记录");
  });

  it("全 0 差异 ⇒ ok；有差异 ⇒ warn ＋ 差异天数/最近差异日期", () => {
    const clean = summarizeShadowHistory([rec("2026-11-20"), rec("2026-11-21")]);
    expect(clean.text).toContain("最近 2 天无差异");
    expect(clean.text).toContain("2026-11-21");
    expect(clean.tone).toBe("ok");
    expect(clean.differDays).toBe(0);

    const dirty = summarizeShadowHistory([
      rec("2026-11-20", 2),
      rec("2026-11-21"),
      rec("2026-11-22", 1),
    ]);
    expect(dirty.days).toBe(3);
    expect(dirty.differDays).toBe(2);
    expect(dirty.lastDifferDate).toBe("2026-11-22");
    expect(dirty.text).toContain("有差异 2 天");
    expect(dirty.tone).toBe("warn");
    // 摘要只取最近 7 天（更早的不算）。
    const many = summarizeShadowHistory(
      Array.from({ length: 10 }, (_, i) => rec(`2026-11-2${i}`, i === 0 ? 1 : 0)),
    );
    expect(many.days).toBe(7);
    expect(many.differDays).toBe(0);
  });

  // ⭐ owner 2026-11-19 拍：「作废的那 5 天不许再让人以为现在还在差」
  it("⭐ 2026-11-14 之前的记录**作废、不计入**（记录本身不删，且如实说「另有 N 天作废」）", () => {
    // ① 五天作废 ＋ 两天有效 ⇒ 只数有效那两天；那行文字必须点名"作废·不计入"
    const s = summarizeShadowHistory([
      rec("2026-11-09", 1),
      rec("2026-11-10", 2),
      rec("2026-11-11", 2),
      rec("2026-11-12", 2),
      rec("2026-11-13", 2),
      rec("2026-11-14", 0),
      rec("2026-11-18", 0),
    ]);
    expect(s.days, "有效日只算 11-14 与 11-18 两天").toBe(2);
    expect(s.differDays, "作废那几天的差异不许计入").toBe(0);
    expect(s.tone).toBe("ok");
    expect(s.voidedDays).toBe(5);
    expect(s.text).toContain("无差异");
    expect(s.text).toContain("另有 5 天作废·不计入");
    expect(s.lastDifferDate).toBeNull();
    // ② 只有作废记录 ⇒ 不说"最近 N 天无差异"（那会假装有证据），要说"无有效记录"
    const onlyVoid = summarizeShadowHistory([rec("2026-11-09", 3), rec("2026-11-13", 2)]);
    expect(onlyVoid.days).toBe(0);
    expect(onlyVoid.voidedDays).toBe(2);
    expect(onlyVoid.tone).toBe("muted");
    expect(onlyVoid.text).toContain("无有效记录");
    expect(onlyVoid.text).toContain("作废");
    expect(onlyVoid.text).not.toContain("无差异");
    // ③ 边界：11-14 当天**算有效**（修法 A 落地当天），11-13 不算
    expect(summarizeShadowHistory([rec("2026-11-13")]).days).toBe(0);
    expect(summarizeShadowHistory([rec("2026-11-14")]).days).toBe(1);
  });

  it("复制摘要脱敏：日期/计数，无 page id/正文", () => {
    const s = summarizeShadowHistory([rec("2026-11-20", 1)]);
    const text = shadowHistoryCopyText(s);
    expect(text).toContain("[crdt-shadow] 影子观测");
    expect(text).toContain("2026-11-20");
    expect(text).not.toContain("differPageIds");
    expect(text).not.toContain("content");
    expect(dayRecordFromSummary(rows({ total: 1 }), at(2026, 11, 9)).date).toBe("2026-11-09");
  });
});
