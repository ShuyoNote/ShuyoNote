// 命令参数表单 → 命令参数的转换规则。
//
// 这是作者声明的 schema 与用户填的值之间唯一的转换点，所以规则要钉死：
// 「必填留空」必须报错而不是传空串，「非必填留空」必须**不传这个键**（否则插件的
// 默认值永远不生效），布尔必须传布尔值。这三条错了都不会崩，只会悄悄行为不对。
import { describe, expect, it } from "vitest";
import type { PluginCommandParam } from "../types";
import { buildCommandArgs, initialParamValues } from "./pluginParams";

const P = (over: Partial<PluginCommandParam> & { name: string }): PluginCommandParam => ({
  label: "",
  type: "string",
  required: false,
  placeholder: "",
  options: [],
  ...over,
});

describe("buildCommandArgs", () => {
  it("必填留空 → 报错（不是悄悄传空串）", () => {
    const r = buildCommandArgs([P({ name: "title", label: "标题", required: true })], { title: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("标题");
  });

  it("非必填留空 → 不传这个键（让插件的默认值生效）", () => {
    const r = buildCommandArgs([P({ name: "note" })], { note: "" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(JSON.parse(r.json)).toEqual({});
  });

  it("必填填了 → 原样传下去", () => {
    const r = buildCommandArgs([P({ name: "title", required: true })], { title: "你好" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(JSON.parse(r.json)).toEqual({ title: "你好" });
  });

  it("number：数字字符串转成数字，非数字报错", () => {
    const ok = buildCommandArgs([P({ name: "n", type: "number" })], { n: "42" });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(JSON.parse(ok.json)).toEqual({ n: 42 });

    const bad = buildCommandArgs([P({ name: "n", type: "number", label: "条数" })], { n: "abc" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("条数");
  });

  it("number 的 0 是有效值，不能被当成「没填」", () => {
    const r = buildCommandArgs([P({ name: "n", type: "number", required: true })], { n: "0" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(JSON.parse(r.json)).toEqual({ n: 0 });
  });

  it("boolean：没勾也要传 false（不是省略）", () => {
    const r = buildCommandArgs([P({ name: "loud", type: "boolean" })], {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(JSON.parse(r.json)).toEqual({ loud: false });
  });

  it("select：传选项的 value", () => {
    const r = buildCommandArgs(
      [P({ name: "mode", type: "select", options: [{ value: "b", label: "乙" }] })],
      { mode: "b" },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(JSON.parse(r.json)).toEqual({ mode: "b" });
  });

  it("多个参数：混着填也能得到干净的对象", () => {
    const r = buildCommandArgs(
      [
        P({ name: "title", required: true }),
        P({ name: "count", type: "number" }),
        P({ name: "loud", type: "boolean" }),
        P({ name: "skip" }),
      ],
      { title: "T", count: "3", loud: true, skip: "" },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(JSON.parse(r.json)).toEqual({ title: "T", count: 3, loud: true });
  });
});

describe("initialParamValues", () => {
  it("有默认值就预填，布尔默认 false，其余留空", () => {
    const init = initialParamValues([
      P({ name: "title", default: "默认标题" }),
      P({ name: "count", type: "number", default: 5 }),
      P({ name: "loud", type: "boolean", default: true }),
      P({ name: "other" }),
      P({ name: "off", type: "boolean" }),
    ]);
    expect(init).toEqual({ title: "默认标题", count: "5", loud: true, other: "", off: false });
  });
});
