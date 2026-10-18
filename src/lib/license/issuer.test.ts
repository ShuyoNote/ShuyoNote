// 判据：发卡站三条流程的**请求形状**（任务书 §3 点名：下单请求里没有价钱、轮询 Authorization 格式）。
//
// 全部注入假 transport / 假 signer ⇒ **一次网都不出**。
import { describe, expect, it } from "vitest";

import {
  createOrder,
  createOrderBody,
  deviceAuthHeader,
  isIssuerConfigured,
  pollOrder,
  pollOrderPath,
  renew,
  unbindDevice,
  unbindBody,
} from "./issuer";
import { orderBytes, renewBytes, unbindBytes } from "./signedBytes";

const DEV = "dev-0123456789abcdef";

/** 收集调用：既当 signer，又当 transport。 */
function harness(reply: unknown) {
  const signed: string[] = [];
  const calls: Array<{ url: string; method: string; headers?: Record<string, string>; body?: string }> = [];
  return {
    signed,
    calls,
    signer: async (bytes: string) => {
      signed.push(bytes);
      return "SIG";
    },
    transport: async (url: string, init: { method: string; headers?: Record<string, string>; body?: string }) => {
      calls.push({ url, ...init });
      return { status: 200, text: async () => JSON.stringify(reply) };
    },
  };
}

describe("配置与头", () => {
  it("① 没配地址 ⇒ false（界面据此整块关掉，⛔ 不显示假按钮）", () => {
    expect(isIssuerConfigured(undefined)).toBe(false);
    expect(isIssuerConfigured("")).toBe(false);
    expect(isIssuerConfigured("   ")).toBe(false);
    expect(isIssuerConfigured("不是网址")).toBe(false);
    expect(isIssuerConfigured("https://license.shuyo.cn")).toBe(true);
    expect(isIssuerConfigured("http://127.0.0.1:8789")).toBe(true);
  });

  it("② Device 头逐字：`Device {dev}:{ts}:{sig}`", () => {
    expect(deviceAuthHeader(DEV, 1700000000, "SIG")).toBe(`Device ${DEV}:1700000000:SIG`);
  });
});

describe("开通（下单）", () => {
  it("① 请求体**没有价钱**（客户端不算也不传 —— 价钱由发卡站按配置算）", () => {
    const body = createOrderBody({ sub: "h_sub", days: 30, dev: DEV, pubkey: "PUB", seats: 3 });
    expect(body).toEqual({ sub: "h_sub", days: 30, dev: DEV, pubkey: "PUB", seats: 3 });
    for (const k of Object.keys(body)) {
      expect(/price|amount|money|fee|charge|cny|yuan/i.test(k), `⛔ 请求体里不许出现价钱字段：${k}`).toBe(false);
    }
  });

  it("② 不传 seats 就不带这一格（⛔ 不塞 seats:0 之类默认值）", () => {
    expect(createOrderBody({ sub: "s", days: 7, dev: DEV, pubkey: "P" })).not.toHaveProperty("seats");
  });

  it("③ 下单走 POST /v1/orders，带 Device 头；返回里带 payUrl", async () => {
    const h = harness({ outTradeNo: "N1", amountCents: 1500, payUrl: "https://pay.example/alipay" });
    const r = await createOrder(
      { baseUrl: "https://license.shuyo.cn", signer: h.signer, transport: h.transport, now: () => 1700000000 },
      { sub: "s", days: 30, dev: DEV, pubkey: "P" },
    );
    expect(r).toEqual({ outTradeNo: "N1", amountCents: 1500, payUrl: "https://pay.example/alipay" });
    expect(h.calls[0].url).toBe("https://license.shuyo.cn/v1/orders");
    expect(h.calls[0].method).toBe("POST");
    expect(h.calls[0].headers?.Authorization).toBe(`Device ${DEV}:1700000000:SIG`);
  });
});

describe("轮询单", () => {
  it("① 路径逐字：`/v1/orders/{no}`（单号要 URL 编码）", () => {
    expect(pollOrderPath("N1")).toBe("/v1/orders/N1");
    expect(pollOrderPath("a/b")).toBe("/v1/orders/a%2Fb");
  });

  it("② Authorization 是 `Device {dev}:{ts}:{sig}`，且 sig 是**对轮询单字节**签的", async () => {
    const h = harness({ status: "paid", card: "SHUYO-LIC-1.x.y" });
    const out = await pollOrder(
      { baseUrl: "http://127.0.0.1:8789", dev: DEV, signer: h.signer, transport: h.transport, now: () => 1700000000 },
      "N1",
    );
    expect(out).toEqual({ status: "paid", card: "SHUYO-LIC-1.x.y" });
    // 被签名的字节必须逐字等于 orderBytes（⛔ 不能是 requestBytes）
    expect(h.signed[0]).toBe(orderBytes("N1", DEV, 1700000000));
    expect(h.calls[0].headers?.Authorization).toBe(`Device ${DEV}:1700000000:SIG`);
    expect(h.calls[0].url).toBe("http://127.0.0.1:8789/v1/orders/N1");
  });

  it("③ 未支付 ⇒ pending（⛔ 别把 pending 当失败炸给用户）", async () => {
    const h = harness({ status: "pending" });
    const out = await pollOrder(
      { baseUrl: "http://x", dev: DEV, signer: h.signer, transport: h.transport, now: () => 1 },
      "N1",
    );
    expect(out).toEqual({ status: "pending" });
  });
});

describe("续期与解绑", () => {
  it("① 续期：签的是续期字节，体里带 sig；返回新卡 + 租约", async () => {
    const h = harness({ card: "NEW", lease: "TOK", jti: "j2", rot: 1, exp: 2, leaseJti: "l2", leaseExp: 3 });
    const out = await renew(
      { baseUrl: "http://x", dev: DEV, signer: h.signer, transport: h.transport, now: () => 42 },
      "OLD",
    );
    expect(out.card).toBe("NEW");
    expect(out.lease).toBe("TOK");
    expect(h.signed[0]).toBe(renewBytes("OLD", DEV, 42));
    expect(JSON.parse(h.calls[0].body ?? "{}")).toMatchObject({ card: "OLD", dev: DEV, ts: 42, sig: "SIG" });
  });

  it("② 解绑：`target` 含 query 整串，且**它参与签名**", async () => {
    const h = harness({ ok: true });
    const target = "/v1/devices?card=jti-1&dev=dev-old";
    await unbindDevice(
      { baseUrl: "http://x", dev: DEV, signer: h.signer, transport: h.transport, now: () => 7 },
      { card: "C", by: DEV, target },
    );
    expect(h.signed[0]).toBe(unbindBytes("C", DEV, target, 7));
    expect(h.signed[0]).toContain("card=jti-1&dev=dev-old");
    expect(JSON.parse(h.calls[0].body ?? "{}")).toMatchObject({ confirm: true, target });
  });

  it("③ 解绑体里必须有 `confirm: true`（规格 §7：没有它服务端拒绝）", () => {
    expect(unbindBody({ card: "C", by: "b", target: "/x?y=1", ts: 1, sig: "s" })).toEqual({
      card: "C",
      by: "b",
      target: "/x?y=1",
      confirm: true,
      ts: 1,
      sig: "s",
    });
  });
});
