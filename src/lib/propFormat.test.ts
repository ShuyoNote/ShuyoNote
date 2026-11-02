import { describe, expect, it } from "vitest";
import { displayMiddle, formatDateTime, formatPerson, formatUrl } from "./propFormat";

describe("B2 · propFormat 纯函数", () => {
  it("URL：无协议补 https；中段省略；复制保留原文", () => {
    expect(formatUrl("example.com/a/b")?.href).toBe("https://example.com/a/b");
    expect(formatUrl("https://example.com/a")?.display).toBe("https://example.com/a");
    const long = `https://example.com/${"x".repeat(80)}/end`;
    const f = formatUrl(long)!;
    expect(f.display).toContain("…");
    expect(f.display.length).toBeLessThanOrEqual(48);
    expect(f.copyText).toBe(long);
    expect(formatUrl("")).toBeNull();
    expect(formatUrl("   ")).toBeNull();
    expect(formatUrl(undefined)).toBeNull();
  });

  it("中段省略：短串原样，长串保头尾", () => {
    expect(displayMiddle("short")).toBe("short");
    const s = "a".repeat(60);
    const out = displayMiddle(s, 20);
    expect(out).toContain("…");
    expect(out.length).toBeLessThanOrEqual(20);
  });

  it("日期：到分钟 + 相对时间 + 时区（注入时钟，不靠真实时间）", () => {
    const now = new Date("2026-10-30T12:00:00+08:00").getTime();
    const f = formatDateTime("2026-10-30 11:30", now)!;
    expect(f.absolute).toBe("2026-10-30 11:30");
    expect(f.timezone).toBe("+08:00");
    expect(f.relative).toBe("30 分钟前");
    expect(formatDateTime("2026-10-30T12:00:00+08:00", now)?.relative).toBe("刚刚");
    expect(formatDateTime("2026-10-30 13:00", now)?.relative).toBe("1 小时后");
    expect(formatDateTime("not-a-date")).toBeNull();
    expect(formatDateTime("")).toBeNull();
  });

  it("作者：person chip 标签/首字", () => {
    expect(formatPerson("张三")).toEqual({ label: "张三", initial: "张" });
    expect(formatPerson("  ")).toBeNull();
    expect(formatPerson(3)).toBeNull();
  });
});
