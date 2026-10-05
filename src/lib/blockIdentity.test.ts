// 块身份这一层的判据（纯函数，本机全量可跑）。
//
// 这一层最容易出的错不是"崩"，而是**悄悄改了别人的数据**：多补一个 ID、把不该动的类型换掉、
// 或者把"模型形态"漏到落盘/同步的 JSON 上（旧版本客户端会因此**丢段落**）。
// ⇒ 下面每一条都在钉这些具体后果，而不是钉"函数能跑"。

import { describe, expect, it } from "vitest";

import {
  MODEL_TYPE_BY_LEGACY,
  toLegacyDoc,
  toModelDoc,
  readBlockId,
  topLevelBlockIds,
} from "./blockIdentity";

/** 依次发号的造 ID（测试里要确定化，不能随机）。 */
function makeIdFactory(prefix = "blk") {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

const para = (text: string, blockId?: string) => ({
  ...(blockId === undefined ? {} : { blockId }),
  children: [{ detail: 0, format: 0, mode: "normal", style: "", text, type: "text", version: 1 }],
  direction: "ltr",
  format: "",
  indent: 0,
  type: "paragraph",
  version: 1,
});

const doc = (children: unknown[]) => JSON.stringify({
  root: { children, direction: "ltr", format: "", indent: 0, type: "root", version: 1 },
});

describe("toModelDoc：落盘形态 → 内存模型", () => {
  it("把段落换成模型 type，并给没有 ID 的顶层块补种", () => {
    const legacy = doc([para("第一段", "keep-me"), para("第二段")]);
    const model = JSON.parse(toModelDoc(legacy, makeIdFactory()));
    expect(model.root.children[0].type).toBe("shuyo-paragraph");
    expect(model.root.children[0].blockId).toBe("keep-me"); // 已有的**不许换**
    expect(model.root.children[1].blockId).toBe("blk-1"); // 缺的补种
  });

  it("补种是**幂等**的：同一份文档转两次，ID 不会变（第二次一个都不发号）", () => {
    const makeId = makeIdFactory();
    const once = toModelDoc(doc([para("一"), para("二")]), makeId);
    const twice = toModelDoc(once, makeId);
    expect(twice).toBe(once);
    expect(topLevelBlockIds(twice)).toEqual(["blk-1", "blk-2"]); // 没有 blk-3
  });

  it("**嵌套**段落也换 type，但**不**给它补 ID（今天只有顶层块有块身份）", () => {
    const nested = doc([
      {
        children: [
          {
            children: [para("列表项里的段落")],
            direction: "ltr", format: "", indent: 0, type: "listitem", version: 1,
          },
        ],
        direction: "ltr", format: "", indent: 0, listType: "bullet", start: 1, tag: "ul", type: "list", version: 1,
      },
    ]);
    const model = JSON.parse(toModelDoc(nested, makeIdFactory()));
    const inner = model.root.children[0].children[0].children[0];
    expect(inner.type).toBe("shuyo-paragraph");
    expect(inner.blockId).toBeUndefined(); // 嵌套块**没有**被塞身份
    expect(model.root.children[0].blockId).toBe("blk-1"); // 顶层 list 被补种
  });

  it("★ **只有顶层块补 ID**：嵌套段落（表格单元格里的）类型换了、但**不给身份**", () => {
    // 这一条是**第二层**判据（AMD 在 `reply-1` 里建议的）：第一层在 `blockIdTransform.test.ts`
    // 用真编辑器验变换；这一条纯函数级再钉一次同样的承诺 —— 万一哪天有人重命名/删掉那条用例，
    // "嵌套块不许有身份"这条仍然有人守（它是**落盘形态不漂移**的前提）。
    const nested = JSON.stringify({
      root: {
        children: [
          {
            children: [
              {
                children: [
                  { children: [], direction: "ltr", format: "", indent: 0, type: "paragraph", version: 1 },
                ],
                colSpan: 1, headerState: 0, rowSpan: 1, type: "tablecell", version: 1, width: 1,
              },
            ],
            type: "tablerow", version: 1,
          },
        ],
        direction: "ltr", format: "", indent: 0, type: "table", version: 1,
      },
    });
    const model = JSON.parse(toModelDoc(nested, makeIdFactory()));
    const cellPara = model.root.children[0].children[0].children[0];
    expect(cellPara.type).toBe("shuyo-paragraph"); // 类型照换（模型里统一）
    expect(cellPara.blockId).toBeUndefined(); // 但**不**补身份
    expect(model.root.children[0].blockId).toBe("blk-1"); // 顶层 table 才补
  });

  it("只走 `children`：非节点数组（如 ImageRow 的 items）一个字都不动", () => {    const items = JSON.stringify({
      root: {
        children: [{
          children: [],
          items: [{ src: "a.png", type: "paragraph" /* 假装是数据里的同名字段 */ }],
          type: "imageRow", version: 1,
        }],
        type: "root", version: 1,
      },
    });
    const model = JSON.parse(toModelDoc(items, makeIdFactory()));
    expect(model.root.children[0].items[0].type).toBe("paragraph"); // 数据数组没被当节点改写
  });

  it("解析不了 / 没有 root ⇒ **原样返回**（这层在加载路径上，不能把页面打开变成崩）", () => {
    const makeId = makeIdFactory();
    expect(toModelDoc("", makeId)).toBe("");
    expect(toModelDoc("{ 不是 JSON", makeId)).toBe("{ 不是 JSON");
    expect(toModelDoc("{}", makeId)).toBe("{}");
    expect(toModelDoc('{"root":[]}', makeId)).toBe('{"root":[]}');
  });

  it("`{}`（应用里正文 JSON 的默认值）不变形 —— 空页的归一另有其人（`lexicalStateValid`）", () => {
    expect(toModelDoc("{}", makeIdFactory())).toBe("{}");
  });
});

// ⭐ 2026-10-05：` ```mermaid ` 的**内容迁移**（owner 报"图形还是看不到"之后补的一层）。
// 为什么必须在这一层：页面**加载**走 `setEditorState(parseEditorState(toModelDoc(...)))`，
// 而节点变换只在"节点被创建/更新"时跑 —— 页面打开时那些 `code` 节点早已建好 ⇒ 变换看不到它们。
// 实测：那页在库里一直是 `code:16 / mermaid:0`，装了带变换的版本、重开 App 之后**还是没变**。
describe("mermaid：语言=mermaid 的代码块 → 图（加载时迁移）", () => {
  /** 按**库里真实的形状**造代码块：`code` → `code-highlight` → `text`（实测那页 code-highlight 有 139 个）。 */
  const codeBlock = (language: string, text: string, blockId?: string) => ({
    ...(blockId === undefined ? {} : { blockId }),
    children: [
      {
        children: [{ detail: 0, format: 0, mode: "normal", style: "", text, type: "text", version: 1 }],
        direction: "ltr",
        format: 0,
        indent: 0,
        type: "code-highlight",
        version: 1,
      },
    ],
    direction: "ltr",
    format: "",
    indent: 0,
    language,
    type: "code",
    version: 1,
  });

  it("★ 语言=mermaid 的代码块 ⇒ `mermaid` 节点：正文拼全、没有 children、顶层块仍拿到 blockId", () => {
    const legacy = doc([codeBlock("mermaid", "flowchart LR\n  A-->B")]);
    const node = JSON.parse(toModelDoc(legacy, makeIdFactory())).root.children[0];
    expect(node.type).toBe("mermaid");
    expect(node.src).toBe("flowchart LR\n  A-->B"); // code-highlight 那一层要递归拼出来
    expect(node.syntax).toBe("flowchart");
    expect(node.children).toBeUndefined(); // 装饰节点没有子节点
    expect(node.language).toBeUndefined();
    expect(node.blockId).toBe("blk-1"); // 迁移后仍是顶层块 ⇒ 照旧补种
  });

  it("★ 对照：语言=python 的代码块**照样**走模型代码块（不许被这条抢走）", () => {
    const legacy = doc([codeBlock("python", "print(1)")]);
    const node = JSON.parse(toModelDoc(legacy, makeIdFactory())).root.children[0];
    expect(node.type).toBe("shuyo-code");
    expect(node.language).toBe("python");
  });

  it("★ 幂等：已经是 `mermaid` 的节点再转一次**一个字节都不变**", () => {
    const makeId = makeIdFactory();
    const once = toModelDoc(doc([codeBlock("mermaid", "graph TD\n A-->B")]), makeId);
    const twice = toModelDoc(once, makeId);
    expect(twice).toBe(once);
  });

  it("★ 大小写不敏感（`Mermaid` 也认）—— 语言字段来自各种导出工具，不能只认小写", () => {
    const node = JSON.parse(toModelDoc(doc([codeBlock("Mermaid", "graph TD\n A-->B")]), makeIdFactory()))
      .root.children[0];
    expect(node.type).toBe("mermaid");
  });
});

describe("toLegacyDoc：内存模型 → 落盘/同步形态", () => {
  it("模型 type 换回老 type；块 ID 保留（今天的落盘形态本来就带它）", () => {
    const model = doc([
      { blockId: "blk-1", children: [], direction: "ltr", format: "", indent: 0, type: "shuyo-paragraph", version: 1 },
    ]);
    const legacy = JSON.parse(toLegacyDoc(model));
    expect(legacy.root.children[0].type).toBe("paragraph");
    expect(legacy.root.children[0].blockId).toBe("blk-1");
  });

  it("⚠️ 产物里**不许**出现任何模型 type（旧版本客户端会丢掉未注册类型 ⇒ 段落全丢）", () => {
    const model = JSON.stringify({
      root: {
        children: [
          { blockId: "a", children: [para("嵌套")], type: "shuyo-paragraph" },
          { blockId: "b", children: [{ children: [para("再嵌套")], type: "listitem" }], type: "list" },
        ],
        type: "root",
      },
    });
    const legacy = toLegacyDoc(model);
    for (const modelType of Object.values(MODEL_TYPE_BY_LEGACY)) {
      expect(legacy.includes(`"${modelType}"`)).toBe(false);
    }
  });

  it("两形态互转**可逆**：今天的形态 → 模型 → 落盘，与今天的形态逐字节一致", () => {
    const legacy = doc([para("一", "blk-1"), para("二", "blk-2")]);
    expect(toLegacyDoc(toModelDoc(legacy, makeIdFactory()))).toBe(legacy);
  });

  it("非段落的类型原样穿过（这一步只认模型 type）", () => {
    const mixed = doc([
      { blockId: "h", children: [], direction: "ltr", format: "", indent: 0, tag: "h1", type: "heading", version: 1 },
      { blockId: "c", children: [], direction: "ltr", format: "", indent: 0, type: "callout", version: 1 },
    ]);
    expect(toLegacyDoc(toModelDoc(mixed, makeIdFactory()))).toBe(mixed);
  });
});

describe("读块 ID 的小工具", () => {
  it("readBlockId：非对象/缺字段/非字符串一律给空串（不抛）", () => {
    expect(readBlockId(null)).toBe("");
    expect(readBlockId("x")).toBe("");
    expect(readBlockId({})).toBe("");
    expect(readBlockId({ blockId: 42 })).toBe("");
    expect(readBlockId({ blockId: "ok" })).toBe("ok");
  });

  it("topLevelBlockIds：只看顶层、按顺序、空位用空串占位", () => {
    expect(topLevelBlockIds(doc([para("一", "a"), para("二"), { type: "heading", blockId: "c", children: [] }])))
      .toEqual(["a", "", "c"]);
    expect(topLevelBlockIds("{}")).toEqual([]);
    expect(topLevelBlockIds("不是 JSON")).toEqual([]);
  });
});
