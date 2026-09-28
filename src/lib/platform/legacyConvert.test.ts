// `legacyConverterFor` 的两条判据（旧格式转换的平台注入适配器）。
//
// 为什么单开一个小文件：这个适配器只有十几行，但它**承担一条承重的语义** ——
// **不吞错误**。抽取器靠"转换器 reject"来区分「这台机器做不了 / 文件坏了」与「文件里没内容」；
// 一旦这里加了 `catch { return new Uint8Array() }`，那次失败就会退化成一个**看起来像内容问题**的答复
// （§15.10 那条老坑：把"没抽到"说成"文件里没有"）。

import { describe, expect, it } from "vitest";

import { legacyConverterFor, type ByteCommandInvoker } from "./legacyConvert";

describe("legacyConverterFor：命令面的薄适配器", () => {
  it("★ 平台 reject ⇒ 原样往上抛（**不许**吞成空字节或假成功）", async () => {
    const dep = legacyConverterFor({
      invoke: (async () => {
        throw new Error("这台机器上没找到 LibreOffice（soffice）");
      }) as ByteCommandInvoker["invoke"],
    });
    await expect(
      dep(new Uint8Array([1]), "application/msword", { to: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }),
    ).rejects.toThrow("没找到 LibreOffice");
  });

  it("平台直接回 `Uint8Array` 时不再包一层（两种字节形状都要能用）", async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    const dep = legacyConverterFor({ invoke: (async () => bytes) as ByteCommandInvoker["invoke"] });
    const out = await dep(new Uint8Array([9]), "application/vnd.ms-excel", {
      to: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    expect(out).toBe(bytes); // 同一个引用：不做无谓的拷贝
  });
});
