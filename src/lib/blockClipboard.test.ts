import { describe, expect, it } from "vitest";
import { blocksToPlainText } from "./blockClipboard";

// 2026-10-31：「块多选·复制」要真的写进剪贴板（以前只 duplicate，粘到 VS Code 是空的）。
describe("blocksToPlainText（块多选复制 → 纯文本）", () => {
  it("① 多块按空行外的顺序拼接", () => {
    expect(blocksToPlainText(["第一段", "第二段"])).toBe("第一段\n第二段");
  });

  it("② 去掉首尾空白与多余空行，但不吞段内换行", () => {
    expect(blocksToPlainText(["  甲\n\n\n乙  ", " 丙 "])).toBe("甲\n\n乙\n丙");
  });

  it("③ 空块/空白块被跳过（不产生空行）", () => {
    expect(blocksToPlainText(["甲", "", "   ", "乙"])).toBe("甲\n乙");
  });

  it("④ CRLF 归一化（粘到别的应用不要带 \\r）", () => {
    expect(blocksToPlainText(["甲\r\n乙"])).toBe("甲\n乙");
  });

  it("⑤ 全是空块 ⇒ 空串（调用方据此报「没有可复制的文字」）", () => {
    expect(blocksToPlainText(["", "  "])).toBe("");
  });
});
