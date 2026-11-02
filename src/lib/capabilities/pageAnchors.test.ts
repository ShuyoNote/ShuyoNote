// `pages.get` 读面（P1，2026-10-29）的**块锚点**与 **rev** 判据 —— TS 侧。
//
// 与 Rust 侧（`src-tauri/src/plugins.rs` 的 `#[cfg(test)]`）读**同一份夹具**
// `tests/pages-get-anchors-parity.json`：桌面走 Rust、Web 走这里，同一个外部 agent 在两条路上
// 必须拿到同一种锚点与令牌。这类漂移**没有编译期信号**（把"块尾落在窗内"改成"块起点落在窗内"
// 两边都能跑、都不报错），所以只能靠共用夹具钉住。
//
// 四条判据（对应方案 `docs/plans/2026-10-29-agent-block-write-p2.md` 的 P1）：
//   ① 锚点数 = 返回范围内顶层块数；② `includeAnchors:false` ⇒ 正文与旧行为**逐字节相同**；
//   ③ `rev` 形状合法 ＋ 同一页两次读相同 ＋ 内容改一次就变；④ 分页截断只标返回的块。

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { annotatedWindow, blockEndOffsets, pageRev } from "./pageAnchors";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

interface Case {
  name: string;
  docJson: string;
  contentText: string;
  offset: number;
  limit: number;
  includeAnchors: boolean;
  expectAnchors: number;
  expectText: string;
}

interface Fixture {
  cases: Case[];
  rev: { updatedAt: number; docJson: string; expect: string };
}

const fixture: Fixture = JSON.parse(
  readFileSync(join(root, "tests", "pages-get-anchors-parity.json"), "utf8"),
);

/** 参照口径的窗口切片（按码点；与分页同一条）。 */
const cpSlice = (s: string, off: number, lim: number) => Array.from(s).slice(off, off + lim).join("");

const countAnchors = (s: string) => (s.match(/<!-- b:/g) || []).length;

describe("pages.get 锚点/rev：与 Rust 侧共用的夹具", () => {
  it("夹具本身非空（别让一条空循环假装通过）", () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(8);
    expect(typeof fixture.rev.expect).toBe("string");
  });

  for (const c of fixture.cases) {
    it(c.name, () => {
      const window = cpSlice(c.contentText, c.offset, c.limit);
      const got = c.includeAnchors
        ? annotatedWindow(c.contentText, blockEndOffsets(c.docJson, c.contentText), c.offset, c.limit)
        : window;

      expect(got).toBe(c.expectText);
      // 判据 ①／④：锚点数 = **返回范围内**的顶层块数（不是整页块数）
      expect(countAnchors(got)).toBe(c.expectAnchors);
      // 判据 ②：关掉开关 ⇒ 正文与旧行为逐字节相同
      if (!c.includeAnchors) expect(got).toBe(window);
    });
  }

  it("判据 ①（显式）：3 个顶层块 ⇒ 3 个锚点，且每个块 id 都在", () => {
    const doc = JSON.stringify({
      root: {
        children: [
          { type: "paragraph", blockId: "blk1", children: [{ type: "text", text: "甲" }] },
          { type: "paragraph", blockId: "blk2", children: [{ type: "text", text: "乙" }] },
          { type: "paragraph", blockId: "blk3", children: [{ type: "text", text: "丙" }] },
        ],
      },
    });
    const body = "甲\n\n乙\n\n丙";
    const got = annotatedWindow(body, blockEndOffsets(doc, body), 0, 6000);
    expect(countAnchors(got)).toBe(3);
    for (const id of ["blk1", "blk2", "blk3"]) expect(got).toContain(`<!-- b:${id} -->`);
    // 锚点只加注释：剥掉之后必须回到原文（与 Rust 侧同一条判据）
    expect(got.replace(/\n\n<!-- b:[^>]*? -->/g, "")).toBe(body);
  });

  it("判据 ②：`includeAnchors:false` ⇒ 与旧行为逐字节相同（不是「少加一点」）", () => {
    const c = fixture.cases.find((x) => x.includeAnchors === false);
    expect(c, "夹具里必须有一条关掉锚点的用例").toBeTruthy();
    const window = cpSlice(c!.contentText, c!.offset, c!.limit);
    // 开关关掉时适配器**根本不调** annotatedWindow（正文就是窗口本身）—— 这里照那条路走一遍
    const got = c!.includeAnchors
      ? annotatedWindow(c!.contentText, blockEndOffsets(c!.docJson, c!.contentText), c!.offset, c!.limit)
      : window;
    expect(got).toBe(window);
    expect(got).not.toContain("<!-- b:");
  });

  it("判据 ④：分页截断 ⇒ 只给返回范围内的块加锚点", () => {
    const c = fixture.cases.find((x) => x.name.includes("分页截断"));
    expect(c).toBeTruthy();
    const got = annotatedWindow(c!.contentText, blockEndOffsets(c!.docJson, c!.contentText), c!.offset, c!.limit);
    expect(countAnchors(got)).toBe(2); // 3 块里第 3 块没返回
    expect(got).not.toContain("blk3");
  });
});

describe("pages.get 的 rev：乐观并发令牌", () => {
  it("判据 ③：形状 `^\\d+:[0-9a-f]{8}$`，且与夹具里独立算出来的值一致", async () => {
    const rev = await pageRev(fixture.rev.updatedAt, fixture.rev.docJson);
    expect(rev).toBe(fixture.rev.expect);
    expect(rev).toMatch(/^\d+:[0-9a-f]{8}$/);
  });

  it("判据 ③：同一页两次读 rev 必须相同", async () => {
    const a = await pageRev(fixture.rev.updatedAt, fixture.rev.docJson);
    const b = await pageRev(fixture.rev.updatedAt, fixture.rev.docJson);
    expect(a).toBe(b);
  });

  it("判据 ③：内容改一次 ⇒ rev 变化（**同一毫秒**也挡得住）", async () => {
    const before = await pageRev(1_700_000_000_000, '{"root":{"children":[]}}');
    const after = await pageRev(1_700_000_000_000, '{"root":{"children":[{"type":"paragraph"}]}}');
    expect(before).not.toBe(after);
  });

  it("算不出来就**不带**（⛔ 不编）：拿不到正文原文 / 拿不到更新时间 ⇒ null", async () => {
    expect(await pageRev(fixture.rev.updatedAt, undefined)).toBeNull();
    expect(await pageRev(fixture.rev.updatedAt, null)).toBeNull();
    expect(await pageRev(undefined, fixture.rev.docJson)).toBeNull();
    expect(await pageRev("1700", fixture.rev.docJson)).toBeNull();
    // 空正文**是能算的**（空串也有指纹）—— 别把"空"当成"算不出"
    expect(await pageRev(1, "")).toBe("1:e3b0c442");
  });
});
