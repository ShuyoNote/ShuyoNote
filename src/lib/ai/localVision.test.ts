// 「抽取不得走远程 provider」这条红线的判据。
//
// 这条红线是用户 2026-09-17 定的（方案 §13 第 7 项由"待拍板"变"已定"）。
// 判据的重点不是"函数返回什么"，而是**没有任何一条路能让抽取出网**：
// 非本机 ⇒ 拿不到 `vision` ⇒ 下游按"未注入"走 `provider_error`（契约 §15.3-7）。

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./ocrVision", () => ({
  ocrWithVision: vi.fn(),
  blobToDataUrl: vi.fn(async () => "data:image/png;base64,AAAA"),
}));

import { ocrWithVision } from "./ocrVision";
import { isLoopbackBaseUrl, localVision } from "./localVision";
import { OPENAI_COMPAT_DEFAULT_BASE, OLLAMA_DEFAULT_URL } from "./llm";
import type { ProviderConfig } from "./llm";

const cfg = (baseUrl: string, provider: ProviderConfig["provider"] = "ollama"): ProviderConfig => ({
  provider,
  baseUrl,
  model: "m",
});

describe("isLoopbackBaseUrl：判断依据是**地址**，不是 provider 名字", () => {
  it("本机地址都算绿（含端口/路径/整个 127.0.0.0/8/IPv6）", () => {
    for (const u of [
      "http://localhost:11434",
      "http://127.0.0.1:11434",
      "http://127.0.0.1:11434/api",
      "https://127.1.2.3:8443", // 整个 127/8 都是 loopback
      "http://[::1]:11434",
      "http://[::1]/v1",
    ]) {
      expect(isLoopbackBaseUrl(u), u).toBe(true);
    }
  });

  it("**远程与局域网一律不是本机**（默认从严）", () => {
    for (const u of [
      OPENAI_COMPAT_DEFAULT_BASE, // https://api.deepseek.com —— llm.ts 的默认值之一
      "https://api.openai.com/v1",
      "http://192.168.1.9:11434", // 局域网：**默认拒绝**，见 localVision 的注释
      "http://10.0.0.5:11434",
      "http://0.0.0.0:11434", // bind-all 不是"目的地址"，解析不出"本机"语义 ⇒ 拒绝
      "http://example.com",
      "not a url", // 解析不出来 ⇒ **不当作本机**（宁可错拒一个本地，也不放过一个远程）
      "",
    ]) {
      expect(isLoopbackBaseUrl(u), u).toBe(false);
    }
  });
});

describe("localVision：非本机 ⇒ 拿不到 vision，且给出**能看懂**的理由", () => {
  beforeEach(() => vi.clearAllMocks());

  it("本机 ollama ⇒ 有 vision", () => {
    const r = localVision(cfg(OLLAMA_DEFAULT_URL));
    expect(typeof r.vision).toBe("function");
    expect(r.refusal).toBeUndefined();
  });

  it("**本机的 openai 兼容端点也允许**（本机跑 llama.cpp / vLLM 是正当用法）", () => {
    const r = localVision(cfg("http://127.0.0.1:8080/v1", "openai"));
    expect(typeof r.vision).toBe("function");
  });

  it("远程端点 ⇒ **没有 vision**（这就是红线可执行的地方）+ 明确说明", () => {
    const r = localVision(cfg(OPENAI_COMPAT_DEFAULT_BASE, "openai"));
    expect(r.vision).toBeUndefined(); // ⇒ 下游按"未注入"走 provider_error
    expect(r.refusal).toContain("抽取不得使用远程 provider");
    expect(r.refusal).toContain("provider_error"); // 告诉用户"现在会发生什么"
    expect(r.refusal).toContain("http://127.0.0.1:11434"); // 以及"该怎么做"
  });

  it("局域网地址同样被拒（默认从严，未擅自放宽 —— 见文件头注释）", () => {
    const r = localVision(cfg("http://192.168.1.9:11434"));
    expect(r.vision).toBeUndefined();
    expect(r.refusal).toContain("192.168.1.9");
  });

  it("baseUrl 为空/缺配置 ⇒ 拒绝而不是崩", () => {
    const r = localVision({ provider: "ollama", baseUrl: "", model: "m" });
    expect(r.vision).toBeUndefined();
    expect(r.refusal).toContain("（空）");
  });
});

describe("localVision 造出来的 vision 与契约的衔接", () => {
  beforeEach(() => vi.clearAllMocks());

  it("模型返回文字 ⇒ 原样返回（并把 prompt/图片/mime 交给既有通道）", async () => {
    (ocrWithVision as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ text: "识别结果" });
    const v = localVision(cfg(OLLAMA_DEFAULT_URL)).vision!;
    await expect(v("按这个 prompt", new Uint8Array([1, 2, 3]), "image/png")).resolves.toBe("识别结果");
    expect((ocrWithVision as unknown as ReturnType<typeof vi.fn>).mock.calls[0][2]).toBe("按这个 prompt");
  });

  it("**调用失败（text: null）⇒ 抛**，让抽取器按契约转成 `provider_error`", async () => {
    (ocrWithVision as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ text: null, error: "endpoint down" });
    const v = localVision(cfg(OLLAMA_DEFAULT_URL)).vision!;
    await expect(v("p", new Uint8Array([1]), "image/png")).rejects.toThrow("endpoint down");
  });

  it("**调用成功但图里没有文字（text 为空串）⇒ 不抛**（那是「没内容」，不是「出错」）", async () => {
    (ocrWithVision as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ text: "" });
    const v = localVision(cfg(OLLAMA_DEFAULT_URL)).vision!;
    await expect(v("p", new Uint8Array([1]), "image/png")).resolves.toBe("");
  });
});
