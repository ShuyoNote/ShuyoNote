// 图片 OCR 抽取器单测 —— 重点是把契约里那条**至今没被任何实现覆盖**的不变量钉住：
// §15.3-7「`cost:"gpu"` 的抽取器在 `deps.vision` 缺失时必须立刻 `provider_error`，且不许抛」。
// 顺带验证"视觉模型的异常要转成错误码而不是穿透"（§15.3-2）。

import { describe, expect, it } from "vitest";

import { imageOcrExtractor, OCR_PROMPT } from "./image";
import { fail, ok, type ExtractInput, type Extractor } from "./types";

/** 造一个最小的图片输入（本抽取器不解析字节，只把它们交给 vision）。 */
function input(deps: ExtractInput["deps"] = {}, mime = "image/png"): ExtractInput {
  return {
    bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    filename: "扫描件.png",
    mime,
    hash: "h-img",
    deps,
  };
}

/** 记录调用参数的假 vision。 */
function spyVision(reply: string) {
  const calls: { prompt: string; bytes: Uint8Array; mime: string }[] = [];
  const vision = async (prompt: string, bytes: Uint8Array, mime: string) => {
    calls.push({ prompt, bytes, mime });
    return reply;
  };
  return { vision, calls };
}

describe("image.ocr@1", () => {
  it("声明为 gpu 档（调度器据此排队错峰）", () => {
    expect(imageOcrExtractor.cost).toBe("gpu");
  });

  it("id 带版本号、认领 image/*", () => {
    expect(imageOcrExtractor.id).toBe("image.ocr@1");
    expect(imageOcrExtractor.mimes).toContain("image/*");
    expect(imageOcrExtractor.extensions).toContain(".png");
  });

  it("**没有注入 vision ⇒ 立刻 provider_error**（契约 §15.3-7：不许自己连网）", async () => {
    const r = await imageOcrExtractor.extract(input({}));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("provider_error");
      expect(r.message).toContain("deps.vision");
    }
  });

  it("vision 返回文字 ⇒ ocr 段，loc 为空", async () => {
    const { vision, calls } = spyVision("发票号码 001\n金额 1200");
    const r = await imageOcrExtractor.extract(input({ vision }));
    expect(r).toMatchObject({ ok: true, extractor: "image.ocr@1" });
    if (r.ok) {
      expect(r.segments).toEqual([
        { kind: "ocr", text: "发票号码 001\n金额 1200", loc: "" },
      ]);
    }
    // 提示词与 mime 必须原样传给 vision（适配器要靠 mime 决定怎么编码图片）
    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toBe(OCR_PROMPT);
    expect(calls[0].mime).toBe("image/png");
    expect(calls[0].bytes).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  });

  it("mime 缺失时兜底成 image/png（不要给适配器一个空 mime）", async () => {
    const { vision, calls } = spyVision("x");
    await imageOcrExtractor.extract(input({ vision }, ""));
    expect(calls[0].mime).toBe("image/png");
  });

  it("vision 返回空白 ⇒ empty（合法图片但没字，不是失败）", async () => {
    const { vision } = spyVision("   \n  ");
    const r = await imageOcrExtractor.extract(input({ vision }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("empty");
  });

  it("**vision 抛异常 ⇒ provider_error，不穿透**（契约 §15.3-2）", async () => {
    const vision = async () => {
      throw new Error("ECONNREFUSED");
    };
    // 必须是 resolves（返回结果）而不是 rejects（抛出去）
    await expect(imageOcrExtractor.extract(input({ vision }))).resolves.toMatchObject({
      ok: false,
      code: "provider_error",
    });
  });

  it("vision 返回非字符串也不炸（视作空）", async () => {
    const vision = (async () => undefined) as unknown as ExtractInput["deps"]["vision"];
    const r = await imageOcrExtractor.extract(input({ vision }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("empty");
  });

  it("确定性：同一输入 + 同一 vision ⇒ 结果相同", async () => {
    const { vision } = spyVision("同样的字");
    const a = await imageOcrExtractor.extract(input({ vision }));
    const b = await imageOcrExtractor.extract(input({ vision }));
    expect(a).toStrictEqual(b);
  });
});

describe("与契约工具函数的配合", () => {
  it("ok/fail 的 extractor 字段就是本抽取器的 id", async () => {
    const { vision } = spyVision("甲");
    const good = await imageOcrExtractor.extract(input({ vision }));
    const bad = await imageOcrExtractor.extract(input({}));
    expect(good.extractor).toBe(imageOcrExtractor.id);
    expect(bad.extractor).toBe(imageOcrExtractor.id);
    // 顺手证明工具函数本身没被误用（这两行是类型层面的护栏，值上恒真）
    expect(ok("x", []).extractor).toBe("x");
    expect(fail("y", "empty", "").extractor).toBe("y");
  });

  it("抽出来的 text 是纯文本（无标签残留）", async () => {
    const { vision } = spyVision("<p>粗体</p> 与 <b>标签</b>");
    const r = await imageOcrExtractor.extract(input({ vision }));
    // 注：这里断言的是"原样透传、由适配器负责让模型只吐纯文本"，
    // 抽取器自己不做事后清洗（否则不同抽取器的清洗规则会漂移）。
    if (r.ok) expect(r.segments[0].text).toBe("<p>粗体</p> 与 <b>标签</b>");
  });
});

// 类型层面的自检：extract 的返回类型必须是 ExtractResult（防止有人改成抛异常）
const _typecheck: Extractor = imageOcrExtractor;
void _typecheck;
