// 判据：**四条被签名字节逐字**（任务书 §3 第 1 条点名）＋ 续期提示的四种口径。
//
// 这一族判据的价值全在"逐字"：把期望值**手写成字符串字面量**（⛔ 不调被测函数生成），
// 否则就是自己证明自己 —— 换行多一个、ts 写成字符串，测试照样绿。
import { describe, expect, it } from "vitest";

import { RENEW_WARN_DAYS, renewDecision } from "./renewPrompt";
import {
  SHA256_EMPTY,
  SIGNED_BYTES,
  nowTs,
  orderBytes,
  renewBytes,
  requestBytes,
  unbindBytes,
} from "./signedBytes";

describe("四条被签名字节（逐字）", () => {
  it("① 续期：SHUYO-RENEW-1\\n{卡}\\n{dev}\\n{ts}", () => {
    expect(renewBytes("SHUYO-LIC-1.aaa.bbb", "dev-0123456789abcdef", 1700000000)).toBe(
      "SHUYO-RENEW-1\nSHUYO-LIC-1.aaa.bbb\ndev-0123456789abcdef\n1700000000",
    );
  });

  it("② 轮询单：SHUYO-ORDER-1\\n{单号}\\n{dev}\\n{ts}", () => {
    expect(orderBytes("2026101800001", "dev-0123456789abcdef", 1700000000)).toBe(
      "SHUYO-ORDER-1\n2026101800001\ndev-0123456789abcdef\n1700000000",
    );
  });

  it("③ 解绑：SHUYO-UNBIND-1\\n{卡}\\n{by}\\n{target}\\n{ts}（target 含 query 整串）", () => {
    expect(
      unbindBytes("SHUYO-LIC-1.aaa.bbb", "dev-old", "/v1/devices?card=jti-1&dev=dev-old", 1700000000),
    ).toBe("SHUYO-UNBIND-1\nSHUYO-LIC-1.aaa.bbb\ndev-old\n/v1/devices?card=jti-1&dev=dev-old\n1700000000");
  });

  it("④ 普通请求：SHUYO-REQ-1\\n{METHOD}\\n{target}\\n{ts}\\n{sha256(body) hex}", () => {
    expect(requestBytes("GET", "/v1/devices?card=jti-1", 1700000000, SHA256_EMPTY)).toBe(
      "SHUYO-REQ-1\nGET\n/v1/devices?card=jti-1\n1700000000\n" +
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("⑤ 末尾**没有**换行（多一个 \\n 就会 401，而 401 看着像权限问题）", () => {
    for (const s of [
      renewBytes("c", "d", 1),
      orderBytes("o", "d", 1),
      unbindBytes("c", "b", "/v1/devices?x=1", 1),
      requestBytes("GET", "/x", 1, SHA256_EMPTY),
    ]) {
      expect(s.endsWith("\n"), `不该以换行结尾：${JSON.stringify(s.slice(-8))}`).toBe(false);
    }
  });

  it("⑥ 空 body 的 sha256 常量逐字（⛔ 不许写成「0」或省掉那一格）", () => {
    expect(SHA256_EMPTY).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(requestBytes("GET", "/x", 1, SHA256_EMPTY).split("\n")).toHaveLength(5);
  });

  it("⑦ 前缀四个各自独立（抄错一个前缀 ⇒ 服务端一律 401）", () => {
    expect(SIGNED_BYTES).toEqual({
      renew: "SHUYO-RENEW-1",
      order: "SHUYO-ORDER-1",
      unbind: "SHUYO-UNBIND-1",
      request: "SHUYO-REQ-1",
    });
  });

  it("⑧ ts 是**客户端自己算的 Unix 秒**（⛔ 不用本地时区格式串）", () => {
    expect(nowTs(1_700_000_000_999)).toBe(1_700_000_000);
    expect(String(nowTs())).toMatch(/^\d{10}$/);
  });
});

describe("续期提示的四种口径（任务书 §2）", () => {
  it("① active 且剩 ≤ 7 天 ⇒ renew；剩更多 ⇒ 什么都不提示", () => {
    expect(renewDecision("active", RENEW_WARN_DAYS).action).toBe("renew");
    expect(renewDecision("active", RENEW_WARN_DAYS + 1)).toEqual({ action: "none", text: "" });
  });

  it("② grace / expired ⇒ 必须提示（宽限一过就静默断网）", () => {
    expect(renewDecision("grace", 3).action).toBe("renew");
    expect(renewDecision("expired", 0).action).toBe("renew");
  });

  it("③ stopped ⇒ ⛔ **不提示续期**，而是「重新开通」（停卡 ≠ 过期）", () => {
    const d = renewDecision("stopped", 0);
    expect(d.action).toBe("reopen");
    expect(d.text).toContain("已停卡");
    expect(d.text).toContain("只停了跨网");
    expect(d.text, "⛔ 停卡那张卡上不许出现「已过期」").not.toContain("已过期");
    expect(d.text, "⛔ 也不许让人去点续期").not.toContain("续期");
  });

  it("④ not-yet ⇒ 不提示", () => {
    expect(renewDecision("not-yet", 30)).toEqual({ action: "none", text: "" });
  });
});
