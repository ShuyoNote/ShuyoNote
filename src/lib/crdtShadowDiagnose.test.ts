import { describe, expect, it } from "vitest";
import {
  diagnoseCopyText,
  diagnoseDetailLines,
  diagnoseErrorText,
  diagnoseFootnote,
  diagnoseHeadline,
  diagnoseTone,
} from "./crdtShadowDiagnose";
import type { ShadowRowsResult } from "./crdtShadow";

const rows = (patch: Partial<ShadowRowsResult>): ShadowRowsResult => ({
  total: 0,
  withState: 0,
  equal: 0,
  differ: 0,
  uncomparable: 0,
  differPageIds: [],
  ...patch,
});

describe("crdtShadowDiagnose：体检文案矩阵", () => {
  it("空空间 ⇒ 明说没有页（不是「全部一致」）", () => {
    const s = rows({});
    expect(diagnoseHeadline(s)).toContain("还没有页");
    expect(diagnoseTone(s)).toBe("muted");
    expect(diagnoseFootnote(s)).toContain("不自动修复");
  });

  it("全部一致 ⇒ ok；明细只有计数", () => {
    const s = rows({ total: 3, withState: 3, equal: 3 });
    expect(diagnoseHeadline(s)).toContain("全部一致");
    expect(diagnoseTone(s)).toBe("ok");
    expect(diagnoseDetailLines(s)).toEqual([
      "总页数：3",
      "有 CRDT 状态：3",
      "一致：3",
      "不一致：0",
      "不可比：0",
    ]);
  });

  it("有差异 ⇒ warn ＋ 明说「不自动修复」；差异页 id 不进any文案", () => {
    const s = rows({
      total: 4,
      withState: 4,
      equal: 3,
      differ: 1,
      differPageIds: ["p-internal-id-1"],
    });
    expect(diagnoseHeadline(s)).toContain("不一致");
    expect(diagnoseTone(s)).toBe("warn");
    expect(diagnoseFootnote(s)).toContain("不自动修复");
    // 脱敏：page id（内部标识）不许进文案或复制摘要（文案里"正文"只是口径说明，不是内容）。
    const all = [diagnoseHeadline(s), ...diagnoseDetailLines(s), diagnoseFootnote(s), diagnoseCopyText(s)].join("\n");
    expect(all).not.toContain("p-internal-id-1");
    expect(all).not.toContain("这段是页面正文内容");
  });

  it("全部不可比 ⇒ 说清两种常见原因；混合 ⇒ 部分可比", () => {
    const bad = rows({ total: 2, uncomparable: 2 });
    expect(diagnoseHeadline(bad)).toContain("无法比较");
    expect(diagnoseHeadline(bad)).toContain("CRDT 状态");
    expect(diagnoseTone(bad)).toBe("warn");
    const mixed = rows({ total: 3, withState: 2, equal: 1, uncomparable: 2 });
    expect(diagnoseHeadline(mixed)).toContain("部分可比");
  });

  it("复制摘要可读且脱敏；错误文案不吞原因", () => {
    const s = rows({ total: 2, withState: 2, equal: 2 });
    const copy = diagnoseCopyText(s);
    expect(copy).toContain("[crdt-shadow] 体检结果（只读）");
    expect(copy).toContain("一致：2");
    expect(diagnoseErrorText(new Error("扫描炸了"))).toBe(
      "体检没跑成：扫描炸了（不影响同步，也没有改任何数据）",
    );
    expect(diagnoseErrorText("字符串错误")).toContain("字符串错误");
  });
});
