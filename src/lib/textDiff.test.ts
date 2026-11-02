// P2 判据：版本历史「与当前版本对比」的逐行 diff 纯函数。
import { describe, expect, it } from "vitest";

import { hasDiff, lineDiff } from "./textDiff";

const strip = (lines: readonly { kind: string; text: string }[]) =>
  lines.map((l) => `${l.kind}:${l.text}`);

describe("版本历史 diff（版本正文 → 当前正文）", () => {
  it("① 完全相同 ⇒ 全是 same，hasDiff=false", () => {
    const d = lineDiff("a\nb", "a\nb");
    expect(strip(d)).toEqual(["same:a", "same:b"]);
    expect(hasDiff(d)).toBe(false);
  });

  it("② 当前新增一行 ⇒ add；旧版本删掉一行 ⇒ del", () => {
    const d = lineDiff("a\nb", "a\nc\nb");
    expect(strip(d)).toEqual(["same:a", "add:c", "same:b"]);
    expect(hasDiff(d)).toBe(true);

    const d2 = lineDiff("a\nc\nb", "a\nb");
    expect(strip(d2)).toEqual(["same:a", "del:c", "same:b"]);
  });

  it("③ 替换一行 ⇒ del + add（不是把两行糊成一行）", () => {
    const d = lineDiff("a\nold\nb", "a\nnew\nb");
    expect(strip(d)).toEqual(["same:a", "del:old", "add:new", "same:b"]);
  });

  it("④ 空文本按 0 行处理：空 → 有内容只显示新增", () => {
    expect(strip(lineDiff("", "x\ny"))).toEqual(["add:x", "add:y"]);
    expect(strip(lineDiff("x", ""))).toEqual(["del:x"]);
  });
});
