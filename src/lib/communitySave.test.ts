import { describe, expect, it } from "vitest";
import {
  absolutizeCommunityLinks,
  findStoredPost,
  linkIntentOf,
  noteForPost,
  previewOf,
  searchKeyOf,
} from "./communitySave";
import type { CommunityPost } from "./communityPost";

const post: CommunityPost = {
  id: "30",
  title: "插件配方：批量一",
  bodyMarkdown: "第一行\n第二行\n第三行",
  author: "数友社区",
  createdAt: "2026-09-11T10:00:00Z",
  updatedAt: "2026-09-11T11:00:00Z",
  tags: ["插件", "ShuyoNote"],
  url: "https://community.shuyo.cn/post/plugin-recipes-batch-1",
};

describe("linkIntentOf — 深链与网址都认，认不出就说清为什么", () => {
  it("深链的 save / import **动作要分开**（存笔记 ≠ 导入产物）", () => {
    expect(linkIntentOf("shuyonote://save?url=https%3A%2F%2Fcommunity.shuyo.cn%2Fpost%2Fx")).toEqual({
      ok: true,
      action: "save",
      url: "https://community.shuyo.cn/post/x",
    });
    expect(linkIntentOf("shuyonote://import?url=https://community.shuyo.cn/tpl.json")).toEqual({
      ok: true,
      action: "import",
      url: "https://community.shuyo.cn/tpl.json",
    });
  });

  it("compose 还没做 → 说清「这条路还没做」，并给出替代做法", () => {
    const r = linkIntentOf("shuyonote://compose?title=hi");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("还没做");
      expect(r.reason).toContain("新建页面");
    }
  });

  it("普通网址也认（深链还没接完时，用户粘网址就能用）", () => {
    // 手动粘网址默认按「存笔记」处理；要导入模板就粘 shuyonote://import?…（动作由链接说清，不靠猜）
    expect(linkIntentOf("  https://community.shuyo.cn/post/x  ")).toEqual({
      ok: true,
      action: "save",
      url: "https://community.shuyo.cn/post/x",
    });
  });

  it("粘了一条 `.json` 网址 → 指出它更像模板导入（而不是按「存笔记」去抓出一句莫名其妙的错）", () => {
    const r = linkIntentOf("https://community.shuyo.cn/files/tpl.json");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("shuyonote://import?url=");
      expect(r.reason).toContain("索引订阅");
    }
    // 帖子地址不受影响（路径里有 .json 才拦）
    expect(linkIntentOf("https://community.shuyo.cn/post/json-tips").ok).toBe(true);
  });

  it("空、非社区域名、别的动作、非法深链——每一种都说得出原因", () => {
    expect(linkIntentOf("")).toEqual({ ok: false, reason: expect.stringContaining("还没有粘贴链接") });
    expect(linkIntentOf("https://evil.example.com/post/x")).toEqual({
      ok: false,
      reason: expect.stringContaining("只接受这些来源"),
    });
    expect(linkIntentOf("shuyonote://compose?title=hi").ok).toBe(false);
    expect(linkIntentOf("shuyonote://nope")).toEqual({ ok: false, reason: expect.stringContaining("不认识") });
  });
});

describe("noteForPost — 来源必须写在最前面", () => {
  it("第一行是来源引用块，含标题、地址、作者与时间；标签**不在正文里**（落成真标签）", () => {
    const { title, markdown, tags } = noteForPost(post);
    expect(title).toBe("插件配方：批量一");
    const first = markdown.split("\n")[0];
    // 地址是**纯文本**：全文检索索引的是 content_text，只放链接 href 会让幂等查不到
    //（2026-09-21 起它同时是属性里的「来源」，但正文这一份**不能删** —— 属性值不进全文索引）。
    expect(first).toBe(
      "> 来源：插件配方：批量一 · https://community.shuyo.cn/post/plugin-recipes-batch-1（作者 数友社区 · 2026-09-11T11:00:00Z）",
    );
    expect(markdown).toContain("第一行\n第二行\n第三行");
    // 标签走 `add_tag`（见 `communitySaveNote.ts`），正文里不再有那一行
    expect(tags).toEqual(["插件", "ShuyoNote"]);
    expect(markdown).not.toContain("标签：");
  });

  it("没有作者/时间/标签时不留空壳（不出现「作者 」这种半句话）", () => {
    const bare = noteForPost({ ...post, author: "", createdAt: "", updatedAt: "", tags: [] });
    expect(bare.markdown.split("\n")[0]).toBe(
      "> 来源：插件配方：批量一 · https://community.shuyo.cn/post/plugin-recipes-batch-1",
    );
    expect(bare.markdown).not.toContain("标签：");
  });

  it("正文首尾空白会被清掉（粘贴出来的正文常带）", () => {
    const padded = noteForPost({ ...post, bodyMarkdown: "\n\n  正文  \n\n" });
    expect(padded.markdown).toContain("---\n\n正文\n");
  });
});

describe("previewOf — 预览不假装全文都在眼前", () => {
  it("给前 N 行并说清后面还有多少行", () => {
    const md = Array.from({ length: 20 }, (_, i) => `第 ${i + 1} 行`).join("\n");
    const p = previewOf(md, 12);
    expect(p.lines).toHaveLength(12);
    expect(p.hiddenLines).toBe(8);
    expect(p.lines[0]).toBe("第 1 行");
  });

  it("没超长时不报「后面还有」", () => {
    expect(previewOf("a\nb", 12)).toEqual({ lines: ["a", "b"], hiddenLines: 0 });
  });
});

