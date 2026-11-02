// ⭐ 2026-10-15（owner：「添加一个直接导出 Markdown 文件的功能」）的判据。
//
// 这一组盯的是**接线**，不是转换本身：转换那一份（`pageContentToMarkdown`，含列块展开）
// 由别处的判据管；这里要钉死的是——
//   ① 取消 ⇒ **一个字节都不写**，而且**不报成功** ✗；
//   ② 存文件时：默认文件名**清洗过**、过滤器是 `md`；
//   ③ 写下去的内容 ＝ 那行头部注释 ＋ **共享转换器**的输出（⛔ 不是另写一份转换 ✗）；
//   ④ 标题缺失/空内容不许抛，也不许把 `undefined` 写进文件名或头部。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createEditor, $getRoot, $createParagraphNode, $createTextNode } from "lexical";
import { $createHeadingNode, $createQuoteNode, HeadingNode, QuoteNode } from "@lexical/rich-text";
import { $createListItemNode, $createListNode, ListItemNode, ListNode } from "@lexical/list";
import { CalloutNode, $createCalloutNode } from "../editor/nodes/CalloutNode";
import { MermaidNode, $createMermaidNode } from "../editor/nodes/MermaidNode";

const saveMock = vi.fn();
const writeMock = vi.fn();

// 只 mock 两个"会碰外部世界"的依赖：保存对话框与写文件。
vi.mock("./platform", () => ({
  platform: { dialog: { save: (...a: unknown[]) => saveMock(...a) } },
  isDesktopPlatform: () => true,
}));
vi.mock("./api", () => ({
  api: { writeTextFile: (...a: unknown[]) => writeMock(...a) },
}));

// ⚠️ import 必须在 vi.mock 之后（vitest 会提升 mock，但顺序写清楚更好读）
import { exportPageToMarkdown, pageContentToMarkdown } from "./exportMarkdown";

/** 造一份**真的**编辑器状态 JSON（用真节点，不用手搓形状——手搓的容易缺字段）。 */
function stateJson(build?: (root: ReturnType<typeof $getRoot>) => void): string {
  const editor = createEditor({
    namespace: "export-markdown-test",
    nodes: [HeadingNode, QuoteNode],
    onError: (e) => {
      throw e;
    },
  });
  editor.update(
    () => {
      // ⚠️ 新编辑器的 root 是**空的** ⇒ 必须补一个空段落，否则 Lexical 拒绝
      //    （`the editor state's root node never becomes empty`）—— 真页面的 JSON 就长这样 ✓
      if (build) build($getRoot());
      else $getRoot().append($createParagraphNode());
    },
    { discrete: true },
  );
  return JSON.stringify(editor.getEditorState().toJSON());
}

function docJson(): string {
  return stateJson((root) => {
    const h = $createHeadingNode("h1");
    h.append($createTextNode("标题"));
    const p = $createParagraphNode();
    p.append($createTextNode("正文"));
    root.append(h, p);
  });
}

/**
 * 「内容为空」那一档：⚠️ **必须拿真编辑器造** —— 我第一版手搓了
 * `{root:{children:[]}}`，Lexical 当场拒收（`the editor state's root node never becomes empty`
 * ⇒ 真页面的 JSON 本来就带着一个空段落 ✓）。手搓形状的夹具会骗人，所以这里也走真编辑器 ✓。
 */
const EMPTY_JSON = stateJson();

beforeEach(() => {
  saveMock.mockReset();
  writeMock.mockReset();
});

