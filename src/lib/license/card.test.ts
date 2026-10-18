// 判据：卡解析 / 五态边界 / 挑当前代 / 停卡文案（任务书 §3 点名要的那几条）。
//
// ⚠️ 这一族判据最容易写成"看着绿"：只测 happy path、或者把容差写成 `<=` 却没人验边界。
//    所以下面每条都钉**边界两侧**的逐字读数。
import { describe, expect, it } from "vitest";

import {
  CLOCK_TOLERANCE_SECS,
  graceDaysLeft,
  CROSSNET_CAP,
  cardState,
  crossnetAllowed,
  daysLeft,
  parseCard,
  pickCurrent,
} from "./card";
import type { LicenseClaims } from "./types";

const b64url = (s: string): string =>
  btoa(String.fromCharCode(...new TextEncoder().encode(s)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** 造一张**形状合法**的卡（签名是假的 64 字节 —— 验签不在这条判据的范围内）。 */
function makeCard(over: Partial<LicenseClaims> = {}, head = "SHUYO-LIC-1"): string {
  const payload: LicenseClaims = {
    v: 1,
    typ: "card",
    sub: "h_sub",
    dev: ["dev-abc"],
    seats: 3,
    nbf: 1_000_000,
    exp: 1_000_000 + 30 * 86_400,
    grace: 14,
    kid: "k1",
    iat: 1_000_000,
    jti: "jti-1",
    cap: [CROSSNET_CAP],
    rot: 0,
    ...over,
  };
  const sig = b64url("x".repeat(64));
  return `${head}.${b64url(JSON.stringify(payload))}.${sig}`;
}

const parseOk = (text: string): LicenseClaims => {
  const r = parseCard(text);
  if (!r.ok) throw new Error(`应当解析成功，实际 ${r.error}`);
  return r.payload;
};

describe("parseCard —— 形状与版本", () => {
  it("① 正常卡解析得出来，字段逐字对上", () => {
    const p = parseOk(makeCard({ jti: "jti-9", rot: 3 }));
    expect(p.jti).toBe("jti-9");
    expect(p.rot).toBe(3);
    expect(p.cap).toEqual([CROSSNET_CAP]);
  });

  it("② 版本号在最外层：`SHUYO-LIC-2.*` ⇒ VERSION（⛔ 不许报 MALFORMED/BAD_SIG）", () => {
    const r = parseCard(makeCard({}, "SHUYO-LIC-2"));
    expect(r).toEqual({ ok: false, error: "VERSION" });
  });

  it("③ 坏形状一律 MALFORMED（前缀/段数/base64url/JSON 任一坏掉）", () => {
    for (const bad of [
      "",
      "hello",
      "SHUYO-LIC-1.only-two-segments",
      "SHUYO-LIC-1.^^^.###",
      `SHUYO-LIC-1.${b64url("{not json")}.${b64url("x".repeat(64))}`,
      // 签名长度不是 64
      `SHUYO-LIC-1.${b64url(JSON.stringify({ v: 1 }))}.${b64url("short")}`,
    ]) {
      expect(parseCard(bad), `应当 MALFORMED：${bad.slice(0, 24)}`).toEqual({ ok: false, error: "MALFORMED" });
    }
  });

  it("④ 必填字段缺一个 ⇒ MALFORMED（⛔ 不补默认值）", () => {
    const full = JSON.parse(new TextDecoder().decode(
      Uint8Array.from(atob(b64url(JSON.stringify({
        v: 1, typ: "card", sub: "s", dev: ["d"], seats: 3, nbf: 1, exp: 2, grace: 14,
        kid: "k", iat: 1, jti: "j", cap: [], rot: 0,
      })).replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)),
    )) as Record<string, unknown>;
    for (const key of Object.keys(full)) {
      if (key === "v") continue; // v 单独测过
      const one = { ...full };
      delete one[key];
      const card = `SHUYO-LIC-1.${b64url(JSON.stringify(one))}.${b64url("x".repeat(64))}`;
      expect(parseCard(card), `缺 ${key} 应当 MALFORMED`).toEqual({ ok: false, error: "MALFORMED" });
    }
  });

  it("⑤ dev 比 seats 多 ⇒ MALFORMED（签发侧的错，但客户端读不懂就是读不懂）", () => {
    expect(parseCard(makeCard({ dev: ["a", "b", "c", "d"], seats: 3 }))).toEqual({ ok: false, error: "MALFORMED" });
  });
});

describe("cardState —— 五态与 ±10 分钟容差（边界两侧都钉）", () => {
  const base: LicenseClaims = {
    v: 1, typ: "card", sub: "s", dev: ["d"], seats: 3,
    nbf: 1000, exp: 2000, grace: 14, kid: "k", iat: 1000, jti: "j", cap: [CROSSNET_CAP], rot: 0,
  };
  const T = CLOCK_TOLERANCE_SECS;

  it("① not-yet：`now < nbf - 容差` 才是；**容差内算有效**", () => {
    expect(cardState(base, base.nbf - T - 1)).toBe("not-yet");
    expect(cardState(base, base.nbf - T)).toBe("active"); // 恰好压在容差边界 ⇒ 有效
    expect(cardState(base, base.nbf - T + 1)).toBe("active");
  });

  it("② active → grace → expired：容差在 `exp` 与 `exp+grace` 两处都生效", () => {
    expect(cardState(base, base.exp + T)).toBe("active"); // exp 之后但仍在容差内
    expect(cardState(base, base.exp + T + 1)).toBe("grace");
    const graceEnd = base.exp + base.grace * 86_400;
    expect(cardState(base, graceEnd + T)).toBe("grace"); // 宽限末尾的容差内
    expect(cardState(base, graceEnd + T + 1)).toBe("expired");
  });

  it("③ 停卡：`cap` 里没有 crossnet ⇒ stopped（⛔ 不因为「过期了」就报 expired）", () => {
    const stopped = { ...base, cap: [] as string[] };
    expect(cardState(stopped, base.nbf + 10)).toBe("stopped");
    // 即使时间上早已过了宽限，也仍然是 stopped —— 用户要看到的是"只停了跨网"
    expect(cardState(stopped, base.exp + base.grace * 86_400 + 10)).toBe("stopped");
    expect(cardState({ ...base, cap: ["other"] }, base.nbf + 10)).toBe("stopped");
  });

  it("④ 只有 active/grace 放行跨网；stopped/expired/not-yet 一律不放", () => {
    expect(crossnetAllowed("active")).toBe(true);
    expect(crossnetAllowed("grace")).toBe(true);
    for (const s of ["stopped", "expired", "not-yet"] as const) expect(crossnetAllowed(s)).toBe(false);
  });

  it("⑤ 剩余天数只算到 exp（⛔ 不含宽限 —— 含了会让续期提示晚 14 天才响）", () => {
    // 真链路实测（2026-10-18）：30 天的卡曾经显示"还剩 44 天"（把 14 天宽限也算了）。
    expect(daysLeft(base, base.nbf), "从生效算 = 整段有效期").toBe(Math.ceil((base.exp - base.nbf) / 86_400));
    expect(daysLeft(base, base.exp), "到 exp 当天算 0").toBe(0);
    expect(daysLeft(base, base.exp + 99_999), "过期后不为负").toBe(0);
    expect(graceDaysLeft(base, base.exp + 86_400), "宽限另算（这一档只在 grace 用）").toBe(base.grace - 1);
  });
});

describe("pickCurrent —— 按 rot 挑当前代（⛔ 不看 exp）", () => {
  const mk = (rot: number, iat: number, cap: string[], jti: string) => ({
    payload: { v: 1, typ: "card" as const, sub: "s", dev: ["d"], seats: 3, nbf: 1, exp: 2, grace: 14,
      kid: "k", iat, jti, cap, rot },
    jti,
  });

  it("① rot 大的赢（哪怕它的 exp 与旧卡一样）", () => {
    const old = mk(0, 1000, [CROSSNET_CAP], "old");
    const stopper = mk(1, 1001, [], "stopper"); // 停卡那代，exp 相同
    expect(pickCurrent([old, stopper])?.jti).toBe("stopper");
  });

  it("② 同 rot 看 iat 大的", () => {
    expect(pickCurrent([mk(0, 1000, [CROSSNET_CAP], "a"), mk(0, 2000, [CROSSNET_CAP], "b")])?.jti).toBe("b");
  });

  it("③ 空数组 ⇒ null（⛔ 别返回 undefined 让调用方炸）", () => {
    expect(pickCurrent([])).toBeNull();
  });
});