describe("findStoredPost — 逐字核对，不信分词", () => {
  const url = "https://community.shuyo.cn/post/plugin-recipes-batch-1";

  it("正文里逐字含这条地址才算已经存过", () => {
    expect(
      findStoredPost(
        [
          { id: "p1", title: "别的帖子", text: "同域名但不是这篇：https://community.shuyo.cn/post/other" },
          { id: "p2", title: "已经存过的那篇", text: `> 来源：[x](${url})\n\n正文` },
        ],
        url,
      )?.id,
    ).toBe("p2");
  });

  it("只是「搜到了」但没有这条地址 → 不算（误判会让用户找不到笔记）", () => {
    expect(
      findStoredPost([{ id: "p1", title: "同 slug 片段", text: "plugin-recipes-batch-1 出现在正文里" }], url),
    ).toBeNull();
  });

  it("空地址或空候选一律不算", () => {
    expect(findStoredPost([{ id: "p1", title: "x", text: url }], "   ")).toBeNull();
    expect(findStoredPost([], url)).toBeNull();
  });
});

describe("searchKeyOf — 用 slug 搜，准确性交给逐字核对", () => {
  it("取地址最后一段", () => {
    expect(searchKeyOf("https://community.shuyo.cn/post/plugin-recipes-batch-1")).toBe(
      "plugin-recipes-batch-1",
    );
    expect(searchKeyOf("https://community.shuyo.cn/post/plugin-recipes-batch-1/")).toBe(
      "plugin-recipes-batch-1",
    );
    expect(searchKeyOf("https://community.shuyo.cn/")).toBe("community.shuyo.cn");
  });

  it("不是 URL 时原样返回（不抛异常）", () => {
    expect(searchKeyOf("随便一段字")).toBe("随便一段字");
  });
});

// **2026-09-21：社区文章存进笔记后，图是破的** —— 正文里的图是站内相对地址
// （`/attachments/<hash>`），存进笔记后"相对于谁"就不存在了。这条判据钉住"存进去之前先绝对化"。
describe("absolutizeCommunityLinks — 站内相对地址要变成绝对地址（否则笔记里的图是破的）", () => {
  const url = "https://community.shuyo.cn/post/plugin-recipes-batch-1";

  it("Markdown 的图片与链接：单个 / 开头的都补上站点前缀", () => {
    expect(absolutizeCommunityLinks("![图](/attachments/abc123)", url)).toBe(
      "![图](https://community.shuyo.cn/attachments/abc123)",
    );
    expect(absolutizeCommunityLinks("看[这篇](/post/another-post)", url)).toBe(
      "看[这篇](https://community.shuyo.cn/post/another-post)",
    );
    // 图前后有别的字也要对
    expect(absolutizeCommunityLinks("前 ![图](/attachments/a.png) 后", url)).toBe(
      "前 ![图](https://community.shuyo.cn/attachments/a.png) 后",
    );
  });

  it("内嵌 HTML 的 src/href 同样要绝对化（社区正文允许 HTML）", () => {
    expect(absolutizeCommunityLinks('<img src="/attachments/x.png">', url)).toBe(
      '<img src="https://community.shuyo.cn/attachments/x.png">',
    );
    expect(absolutizeCommunityLinks("<a href='/u/cnzen'>我</a>", url)).toBe(
      "<a href='https://community.shuyo.cn/u/cnzen'>我</a>",
    );
  });

  it("**不许**动的那些：绝对地址 / 协议相对 / data: / attachment: / 锚点 / 不带头斜杠的相对路径", () => {
    for (const keep of [
      "![图](https://cdn.example.com/a.png)",
      "![图](//cdn.example.com/a.png)",
      "![图](data:image/png;base64,AAA)",
      "![图](attachment://localhost/C%3A/hash.png)",
      "![图](foo.png)",
      "[锚](#section)",
      "[邮件](mailto:a@b.com)",
    ]) {
      expect(absolutizeCommunityLinks(keep, url)).toBe(keep);
    }
  });

  it("来源地址解析不了 ⇒ 一个字都不改（宁可保持原样，也不要把正文搞坏）", () => {
    const md = "![图](/attachments/a.png)";
    expect(absolutizeCommunityLinks(md, "不是地址")).toBe(md);
    expect(absolutizeCommunityLinks(md, "")).toBe(md);
  });

  it("noteForPost 存进笔记的那份正文已经是绝对地址（含图的帖子）", () => {
    const withImage: CommunityPost = {
      ...post,
      bodyMarkdown: "看看这张图：\n\n![截图](/attachments/deadbeef.png)\n\n完。",
    };
    const { markdown } = noteForPost(withImage);
    expect(markdown).toContain("![截图](https://community.shuyo.cn/attachments/deadbeef.png)");
    expect(markdown).not.toContain("](/attachments/");
    // 来源行照旧在最前面（幂等要靠它逐字核对）
    expect(markdown.split("\n")[0]).toContain("> 来源：");
  });
});
