// 「本页文字识别」浮层的文案判据。
//
// 事故（2026-09-20 用户截图）：按的是 **AI 识别**，浮层标题写着「OCR 识别结果」，
// 正文还在讲"语言包按需下载"——那是 OCR（Tesseract）那条路的事，AI 这条路根本没有语言包。
// 下面这几条把两个方向都钉死：AI 不许提 OCR/语言包；OCR 的失败必须给出可执行的那一步。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ocrBusyButtonLabel, ocrPopoverCopy, ocrPopoverTitle, type OcrMode, type OcrStatus } from "./pdfOcrCopy";

const MODES: OcrMode[] = ["ocr", "ai"];
const STATES: OcrStatus[] = ["idle", "empty", "timeout", "error", "error-recognize"];

describe("识别浮层的标题跟着用户按的那个按钮走", () => {
  it("AI 那条路的标题不许出现 OCR", () => {
    expect(ocrPopoverTitle("ai", true)).toBe("AI 识别中…");
    expect(ocrPopoverTitle("ai", false)).toBe("AI 识别结果");
    for (const busy of [true, false]) expect(ocrPopoverTitle("ai", busy)).not.toContain("OCR");
  });

  it("OCR 那条路照旧写 OCR", () => {
    expect(ocrPopoverTitle("ocr", true)).toBe("OCR 识别中…");
    expect(ocrPopoverTitle("ocr", false)).toBe("OCR 识别结果");
  });

  it("忙碌按钮文案分得清是谁在跑", () => {
    expect(ocrBusyButtonLabel("ai")).toBe("AI 识别中…");
    expect(ocrBusyButtonLabel("ocr")).toBe("识别中…");
  });
});

describe("AI 那条路的任何一句话都不许把人指到语言包上", () => {
  it("全部状态的 main+hint 都不含 OCR / 语言包 / Tesseract", () => {
    for (const st of STATES) {
      const { main, hint = "" } = ocrPopoverCopy("ai", st);
      const all = main + " " + hint;
      expect(all, `状态 ${st} 的文案提到了 OCR/语言包`).not.toMatch(/OCR|语言包|Tesseract|tesseract/);
    }
  });

  it("AI 失败时必须指向「支持图像的模型」，而不是让人去下语言包", () => {
    const { main, hint = "" } = ocrPopoverCopy("ai", "error");
    expect(main).toContain("AI 识别失败");
    expect(hint).toContain("支持图像");
    expect(hint).toMatch(/gpt-4o|qwen-vl|llava/);
  });
});

describe("OCR 那条路的失败必须给出可执行的一步（首次联网下语言包）", () => {
  it("error（模型/语言包没加载）说清要联网下语言包", () => {
    const { main, hint = "" } = ocrPopoverCopy("ocr", "error");
    expect(main).toContain("没加载成功");
    expect(hint).toContain("联网下载一次语言包");
    expect(hint).toContain("30 MB");
  });

  it("识别阶段失败与模型加载失败分开说（历史踩坑：混在一起会把排查方向带偏）", () => {
    const load = ocrPopoverCopy("ocr", "error");
    const recog = ocrPopoverCopy("ocr", "error-recognize");
    expect(recog.main).toContain("模型已加载");
    expect(recog.main).not.toBe(load.main);
  });
});

describe("正文不出现内部术语（打包方式、环境变量名属于排查细节）", () => {
  it("两种模式、全部状态的 main 都不含 随包分发 / 按需下载 / VITE_", () => {
    for (const mode of MODES) {
      for (const st of STATES) {
        const { main } = ocrPopoverCopy(mode, st);
        expect(main, `${mode}/${st} 的正文泄漏了内部术语`).not.toMatch(/随包分发|按需下载|VITE_/);
      }
    }
  });

  it("正在识别时说的是「稍等」，而不是打包方式的权衡", () => {
    expect(ocrPopoverCopy("ocr", "idle").main).toBe("正在识别本页文字…");
    expect(ocrPopoverCopy("ai", "idle").main).toBe("正在用 AI 识别本页文字…");
  });
});

// 文案对了，但**组件没接上**等于白干 —— 这次的事故正是"两条路共用一份硬编码的 JSX"。
// 所以再加一层：读组件源码，钉住它确实调了上面那两个函数，且旧句子不许回来。
describe("组件确实把浮层接到了这个纯函数上（别再退回硬编码）", () => {
  // 用 cwd 拼路径而不是 `new URL(..., import.meta.url)`：vitest 在 happy-dom 下
  // `import.meta.url` 不是 `file:` 方案，`readFileSync` 会报 "The URL must be of scheme file"。
  const src = readFileSync(resolve(process.cwd(), "src/components/PdfAnnotationCanvas.tsx"), "utf8");

  it("标题走 ocrPopoverTitle(ocrMode, …)", () => {
    expect(src).toContain("ocrPopoverTitle(ocrMode, ocrBusy)");
  });

  it("正文走 OcrTip + ocrPopoverCopy", () => {
    expect(src).toContain("ocrPopoverCopy(ocrMode");
    expect(src).toContain("<OcrTip copy={ocrCopy} />");
  });

  it("两条路各自记住「这一次是谁跑的」", () => {
    expect(src).toMatch(/setOcrMode\("ocr"\)/);
    expect(src).toMatch(/setOcrMode\("ai"\)/);
  });

  it("旧的那几句硬编码文案不许回来", () => {
    expect(src).not.toContain("模型随包分发时首次加载稍慢");
    expect(src).not.toContain("语言包按需下载");
    expect(src).not.toContain(">OCR 识别结果<");
  });
});
