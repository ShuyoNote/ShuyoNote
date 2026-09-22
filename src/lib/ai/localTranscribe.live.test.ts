// **真模型**那条链路的判据（TTS 合成 → 经 `localTranscribe` 转写 → 经 `av.transcript@1` 成段）。
//
// 为什么单开一个 live 文件（而不是塞进 `localTranscribe.test.ts`）：
// 那个文件用的是**假端点**，它证明的是"我们发的请求形状与解析对不对"；
// 它**证明不了**"接上真服务能不能用" —— 而后者正是这条通道唯一还没证过的一格
// （2026-09-22：本机与 Windows 验收机的 herdsman 都没在跑，两边都只有假端点的绿）。
//
// 纪律（与 `image.localVlm.test.ts` / `realSamples.test.ts` 同一条）：
// **服务不在就跳过，不判红**，而且**跳过的理由写进 describe 标题**（一眼能看出是环境问题）。
// 绝不为了"看起来很全"把 skip 写成一个恒真的断言。
//
// 它验的三件事（对应 ASR 方案 §4-3 与 §6）：
//   ① 走的是**我们自己的通道**（`localTranscribe`），不是这个文件里另写一份 multipart 请求 ——
//      否则验的是"curl 能通"，不是"我们的代码能通"；
//   ② 中文真的认得出来（TTS 合成那句，断言包含**去标点的关键词**：两个本地 ASR 只差标点，
//      按带标点的那句断言会让无标点的模型假红）；
//   ③ 服务端**给不给 `segments`** 这件事被如实区分：给了 ⇒ `loc` 必须是 `HH:MM:SS`；
//      没给 ⇒ 契约上是"一段、`loc=""`"（**不编造定位**）。这条会打印服务端实际给的是哪种形状。
//
// 环境变量：`HERDSMAN_BASE`（默认 `http://127.0.0.1:8080/v1`）、
// `HERDSMAN_TTS_MODEL`（默认 `sherpa-onnx-vits-melo-tts-zh-en`）、
// `HERDSMAN_ASR_MODEL`（默认 `funasr-nano`）。

import { describe, expect, it } from "vitest";

import { localTranscribe } from "./localTranscribe";
import { DEFAULT_ASR_MODEL, avTranscriptExtractor } from "../extract/avTranscript";

const BASE = process.env.HERDSMAN_BASE ?? "http://127.0.0.1:8080/v1";
const TTS_MODEL = process.env.HERDSMAN_TTS_MODEL ?? "sherpa-onnx-vits-melo-tts-zh-en";
const ASR_MODEL = process.env.HERDSMAN_ASR_MODEL ?? DEFAULT_ASR_MODEL;

/** 要合成的那句（`docs/development.md §10.7` 的模板同款）。 */
const SENTENCE = "今天天气不错，我们下午三点开会。";
/** 断言用的**去标点**关键词：带标点/裸文本两个 ASR 都必须包含它。 */
const KEYWORD = "我们下午三点开会";

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

/** 用本机 TTS 合成一段 wav（不引外部音频夹具：本仓没有短音频样本）。 */
async function synthesize(): Promise<Uint8Array> {
  const r = await fetch(`${BASE}/audio/speech`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: TTS_MODEL, input: SENTENCE, response_format: "wav" }),
  });
  if (!r.ok) throw new Error(`TTS 失败（${r.status}）：${(await r.text()).slice(0, 200)}`);
  return new Uint8Array(await r.arrayBuffer());
}

const up = await serviceUp();
const skipReason = up ? "" : `本机模型服务不可达（${BASE}）—— 这是环境，不是回归`;

describe.skipIf(skipReason !== "")(`ASR 真跑：TTS → localTranscribe → 抽取器（${skipReason || BASE}）`, () => {
  const transcribe = () => {
    const lt = localTranscribe({ provider: "openai", baseUrl: BASE, model: "", apiKey: "" }, { model: ASR_MODEL, timeoutMs: 300_000 });
    // 红线：loopback 端点才给得出 `transcribe`；给了 refusal 就是配置错了 ⇒ 让判据红。
    expect(lt.refusal ?? null).toBeNull();
    return lt.transcribe!;
  };

  it("TTS 合成出来的是 wav（不是空响应）", async () => {
    const wav = await synthesize();
    expect(wav.byteLength).toBeGreaterThan(1000);
    // RIFF 魔数：证明拿到的是音频而不是一段 JSON 错误
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe("RIFF");
  });

  it(`★ 经我们自己的通道转写，中文关键词认得出来（模型 ${ASR_MODEL}）`, async () => {
    const wav = await synthesize();
    const out = await transcribe()(wav, "audio/wav", {});
    expect(typeof out.text).toBe("string");
    expect(out.text.length).toBeGreaterThan(0);
    // 去标点断言：`funasr-nano` 带标点、`sherpa-onnx-paraformer-zh-small` 裸文本，两者都含这句
    expect(out.text.replace(/[，。！？、\s]/g, "")).toContain(KEYWORD);
  });

  it("★ 抽取器这一层：段与 `loc` 的形状**按服务端实际给的**如实区分（不编造定位）", async () => {
    const wav = await synthesize();
    const res = await avTranscriptExtractor.extract({
      bytes: wav,
      filename: "live-smoke.wav",
      mime: "audio/wav",
      hash: "live-smoke",
      deps: { transcribe: transcribe() },
    });
    // ⚠️ 判别式是 `ok`（`ExtractResult` 是 `ok: true | false` 的联合），不是 `status`
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(`抽取失败：${res.code} ${res.message}`);
    expect(res.segments.length).toBeGreaterThan(0);
    expect(res.segments.every((s) => s.kind === "transcript")).toBe(true);
    expect(res.segments.map((s) => s.text).join("").replace(/[，。！？、\s]/g, "")).toContain(KEYWORD);

    const shaped = res.segments.filter((s) => s.loc !== "");
    if (shaped.length > 0) {
      // 服务端给了分段 ⇒ 定位必须是 HH:MM:SS（转写与其它抽取器最本质的区别）
      for (const s of shaped) expect(s.loc).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    } else {
      // 没给分段 ⇒ 契约上退成一段、`loc=""`。这不是缺陷，是"不编造定位"。
      expect(res.segments).toHaveLength(1);
    }
    // 把服务端实际形状打印出来：这条读数决定"时间戳定位"在真数据上到底成不成立
    console.log(
      `[live] ${ASR_MODEL} ⇒ frames=${res.segments.length} ` +
        `带定位=${shaped.length}（${shaped.length ? "服务端给了 segments" : "服务端只给 text ⇒ loc 为空，符合契约"}）`,
    );
  });
});
