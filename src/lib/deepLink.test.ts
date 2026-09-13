import { describe, expect, it } from "vitest";
import {
  DEEP_LINK_HOSTS,
  MAX_COMPOSE_BODY,
  MAX_COMPOSE_TITLE,
  MAX_DEEP_LINK_LEN,
  describeDeepLink,
  parseDeepLink,
} from "./deepLink";

/** 表驱动：纯字符串 → 动作映射。方案里那条"三条链接的解析都有测试"就是这张表。 */
const ok = (link: string) => {
  const r = parseDeepLink(link);
  if (!r.ok) throw new Error(`本该解析成功，却报了：${r.reason}`);
  return r.action;
};

const bad = (link: string) => {
  const r = parseDeepLink(link);
  if (r.ok) throw new Error(`本该被拒，却解析成了：${JSON.stringify(r.action)}`);
  return r.reason;
};

describe("parseDeepLink — 认得出的四种动作", () => {
  it("save：社区帖子 → 存成笔记", () => {
    expect(ok("shuyonote://save?url=https%3A%2F%2Fcommunity.shuyo.cn%2Fpost%2Fabc")).toEqual({
      kind: "save",
      url: "https://community.shuyo.cn/post/abc",
    });
  });

  it("import：导入配方 / 主题 / 模板", () => {
    expect(ok("shuyonote://import?url=https://community.shuyo.cn/recipes/weekly.json")).toEqual({
      kind: "import",
      url: "https://community.shuyo.cn/recipes/weekly.json",
    });
  });

  it("compose：起一份草稿（中文与百分号编码都要解对）", () => {
    const link = `shuyonote://compose?title=${encodeURIComponent("插件配方：周回顾")}&body=${encodeURIComponent("一段摘要，含空格与 标点。")}`;
    expect(ok(link)).toEqual({ kind: "compose", title: "插件配方：周回顾", body: "一段摘要，含空格与 标点。" });
  });

  it("page：应用内部链接（历史上 DrawingEditorModal 生成的就是这个形状）", () => {
    expect(ok("shuyonote://page/2f1c9a4e-77aa-4a1f-9a0e-1b2c3d4e5f60")).toEqual({
      kind: "page",
      pageId: "2f1c9a4e-77aa-4a1f-9a0e-1b2c3d4e5f60",
    });
  });

  it("动作名后面**多一个 `/`** 也认（真机归一化出来的形态，Windows 实测）", () => {
    // Windows 的 shell 会把 `shuyonote://save?url=…` 交成 `shuyonote://save/?url=…`：
    // 动作名后多一个 `/`，百分号编码完好。所以"规范化"这一步必须容忍它——
    // 否则真机上这条链接会被判成"不认识的动作"，而开发者照文档写永远复现不出来。
    expect(ok("shuyonote://save/?url=https%3A%2F%2Fcommunity.shuyo.cn%2Fpost%2Fx")).toEqual({
      kind: "save",
      url: "https://community.shuyo.cn/post/x",
    });
    expect(ok("shuyonote://import/?url=https%3A%2F%2Fcommunity.shuyo.cn%2Fr.json")).toEqual({
      kind: "import",
      url: "https://community.shuyo.cn/r.json",
    });
  });

  it("没有 // 的写法也认（有些平台就是这样投递的）", () => {
    expect(ok("shuyonote:save?url=https://community.shuyo.cn/post/x")).toEqual({
      kind: "save",
      url: "https://community.shuyo.cn/post/x",
    });
    expect(ok("shuyonote:page/abc")).toEqual({ kind: "page", pageId: "abc" });
  });

  it("大小写与多余斜杠都不影响", () => {
    expect(ok("SHUYONOTE://Save?url=https://community.shuyo.cn/post/x")).toEqual({
      kind: "save",
      url: "https://community.shuyo.cn/post/x",
    });
    expect(ok("shuyonote:///page//abc//")).toEqual({ kind: "page", pageId: "abc" });
  });

  it("链接自己的 #fragment 会被丢掉；要保留锚点就必须编码进 url 参数", () => {
    // 裸 `#` 在 URL 里就是"链接的 fragment"，不是参数的一部分——这是标准语义，不猜。
    expect(ok("shuyonote://save?url=https%3A%2F%2Fcommunity.shuyo.cn%2Fpost%2Fx#done")).toEqual({
      kind: "save",
      url: "https://community.shuyo.cn/post/x",
    });
    expect(ok("shuyonote://save?url=https%3A%2F%2Fcommunity.shuyo.cn%2Fpost%2Fx%23done")).toEqual({
      kind: "save",
      url: "https://community.shuyo.cn/post/x#done",
    });
  });
});

