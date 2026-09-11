// **「从社区链接存一篇笔记」：取消与失败必须零痕迹，重复帖子不许存第二篇。**
//
// 这一屏是 P0 的落点，把六个环节串在一起（解析 → 抓取 → 预览 → 确认 → 幂等 → 落库）。
// 每一环单独测过（`deepLink.test.ts` / `communityPost.test.ts` / `communitySave.test.ts`），
// 但**接起来**会不会漏、会不会在"没确认"的情况下落库，只有真的挂起来点一遍才知道。
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import "../i18n";

const mocks = vi.hoisted(() => ({
  fetchImpl: vi.fn<(url: string, init?: unknown) => Promise<unknown>>(),
  search: vi.fn<(q: string, limit?: number, all?: boolean) => Promise<unknown>>(),
  createPage: vi.fn<(parent: string | null, content?: unknown) => Promise<string | null>>(),
  openPage: vi.fn<(id: string) => Promise<void>>(),
  openUrl: vi.fn<(url: string) => Promise<void>>(),
  saveAs: vi.fn<(arg: unknown) => Promise<boolean>>(),
  toast: vi.fn<(msg: string, kind?: string) => void>(),
}));

vi.mock("../lib/api", () => ({ api: { search: mocks.search, getPage: async () => ({}) } }));
vi.mock("../store/toast", () => ({ toast: mocks.toast }));
vi.mock("../lib/platform", () => ({
  // 对话框走平台驱动：这里把它接回同一个假 fetch，于是"驱动把失败翻译成一句人话"
  // 这一段也被测到（真机上桌面端走的是 Rust 命令，Web 端走浏览器 fetch）。
  platform: {
    opener: { openUrl: mocks.openUrl },
    community: {
      fetchDocument: async (url: string) => {
        const { fetchCommunityDocument } = await import("../lib/communityPost");
        const r = await fetchCommunityDocument(url, { fetchImpl: mocks.fetchImpl as never });
        if (!r.ok) throw new Error(r.reason);
        return r.text;
      },
      fetchPost: async (url: string) => {
        const { fetchCommunityPost } = await import("../lib/communityPost");
        const r = await fetchCommunityPost(url, { fetchImpl: mocks.fetchImpl as never });
        if (!r.ok) throw new Error(r.reason);
        return r.post;
      },
    },
  },
  isDesktopPlatform: () => false,
}));
vi.mock("../store/templates", () => ({
  useTemplates: Object.assign(() => ({}), {
    getState: () => ({ saveAs: mocks.saveAs }),
  }),
}));
vi.mock("../store/notes", () => ({
  useNotes: Object.assign(() => ({}), {
    getState: () => ({ createPage: mocks.createPage, openPage: mocks.openPage }),
  }),
}));

import { CommunitySaveDialog } from "./CommunitySaveDialog";
import { useCommunitySave } from "../store/communitySave";

const POST_URL = "https://community.shuyo.cn/post/plugin-recipes-batch-1";

const post = {
  id: "30",
  title: "插件配方：批量一",
  body_markdown: "正文第一行\n正文第二行",
  author: "数友社区",
  created_at: "2026-09-11T10:00:00Z",
  updated_at: "2026-09-11T11:00:00Z",
  tags: ["插件"],
  url: POST_URL,
};

/** 假响应：JSON + 流式 body（和 communityPost 的测试同一个形状）。 */
function jsonResponse(payload: unknown, url = POST_URL) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return Promise.resolve({
    ok: true,
    status: 200,
    url,
    headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? "application/json" : null) },
    body: {
      getReader: () => {
        let done = false;
        return {
          read: async () => {
            if (done) return { done: true };
            done = true;
            return { done: false, value: bytes };
          },
        };
      },
    },
    text: async () => JSON.stringify(payload),
  });
}

let root: ReturnType<typeof createRoot> | null = null;

