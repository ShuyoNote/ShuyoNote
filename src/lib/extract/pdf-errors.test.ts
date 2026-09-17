// `pdf.text@1` 的**错误分类**判据（用假 pdf.js，不需要真加密 PDF）。
//
// 为什么单独一个文件、并且 mock 掉 `pdfjs-dist`：真实的"口令保护 PDF"很难在仓库里现造
// （pdf-lib 不能加密，手写 RC4 安全处理器代价高且容易造出一个"其实不合法"的样本），
// 而这三条分支的价值恰恰在**错误码本身**：
//   · `encrypted` 与 `corrupt` 对调度器是**不同**的语义（都"不换候选"，但给用户的说法不同）；
//   · `internal` 要保留原文，否则线上只能看到"抽不出来"。
// 之前这三条**一条判据都没有** —— 也就是说把 PasswordException 错判成 corrupt 也不会有人发现。
//
// ⚠️ 这里是"用假模块测分类逻辑"，**不能**替代真样张：真 PDF 的路径由
// `conformance.test.ts`（合成 PDF）与真样张冒烟跑器（`EXTRACT_SAMPLES`）覆盖。

import { beforeEach, describe, expect, it, vi } from "vitest";

/** 假 pdf.js 的可控状态：`reject` 非空 ⇒ getDocument 直接拒。 */
const fake = { reject: null as unknown, pages: 1 };

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: () => ({
    promise: fake.reject
      ? Promise.reject(fake.reject)
      : Promise.resolve({
          numPages: fake.pages,
          getPage: async () => ({ getTextContent: async () => ({ items: [] }) }),
          destroy: async () => {},
        }),
  }),
}));

const { pdfTextExtractor } = await import("./pdf");

const bytes = () => new TextEncoder().encode("%PDF-1.4\n% fake\n");
const input = () => ({ bytes: bytes(), filename: "x.pdf", mime: "application/pdf", hash: "a".repeat(64), deps: {} });
const codeOf = async () => {
  const r = await pdfTextExtractor.extract(input());
  return r.ok ? "(ok)" : r.code;
};

beforeEach(() => {
  fake.reject = null;
  fake.pages = 1;
});

describe("pdf.text@1 的错误分类", () => {
  it("PasswordException ⇒ **encrypted**（不是 corrupt —— 两者给用户的说法不同）", async () => {
    fake.reject = Object.assign(new Error("No password given"), { name: "PasswordException" });
    expect(await codeOf()).toBe("encrypted");
  });

  it("InvalidPDFException ⇒ corrupt", async () => {
    fake.reject = Object.assign(new Error("Invalid PDF structure"), { name: "InvalidPDFException" });
    expect(await codeOf()).toBe("corrupt");
  });

  it("其余异常 ⇒ internal，且 message 里带上原始信息（否则线上只知道「抽不出来」）", async () => {
    fake.reject = Object.assign(new Error("boom-detail-1234"), { name: "SomeWeirdError" });
    const r = await pdfTextExtractor.extract(input());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("internal");
    expect(r.message).toContain("boom-detail-1234");
  });

  it("加载成功但整页没有文本项 ⇒ empty（扫件路径，与错误分类分开）", async () => {
    expect(await codeOf()).toBe("empty");
  });
});
