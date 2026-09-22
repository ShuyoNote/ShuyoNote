// 「语音转写通道」的判据（`localTranscribe`）。
//
// 三层里这层是**纯逻辑 + 假端点**：真模型那层（live）现在跑不了 ——
// herdsman 在验收机上没起（Windows 侧 2026-09-22 实测 `curl` exit=7），
// 所以本文件**不假装**验过真链路，只钉住"我们能控的那部分"：
//   ① 红线（非本机 ⇒ 拿不到 `transcribe`）；② 请求形状（端点、multipart 字段、默认模型）；
//   ③ 响应归一（`{text}` 与 `{text, segments}` 两种形状）；④ 失败路径（4xx/5xx/非 JSON/缺字段/空音频）。

import { afterEach, describe, expect, it, vi } from "vitest";

import { OPENAI_COMPAT_DEFAULT_BASE } from "./llm";
import type { ProviderConfig } from "./llm";
import {
  filenameForAudioMime,
  localTranscribe,
  parseTranscription,
  transcribeEndpoint,
} from "./localTranscribe";
import { DEFAULT_ASR_MODEL } from "../extract/avTranscript";

const cfg = (baseUrl: string, apiKey = ""): ProviderConfig => ({
  provider: "openai",
  baseUrl,
  model: "文本对话模型（**不该**被拿去打转写端点）",
  apiKey,
});

/** 造一个"服务端返回"的 Response。 */
const reply = (body: string, status = 200): Response =>
  new Response(body, { status, headers: { "Content-Type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

describe("端点与文件名（纯函数）", () => {
  it("base 带不带 `/v1` 都拼对（重复加 `/v1` 会 404 —— 踩过一次）", () => {
    expect(transcribeEndpoint("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080/v1/audio/transcriptions");
    expect(transcribeEndpoint("http://127.0.0.1:8080/v1")).toBe("http://127.0.0.1:8080/v1/audio/transcriptions");
    expect(transcribeEndpoint("http://127.0.0.1:8080/v1/")).toBe("http://127.0.0.1:8080/v1/audio/transcriptions");
  });

  it("文件名按 mime 给扩展名（有些服务端按扩展名猜容器）", () => {
    expect(filenameForAudioMime("audio/wav")).toBe("audio.wav");
    expect(filenameForAudioMime("audio/mpeg")).toBe("audio.mp3");
    expect(filenameForAudioMime("audio/mp4")).toBe("audio.m4a");
    expect(filenameForAudioMime("video/quicktime")).toBe("video.mov");
    expect(filenameForAudioMime("audio/x-m4a; codecs=1")).toBe("audio.m4a");
    // 不认识的**不许猜**成某个已知容器（猜错会变成"能收到字节但解不出来"）
    expect(filenameForAudioMime("application/octet-stream")).toBe("audio.bin");
    expect(filenameForAudioMime("")).toBe("audio.bin");
  });
});

describe("红线：非本机 ⇒ 拿不到 transcribe（与 localVision 共用同一个判据）", () => {
  it("远程 / 局域网 ⇒ 拒绝，且理由里写清「语音转写」与下一步", () => {
    for (const u of [OPENAI_COMPAT_DEFAULT_BASE, "https://api.openai.com/v1", "http://192.168.1.9:8080/v1", ""]) {
      const r = localTranscribe(cfg(u));
      expect(r.transcribe, u).toBeUndefined();
      expect(r.refusal, u).toMatch(/远程/);
      expect(r.refusal, u).toMatch(/转写/);
    }
  });

  it("本机 ⇒ 有 transcribe", () => {
    const r = localTranscribe(cfg("http://127.0.0.1:8080/v1"));
    expect(typeof r.transcribe).toBe("function");
    expect(r.refusal).toBeUndefined();
  });
});

describe("请求形状：端点、multipart 字段、默认模型", () => {
  it("发到 `/v1/audio/transcriptions`，字段是 file/model，**默认模型是 funasr-nano**", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return reply(JSON.stringify({ text: "今天天气不错，我们下午三点开会。" }));
    });

    const t = localTranscribe(cfg("http://127.0.0.1:8080/v1")).transcribe!;
    const out = await t(new Uint8Array([1, 2, 3]), "audio/wav", {});

    expect(out.text).toBe("今天天气不错，我们下午三点开会。");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://127.0.0.1:8080/v1/audio/transcriptions");
    expect(calls[0].init.method).toBe("POST");

    const form = calls[0].init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("model")).toBe(DEFAULT_ASR_MODEL);
    expect(DEFAULT_ASR_MODEL).toBe("funasr-nano"); // 拍板值，写死在这条判据里
    expect(form.get("file")).toBeInstanceOf(Blob);
    expect((form.get("file") as Blob).type).toBe("audio/wav");
    expect(form.get("language")).toBeNull(); // 没给语言就不发这个字段（不是发空串）

    // ★ 刻意**不设** Content-Type：boundary 必须由实现生成
    const headers = (calls[0].init.headers ?? {}) as Record<string, string>;
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain("content-type");
    // ★ 也**不该**把文本对话模型的名字当转写模型发出去
    expect(JSON.stringify([...form.entries()])).not.toContain("文本对话模型");
  });

  it("调用时的 `model`/`language` 覆盖构造时的值；apiKey 走 Bearer", async () => {
    const calls: RequestInit[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      calls.push(init);
      return reply(JSON.stringify({ text: "ok" }));
    });

    const t = localTranscribe(cfg("http://127.0.0.1:11434", "k-123"), {
      model: "sherpa-onnx-paraformer-zh-small",
      language: "zh",
    }).transcribe!;
    await t(new Uint8Array([9]), "audio/mpeg", { model: "funasr-nano" });

    const form = calls[0].body as FormData;
    expect(form.get("model")).toBe("funasr-nano"); // 本次调用优先
    expect(form.get("language")).toBe("zh"); // 构造时的语言仍生效
    expect((calls[0].headers as Record<string, string>).Authorization).toBe("Bearer k-123");
  });
});

