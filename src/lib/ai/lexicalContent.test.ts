// 「AI / PDF 路径的正文派生」与「编辑器语义」的**配对判据**。
//
// 为什么需要这条（一次真实事故 + 一次真实取舍）：
//   · 事故：`contentTextOf` 原先住 `lib/ai/lexical.ts`（纯逻辑模块），而它为了与编辑器
//     统一语义要 import `lib/contentText`（那层要 `editor/config` 的节点表）⇒ 整个编辑器
//     节点图被拖进每一条 import `ai/lexical` 的打包路径（`smoke-web` 门禁红，见该文件注释）。
//   · 取舍：`pageJsonFromText` 因此改成**按构造成本**算 `content_text`（`docLines().join("\n\n")`），
//     不再回头调 `deriveContentText`。这是"两条算法"，**必须**有判据钉住它们不许漂 ——
//     否则就是这次冲刺要消灭的那种病（同一份内容、谁最后保存决定正文文本长什么样）。
//
// ⇒ 下面这条判据是**配对**的：一边是"按构造成本算"，另一边是"编辑器语义真派一遍"，
//   逐字比。分隔符不写死（交给 Lexical 定），漂了就红。

import { describe, expect, it } from "vitest";

import { deriveContentText } from "../contentText";
import { appendBlocksToJson, pageJsonFromText } from "./lexical";
import { contentTextOf } from "./lexicalContent";

const makeId = () => {
  let i = 0;
  return () => `blk-${++i}`;
};

describe("★ 配对：`pageJsonFromText` 按构造成本算的正文 == 编辑器语义派生同一份 JSON", () => {
  it.each([
    ["单行", "你好"],
    ["两行", "a\nb"],
    ["空行与两侧空格", "  a \n\n  b  "],
    ["markdown 行（原样保留，清理由 cleanDraftText 负责）", "**粗**\n---\n正文"],
    ["全空白", "   \n "],
    ["空串", ""],
  ])("%s", (_name, text) => {
    const { content_json, content_text } = pageJsonFromText(text, makeId());
    expect(content_text).toBe(deriveContentText(content_json));
  });

  it("两行**不是**空格拼接（老算法就是那样漂掉的）", () => {
    const { content_text } = pageJsonFromText("a\nb", makeId());
    expect(content_text).not.toBe("a b");
  });
});

describe("`contentTextOf`：与唯一实现逐字相同（它就是一层薄委托）", () => {
  it.each([
    ["普通页面", '{"root":{"children":[{"type":"paragraph","version":1,"children":[{"type":"text","text":"甲","version":1}]}],"type":"root","version":1}}'],
    ["空 root", '{"root":{"children":[],"type":"root","version":1}}'],
    ["脏输入不抛", "{ 这不是 JSON"],
  ])("%s", (_name, json) => {
    expect(contentTextOf(json)).toBe(deriveContentText(json));
  });

  it("★ 追加块之后派生出来的文本，块之间是分隔符而不是空格", () => {
    const base = '{"root":{"children":[{"type":"paragraph","version":1,"children":[{"type":"text","text":"hi","version":1}]}],"type":"root","version":1}}';
    const next = appendBlocksToJson(base, "a\nb", makeId());
    const out = contentTextOf(next);
    expect(out).toBe(deriveContentText(next));
    expect(out).not.toBe("hi a b");
  });
});