const mount = () => {
  flushSync(() => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    root = createRoot(el);
    root.render(React.createElement(CommunitySaveDialog));
  });
};

const text = () => document.body.textContent ?? "";
const input = () => document.querySelector<HTMLInputElement>(".community-save-input")!;
const byText = (label: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>(".community-save-btn")).find(
    (b) => (b.textContent ?? "").trim() === label,
  )!;

function type(value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  flushSync(() => {
    setter.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  mocks.fetchImpl.mockReset();
  mocks.search.mockReset();
  mocks.createPage.mockReset();
  mocks.openPage.mockReset();
  mocks.openUrl.mockReset();
  mocks.saveAs.mockReset();
  mocks.saveAs.mockResolvedValue(true);
  mocks.toast.mockReset();
  mocks.search.mockResolvedValue([]);
  mocks.createPage.mockResolvedValue("new-page-id");
  vi.stubGlobal("fetch", mocks.fetchImpl);
  // 连 pendingLink 一起重置：只设 open:true 会让上一个用例的链接"漏"到下一个（我踩过）
  useCommunitySave.setState({ open: true, pendingLink: null });
});

afterEach(() => {
  if (root) flushSync(() => root!.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("存社区帖子：预览在前，落库在后", () => {
  it("读取成功 → 先出预览（标题/作者/来源/正文），**此时还没有落库**", async () => {
    mocks.fetchImpl.mockImplementation(() => jsonResponse(post));
    mount();
    type(POST_URL);
    flushSync(() => byText("读取").click());
    await vi.waitFor(() => expect(text()).toContain("插件配方：批量一"));

    expect(text()).toContain("数友社区");
    expect(text()).toContain("来源：");
    expect(text()).toContain("正文第一行");
    // 落点必须写明（静默决定"存到哪"是最容易被冒犯的地方）
    expect(text()).toContain("将存到：工作区根目录");
    expect(mocks.createPage).not.toHaveBeenCalled();
  });

  it("点「存进笔记」才落库一次，正文最前面是来源行", async () => {
    mocks.fetchImpl.mockImplementation(() => jsonResponse(post));
    mount();
    type(`shuyonote://save?url=${encodeURIComponent(POST_URL)}`);
    flushSync(() => byText("读取").click());
    await vi.waitFor(() => expect(text()).toContain("插件配方：批量一"));
    flushSync(() => byText("存进笔记").click());
    await vi.waitFor(() => expect(mocks.createPage).toHaveBeenCalledTimes(1));

    const [, content] = mocks.createPage.mock.calls[0] as [string | null, { title?: string; content_text?: string }];
    expect(content.title).toBe("插件配方：批量一");
    expect(content.content_text?.startsWith("来源：")).toBe(true);
    // 来源地址必须在**纯文本**里（幂等靠全文检索核对它；只放链接 href 会查不到）
    expect(content.content_text).toContain(POST_URL);
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("已存进笔记"), "success");
  });

  it("取消（关闭对话框）→ 零痕迹：没落库、没提示、没打开任何页面", async () => {
    mocks.fetchImpl.mockImplementation(() => jsonResponse(post));
    mount();
    type(POST_URL);
    flushSync(() => byText("读取").click());
    await vi.waitFor(() => expect(text()).toContain("插件配方：批量一"));
    flushSync(() => byText("取消").click());

    expect(mocks.createPage).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(mocks.openPage).not.toHaveBeenCalled();
    expect(useCommunitySave.getState().open).toBe(false);
  });

  it("链接不合法 → 说清原因，且**根本不发请求**", async () => {
    mount();
    type("https://evil.example.com/post/x");
    flushSync(() => byText("读取").click());
    await vi.waitFor(() => expect(text()).toContain("只接受这些来源"));
    expect(mocks.fetchImpl).not.toHaveBeenCalled();
    expect(mocks.createPage).not.toHaveBeenCalled();
  });

  it("抓取失败（返回网页）→ 原样说出原因，不落库", async () => {
    mocks.fetchImpl.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        url: POST_URL,
        headers: { get: () => "text/html; charset=utf-8" },
        body: null,
        text: async () => "<html></html>",
      }),
    );
    mount();
    type(POST_URL);
    flushSync(() => byText("读取").click());
    await vi.waitFor(() => expect(text()).toContain("返回的不是 JSON"));
    expect(mocks.createPage).not.toHaveBeenCalled();
  });
});

