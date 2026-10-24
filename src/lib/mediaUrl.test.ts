// ⭐ 2026-10-24（owner 报「图片块同步不正常」）：渲染期"按 hash 解析媒体地址"的顺序判据。
//
// 真机现场：Windows 的页面里图片块 `src` 是 `http://attachment.localhost/C:\Users\…`（本机绝对地址），
// 同步到 macOS 后那个地址不存在；而桌面渲染只认 `src` ⇒ 碎图。修法要求三条顺序都成立：
//   ① 本机盘上有字节 ⇒ 直接用本机 hash 地址（**不看** `src`）；
//   ② 本机没有 ⇒ 先按需取回（服务端/对端），成功后**再解析一次**（URL 串相同也要能触发重载）；
//   ③ 取不回 ⇒ 回落 `src`（保持旧行为，不把老数据画成空白）。
// Web 那条保持原样（blobStore → object URL）。
import { describe, expect, it, vi } from "vitest";
import { resolveMediaUrl, type MediaUrlDeps } from "./mediaUrl";

function deps(over: Partial<MediaUrlDeps> = {}): MediaUrlDeps {
  return {
    desktop: true,
    localPathForHash: vi.fn(async () => ""),
    urlForPath: (p) => `attachment://localhost/${p}`,
    fetchBytes: vi.fn(async () => false),
    readBlob: vi.fn(async () => null),
    objectUrl: () => "blob:fake",
    ...over,
  };
}

describe("resolveMediaUrl · 同步过来的图片怎么显示", () => {
  it("① 本机已有字节 ⇒ 用 hash 解析出的本机地址（⛔ 不是同步过来的那个绝对 src）", async () => {
    const d = deps({ localPathForHash: vi.fn(async () => "/data/att/aa/x.jpg") });
    const url = await resolveMediaUrl(
      { hash: "aa".repeat(32), src: "http://attachment.localhost/C%3A%5CUsers%5Cwin%5Cx.jpg" },
      d,
    );
    expect(url).toBe("attachment://localhost//data/att/aa/x.jpg");
    expect(d.fetchBytes).not.toHaveBeenCalled();
  });

  it("② 本机没有 ⇒ 按需取回后再解析，且 URL 串必须与失败那次**不同**（否则 <img> 不会重试）", async () => {
    let hasBytes = false;
    const d = deps({
      localPathForHash: vi.fn(async () => {
        if (!hasBytes) throw new Error("附件不存在");
        return "/data/att/bb/y.jpg";
      }),
      fetchBytes: vi.fn(async () => {
        hasBytes = true;
        return true;
      }),
      retryTag: () => "#r1",
    });
    const url = await resolveMediaUrl({ hash: "bb".repeat(32), src: "foreign" }, d);
    expect(d.fetchBytes).toHaveBeenCalledTimes(1);
    expect(url).toBe("attachment://localhost//data/att/bb/y.jpg#r1");
  });

  it("③ 取不回 ⇒ 回落 src（旧行为，不把老数据画成空白）", async () => {
    const d = deps({ localPathForHash: vi.fn(async () => { throw new Error("附件不存在"); }) });
    const url = await resolveMediaUrl({ hash: "cc".repeat(32), src: "fallback.png" }, d);
    expect(url).toBe("fallback.png");
    expect(d.fetchBytes).toHaveBeenCalledTimes(1);
  });

  it("没有 hash ⇒ 原样用 src（老内容不做任何解析）", async () => {
    const d = deps();
    expect(await resolveMediaUrl({ src: "legacy.png" }, d)).toBe("legacy.png");
    expect(d.localPathForHash).not.toHaveBeenCalled();
    expect(d.fetchBytes).not.toHaveBeenCalled();
  });

  it("Web 档保持原样：blobStore 有字节 ⇒ object URL；没有 ⇒ 回落 src", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const withBytes = deps({ desktop: false, readBlob: vi.fn(async () => bytes) });
    expect(await resolveMediaUrl({ hash: "dd".repeat(32), src: "x" }, withBytes)).toBe("blob:fake");

    const empty = deps({ desktop: false, readBlob: vi.fn(async () => null) });
    expect(await resolveMediaUrl({ hash: "dd".repeat(32), src: "x" }, empty)).toBe("x");
  });
});
