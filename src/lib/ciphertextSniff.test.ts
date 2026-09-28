// B=甲 的判据：① 纯函数认得准（含四条"不猜"）；② 接线处**真的**在解析载荷之前拦。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ciphertextRefusalMessage, CRYPTO_MAGIC, looksLikeCiphertext } from "./ciphertextSniff";

/** 造一段"像 Rust 那边写出来的"密文载荷：base64(magic | version | 若干字节)。 */
function boxed(version: number, extra = 8): string {
  const bytes = [CRYPTO_MAGIC, version, ...Array.from({ length: extra }, (_, i) => i + 1)];
  return Buffer.from(bytes).toString("base64");
}

describe("B=甲 · 密文载荷识别（纯函数）", () => {
  it("★ 认得出我们写的密文（v1 与 v2）", () => {
    expect(looksLikeCiphertext(boxed(1))).toBe(true);
    expect(looksLikeCiphertext(boxed(2))).toBe(true);
  });

  it("★ 四条「不猜」：明文/空/非 base64/版本不认识 都不许当成密文", () => {
    // 明文 JSON（今天网页版真正会收到的东西）——一定不是密文
    expect(looksLikeCiphertext(JSON.stringify({ id: "p1", title: "页" }))).toBe(false);
    expect(looksLikeCiphertext("")).toBe(false);
    expect(looksLikeCiphertext("   ")).toBe(false);
    // 普通 base64（不是密文）：魔数不对 ⇒ 不是
    expect(looksLikeCiphertext(Buffer.from([1, 2, 3, 4, 5, 6]).toString("base64"))).toBe(false);
    // 魔数对、但版本不认识（3）⇒ **不猜**（真正的版本拒绝归 Rust 的 `format_supported`）
    expect(looksLikeCiphertext(boxed(3))).toBe(false);
    // 太短（只有 1 字节）
    expect(looksLikeCiphertext(Buffer.from([CRYPTO_MAGIC]).toString("base64"))).toBe(false);
  });

  it("拒收时那句话要说得清「去哪儿」", () => {
    const msg = ciphertextRefusalMessage();
    expect(msg).toContain("端到端加密");
    expect(msg).toContain("桌面端");
  });
});

describe("B=甲 · 接线（文本级）：认出来就**先拦**，不许走到 JSON 解析", () => {
  const stripComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const web = stripComments(readFileSync(join(process.cwd(), "src/lib/platform/web.ts"), "utf8"));

  it("★ `applyChange` 在 `parseJson(change.payload…)` **之前**检查密文并**抛可操作的话**", () => {
    const checkAt = web.indexOf("looksLikeCiphertext(");
    const parseAt = web.indexOf("parseJson(change.payload");
    expect(checkAt, "web.ts 里没有密文检查 ⇒ 网页版还会把密文当明文/坏 JSON").toBeGreaterThan(-1);
    expect(parseAt, "找不到载荷解析点（接线判据要更新）").toBeGreaterThan(-1);
    expect(checkAt, "★ 检查必须在解析**之前**（否则已经当成明文走下去了）").toBeLessThan(parseAt);
    // 抛出的是**那句可操作的话**（单一来源），不是"坏 JSON"之类
    expect(web).toContain("ciphertextRefusalMessage()");
  });
});
