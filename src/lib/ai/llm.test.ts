import { describe, expect, it } from "vitest";
import { extractToolCalls, parseToolArgs } from "./llm";

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
