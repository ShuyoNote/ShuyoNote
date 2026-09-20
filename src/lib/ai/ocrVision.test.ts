import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderConfig } from "./llm";

vi.mock("../coreHttp", () => ({ coreFetch: vi.fn() }));

import { coreFetch } from "../coreHttp";
import { ocrWithVision } from "./ocrVision";

const mock = coreFetch as unknown as ReturnType<typeof vi.fn>;
const cfg = {
  provider: "openai",
  baseUrl: "http://127.0.0.1:1234",
  model: "qwen-vl",
  apiKey: "",
} as unknown as ProviderConfig;

/**
 * 缺陷 #9（2026-09-20，用户报「PDF 阅读器 AI 识别出错」）暴露的不是识别本身，是**报错的指向**：
 * 失败只回一个 `"error"`，界面于是永远喊「请确认已配置支持图像的模型」——
 * 而真因可能是 404（模型名/路径不对）、401（key 不对）、空图（取图/渲染）、模型不支持图像。
 * 这几条要**各说各的**，否则用户只会去改一个没错的地方。
 */
describe("视觉识别失败必须说清原因（缺陷 #9）", () => {
  beforeEach(() => mock.mockReset());

  it("HTTP 404 ⇒ 带上状态码（模型名/路径不对），不是「请确认模型支持图像」", async () => {
    mock.mockResolvedValue(new Response("not found", { status: 404 }));
    const r = await ocrWithVision(cfg, "data:image/png;base64,AAAA");
    expect(r.text).toBeNull();
    expect(r.error).toBe("error");
    expect(String(r.message)).toContain("404");
  });

  it("HTTP 401 ⇒ 带上 401（key 不对）", async () => {
    mock.mockResolvedValue(new Response("unauthorized", { status: 401 }));
    const r = await ocrWithVision(cfg, "data:image/png;base64,AAAA");
    expect(String(r.message)).toContain("401");
  });

  it("空图 ⇒ 明说问题在取图/渲染，不在模型（且根本不该发请求）", async () => {
    const r = await ocrWithVision(cfg, "");
    expect(r.error).toBe("error");
    expect(String(r.message)).toContain("取图");
    expect(mock).not.toHaveBeenCalled();
  });

  it("模型返回空文本 ⇒ 提示可能不支持图像输入", async () => {
    mock.mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "   " } }] }), { status: 200 }),
    );
    const r = await ocrWithVision(cfg, "data:image/png;base64,AAAA");
    expect(r.text).toBeNull();
    expect(String(r.message)).toContain("不支持图像");
  });

  // 说明：**连接异常那条不在这里测**。原写法（mock 抛错）会让 vitest 把我们自己造的错记成
  // "未处理的错误"，看起来像用例挂了、其实被测代码已经 catch 并回填了 message（实测收到的正是
  // `连接失败：connect ECONNREFUSED 127.0.0.1:1234`）。网络错误→中文的那层映射由
  // `describeFetchError` 自己的用例覆盖，这里只钉「原因有没有跟着结果一起回」。

  it("成功 ⇒ 不塞 message（别给正常路径加噪音）", async () => {
    mock.mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "识别到的文字" } }] }), { status: 200 }),
    );
    const r = await ocrWithVision(cfg, "data:image/png;base64,AAAA");
    expect(r.text).toBe("识别到的文字");
    expect(r.message).toBeUndefined();
  });
});
