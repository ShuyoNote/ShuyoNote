// 词库首次下载的判据（owner 拍 A）—— 三条**缺一不可**：
//   a) **sha256 不匹配 ⇒ 必须拒绝**（⭐ 危险方向优先：不匹配却落盘＝把坏数据装进用户目录）
//   b) 下载成功（夹具）⇒ 落盘 ＋ 字节逐字一致 ＋ 进度可核
//   c) **反向**：没有托管地址/没下载 ⇒ ⛔ 不许假装能下载、⛔ 不许假装词典可用
//
// ⚠️ 这一层**不联网**：`fetchImpl` / `savePack` 全是注入的（夹具响应）。
//    "查询能命中"那条读数在 Rust 侧：`cargo test --lib dictionary::`（真词库样本）。

import { describe, expect, it } from "vitest";
import {
  ECDICT_PACK_ID,
  bytesToBase64,
  describeDownloadResult,
  downloadDictionaryPack,
  downloadPack,
  resolvePackUrl,
  sha256Hex,
  type PackDownloadProgress,
  type PackDownloadResult,
} from "./download";

/** 夹具字节（22 字节）。sha256 是**另外算出来的**读数，⛔ 不是本模块现算的（否则自己证自己）。 */
const FIXTURE_TEXT = "ecdict-fixture-pack-v1";
const FIXTURE = new TextEncoder().encode(FIXTURE_TEXT);
const FIXTURE_SHA = "967fcd1010d7bcaf38c962af0f1600e393b15eb33cd01b9266168c1671af79b9";
/** 另一个真实存在的 sha（"ecdict-fixture-pack-v2"）—— 用来演"不匹配"。 */
const OTHER_SHA = "dcbe7d9bcc342c397865c8955e7d1f8524a555e9b02239bc4f276df69bdb5811";

