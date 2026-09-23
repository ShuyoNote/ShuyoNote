// `remote-fact.mjs` 的判据 —— 这一族的风险不是"算错"，而是**把两种东西混成一种**：
// 把"我没取到"报成红（人开始忽略这条红），或把"资源不在/值不符"放过（真问题被放过）。
// 所以下表逐格钉住，**两侧都钉**：该红的必须红，该"未实查"的必须"未实查"。

import { describe, expect, it } from "vitest";

import { fetchVerdict, isRed } from "./remote-fact.mjs";

describe("远端事实的三态判定", () => {
  it("HTTP 2xx ⇒ 通过（值对不对不在这里判）", () => {
    const v = fetchVerdict({ ok: true, status: 200 });
    expect(v.kind).toBe("ok");
    expect(isRed(v)).toBe(false);
  });

  it("★ 404 ⇒ **红**（资源不在是事实，不是网络问题）", () => {
    const v = fetchVerdict({ ok: false, status: 404 });
    expect(v.kind).toBe("red");
    expect(isRed(v)).toBe(true);
    expect(v.why).toContain("事实");
  });

  it("★ 401/403 ⇒ **未实查**（凭据问题不能当「我们发错了」）", () => {
    for (const status of [401, 403]) {
      const v = fetchVerdict({ ok: false, status });
      expect(v.kind, `HTTP ${status}`).toBe("unverified");
      expect(isRed(v)).toBe(false);
    }
  });

  it("★ 5xx / 429 / 其它 4xx ⇒ **未实查**（服务端或我们的请求有问题，不足以判定）", () => {
    for (const status of [500, 502, 503, 429, 400, 410]) {
      const v = fetchVerdict({ ok: false, status });
      expect(v.kind, `HTTP ${status}`).toBe("unverified");
      expect(isRed(v)).toBe(false);
    }
  });

  it("★ 网络类失败（两条路都走完）⇒ **未实查**（到不了 ≠ 东西不对）", () => {
    for (const code of [
      "ENOTFOUND",
      "ETIMEDOUT",
      "exhausted",
      "UND_ERR_CONNECT_TIMEOUT",
      // ★ 实测那条：钉 IP 在 HTTPS 上会被 SNI/证书校验拒（`planAttempts` 上方有实测与取舍）——
      //   它也是"没查成"，**不是**"线上不对"。
      "ERR_TLS_CERT_ALTNAME_INVALID",
    ]) {
      const v = fetchVerdict({ ok: false, status: null, failure: { kind: "network", code } });
      expect(v.kind, code).toBe("unverified");
      expect(isRed(v)).toBe(false);
      expect(v.why).toContain("到不了");
    }
  });

  it("状态为 null 又没有 failure ⇒ 仍按「未实查」（不猜成红）", () => {
    const v = fetchVerdict({ ok: false, status: null });
    expect(v.kind).toBe("unverified");
    expect(isRed(v)).toBe(false);
  });

  it("★ 反向：**只有** red 会让自检红（`ok` 与 `unverified` 都不红）", () => {
    // 这条是"别把 unverified 也做成红"的守门判据：三态里只有一态该红。
    expect([fetchVerdict({ ok: true, status: 200 }), fetchVerdict({ ok: false, status: 503 }), fetchVerdict({ ok: false, status: null, failure: { kind: "network", code: "EAI_AGAIN" } })].map(isRed)).toEqual([
      false,
      false,
      false,
    ]);
    expect(isRed(fetchVerdict({ ok: false, status: 404 }))).toBe(true);
  });
});
