import { describe, expect, it, vi } from "vitest";
import {
  MAX_POST_JSON_BYTES,
  MAX_POST_TAGS,
  MAX_POST_TITLE,
  fetchCommunityPost,
  parseCommunityPost,
  type FetchLike,
} from "./communityPost";

const POST_URL = "https://community.shuyo.cn/api/posts/30.json";

const body = (obj: unknown) => JSON.stringify(obj);

const validPost = {
  id: 30,
  slug: "plugin-recipes-batch-1",
  title: "插件配方：批量一",
  body_markdown: "# 标题\n\n正文里有 **Markdown** 与中文。",
  author: "数友社区",
  created_at: "2026-09-11T10:00:00Z",
  updated_at: "2026-09-11T11:00:00Z",
  tags: ["插件", "ShuyoNote"],
  url: "https://community.shuyo.cn/post/plugin-recipes-batch-1",
};

/** 造一个假响应：body 走流式（按 chunk 喂），headers 给指定 content-type。 */
function fakeFetch(
  init: { status?: number; url?: string; contentType?: string; chunks?: Uint8Array[]; text?: string },
): FetchLike {
  const status = init.status ?? 200;
  const chunks = init.chunks ?? [new TextEncoder().encode(init.text ?? "")];
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    url: init.url ?? POST_URL,
    headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? (init.contentType ?? "application/json") : null) },
    body:
      init.chunks === undefined && init.text === undefined
        ? null
        : {
            getReader: () => {
              let i = 0;
              return { read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }) };
            },
          },
    text: async () => init.text ?? "",
  })) as unknown as FetchLike;
}

describe("parseCommunityPost — 缺字段是报错，不是填空", () => {
  it("正常帖子：字段各就各位，id 数字也认", () => {
    const r = parseCommunityPost(validPost);
    if (!r.ok) throw new Error(r.reason);
    expect(r.post).toEqual({
      id: "30",
      title: "插件配方：批量一",
      bodyMarkdown: "# 标题\n\n正文里有 **Markdown** 与中文。",
      author: "数友社区",
      createdAt: "2026-09-11T10:00:00Z",
      updatedAt: "2026-09-11T11:00:00Z",
      tags: ["插件", "ShuyoNote"],
      url: "https://community.shuyo.cn/post/plugin-recipes-batch-1",
    });
  });

  it("缺 id / title / body_markdown 一律报错并说清缺哪个", () => {
    expect(parseCommunityPost({ ...validPost, id: "" })).toEqual({ ok: false, reason: expect.stringContaining("缺少 id") });
    expect(parseCommunityPost({ ...validPost, title: "  " })).toEqual({
      ok: false,
      reason: expect.stringContaining("缺少 title"),
    });
    expect(parseCommunityPost({ ...validPost, body_markdown: "" })).toEqual({
      ok: false,
      reason: expect.stringContaining("缺少 body_markdown"),
    });
  });

  it("不是对象 / 是数组也要说清", () => {
    expect(parseCommunityPost(null)).toEqual({ ok: false, reason: expect.stringContaining("不是一个 JSON 对象") });
    expect(parseCommunityPost([validPost])).toEqual({ ok: false, reason: expect.stringContaining("不是一个 JSON 对象") });
    expect(parseCommunityPost("hi")).toEqual({ ok: false, reason: expect.stringContaining("不是一个 JSON 对象") });
  });

  it("帖子里的 url 必须过同一条地址策略（它是写进笔记的「来源」）", () => {
    expect(parseCommunityPost({ ...validPost, url: "https://evil.example.com/post/x" })).toEqual({
      ok: false,
      reason: expect.stringContaining("帖子里的 url 不可信"),
    });
    expect(parseCommunityPost({ ...validPost, url: "javascript:alert(1)" })).toEqual({
      ok: false,
      reason: expect.stringContaining("帖子里的 url 不可信"),
    });
  });

  it("标题上限；标签多余的直接丢掉（不因此拒绝整篇帖子）", () => {
    expect(parseCommunityPost({ ...validPost, title: "标".repeat(MAX_POST_TITLE + 1) })).toEqual({
      ok: false,
      reason: expect.stringContaining("标题过长"),
    });
    const many = parseCommunityPost({ ...validPost, tags: Array.from({ length: MAX_POST_TAGS + 5 }, (_, i) => `t${i}`) });
    if (!many.ok) throw new Error(many.reason);
    expect(many.post.tags).toHaveLength(MAX_POST_TAGS);
  });

  it("多出来的字段一律忽略（社区加字段不该让老应用抓不动）", () => {
    const r = parseCommunityPost({ ...validPost, futureField: { a: 1 }, reactions: 12 });
    expect(r.ok).toBe(true);
  });
});

