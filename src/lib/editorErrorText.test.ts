// 判据：编辑器报错的 toast 必须是**一句话**（owner 连发三次那张截图里的 toast 被自己截断了 ✗）。
import { describe, expect, it } from "vitest";
import { shortEditorError } from "./editorErrorText";

const REAL =
  "Minified Lexical error #335; visit https://lexical.dev/docs/error?code=335&v=18972 for the full message or use the non-minified dev environment for full errors and additional helpful warnings.";

describe("编辑器报错的一句话版本", () => {
  it("★ 压缩编号 ⇒ 只留「Lexical #335 + 去哪看完整」，长度可控", () => {
    const s = shortEditorError(REAL);
    expect(s).toContain("#335");
    expect(s).toContain("控制台");
    expect(s.length).toBeLessThan(80);
    expect(s).not.toContain("lexical.dev"); // 长 URL 不该占满 toast ✓（完整消息在控制台里 ✓）
  });

  it("从 `code=` 形态也能认出编号（两种写法都认 ✓）", () => {
    expect(shortEditorError("visit https://lexical.dev/docs/error?code=335&v=1 for the full message")).toContain("#335");
    expect(shortEditorError("Minified Lexical error #12")).toContain("#12");
  });

  it("别的错误 ⇒ 压平空白、按上限截断，并指明完整版在哪", () => {
    const long = "a".repeat(300) + "\n\n  b";
    const s = shortEditorError(long, 90);
    expect(s).toContain("完整报错见控制台");
    expect(s.length).toBeLessThan(120);
    expect(s).not.toContain("\n");
    expect(shortEditorError("短错误")).toBe("短错误");
  });

  it("空的 / 不是 Error ⇒ 也要说一句人话（⛔ 不留空 toast ✗）", () => {
    expect(shortEditorError("")).toContain("完整报错");
    expect(shortEditorError(new Error(""))).toContain("完整报错");
    expect(shortEditorError(null)).toContain("完整报错");
  });
});
