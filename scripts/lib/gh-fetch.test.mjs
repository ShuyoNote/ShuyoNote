// `scripts/lib/gh-fetch.mjs` 的判据（**不碰真网络**：`fetchImpl` 注入）。
//
// 这六条就是与 windows 商定的约束本身 —— 有一条没有判据，它就会在下一次"顺手兜底"里悄悄失效：
//   ① 默认不钉 IP；② 只对网络类失败兜底；③ 404 不兜底；④ 走过的路进日志；
//   ⑤ 两条路都给 sha256；⑥ 纯函数可测（本文件）。
import { describe, expect, it, vi } from "vitest";

import { classifyError, classifyStatus, fetchWithFallback, planAttempts, sha256Hex } from "./gh-fetch.mjs";

const URL_ = "https://api.github.com/repos/o/r/releases/tags/v1";
const PINNED = "140.82.113.6";

/** 造一个假的 fetch：按 URL 命中给响应；未命中按顺序吐预设结果。 */
function fakeFetch(script) {
  const calls = [];
  const impl = vi.fn(async (url, opts) => {
    calls.push({ url, host: opts?.headers?.Host });
    const step = script.shift();
    if (!step) throw new Error("fakeFetch: 脚本用完了");
    if (step.throw) {
      const e = new Error(step.message || "fetch failed");
      e.code = step.code;
      throw e;
    }
    return {
      ok: step.status >= 200 && step.status < 300,
      status: step.status,
      arrayBuffer: async () => new TextEncoder().encode(step.body ?? "").buffer,
    };
  });
  return { impl, calls };
}

const netErr = (code = "ENOTFOUND") => ({ throw: true, code, message: "getaddrinfo ENOTFOUND" });

describe("① 默认不钉 IP", () => {
  it("没给 pinnedIp ⇒ 只有一次直连尝试，URL 里不出现 IP", () => {
    const attempts = planAttempts(URL_);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].label).toBe("direct");
    expect(attempts[0].url).toBe(URL_);
    expect(attempts[0].url).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });

  it("给了 pinnedIp ⇒ 第二条把目标换成 IP，但 **Host 头保持原主机名**（否则 SNI/证书就对不上了）", () => {
    const attempts = planAttempts(URL_, { pinnedIp: PINNED });
    expect(attempts.map((a) => a.label)).toEqual(["direct", "pinned-ip"]);
    expect(attempts[1].url.startsWith(`https://${PINNED}/`)).toBe(true);
    expect(attempts[1].host).toBe("api.github.com");
  });
});

describe("② 只对网络类失败兜底", () => {
  it("直连网络类失败 + 有钉 IP ⇒ 退第二条，最终 how=pinned-ip（且**只**调了两次）", async () => {
    const { impl, calls } = fakeFetch([netErr(), { status: 200, body: "ok" }]);
    const r = await fetchWithFallback(URL_, { pinnedIp: PINNED, fetchImpl: impl });
    expect(r.ok).toBe(true);
    expect(r.how).toBe("pinned-ip");
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toContain(PINNED);
    expect(calls[1].host).toBe("api.github.com");
  });

  it("直连成功 ⇒ **不**走第二条（别为了'更稳'把一次成功变成两次请求）", async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: "ok" }]);
    const r = await fetchWithFallback(URL_, { pinnedIp: PINNED, fetchImpl: impl });
    expect(r.ok).toBe(true);
    expect(r.how).toBe("direct");
    expect(calls).toHaveLength(1);
  });

  it("错误分类：网络类 vs 其它（分类只有一处，调用点不许再写兜底）", () => {
    expect(classifyError({ code: "ENOTFOUND" }).kind).toBe("network");
    expect(classifyError({ code: "UND_ERR_CONNECT_TIMEOUT" }).kind).toBe("network");
    expect(classifyError(new Error("getaddrinfo ENOTFOUND api.github.com")).kind).toBe("network");
    expect(classifyError(new Error("某种解析失败")).kind).toBe("other");
    expect(classifyStatus(404).kind).toBe("notfound");
    expect(classifyStatus(500).retryable).toBe(true);
    expect(classifyStatus(403).retryable).toBe(false);
  });
});

describe("③ 404（以及其它 4xx/5xx）**绝不**兜底", () => {
  it("直连 404 + 有钉 IP ⇒ 不换路，原样把 404 带回来", async () => {
    const { impl, calls } = fakeFetch([{ status: 404 }]);
    const r = await fetchWithFallback(URL_, { pinnedIp: PINNED, fetchImpl: impl });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
    expect(calls).toHaveLength(1); // ★ 关键：没有第二次
    expect(r.log.join("\n")).toMatch(/不兜底/);
  });

  it("直连 500 + 有钉 IP ⇒ 也不换路（换 IP 不会把 5xx 变成 200）", async () => {
    const { impl, calls } = fakeFetch([{ status: 500 }]);
    const r = await fetchWithFallback(URL_, { pinnedIp: PINNED, fetchImpl: impl });
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("网络类失败但**没给**钉 IP ⇒ 直接失败（不许自己造一个 IP 出来）", async () => {
    const { impl, calls } = fakeFetch([netErr()]);
    const r = await fetchWithFallback(URL_, { fetchImpl: impl });
    expect(r.ok).toBe(false);
    expect(r.how).toBe("none");
    expect(calls).toHaveLength(1);
    expect(r.failure.kind).toBe("network");
  });

  it("★ **非**网络类错误 + 有钉 IP ⇒ 也**不**兜底（否则「只对网络类兜底」这条等于没有）", async () => {
    // 这条是这套约束里最容易悄悄失效的一格：写兜底的人很容易 catch 一切。
    const { impl, calls } = fakeFetch([{ throw: true, code: "ERR_SOMETHING_ELSE", message: "某种解析失败" }]);
    const r = await fetchWithFallback(URL_, { pinnedIp: PINNED, fetchImpl: impl });
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(1);
    expect(r.failure.kind).toBe("other");
  });
});

describe("④⑤ 日志如实 + 两条路都给 sha256", () => {
  it("日志里能看到走过的路（direct / pinned-ip 与原因）", async () => {
    const { impl } = fakeFetch([netErr(), { status: 200, body: "ok" }]);
    const r = await fetchWithFallback(URL_, { pinnedIp: PINNED, fetchImpl: impl });
    const log = r.log.join("\n");
    expect(log).toMatch(/direct:/);
    expect(log).toMatch(/pinned-ip:/);
    expect(log).toMatch(/网络类/);
  });

  it("两条路拿到同一份字节 ⇒ 同一个 sha256（且与已知值一致）", async () => {
    const body = "same-bytes";
    const expected = sha256Hex(Buffer.from(body));
    const a = await fetchWithFallback(URL_, { pinnedIp: PINNED, fetchImpl: fakeFetch([{ status: 200, body }]).impl });
    const b = await fetchWithFallback(URL_, {
      pinnedIp: PINNED,
      fetchImpl: fakeFetch([netErr(), { status: 200, body }]).impl,
    });
    expect(a.sha256).toBe(expected);
    expect(b.sha256).toBe(expected);
    expect(a.how).toBe("direct");
    expect(b.how).toBe("pinned-ip");
  });
});
