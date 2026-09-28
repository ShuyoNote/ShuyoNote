// `gh-asset-fetch.mjs` 的判据 —— **注入 fetchImpl，全程不碰网络**。
//
// ⚠️ 这里**故意不测 curl 兜底那条**：`curlGet` 用的是真的 curl 子进程，测它就得真上网。
// 那条路的实测读数记在 `docs/TESTING.md` 的「取 GitHub 资产：两条路……」一节（含 `--list` 与
// 真下载的字节数/sha256）。这里钉的是**注入得到的那半边**：直连成功、结果类不换路、取错/取空、
// 哈希不符、以及"凭据/钉 IP"的环境读取。

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  DEFAULT_API_IP,
  fetchAssetTo,
  fetchReleaseJson,
  parseJson,
  readToken,
  resolveApiIp,
  splitStatus,
} from "./gh-asset-fetch.mjs";

const dir = mkdtempSync(join(tmpdir(), "gh-asset-fetch-test-"));
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 清不掉不影响判据 */
  }
});

const RELEASE = {
  tag_name: "v1.2.3",
  assets: [
    { id: 11, name: "tool-win-x64.tgz", size: 3 },
    { id: 12, name: "tool-linux-x64.tgz", size: 3 },
  ],
};

/** 按 URL 分派的假 fetch：元数据给 JSON，资产端点给字节。 */
function fakeFetch({ release = RELEASE, releaseStatus = 200, assetStatus = 200, assetBody = Buffer.from("abc"), throwOn } = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    if (throwOn && url.includes(throwOn)) {
      const e = new Error("fetch failed");
      e.code = "ENOTFOUND";
      throw e;
    }
    if (url.includes("/releases/assets/")) {
      if (assetStatus !== 200) return new Response("not found", { status: assetStatus });
      return new Response(assetBody, { status: 200 });
    }
    if (releaseStatus !== 200) return new Response("nope", { status: releaseStatus });
    return new Response(JSON.stringify(release), { status: 200, headers: { "content-type": "application/json" } });
  };
  impl.calls = calls;
  return impl;
}

const noToken = { token: "" };
const outPath = (n) => join(dir, n);