describe("fetchCommunityPost — 先判地址，再守体积，只认 JSON", () => {
  it("正常：抓到并解析成结构化对象", async () => {
    const impl = fakeFetch({ text: body(validPost) });
    const r = await fetchCommunityPost(POST_URL, { fetchImpl: impl });
    if (!r.ok) throw new Error(r.reason);
    expect(r.post.title).toBe("插件配方：批量一");
  });

  it("地址不合法时**根本不发请求**（策略在抓取之前）", async () => {
    const impl = vi.fn(fakeFetch({ text: body(validPost) }));
    for (const bad of ["http://community.shuyo.cn/api/posts/1.json", "https://evil.example.com/api/posts/1.json"]) {
      const r = await fetchCommunityPost(bad, { fetchImpl: impl as unknown as FetchLike });
      expect(r.ok).toBe(false);
    }
    expect(impl).not.toHaveBeenCalled();
  });

  it("重定向到不允许的地方 → 拒（跟过去之前先看落地地址）", async () => {
    const impl = fakeFetch({ text: body(validPost), url: "https://evil.example.com/api/posts/30.json" });
    const r = await fetchCommunityPost(POST_URL, { fetchImpl: impl });
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("重定向到了不允许的地方") });
  });

  it("HTTP 错误码要说清是哪个码", async () => {
    const r = await fetchCommunityPost(POST_URL, { fetchImpl: fakeFetch({ status: 404, text: "nope" }) });
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("HTTP 404") });
  });

  it("返回网页（text/html）就说「不是 JSON」，不尽力抽正文", async () => {
    const r = await fetchCommunityPost(POST_URL, {
      fetchImpl: fakeFetch({ contentType: "text/html; charset=utf-8", text: "<html>…</html>" }),
    });
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("返回的不是 JSON") });
  });

  it("体积超限：**读的过程中**就停下（不靠 Content-Length）", async () => {
    const big = new Uint8Array(MAX_POST_JSON_BYTES + 1);
    const r = await fetchCommunityPost(POST_URL, { fetchImpl: fakeFetch({ chunks: [big] }) });
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("超过体积上限") });
  });

  it("坏 JSON 说清是解析失败，而不是当成空帖子", async () => {
    const r = await fetchCommunityPost(POST_URL, { fetchImpl: fakeFetch({ text: "{ not json" }) });
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("JSON 解析失败") });
  });

  it("超时会说清是超时（不是笼统的失败）", async () => {
    const impl = (async () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }) as unknown as FetchLike;
    const r = await fetchCommunityPost(POST_URL, { fetchImpl: impl, timeoutMs: 500 });
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("请求超时") });
  });

  it("没有流能力时退回整体读取，体积上限仍然生效", async () => {
    const okText = body(validPost);
    const r1 = await fetchCommunityPost(POST_URL, { fetchImpl: fakeFetch({ text: okText }) });
    expect(r1.ok).toBe(true);
    const huge = "x".repeat(MAX_POST_JSON_BYTES + 1);
    const r2 = await fetchCommunityPost(POST_URL, { fetchImpl: fakeFetch({ text: huge }) });
    expect(r2).toEqual({ ok: false, reason: expect.stringContaining("超过体积上限") });
  });
});
