// 抽取器注册与分派单测 —— 契约见 docs/plans/2026-09-17-knowledge-base-ai-coverage-plan.md §15.4。

import { describe, expect, it } from "vitest";

import { extensionOf, normalizeMime, pickExtractor } from "./registry";
import type { Extractor } from "./types";

/** 造一个只用于分派测试的假抽取器（不实现 extract）。 */
function fake(id: string, mimes: string[], extensions: string[]): Extractor {
  return {
    id,
    mimes,
    extensions,
    cost: "cpu",
    extract: async () => ({ ok: true, extractor: id, segments: [] }),
  };
}

const A = fake("a", ["application/x-a"], [".a"]);
const B = fake("b", ["application/x-b"], [".b"]);
const WILD = fake("img", ["image/*"], [".png"]);
const REG = [A, B, WILD];

describe("normalizeMime", () => {
  it("去参数、去空白、转小写", () => {
    expect(normalizeMime("Text/Plain; charset=utf-8")).toBe("text/plain");
    expect(normalizeMime("  APPLICATION/PDF  ")).toBe("application/pdf");
  });
  it("空值与 undefined 归一成空串（不抛）", () => {
    expect(normalizeMime("")).toBe("");
    expect(normalizeMime(undefined as unknown as string)).toBe("");
  });
});

describe("extensionOf", () => {
  it("取小写扩展名，兼容路径分隔符", () => {
    expect(extensionOf("报告.DOCX")).toBe(".docx");
    expect(extensionOf("C:\\a\\b\\x.PDF")).toBe(".pdf");
    expect(extensionOf("/tmp/a/b.xlsx")).toBe(".xlsx");
  });
  it("无扩展名 / 隐藏文件 / 末尾点 都不算扩展名", () => {
    expect(extensionOf("README")).toBe("");
    expect(extensionOf(".gitignore")).toBe("");
    expect(extensionOf("trailing.")).toBe("");
  });
});

describe("pickExtractor", () => {
  it("按 mime 命中", () => {
    expect(pickExtractor("application/x-b", "whatever", REG)?.id).toBe("b");
  });

  it("mime 带参数也能命中", () => {
    expect(pickExtractor("application/x-a; charset=utf-8", "x", REG)?.id).toBe("a");
  });

  it("mime 不认时回落到扩展名", () => {
    expect(pickExtractor("", "x.B", REG)?.id).toBe("b");
    expect(pickExtractor("application/octet-stream", "x.a", REG)?.id).toBe("a");
  });

  it("**mime 优先于扩展名**：扩展名指向 A 但 mime 指向 B 时，选 B", () => {
    // 这是刻意的：文件被改名过时，mime 比扩展名可信。
    expect(pickExtractor("application/x-b", "x.a", REG)?.id).toBe("b");
  });

  it("支持 `类型/*` 前缀通配", () => {
    expect(pickExtractor("image/png", "x", REG)?.id).toBe("img");
    expect(pickExtractor("image/jpeg", "x.bin", REG)?.id).toBe("img");
  });

  it("都不认则返回 null（调度器记 unsupported）", () => {
    expect(pickExtractor("application/x-c", "x.c", REG)).toBeNull();
    expect(pickExtractor("", "", REG)).toBeNull();
  });

  it("同名冲突先到先得，由注册表顺序决定", () => {
    const first = fake("first", ["application/x-a"], [".z"]);
    const second = fake("second", ["application/x-a"], [".z"]);
    expect(pickExtractor("application/x-a", "f.z", [first, second])?.id).toBe("first");
    expect(pickExtractor("application/x-a", "f.z", [second, first])?.id).toBe("second");
  });

  it("空注册表返回 null", () => {
    expect(pickExtractor("application/x-a", "x.a", [])).toBeNull();
  });
});
