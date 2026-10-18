// 「看图识字（VLM）」本机端点探测的判据（2026-10-18）。
//
// 守三件事：
// ① **只认本机**：非 loopback 的 baseUrl ⇒ 直接拒（与 `localVision` 同一条红线 ✓）；
// ② **探不到 ≠ 没有**：连不上/超时/形状不认识 ⇒ `ok: false` 带原因（⛔ 不许静默当成"没装"✗）；
// ③ **判定是纯函数**：视觉模型按**名字**认（判据直接喂名字，一次网都不出 ✓）。
import { describe, expect, it } from "vitest";

import {
  OLLAMA_DEFAULT_BASE,
  RECOMMENDED_VISION_MODEL,
  isLoopbackUrl,
  looksLikeVisionModel,
  probeVisionModels,
  visionProbeText,
} from "./localEndpoint";

/** 造一个假 fetch：第 n 次调用回什么，由 fixtures 决定。 */
function fakeFetch(reply: { ok: boolean; status?: number; json?: unknown } | (() => never)): typeof fetch {
  return (async () => {
    if (typeof reply === "function") return reply();
    return { ok: reply.ok, status: reply.status ?? 200, json: async () => reply.json };
  }) as unknown as typeof fetch;
}

const tags = (names: string[]) => ({ ok: true, json: { models: names.map((name) => ({ name })) } });

describe("looksLikeVisionModel —— 按名字认视觉模型（纯函数）", () => {
  it("★ 认识常见的视觉模型名", () => {
    for (const n of ["qwen2.5vl:3b", "qwen2.5-vl:7b", "llava:7b", "llama3.2-vision:11b", "minicpm-v:8b", "moondream:latest"]) {
      expect(looksLikeVisionModel(n), `应当认成视觉模型：${n}`).toBe(true);
    }
  });

  it("★ 不许把纯文本模型当视觉模型（否则界面会骗人：说「有视觉模型」却抽不出图 ✗）", () => {
    for (const n of ["qwen2.5:8b", "llama3:8b", "nomic-embed-text", "deepseek-r1:14b"]) {
      expect(looksLikeVisionModel(n), `不该认成视觉模型：${n}`).toBe(false);
    }
  });
});

describe("isLoopbackUrl —— 只许本机端点", () => {
  it("本机三种写法都认（127.x / localhost / [::1]）", () => {
    expect(isLoopbackUrl("http://127.0.0.1:11434")).toBe(true);
    expect(isLoopbackUrl("http://127.1.2.3:8080")).toBe(true);
    expect(isLoopbackUrl("http://localhost:11434")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:11434")).toBe(true);
  });

  it("★ 远程端点一律不认（红线：抽取不许出本机 ✗）", () => {
    expect(isLoopbackUrl("https://api.deepseek.com")).toBe(false);
    expect(isLoopbackUrl("http://192.168.1.9:11434")).toBe(false);
    expect(isLoopbackUrl("不是网址")).toBe(false);
  });
});

describe("probeVisionModels —— 探本机端点", () => {
  it("★ 有视觉模型 ⇒ 列出来（qwen2.5vl:3b 是推荐那个）", async () => {
    const p = await probeVisionModels({ fetchImpl: fakeFetch(tags(["qwen2.5:8b", "qwen2.5vl:3b"])) });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.baseUrl).toBe(OLLAMA_DEFAULT_BASE);
    expect(p.models).toEqual(["qwen2.5:8b", "qwen2.5vl:3b"]);
    expect(p.vision).toEqual(["qwen2.5vl:3b"]);
    expect(visionProbeText(p)).toContain(RECOMMENDED_VISION_MODEL);
  });

  it("★ 有模型但没有视觉模型 ⇒ 说清楚「缺什么」，并给那条命令", async () => {
    const p = await probeVisionModels({ fetchImpl: fakeFetch(tags(["qwen2.5:8b"])) });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.vision).toEqual([]);
    const text = visionProbeText(p);
    expect(text).toContain("没有视觉模型");
    expect(text).toContain(`ollama pull ${RECOMMENDED_VISION_MODEL}`);
  });

  it("★ 连不上 ⇒ `ok:false` 且**给原因**（⛔ 不许当成「没装模型」来冒充「探到了」✗）", async () => {
    const p = await probeVisionModels({
      fetchImpl: fakeFetch(() => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
      }),
    });
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.reason).toContain("连不上");
    expect(visionProbeText(p)).toContain(`ollama pull ${RECOMMENDED_VISION_MODEL}`);
  });

  it("★ 非本机 baseUrl ⇒ 不去探（红线先于功能 ✓）", async () => {
    let called = 0;
    const spy = (async () => {
      called++;
      return { ok: true, status: 200, json: async () => ({}) };
    }) as unknown as typeof fetch;
    const p = await probeVisionModels({ baseUrl: "https://api.deepseek.com", fetchImpl: spy });
    expect(p.ok).toBe(false);
    expect(called, "⛔ 非本机端点：一次请求都不该发 ✗").toBe(0);
  });
});