describe("pageContentToMarkdown —— 段落里被包住的 mermaid 也必须出围栏（2026-10-15 owner 实测）", () => {
  // 现场：owner 导出的 .md 里 mermaid 块**没有 ```mermaid 围栏**（源码裸奔）✗。
  // 真因（拿真页复现出来的）：那些图块在树里是 `root > paragraph > mermaid`（老内容的形状），
  // 而 `$convertToMarkdownString` 对"段落里的装饰块"**不走** MERMAID 那条 `export` ✗。
  // ⚠️ 修法有个反直觉的点：**不能**在另一趟 update 里先提级再导出 —— Lexical 提交时会把根上的
  //   裸装饰节点**再包回段落**（试过：树里 hoist ＋ `discrete: true`、以及解析前改 JSON，都无效 ✗），
  //   ⇒ 提级与导出**必须在同一次 `editor.update` 里**（`markdownTransformers.test.ts` 那条绿判据
  //   用的正是这个形状 ✓）。
  const nested = JSON.stringify({
    root: {
      type: "root",
      version: 1,
      children: [
        {
          type: "paragraph",
          version: 1,
          children: [
            { type: "linebreak", version: 1 },
            { type: "mermaid", version: 1, src: "flowchart LR\n  A-->B", syntax: "flowchart" },
          ],
        },
        { type: "paragraph", version: 1, children: [{ type: "text", text: "后面的段落", version: 1 }] },
      ],
    },
  });

  it("★ 围栏在，且源码原样（`paragraph > linebreak,mermaid` 这个真原形）", () => {
    const md = pageContentToMarkdown(nested);
    expect(md, "mermaid 没有围栏 ⇒ 导出的 .md 里会是一段裸源码").toContain("```mermaid\nflowchart LR\n  A-->B\n```");
    expect(md).toContain("后面的段落");
    expect(md).not.toContain("\n\n\n");
  });

  it("★ 段落里还有真文字（同段混排）⇒ 文字留下、图块提到顶层仍出围栏（2026-10-31 owner 报「导出丢了 mermaid 标记」）", () => {
    // ⚠️ 2026-10-15 那版把这一档**故意留着不提级**（"拆开改变语义"）。2026-10-31 owner 又报
    //    "导出 markdown 丢了 mermaid 图块的标记" ⇒ 同段混排正是会丢的四种形状之一（实测围栏 0 ✗）。
    //    md 本来就没有"段落内的图"这种形态 ⇒ 文字与原段落留下、图块以顶层围栏导出，是唯一能带走的表示。
    const inline = JSON.stringify({
      root: {
        type: "root",
        version: 1,
        children: [
          {
            type: "paragraph",
            version: 1,
            children: [
              { type: "text", text: "前面的文字", version: 1 },
              { type: "mermaid", version: 1, src: "flowchart LR\n  A-->B", syntax: "flowchart" },
            ],
          },
        ],
      },
    });
    const md = pageContentToMarkdown(inline);
    expect(md).toContain("前面的文字");
    expect(md).toContain("```mermaid\nflowchart LR\n  A-->B\n```");
  });
});