describe("响应归一：两种形状都认，别的形状**不许猜**", () => {
  it("只有 text ⇒ 只回 text（`segments` 字段不出现）", () => {
    expect(parseTranscription('{"text":"甲"}')).toEqual({ text: "甲" });
  });

  it("带 segments ⇒ 逐段映射成 `{start,end,text}`（数字/文本）", () => {
    const out = parseTranscription(
      JSON.stringify({ text: "甲乙", segments: [{ start: 0, end: 1.5, text: "甲" }, { start: 1.5, end: 3, text: "乙" }] }),
    );
    expect(out.text).toBe("甲乙");
    expect(out.segments).toEqual([
      { start: 0, end: 1.5, text: "甲" },
      { start: 1.5, end: 3, text: "乙" },
    ]);
  });

  it("坏段被丢掉、好段保留；**全坏 ⇒ 不给 segments**（空数组与「没有分段」对下游是同一件事）", () => {
    const mixed = parseTranscription(
      JSON.stringify({ text: "甲", segments: [{ start: 0, end: 1, text: "甲" }, { start: "x", end: 2, text: "乙" }, null] }),
    );
    expect(mixed.segments).toEqual([{ start: 0, end: 1, text: "甲" }]);
    expect(parseTranscription(JSON.stringify({ text: "甲", segments: [] }))).toEqual({ text: "甲" });
    expect(parseTranscription(JSON.stringify({ text: "甲", segments: [null] }))).toEqual({ text: "甲" });
  });

  it("空文本是**合法**结果（内容为空 ≠ 出错）", () => {
    expect(parseTranscription('{"text":""}')).toEqual({ text: "" });
  });

  it("非 JSON / 没有 text 字段 ⇒ **抛**（猜字段名会让错误以「内容为空」的样子出现）", () => {
    expect(() => parseTranscription("<!doctype html>")).toThrow(/不是 JSON/);
    expect(() => parseTranscription('{"result":"甲"}')).toThrow(/没有 text 字段/);
    expect(() => parseTranscription('{"result":"甲"}')).toThrow(/result/); // 把拿到的键写进错误里
    expect(() => parseTranscription("{}")).toThrow(/没有 text 字段/);
  });
});

describe("失败路径：都要抛（抽取器按契约转成 provider_error）", () => {
  it("空音频 ⇒ 明确指出「问题在取字节不在模型」", async () => {
    vi.stubGlobal("fetch", async () => reply('{"text":"x"}'));
    const t = localTranscribe(cfg("http://127.0.0.1:8080/v1")).transcribe!;
    await expect(t(new Uint8Array(), "audio/wav", {})).rejects.toThrow(/空（0 字节）.*取字节/);
  });

  it("404 ⇒ 理由里点到「模型名可能不对」并给默认值", async () => {
    vi.stubGlobal("fetch", async () => reply('{"error":"model not found"}', 404));
    const t = localTranscribe(cfg("http://127.0.0.1:8080/v1")).transcribe!;
    await expect(t(new Uint8Array([1]), "audio/wav", {})).rejects.toThrow(/404/);
    await expect(t(new Uint8Array([1]), "audio/wav", {})).rejects.toThrow(/funasr-nano/);
  });

  it("连不上 ⇒ 一句「连不上」的话（复用 describeFetchError）", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    const t = localTranscribe(cfg("http://127.0.0.1:8080/v1")).transcribe!;
    await expect(t(new Uint8Array([1]), "audio/wav", {})).rejects.toThrow(/无法连接到/);
  });

  it("超时 ⇒ 指名超时与「长音频请先分段」", async () => {
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
      // 模拟 abort：真实实现会因 signal 触发而抛
      const e = new Error("The operation was aborted");
      void init;
      throw e;
    });
    const t = localTranscribe(cfg("http://127.0.0.1:8080/v1"), { timeoutMs: 1000 }).transcribe!;
    await expect(t(new Uint8Array([1]), "audio/wav", {})).rejects.toThrow(/超时（1s）/);
  });
});
