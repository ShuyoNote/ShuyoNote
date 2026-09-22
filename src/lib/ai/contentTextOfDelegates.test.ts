// 「派生**合一**」这件事本身的判据 —— 补在 `contentText.test.ts` 之外（AMD 侧）。
//
// 为什么还要一条：`contentText.test.ts` 的 11 条只钉 `deriveContentText` **自己**对不对；
// 而 2026-09-18 那次修复的**动作**是「`contentTextOf` 改为**委托**唯一实现」——
// 这一步原先**没有判据守着**：AMD 把它退回合一之前的实现
// （walk JSON + **空格**连接、外面套 try/catch 以免撞上"不抛"那几条），
// **全量 1127 条仍然全绿**。也就是说：调用方那条路径被改回去，那天查出来的漂移会**静默回来**。
//
// ⚠️ 2026-09-18 晚：`contentTextOf` 已从 `ai/lexical.ts` **搬到 `ai/lexicalContent.ts`**
// （因为纯 JSON 层不许 import 编辑器节点表 —— 见 `lexicalLayering.test.ts` 里那条事故记录）。
// 所以本文件 import 的是 `./lexicalContent`。
import { describe, expect, it } from "vitest";

import { deriveContentText } from "../contentText";
import { contentTextOf } from "./lexicalContent";

const text = (t: string) => ({ detail: 0, format: 0, mode: "normal", style: "", text: t, type: "text", version: 1 });
const doc = (children: unknown[]) =>
  JSON.stringify({ root: { children, direction: "ltr", format: "", indent: 0, type: "root", version: 1 } });
const para = (t: string) => ({ children: [text(t)], direction: "ltr", format: "", indent: 0, type: "paragraph", version: 1 });

/** 合一**之前** AI/PDF 路径的口径（walk + 空格连接）——只用来当"必须不等于它"的反例。 */
function legacySpaceJoin(json: string): string {
  const parsed = JSON.parse(json) as { root?: { children?: unknown[] } };
  const out: string[] = [];
  const walk = (n: unknown) => {
    if (!n || typeof n !== "object") return;
    const node = n as { text?: unknown; children?: unknown[] };
    if (typeof node.text === "string") out.push(node.text);
    if (Array.isArray(node.children)) node.children.forEach(walk);
  };
  (parsed.root?.children ?? []).forEach(walk);
  return out.join(" ");
}

describe("contentTextOf 必须**委托**唯一实现（合一不许被静默退回）", () => {
  const cases: Array<[string, string]> = [
    ["单段落", doc([para("一段话")])],
    ["★ 多段落（旧口径在这里与编辑器不同）", doc([para("第一段"), para("第二段")])],
    ["★ 标题+引用", doc([
      { children: [text("一级标题")], direction: "ltr", format: "", indent: 0, tag: "h1", type: "heading", version: 1 },
      { children: [text("引用一行")], direction: "ltr", format: "", indent: 0, type: "quote", version: 1 },
    ])],
    ["★ 嵌套列表", doc([
      {
        children: [
          { children: [text("第一项")], direction: "ltr", format: "", indent: 0, type: "listitem", value: 1, version: 1 },
          {
            children: [{ children: [text("子项")], direction: "ltr", format: "", indent: 0, type: "listitem", value: 1, version: 1 }],
            direction: "ltr",
            format: "",
            indent: 0,
            listType: "bullet",
            start: 1,
            tag: "ul",
            type: "list",
            version: 1,
          },
        ],
        direction: "ltr",
        format: "",
        indent: 0,
        listType: "bullet",
        start: 1,
        tag: "ul",
        type: "list",
        version: 1,
      },
    ])],
    ["空页面", doc([para("")])],
  ];

  for (const [name, json] of cases) {
    it(`${name}：contentTextOf 与 deriveContentText 逐字相同`, () => {
      expect(contentTextOf(json)).toBe(deriveContentText(json));
    });
  }

  it("★ 多块样本：结果必须是**块分隔**，不是旧口径的空格拼接", () => {
    const json = doc([para("甲"), para("乙")]);
    const viaCallSite = contentTextOf(json);
    expect(viaCallSite).toBe(deriveContentText(json));
    expect(viaCallSite).not.toBe(legacySpaceJoin(json)); // "甲 乙" 那种
    expect(viaCallSite).toContain("\n"); // 块之间是换行（Lexical 的语义）
  });

  it("脏输入：两条入口都不抛（contentTextOf 坐在保存路径上）", () => {
    for (const bad of ["", "{ 这不是 JSON", '{"root":{"children":"nope"}}']) {
      expect(typeof contentTextOf(bad)).toBe("string");
      expect(typeof deriveContentText(bad)).toBe("string");
    }
  });
});