describe("exportPageToMarkdown —— 把当前页存成 .md 文件", () => {
  it("① 用户在保存对话框里点了取消 ⇒ ⛔ 不写文件、也⛔不报成功", async () => {
    saveMock.mockResolvedValue(null);
    const msg = await exportPageToMarkdown({ id: "p1", title: "标题页", docJson: docJson() });
    expect(writeMock).not.toHaveBeenCalled();
    expect(msg).toContain("已取消");
    expect(msg).not.toContain("已导出");
  });

  it("② 默认文件名清洗过、过滤器是 md（用户不用自己修非法字符）", async () => {
    saveMock.mockResolvedValue("D:/out/我的_笔记.md");
    await exportPageToMarkdown({ id: "p1", title: "我的/笔记", docJson: docJson() });
    expect(saveMock).toHaveBeenCalledTimes(1);
    const arg = saveMock.mock.calls[0][0] as { defaultPath: string; filters: { extensions: string[] }[] };
    expect(arg.defaultPath).toBe("我的_笔记.md"); // `/` 被换成 `_`
    expect(arg.defaultPath.endsWith(".md")).toBe(true);
    expect(arg.filters[0].extensions).toEqual(["md"]);
  });

  it("③ 写下去的内容 ＝ 头部注释 ＋ **共享转换器**的输出（⛔ 不是另写一份转换）", async () => {
    const json = docJson();
    saveMock.mockResolvedValue("D:/out/x.md");
    const msg = await exportPageToMarkdown({ id: "p1", title: "标题页", docJson: json });
    expect(writeMock).toHaveBeenCalledTimes(1);
    const [path, text] = writeMock.mock.calls[0] as [string, string];
    expect(path).toBe("D:/out/x.md");
    // ⭐ 逐字等于"头部 ＋ 共享转换器的输出" ⇒ 一旦有人在这里另写一份转换，这条立刻红 ✓
    expect(text).toBe(`<!-- title: 标题页 · id: p1 -->\n` + pageContentToMarkdown(json));
    // 真内容确实进来了（不是空串）：标题是 `# 标题`
    expect(text).toContain("# 标题");
    expect(text).toContain("正文");
    expect(msg).toContain("已导出");
  });

  it("④ 标题缺失 ⇒ 文件名用 id 兜底、头部写「未命名」（⛔ 不把 undefined 写进去 ✗）", async () => {
    saveMock.mockResolvedValue("D:/out/p2.md");
    await exportPageToMarkdown({ id: "p2", title: "", docJson: EMPTY_JSON });
    const arg = saveMock.mock.calls[0][0] as { defaultPath: string };
    expect(arg.defaultPath).toBe("p2.md");
    const text = writeMock.mock.calls[0][1] as string;
    expect(text).toBe(`<!-- title: 未命名 · id: p2 -->\n`);
    expect(text).not.toContain("undefined");
  });

  it("⑤ 内容为空 ⇒ 照样写出（头部在、正文空），不抛", async () => {
    saveMock.mockResolvedValue("D:/out/p3.md");
    await expect(
      exportPageToMarkdown({ id: "p3", title: "空页", docJson: EMPTY_JSON }),
    ).resolves.toContain("已导出");
    expect(writeMock).toHaveBeenCalledTimes(1);
  });
});

describe("pageContentToMarkdown —— 引用 / 列表 / callout 里的 mermaid 也出围栏（2026-10-31 owner 报「导出丢了 mermaid 标记」）", () => {
  // 现场：§2 那个"段落里恰好一个装饰节点"的提级只覆盖了**顶层段落**这一种形状。
  // 图块在引用 / 列表项 / callout / 同段文字里时，`$convertToMarkdownString` 同样不走出围栏
  // （实测四种形状围栏数全是 0 ✗）。修法：③ 把这些嵌套 mermaid 统一提到**顶层块之后**，
  // 结构与文字原样保留、图块以顶层 ```mermaid 围栏导出。
  const SRC = "flowchart LR\n  A-->B";
  const FENCE = "```mermaid\n" + SRC + "\n```";

  function mermaidJson(build: (root: ReturnType<typeof $getRoot>) => void): string {
    const editor = createEditor({
      namespace: "export-mermaid-shape-test",
      nodes: [HeadingNode, QuoteNode, ListNode, ListItemNode, CalloutNode, MermaidNode],
      onError: (e) => {
        throw e;
      },
    });
    editor.update(
      () => {
        $getRoot().append($createParagraphNode()); // root 不能空（同上面的纪律）
        build($getRoot());
      },
      { discrete: true },
    );
    return JSON.stringify(editor.getEditorState().toJSON());
  }

  it("① 引用里的 mermaid", () => {
    const md = pageContentToMarkdown(
      mermaidJson((root) => {
        const q = $createQuoteNode();
        q.append($createMermaidNode(SRC));
        root.append(q);
      }),
    );
    expect(md).toContain(FENCE);
  });

  it("② 列表项里的 mermaid", () => {
    const md = pageContentToMarkdown(
      mermaidJson((root) => {
        const item = $createListItemNode();
        item.append($createMermaidNode(SRC));
        const list = $createListNode("bullet");
        list.append(item);
        root.append(list);
      }),
    );
    expect(md).toContain(FENCE);
  });

  it("③ callout 里的 mermaid", () => {
    const md = pageContentToMarkdown(
      mermaidJson((root) => {
        const callout = $createCalloutNode();
        const p = $createParagraphNode();
        p.append($createMermaidNode(SRC));
        callout.append(p);
        root.append(callout);
      }),
    );
    expect(md).toContain(FENCE);
  });
});
