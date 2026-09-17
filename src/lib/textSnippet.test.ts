// 截断的唯一口径：**不许把代理对切成孤立的一半**（那会变成用户可见的乱码方块）。
import { describe, expect, it } from "vitest";

import { truncateByCodePoints } from "./textSnippet";

describe("truncateByCodePoints", () => {
  it("emoji（代理对）不会被切成孤立的一半", () => {
    const out = truncateByCodePoints("a😀bcdef", 3);
    // 断言"没有孤立代理"：任何位置都不能是没配对的 D800-DBFF
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false);
    expect(/[\uDC00-\uDFFF]/.test(out.slice(0, 1))).toBe(false);
    expect(out).toBe("a😀b…");
  });

  it("没超长就**不加**省略号（调用方据此判断完整与否）", () => {
    expect(truncateByCodePoints("短", 10)).toBe("短");
    expect(truncateByCodePoints("正好十个字十个字", 8)).toBe("正好十个字十个字");
  });

  it("边界：0 / 负数 / 空串都不抛", () => {
    expect(truncateByCodePoints("abc", 0)).toBe("");
    expect(truncateByCodePoints("abc", -5)).toBe("");
    expect(truncateByCodePoints("", 5)).toBe("");
  });
});
