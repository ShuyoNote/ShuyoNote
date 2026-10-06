import { describe, expect, it } from "vitest";
import { extractToolCalls, parseToolArgs, pickModel } from "./llm";

// ⭐ 2026-10-06（owner 截图：「改了缺不持久化？」＋ 界面填的模型不在可用列表里 ✗）：
//    探测到的可用列表**才说了算** ✓ —— 当前值在列表里就一个字都不动 ✓（⛔ 不擅自改用户填的 ✗），
//    不在就换成第一项 ✓，探测不到（空列表）⇒ 原样保留 ✓（"不知道"不等于"你填错了" ✗）。
describe("pickModel（从探测到的可用列表里挑一个能用的）", () => {
  const live = ["deepseek-flash", "deepseek-v4-pro"];

  it("当前值在列表里 ⇒ 原样保留（只把首尾空白抹掉 ✓，大小写不敏感 ✓）", () => {
    expect(pickModel("deepseek-flash", live)).toBe("deepseek-flash");
    // 保留的是**用户填的大小写** ✓，只是把首尾空白去掉（不然存进配置的就是带空格的名字 ✗）
    expect(pickModel("  DeepSeek-Flash ", live)).toBe("DeepSeek-Flash");
  });

  it("★ 当前值**不在**列表里 ⇒ 换成第一项（owner 那次就是这样：名字填着、一发就失败）", () => {
    expect(pickModel("deepseek-v4-flash-vision-exp", live)).toBe("deepseek-flash");
  });

  it("空值 ⇒ 用第一项；列表为空 ⇒ 原样保留（探测不到 ≠ 你填错了）", () => {
    expect(pickModel("", live)).toBe("deepseek-flash");
    expect(pickModel("whatever", [])).toBe("whatever");
    expect(pickModel("whatever", undefined)).toBe("whatever");
  });
});

describe("parseToolArgs", () => {
  it("parses a JSON string", () => {
    expect(parseToolArgs('{"a":1,"b":"x"}')).toEqual({ a: 1, b: "x" });
  });

  it("returns {} for invalid JSON", () => {
    expect(parseToolArgs("not-json")).toEqual({});
  });

  it("passes through an object", () => {
    const obj = { k: "v" };
    expect(parseToolArgs(obj)).toBe(obj);
  });

  it("returns {} for primitives / null", () => {
    expect(parseToolArgs(null)).toEqual({});
    expect(parseToolArgs(42)).toEqual({});
    expect(parseToolArgs("not-json")).toEqual({});
  });
});

describe("extractToolCalls", () => {
  it("parses a <tool_calls> array", () => {
    const text = `<tool_calls>[{"name":"search_pages","arguments":{"q":"hi"}}]</tool_calls>`;
    expect(extractToolCalls(text)).toEqual([{ name: "search_pages", arguments: { q: "hi" } }]);
  });

  it("parses a ```json fenced block", () => {
    const text = "```json\n[{\"name\":\"read_page\",\"arguments\":{\"id\":\"p1\"}}]\n```";
    expect(extractToolCalls(text)).toEqual([{ name: "read_page", arguments: { id: "p1" } }]);
  });

  it("wraps a single object (non-array)", () => {
    const text = `<tool_calls>{"name":"create_page","arguments":{}}</tool_calls>`;
    expect(extractToolCalls(text)).toEqual([{ name: "create_page", arguments: {} }]);
  });

  it("accepts tool/args aliases and filters empty names", () => {
    const text = `<tool_calls>[{"tool":"a","args":{}},{"name":"","arguments":{}}]</tool_calls>`;
    expect(extractToolCalls(text)).toEqual([{ name: "a", arguments: {} }]);
  });

  it("returns [] for no fence / invalid JSON / empty input", () => {
    expect(extractToolCalls("plain text")).toEqual([]);
    expect(extractToolCalls("<tool_calls>not json</tool_calls>")).toEqual([]);
    expect(extractToolCalls("")).toEqual([]);
  });
});
