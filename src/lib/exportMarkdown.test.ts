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
import { $createHeadingNode, HeadingNode, QuoteNode } from "@lexical/rich-text";

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
