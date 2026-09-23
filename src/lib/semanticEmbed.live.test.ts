// **真模型**那条链路：本机 herdsman 的嵌入端点（`bge-m3`）—— 走**我们自己的** `embedText` 通道。
//
// 为什么单开一个 live 文件（不塞进 `semanticEmbed.test.ts`）：那个文件用**假端点**，证明的是
// "我们发的请求形状与解析对不对"，**证明不了**"接上真服务能不能用、而且真的是**语义级**的相似"。
// owner 2026-09-23 拍板「向量模型**在本机跑**」⇒ 这一格从"可选能力"变成**默认路径**，必须有真读数。
//
// 纪律（与 `localTranscribe.live.test.ts` / `image.localVlm.test.ts` 同一条）：
// **服务不在就跳过、不判红**，且**跳过的理由写进 describe 标题**（一眼看出是环境问题）。
//
// 环境变量：`HERDSMAN_BASE`（默认 `http://127.0.0.1:8080/v1`）、`HERDSMAN_EMBED_MODEL`（默认 `bge-m3`）。
//
// ⚠️ 超时显式给足（同 `localTranscribe.live.test.ts` 的理由）：live 判据是**多个文件并发**打同一个
// 本机模型服务，默认 5 s 会让"其实会绿的"判据报 `Test timed out`（看起来像坏了，其实只是排队）。

import { describe, expect, it } from "vitest";

import { cosineSim, embedText, embedUrl, type EmbedConfig } from "./semanticEmbed";

const BASE = process.env.HERDSMAN_BASE ?? "http://127.0.0.1:8080/v1";
const MODEL = process.env.HERDSMAN_EMBED_MODEL ?? "bge-m3";
const cfg: EmbedConfig = { provider: "openai", baseUrl: BASE, apiKey: "", model: MODEL };
const LIVE_TIMEOUT_MS = 120_000;

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
const skipReason = up ? "" : `本机嵌入服务不可达（${BASE}）—— 这是环境，不是回归`;

describe.skipIf(skipReason !== "")(`本机嵌入真跑：${MODEL}（${skipReason || BASE}）`, () => {
  it("★ 端点拼出来的是 `<base>/embeddings`，**不是** `…/v1/v1/embeddings`（两个真实预设都是带 /v1 的形状）", () => {
    expect(embedUrl(BASE, "openai")).toBe(`${BASE}/embeddings`);
  });

  it("★ 拿得到**非空**向量（打印维度，不写死某个模型的维度）", async () => {
    const v = await embedText("测试一句中文", cfg);
    expect(v).not.toBeNull();
    const dim = (v ?? []).length;
    console.log(`[live] ${MODEL} 维度 = ${dim}`);
    expect(dim).toBeGreaterThan(64);
    expect((v ?? []).every((x) => Number.isFinite(x))).toBe(true);
  }, LIVE_TIMEOUT_MS);

  it("★ 语义级：近义句的余弦**大于**无关句（否则「配上了」也只是噪声）", async () => {
    const [a, b, c] = await Promise.all([
      embedText("今天下午三点开会", cfg),
      embedText("我们下午三点钟开个碰头会", cfg),
      embedText("苹果手机的电池续航怎么样", cfg),
    ]);
    expect(a && b && c).toBeTruthy();
    const near = cosineSim(a as number[], b as number[]);
    const far = cosineSim(a as number[], c as number[]);
    console.log(`[live] ${MODEL} 近义=${near.toFixed(4)} 无关=${far.toFixed(4)}（近义必须更大）`);
    expect(near).toBeGreaterThan(far);
  }, LIVE_TIMEOUT_MS);
});
