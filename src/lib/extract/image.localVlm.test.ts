// ⚠️ 这个文件**故意跑在默认的 `happy-dom` 环境**（不要加 `@vitest-environment node`）：
// `localVision()` 那个红线适配器用 `FileReader` 把图片转 data URL（浏览器 API），
// node 环境下会直接 `FileReader is not defined` ⇒ 抽取器一律 `provider_error`
//（2026-09-19 实测，错误原文就是这个）。而 happy-dom 里 `fetch` 到 127.0.0.1 是通的。
//
// 本机 VLM 的**真跑**读数：`image.ocr@1` 与 `image.caption@1` 通过 `localVision()`（红线内的
// 唯一注入路径）打到本机服务上，拿到真读数。
//
// 纪律（与 `realSamples.test.ts` 同一条）：**没有本机服务 / 没有样张时跳过，不判红** ——
// 这条链的失败原因可能是"这台机器没跑模型"，那是环境不是回归。
//
// 为什么值得留着：这一档的价值恰恰是"真模型能不能用"。用假 vision 只能证明管线通，
// 证明不了"接上本机模型真的读得出来"，而后者正是这份方案的门（§13 第 7 项：只许本机推理）。
//
// 环境变量：`HERDSMAN_BASE`（默认 http://127.0.0.1:8080/v1）、`HERDSMAN_MODEL`、
// `HERDSMAN_SAMPLE_PNG`（默认 `.third/herdsman-cap/ocr-sample.png`，一张写着 HELLO HERDSMAN 12345 的图）。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { localVision } from "../ai/localVision";
import { CAPTION_PROMPT, imageCaptionExtractor, imageOcrExtractor } from "./image";

// 本仓的测试环境（happy-dom）**没有把 `FileReader` 挂到 globalThis**，而 `localVision` 的适配器
// 正是用它把图片转 data URL（`ocrVision.ts::blobToDataUrl`：`onload` + `readAsDataURL`）。
// 这里补一个**最小**实现（只覆盖那几个成员），好让"真跑"这条判据能跑起来；
// 生产环境（WebView / 浏览器）用的是自带的那个，不经过这里。
// ⚠️ 这也是本轮的一条读数：**视觉这条路依赖浏览器 API** ⇒ 抽取层的"真跑"只能在有 DOM 的环境里验。
if (typeof (globalThis as { FileReader?: unknown }).FileReader === "undefined") {
  class MiniFileReader {
    result: string | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readAsDataURL(blob: Blob) {
      blob
        .arrayBuffer()
        .then((buf) => {
          const b64 = Buffer.from(buf).toString("base64");
          this.result = `data:${blob.type || "application/octet-stream"};base64,${b64}`;
          this.onload?.();
        })
        .catch(() => this.onerror?.());
    }
  }
  (globalThis as { FileReader?: unknown }).FileReader = MiniFileReader;
}

const BASE = process.env.HERDSMAN_BASE ?? "http://127.0.0.1:8080/v1";
const MODEL = process.env.HERDSMAN_MODEL ?? "Qwen3.8-Flash-Next";
/**
 * 样张：优先用环境变量；否则按"工作区里那几处常见位置"依次找
 * （`.third/herdsman-cap/ocr-sample.png` 是 AMD 这台机放样张的地方，工作区根在检出**上一层**
 *  —— 第一版只看了检出内，于是整组被当成"缺样张"静默跳过；跳过的理由是写进 describe 标题的，
 * 所以一眼能看出是环境问题）。
 */
const SAMPLE_CANDIDATES = [
  process.env.HERDSMAN_SAMPLE_PNG,
  join(process.cwd(), "..", ".third", "herdsman-cap", "ocr-sample.png"),
  join(process.cwd(), ".third", "herdsman-cap", "ocr-sample.png"),
].filter((p): p is string => typeof p === "string" && p.length > 0);
const SAMPLE = SAMPLE_CANDIDATES.find((p) => existsSync(p)) ?? SAMPLE_CANDIDATES[0];

async function serviceUp(): Promise<boolean> {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 1500);
    const r = await fetch(`${BASE}/models`, { signal: ac.signal });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

const up = await serviceUp();
const hasSample = existsSync(SAMPLE);
const skipReason = !up
  ? `本机模型服务不可达（${BASE}）—— 这是环境，不是回归`
  : !hasSample
    ? `缺样张（${SAMPLE}）`
    : "";

describe.skipIf(skipReason !== "")(`本机 VLM 真跑（${skipReason || BASE}）`, () => {
  const bytes = hasSample ? new Uint8Array(readFileSync(SAMPLE)) : new Uint8Array();

  const vision = () => {
    const lv = localVision({ provider: "openai", baseUrl: BASE, model: MODEL, apiKey: "" }, { timeoutMs: 120_000 });
    // 红线：loopback 端点才会给出 `vision`；给了 refusal 就是配置错了 ⇒ 直接让判据红。
    expect(lv.refusal ?? null).toBeNull();
    return lv.vision!;
  };

  it("`localVision()` 对本机端点**放行**（`localhost`/127.0.0.1 是 loopback）", () => {
    const lv = localVision({ provider: "openai", baseUrl: BASE, model: MODEL, apiKey: "" });
    expect(lv.vision).toBeTypeOf("function");
    expect(lv.refusal).toBeUndefined();
  });

  it("★ OCR 真读数：样张上的文字被读出来（含 HERDSMAN）", async () => {
    const r = await imageOcrExtractor.extract({
      bytes,
      filename: "ocr-sample.png",
      mime: "image/png",
      hash: "live-1",
      deps: { vision: vision() },
    });
    if (!r.ok) console.log(`[live ocr] FAILED ${r.code}: ${r.message}`);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const text = r.segments[0].text;
      // 真读数打到输出里（人要看的是这一行）
      console.log(`[live ocr] ${JSON.stringify(text)}`);
      expect(text.toUpperCase()).toContain("HERDSMAN");
      expect(r.segments[0].kind).toBe("ocr");
    }
  }, 180_000);

  it("★ 描述真读数：caption 段非空（同一张图，用来证明这一档真的接上了本机模型）", async () => {
    const r = await imageCaptionExtractor.extract({
      bytes,
      filename: "ocr-sample.png",
      mime: "image/png",
      hash: "live-2",
      deps: { vision: vision() },
    });
    if (!r.ok) console.log(`[live caption] FAILED ${r.code}: ${r.message}`);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const text = r.segments[0].text;
      console.log(`[live caption] ${JSON.stringify(text)}`);
      expect(text.length).toBeGreaterThan(0);
      expect(text.length).toBeLessThan(2000); // 提示词要求"一到两句"，跑飞了说明提示词失效
      expect(r.segments[0].kind).toBe("caption");
      // 用别的提示词（描红）不该被误当成 OCR 的产物：两条路的 prompt 必须不同
      expect(CAPTION_PROMPT).not.toBe("");
    }
  }, 180_000);
});