describe("import 链接：导入的是**产物**，不是「存一篇笔记」", () => {
  const TPL = {
    name: "周回顾",
    category: "我的模板",
    content_json: '{"root":{}}',
    content_text: "要点",
  };

  it("`import` 链接 → 出的是导入清单（会创建什么），**不是帖子预览**，且未落库", async () => {
    mocks.fetchImpl.mockImplementation(() => jsonResponse(TPL, "https://community.shuyo.cn/tpl.json"));
    mount();
    type("shuyonote://import?url=https%3A%2F%2Fcommunity.shuyo.cn%2Ftpl.json");
    flushSync(() => byText("读取").click());
    await vi.waitFor(() => expect(text()).toContain("将创建"));
    expect(text()).toContain("一个模板「周回顾」");
    expect(text()).toContain("不会创建任何页面，也不会安装任何插件");
    // 这是 import 不是 save：不该出现"存进笔记"，也不该建页面
    expect(text()).not.toContain("存进笔记");
    expect(mocks.createPage).not.toHaveBeenCalled();
    expect(mocks.saveAs).not.toHaveBeenCalled();
  });

  it("点「导入模板」→ 恰好写一次模板，且用的是文件里的字段", async () => {
    mocks.fetchImpl.mockImplementation(() => jsonResponse(TPL, "https://community.shuyo.cn/tpl.json"));
    mount();
    type("shuyonote://import?url=https%3A%2F%2Fcommunity.shuyo.cn%2Ftpl.json");
    flushSync(() => byText("读取").click());
    // 等**预览**出现再点：对话框标题里也有"导入模板"四个字，用它当条件是竞态（我踩了）
    await vi.waitFor(() => expect(text()).toContain("将创建"));
    flushSync(() => byText("导入模板").click());
    await vi.waitFor(() => expect(mocks.saveAs).toHaveBeenCalledTimes(1));
    expect(mocks.saveAs.mock.calls[0][0]).toEqual({
      name: "周回顾",
      category: "我的模板",
      content_json: '{"root":{}}',
      content_text: "要点",
    });
    expect(mocks.createPage).not.toHaveBeenCalled();
  });

  it("取消 → 零痕迹（不写模板、不建页面、不提示）", async () => {
    mocks.fetchImpl.mockImplementation(() => jsonResponse(TPL, "https://community.shuyo.cn/tpl.json"));
    mount();
    type("shuyonote://import?url=https%3A%2F%2Fcommunity.shuyo.cn%2Ftpl.json");
    flushSync(() => byText("读取").click());
    await vi.waitFor(() => expect(text()).toContain("将创建"));
    flushSync(() => byText("取消").click());
    expect(mocks.saveAs).not.toHaveBeenCalled();
    expect(mocks.createPage).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("不是模板文件 → 说清缺什么 + 两条替代路（插件走索引、主题没格式）", async () => {
    mocks.fetchImpl.mockImplementation(() =>
      jsonResponse({ hello: "world" }, "https://community.shuyo.cn/not-template.json"),
    );
    mount();
    type("shuyonote://import?url=https%3A%2F%2Fcommunity.shuyo.cn%2Fnot-template.json");
    flushSync(() => byText("读取").click());
    await vi.waitFor(() => expect(text()).toContain("content_json"));
    expect(text()).toContain("索引订阅");
    expect(mocks.saveAs).not.toHaveBeenCalled();
  });
});

describe("深链进来（openWithLink）：预填并预览，但绝不自动保存", () => {
  it("合法深链 → 直接出预览，**没有自动落库**", async () => {
    mocks.fetchImpl.mockImplementation(() => jsonResponse(post));
    mount();
    flushSync(() => useCommunitySave.getState().openWithLink(`shuyonote://save?url=${encodeURIComponent(POST_URL)}`));
    await vi.waitFor(() => expect(text()).toContain("插件配方：批量一"));
    expect(input().value).toContain("shuyonote://save");
    expect(mocks.createPage).not.toHaveBeenCalled();
    expect(text()).toContain("将存到：工作区根目录");
  });

  it("非法深链（指向回环）→ 说清原因、**根本不发请求**、不落库", async () => {
    mount();
    flushSync(() =>
      useCommunitySave.getState().openWithLink("shuyonote://save?url=http%3A%2F%2F127.0.0.1%2Fx"),
    );
    await vi.waitFor(() => expect(text()).toContain("只接受 https"));
    expect(mocks.fetchImpl).not.toHaveBeenCalled();
    expect(mocks.createPage).not.toHaveBeenCalled();
  });

  it("深链进来后取消 → 一样零痕迹（与手动粘贴同一条规矩）", async () => {
    mocks.fetchImpl.mockImplementation(() => jsonResponse(post));
    mount();
    flushSync(() => useCommunitySave.getState().openWithLink(POST_URL));
    await vi.waitFor(() => expect(text()).toContain("插件配方：批量一"));
    flushSync(() => byText("取消").click());
    expect(mocks.createPage).not.toHaveBeenCalled();
    expect(useCommunitySave.getState().pendingLink).toBeNull();
  });
});

describe("幂等：同一篇帖子不存第二篇", () => {
  it("搜到且正文里逐字含来源地址 → 提示已经存过，给「打开那篇」，**不落库**", async () => {
    mocks.fetchImpl.mockImplementation(() => jsonResponse(post));
    mocks.search.mockResolvedValue([
      { id: "old-1", title: "已经存过的那篇", snippet: `> 来源：[x](${POST_URL})` },
    ]);
    mount();
    type(POST_URL);
    flushSync(() => byText("读取").click());
    await vi.waitFor(() => expect(text()).toContain("已经存过"));

    expect(text()).toContain("已经存过的那篇");
    expect(mocks.createPage).not.toHaveBeenCalled();
    // 没有"存进笔记"这个按钮（已经存过就不该再给一次机会）
    expect(Array.from(document.querySelectorAll(".community-save-btn")).map((b) => b.textContent)).not.toContain(
      "存进笔记",
    );

    flushSync(() => byText("打开那篇").click());
    await vi.waitFor(() => expect(mocks.openPage).toHaveBeenCalledWith("old-1"));
  });

  it("只是搜到候选、但正文里没有这条地址 → **仍然可以存**（误判会让用户找不到笔记）", async () => {
    mocks.fetchImpl.mockImplementation(() => jsonResponse(post));
    mocks.search.mockResolvedValue([{ id: "p9", title: "同 slug 的别的页面", snippet: "plugin-recipes-batch-1" }]);
    mount();
    type(POST_URL);
    flushSync(() => byText("读取").click());
    await vi.waitFor(() => expect(text()).toContain("插件配方：批量一"));
    expect(text()).not.toContain("已经存过");
    flushSync(() => byText("存进笔记").click());
    await vi.waitFor(() => expect(mocks.createPage).toHaveBeenCalledTimes(1));
  });

  it("搜索本身失败不该挡住保存（少一次提示，不是错误）", async () => {
    mocks.fetchImpl.mockImplementation(() => jsonResponse(post));
    mocks.search.mockRejectedValue(new Error("search down"));
    mount();
    type(POST_URL);
    flushSync(() => byText("读取").click());
    await vi.waitFor(() => expect(text()).toContain("插件配方：批量一"));
    expect(text()).not.toContain("已经存过");
  });
});