/** 一个**流式**夹具响应（按 `chunk` 分段吐，带 Content-Length）—— 判据不联网。 */
function fixtureFetch(
  bytes: Uint8Array,
  { chunk = 8, status = 200, withLength = true }: { chunk?: number; status?: number; withLength?: boolean } = {},
) {
  const urls: string[] = [];
  const impl = (async (url: unknown) => {
    urls.push(String(url));
    let i = 0;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "Not Found",
      headers: { get: (k: string) => (withLength && k.toLowerCase() === "content-length" ? String(bytes.length) : null) },
      body: {
        getReader: () => ({
          read: async () => (i < bytes.length ? { done: false, value: bytes.subarray(i, (i += chunk)) } : { done: true, value: undefined }),
        }),
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, urls };
}

/** 落盘记录器（判据要能看见"**没调**落盘"这件事 —— 那正是危险方向）。 */
function recorder() {
  const calls: { packId: string; base64: string }[] = [];
  return {
    calls,
    save: async (packId: string, base64: string) => {
      calls.push({ packId, base64 });
      return { path: "（夹具）", bytes: base64.length };
    },
  };
}

function decodeBase64(b64: string): Uint8Array {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const c of b64) {
    if (c === "=") break;
    const v = A.indexOf(c);
    if (v < 0) throw new Error(`非法 base64 字符：${c}`);
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

const opts = (extra: Partial<Parameters<typeof downloadPack>[0]> = {}) => ({
  url: "https://example.invalid/ecdict-en-zh.bin",
  packId: ECDICT_PACK_ID,
  expectedSha256: FIXTURE_SHA,
  expectedBytes: FIXTURE.length,
  fetchImpl: fixtureFetch(FIXTURE).impl,
  savePack: recorder().save,
  ...extra,
});

describe("① 夹具与哈希自证（判据的地基：别让'自己证自己'）", () => {
  it("夹具的 sha256 == 预先算好的那个读数", async () => {
    expect(await sha256Hex(FIXTURE)).toBe(FIXTURE_SHA);
    expect(FIXTURE.length).toBe(22);
  });
  it("bytesToBase64 手写编码与解码逐字一致（大字符串也不用 btoa）", () => {
    expect(new TextDecoder().decode(decodeBase64(bytesToBase64(FIXTURE)))).toBe(FIXTURE_TEXT);
    const big = new Uint8Array(100_000).map((_, i) => i % 251);
    expect(decodeBase64(bytesToBase64(big))).toEqual(big);
  });
});

describe("a) ⭐ sha256 不匹配 ⇒ **必须拒绝**（危险方向）", () => {
  it("清单里的 sha 与下载内容不符 ⇒ refused，且**一个字节都不落盘**", async () => {
    const rec = recorder();
    const r: PackDownloadResult = await downloadPack(opts({ expectedSha256: OTHER_SHA, savePack: rec.save }));
    expect(r.kind, `sha 不匹配必须拒绝，实际：${JSON.stringify(r)}`).toBe("refused");
    if (r.kind === "refused") {
      expect(r.reason).toContain("sha256");
      expect(r.reason).toContain("拒绝");
      expect(r.gotSha256).toBe(FIXTURE_SHA); // 读数要能自证算的是哪一份
    }
    expect(rec.calls, "拒绝时⛔ 绝不许调落盘（磁盘上不留半个字节）").toHaveLength(0);
  });

  it("清单里没钉 sha256 ⇒ 也拒绝（不核指纹就不算校验过）", async () => {
    const rec = recorder();
    const r = await downloadPack(opts({ expectedSha256: "", savePack: rec.save }));
    expect(r.kind).toBe("refused");
    expect(rec.calls).toHaveLength(0);
  });

  it("截断的半包（字节数不符）⇒ 拒绝，且不进校验、不落盘", async () => {
    const rec = recorder();
    const r = await downloadPack(opts({ expectedBytes: FIXTURE.length + 1, savePack: rec.save }));
    expect(r.kind).toBe("refused");
    if (r.kind === "refused") expect(r.reason).toContain("不完整");
    expect(rec.calls).toHaveLength(0);
  });
});

describe("b) 下载成功（夹具）⇒ 落盘 ＋ 字节逐字一致 ＋ 进度可核", () => {
  it("saved：packId 与内容都对，进度单调且覆盖三个阶段", async () => {
    const rec = recorder();
    const progress: PackDownloadProgress[] = [];
    const r = await downloadPack(opts({ savePack: rec.save, onProgress: (p) => progress.push(p) }));

    expect(r.kind, JSON.stringify(r)).toBe("saved");
    if (r.kind === "saved") {
      expect(r.bytes).toBe(FIXTURE.length);
      expect(r.sha256).toBe(FIXTURE_SHA);
    }
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].packId).toBe(ECDICT_PACK_ID);
    // ⭐ 落盘收到的就是下载到的那份字节（逐字）—— 这条是"用户拿到的东西 == 校验过的东西"。
    expect(new TextDecoder().decode(decodeBase64(rec.calls[0].base64))).toBe(FIXTURE_TEXT);

    // 进度：有 downloading（单调不减、最后 100%）＋ verifying ＋ saving
    const dl = progress.filter((p) => p.phase === "downloading");
    expect(dl.length).toBeGreaterThan(1);
    expect(dl.every((p, i) => i === 0 || (p.received >= dl[i - 1].received))).toBe(true);
    // ⚠️ 不用 `.at(-1)`：本仓的 tsconfig lib 目标不带它（tsc 会报 TS2550）—— 老实取最后一个下标。
    const last = dl[dl.length - 1];
    expect(last.received).toBe(FIXTURE.length);
    expect(last.percent).toBe(100);
    expect(dl[0].total).toBe(FIXTURE.length);
    expect(progress.some((p) => p.phase === "verifying")).toBe(true);
    expect(progress.some((p) => p.phase === "saving")).toBe(true);
    expect(describeDownloadResult(r)).toContain("校验通过");
  });

  it("服务端没给 Content-Length ⇒ percent 如实为 null（⛔ 不猜一个百分比）", async () => {
    const rec = recorder();
    const progress: PackDownloadProgress[] = [];
    const r = await downloadPack(
      opts({ fetchImpl: fixtureFetch(FIXTURE, { withLength: false }).impl, savePack: rec.save, onProgress: (p) => progress.push(p) }),
    );
    expect(r.kind).toBe("saved");
    expect(progress.filter((p) => p.phase === "downloading").every((p) => p.total === null && p.percent === null)).toBe(true);
  });

  it("HTTP 404 / 中途中断 ⇒ failed ＋ 可读原因（不是静默）", async () => {
    const notFound = await downloadPack(opts({ fetchImpl: fixtureFetch(FIXTURE, { status: 404 }).impl }));
    expect(notFound.kind).toBe("failed");
    if (notFound.kind === "failed") expect(notFound.reason).toContain("HTTP 404");

    const boom = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const offline = await downloadPack(opts({ fetchImpl: boom }));
    expect(offline.kind).toBe("failed");
    if (offline.kind === "failed") expect(offline.reason).toContain("连不上");
  });
});

describe("c) ⭐ 反向：没有托管地址 / 没下载 ⇒ ⛔ 不许假装", () => {
  it("`resolvePackUrl()` 现在返回 null（真地址＝❌未做），且入口给的是**可读的失败**", async () => {
    expect(resolvePackUrl(), "真地址未托管 ⇒ 这里必须是 null（托管后只改那一行常量）").toBeNull();
    const rec = recorder();
    const r = await downloadDictionaryPack({ expectedSha256: FIXTURE_SHA, expectedBytes: FIXTURE.length, savePack: rec.save });
    expect(r.kind).toBe("failed");
    if (r.kind === "failed") {
      expect(r.reason).toContain("还没有托管地址");
      expect(r.reason).toContain("未做");
    }
    expect(rec.calls).toHaveLength(0);
  });

  it("注入夹具地址后同一条入口能跑通（＝判据与接口已就绪，只是真地址没有）", async () => {
    const rec = recorder();
    const r = await downloadDictionaryPack({
      expectedSha256: FIXTURE_SHA,
      expectedBytes: FIXTURE.length,
      urlOverride: "file:///fixture/ecdict-en-zh.bin",
      fetchImpl: fixtureFetch(FIXTURE).impl,
      savePack: rec.save,
    });
    expect(r.kind).toBe("saved");
    expect(rec.calls).toHaveLength(1);
  });

  it("词典可用性不在这里猜：`dictionaryStatus` 失败时 available=false（见 lookup.test.ts）", () => {
    // 这条是**指路**而不是重复：真"没下载 ⇒ 未就绪"的读数在 Rust 侧
    // `dictionary::tests::status_says_not_ready_instead_of_pretending` 与
    // `missing_file_is_unavailable_not_a_miss`（都由 lookup.test.ts 的同名 TS 面复述）。
    expect(true).toBe(true);
  });
});