describe("parseDeepLink — 一律先判定，失败要有话说", () => {
  it("不是本应用的链接", () => {
    expect(bad("https://community.shuyo.cn/post/x")).toMatch(/不是 ShuyoNote 的链接/);
    expect(bad("")).toMatch(/链接是空的/);
  });

  it("不认识的动作会说清支持哪些", () => {
    expect(bad("shuyonote://install?url=https://community.shuyo.cn/x")).toMatch(
      /不认识的深链动作「install」（支持：save \/ import \/ compose \/ page）/,
    );
  });

  it("缺参数", () => {
    expect(bad("shuyonote://save")).toMatch(/没有带上地址/);
    expect(bad("shuyonote://compose")).toMatch(/既没有标题也没有摘要/);
    expect(bad("shuyonote://save?url=%20")).toMatch(/没有带上地址/);
  });

  // 这几条是"网页能发链接"这个前提带来的风险面：一个用户恰好访问的页面就能让应用去 fetch。
  it("只接受 https（明文 http 一律拒，包括自托常用的回环）", () => {
    expect(bad("shuyonote://save?url=http://community.shuyo.cn/post/x")).toMatch(/只接受 https/);
    expect(bad("shuyonote://import?url=http://127.0.0.1:8787/plugin-index.json")).toMatch(/只接受 https/);
    expect(bad("shuyonote://import?url=http://localhost:8787/x.json")).toMatch(/只接受 https/);
  });

  it("拒带账号密码的地址", () => {
    expect(bad("shuyonote://save?url=https%3A%2F%2Fuser%3Apass%40community.shuyo.cn%2Fpost%2Fx")).toMatch(
      /不能带账号密码/,
    );
  });

  it("拒非默认端口", () => {
    expect(bad("shuyonote://save?url=https://community.shuyo.cn:8443/post/x")).toMatch(/只接受默认端口/);
  });

  it("只接受列出的来源（逐个列，不用通配）", () => {
    expect(bad("shuyonote://save?url=https://evil.example.com/post/x")).toMatch(/只接受这些来源/);
    // 名字里带社区域名也不行：比的是主机名整体，不是包含关系。
    expect(bad("shuyonote://save?url=https://community.shuyo.cn.evil.com/post/x")).toMatch(/只接受这些来源/);
    expect(DEEP_LINK_HOSTS).toEqual(["community.shuyo.cn"]);
  });

  it("拒非法 URL 与畸形的 page id", () => {
    expect(bad("shuyonote://save?url=not a url")).toMatch(/不是合法的 URL/);
    expect(bad("shuyonote://page/")).toMatch(/页面 id 不合法/);
    expect(bad(`shuyonote://page/${"a".repeat(65)}`)).toMatch(/页面 id 不合法/);
    expect(bad("shuyonote://page/../etc/passwd")).toMatch(/页面 id 不合法/);
  });

  it("长度上限：整条链接、标题、摘要各有一条，且超长是**拒绝**而不是悄悄截断", () => {
    expect(bad(`shuyonote://save?url=https://community.shuyo.cn/${"a".repeat(MAX_DEEP_LINK_LEN)}`)).toMatch(
      /链接过长/,
    );
    const longTitle = `shuyonote://compose?title=${encodeURIComponent("标".repeat(MAX_COMPOSE_TITLE + 1))}`;
    expect(bad(longTitle)).toMatch(/标题过长/);
    const longBody = `shuyonote://compose?body=${encodeURIComponent("文".repeat(MAX_COMPOSE_BODY + 1))}`;
    // 整篇正文不该走 URL：被截断的话用户看到的是"内容莫名少了一半"，所以这里必须说清。
    expect(bad(longBody)).toMatch(/分享只带摘要（上限 300 字）/);
    // 摘要本身没超，但编码后整条链接超了——那报的就是"链接过长"，两种原因不混为一谈。
    expect(bad(`shuyonote://compose?body=${encodeURIComponent("文".repeat(1000))}`)).toMatch(/链接过长/);
  });

  it("边界值本身是接受的", () => {
    expect(ok(`shuyonote://compose?body=${encodeURIComponent("文".repeat(MAX_COMPOSE_BODY))}`)).toEqual({
      kind: "compose",
      title: "",
      body: "文".repeat(MAX_COMPOSE_BODY),
    });
  });
});

describe("describeDeepLink — 确认框里的一句人话", () => {
  it("每种动作都说得清是什么、来自谁", () => {
    expect(describeDeepLink({ kind: "page", pageId: "abc" })).toBe("打开这一页");
    expect(describeDeepLink({ kind: "save", url: "https://community.shuyo.cn/post/x" })).toContain(
      "来源：community.shuyo.cn",
    );
    expect(describeDeepLink({ kind: "import", url: "https://community.shuyo.cn/r.json" })).toContain(
      "导入一个配方 / 主题 / 模板",
    );
    expect(describeDeepLink({ kind: "compose", title: "t", body: "b" })).toContain("确认后再发");
  });
});

describe("parseDeepLink —— 测试钩子（解析不产生副作用）", () => {
  it("认得 test/<hook>?k=v，并**只**把它解析成一个动作", () => {
    const r = parseDeepLink("shuyonote://test/run-plugin?cmd=demo.hello");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.action).toEqual({
        kind: "test",
        hook: "run-plugin",
        params: { cmd: "demo.hello" },
      });
    }
  });

  it("不写钩子名字 → 明确报错（而不是解析成一个空动作）", () => {
    const r = parseDeepLink("shuyonote://test/");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("没写名字");
  });

  it("**错误提示里不宣传**这个入口（它是测试用的，不该出现在给用户看的支持列表里）", () => {
    const r = parseDeepLink("shuyonote://nope");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).not.toContain("test");
  });
});