describe("环境读取", () => {
  it("钉的 IP：`GH_API_IP` > `DSH_GITHUB_API_IP` > 默认（后者为兼容旧的 .tools 脚本）", () => {
    expect(resolveApiIp({})).toBe(DEFAULT_API_IP);
    expect(resolveApiIp({ DSH_GITHUB_API_IP: "1.1.1.1" })).toBe("1.1.1.1");
    expect(resolveApiIp({ GH_API_IP: "2.2.2.2", DSH_GITHUB_API_IP: "1.1.1.1" })).toBe("2.2.2.2");
  });

  it("凭据：显式 `GITHUB_TOKEN` 优先；没有就回落到 `~/.git-credentials` 里那把 ghp_（读不到 ⇒ 空，不抛）", () => {
    expect(readToken({ GITHUB_TOKEN: "ghp_x", USERPROFILE: dir })).toBe("ghp_x");
    const fakeHome = mkdtempSync(join(dir, "home-"));
    writeFileSync(join(fakeHome, ".git-credentials"), "https://user:ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA@github.com\n", "utf8");
    expect(readToken({ USERPROFILE: fakeHome })).toBe("ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(readToken({ USERPROFILE: join(dir, "nope") })).toBe("");
  });
});

describe("`curl -w` 尾巴与 JSON 解析", () => {
  it("状态码在最后一段 ⇒ 切得回来；没有标记 ⇒ 状态码是 null（不许猜成 200）", () => {
    expect(splitStatus('{"a":1}\n__FETCH_GH_ASSET_STATUS__200')).toEqual({ body: '{"a":1}', status: 200 });
    expect(splitStatus("plain")).toEqual({ body: "plain", status: null });
  });

  it("先剥 BOM；不是 JSON ⇒ 抛出的消息里带前 120 字（便于判是不是错误页）", () => {
    expect(parseJson("\uFEFF{\"a\":1}")).toEqual({ a: 1 });
    expect(() => parseJson("<html>nope</html>")).toThrow(/不是 JSON/);
  });
});

describe("取 release 元数据", () => {
  it("直连成功 ⇒ 走 direct，步骤里只有 [direct]，不出现任何 curl 字样", async () => {
    const f = fakeFetch();
    const r = await fetchReleaseJson({ repo: "a/b", tag: "v1.2.3", fetchImpl: f, ...noToken });
    expect(r.ok).toBe(true);
    expect(r.how).toBe("direct");
    expect(r.json.tag_name).toBe("v1.2.3");
    expect(r.steps.join(" ")).toContain("[direct]");
    expect(r.steps.join(" ")).not.toContain("curl");
  });

  it("★ 404 ⇒ 立即停、**不换路**（steps 里不许出现「退到 curl」），措辞点明「不是网络故障」", async () => {
    const r = await fetchReleaseJson({ repo: "a/b", tag: "nope", fetchImpl: fakeFetch({ releaseStatus: 404 }), ...noToken });
    expect(r.ok).toBe(false);
    expect(r.steps.join(" ")).not.toContain("退到 curl");
    expect(r.message).toContain("不是网络故障");
  });

  it("★ 403/500 同样不换路（结果类不是网络类）", async () => {
    for (const code of [401, 403, 500, 503, 429]) {
      const r = await fetchReleaseJson({ repo: "a/b", tag: "t", fetchImpl: fakeFetch({ releaseStatus: code }), ...noToken });
      expect(r.ok, `HTTP ${code}`).toBe(false);
      expect(r.steps.join(" "), `HTTP ${code}`).not.toContain("退到 curl");
    }
  });

  it("远端返回的不是 JSON（代理的错误页）⇒ 如实报成失败，且消息里带前 120 字", async () => {
    const impl = async () => new Response("<html>proxy</html>", { status: 200 });
    const r = await fetchReleaseJson({ repo: "a/b", tag: "t", fetchImpl: impl, ...noToken });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("不是 JSON");
    expect(r.message).toContain("<html>");
    expect(r.how).toBe("direct");
  });
});

describe("取资产到文件", () => {
  it("直连成功 + 哈希一致 ⇒ ok；落盘字节数与文件内容都对", async () => {
    const out = outPath("ok.bin");
    const r = await fetchAssetTo({ repo: "a/b", tag: "v1.2.3", match: "win-x64", out, fetchImpl: fakeFetch(), ...noToken });
    expect(r.ok).toBe(true);
    expect(r.asset.name).toBe("tool-win-x64.tgz");
    expect(r.bytes).toBe(3);
    expect(readFileSync(out, "utf8")).toBe("abc");
    expect(r.verdict.kind).toBe("skipped"); // 没给期望值 = 未校验，不许假装通过
  });

  it("★ 哈希不符 ⇒ ok:false 且**两边都报**（文件留着让人自己看，不静默删）", async () => {
    const out = outPath("bad.bin");
    const r = await fetchAssetTo({ repo: "a/b", tag: "v1.2.3", match: "win-x64", out, wantSha: "f".repeat(64), fetchImpl: fakeFetch(), ...noToken });
    expect(r.ok).toBe(false);
    expect(r.verdict.kind).toBe("mismatch");
    expect(r.verdict.message).toMatch(/实际 [0-9a-f]{12}/);
    expect(readFileSync(out, "utf8")).toBe("abc");
  });

  it("★ 资产端点 404 ⇒ 结果类，不换路、也不落盘", async () => {
    const out = outPath("asset404.bin");
    const r = await fetchAssetTo({ repo: "a/b", tag: "v1.2.3", match: "win-x64", out, fetchImpl: fakeFetch({ assetStatus: 404 }), ...noToken });
    expect(r.ok).toBe(false);
    expect(r.steps.join(" ")).not.toContain("退到 curl");
    expect(r.message).toContain("结果类");
  });

  it("★ 名字多命中 ⇒ 拒绝并列出候选（静默取第一个 = 取错东西），且**一次下载都没发起**", async () => {
    const f = fakeFetch();
    const r = await fetchAssetTo({ repo: "a/b", tag: "v1.2.3", match: "tool-", out: outPath("many.bin"), fetchImpl: f, ...noToken });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("更精确");
    expect(f.calls.filter((u) => u.includes("/releases/assets/"))).toHaveLength(0);
  });

  it("名字没命中 ⇒ 把现有资产名列出来（人要知道该写什么子串）", async () => {
    const r = await fetchAssetTo({ repo: "a/b", tag: "v1.2.3", match: "nosuch", out: outPath("none.bin"), fetchImpl: fakeFetch(), ...noToken });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("tool-win-x64.tgz");
  });

  it("release JSON 形状不对（没有 assets）⇒ 如实报，别当成「没有匹配的资产」", async () => {
    const impl = async () => new Response(JSON.stringify({ tag_name: "v1" }), { status: 200 });
    const r = await fetchAssetTo({ repo: "a/b", tag: "v1", match: "x", out: outPath("shape.bin"), fetchImpl: impl, ...noToken });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("没有 assets 数组");
  });
});
