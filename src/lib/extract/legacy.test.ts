// `ooxml.legacy@1` 的判据（macOS 侧实现，契约与共用夹具归 AMD —— 见方案 §15.8 第 7 项）。
//
// 共用夹具（`fixtures.ts` 里那三条）已经覆盖了"成功路径 / 没配转换器"，
// 这里补的是**夹具覆盖不到或不好覆盖**的几处：
//   · 目标 MIME 与承接解析的抽取器**不许漂**（两边各自改一个字，夹具只会红得很难懂）；
//   · 转换器 reject ⇒ `provider_error` 且**带上原话**（诊断要能落到日志里，不能被吞）；
//   · "复用同一套解析"是**真的**（拿转换器给的垃圾字节，报错的必须是 OOXML 那一族）；
//   · 三个目标 MIME 各来一遍（共用夹具只有 docx / xlsx 两条，**pptx 那条没有夹具**）；
//   · 扩展名兜底（mime 缺失时按 `.xls` 认）。

import { describe, expect, it } from "vitest";
import { LEGACY_ID, legacyExtractor, legacyTargetFor } from "./legacy";
import { docxExtractor, pptxExtractor, xlsxExtractor } from "./ooxml";
import type { ExtractInput, ExtractResult } from "./types";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

const WORD = "application/msword";
const EXCEL = "application/vnd.ms-excel";
const POWERPOINT = "application/vnd.ms-powerpoint";

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // 故意的：不是 OLE、也不是 zip

function input(over: Partial<ExtractInput> = {}): ExtractInput {
  return {
    bytes: PDF_BYTES,
    filename: "旧表.xls",
    mime: EXCEL,
    hash: "fixture",
    deps: {},
    ...over,
  };
}

describe("ooxml.legacy@1：目标 MIME ↔ 承接解析的抽取器（漂移判据）", () => {
  it("★ 每个 `to` 都必须**被承接解析的那个抽取器认领**（谁改了一边，这条就红）", () => {
    const pairs = [
      [WORD, DOCX_MIME, docxExtractor],
      [EXCEL, XLSX_MIME, xlsxExtractor],
      [POWERPOINT, PPTX_MIME, pptxExtractor],
    ] as const;
    for (const [mime, to, ex] of pairs) {
      const target = legacyTargetFor(mime, "任意.bin");
      expect(target, `${mime} 应当认得`).not.toBeNull();
      expect(target?.to, `${mime} 的目标 MIME`).toBe(to);
      expect(target?.ex.id).toBe(ex.id);
      // ★ 关键一条：目标 MIME 必须在那个抽取器**自己声明的 mimes** 里
      //   （否则"转换成功但没人认" ⇒ 用户看到的是 corrupt/unsupported，而这里没人报红）
      expect(ex.mimes, `${ex.id} 不认自己那个目标 MIME ${to}`).toContain(to);
    }
  });

  it("扩展名兜底：mime 缺失 / 通用二进制时按扩展名认（`.xls` ⇒ xlsx 那一族）", () => {
    expect(legacyTargetFor("", "旧表.xls")?.to).toBe(XLSX_MIME);
    expect(legacyTargetFor("application/octet-stream", "旧报告.DOC")?.to).toBe(DOCX_MIME);
    expect(legacyTargetFor("application/octet-stream", "旧胶片.ppt")?.to).toBe(PPTX_MIME);
  });

  it("既不认 mime、也不认扩展名 ⇒ `unsupported`（那是注册表派错了文件，不该静默）", () => {
    expect(legacyTargetFor("text/plain", "readme.txt")).toBeNull();
    expect(legacyTargetFor("application/pdf", "x.pdf")).toBeNull();
  });
});

describe("ooxml.legacy@1：deps 缺失 / 转换器失败（§15.3-7 的如实答复）", () => {
  it("★ 没有 `convertLegacy` ⇒ `provider_error`，且**点名叫人知道缺哪个 dep**（不自己起外部程序）", async () => {
    const r = await legacyExtractor.extract(input({ deps: {} }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.extractor).toBe(LEGACY_ID);
    expect(r.code).toBe("provider_error");
    expect(r.message).toContain("convertLegacy");
    // 不许把"抽不了"写成"文件里没有内容"：这两种在 AI 工具面上是**不同**的事实
    expect(r.code).not.toBe("empty");
  });

  it("★ 转换器 reject ⇒ `provider_error`，且**带上转换器的原话**（诊断不能被吞）", async () => {
    const r = await legacyExtractor.extract(
      input({ deps: { convertLegacy: async () => Promise.reject(new Error("soffice 没装或不在 PATH")) } }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("provider_error");
    expect(r.message, "转换器那句原话必须带出来，否则日志里只有我们自己的猜测").toContain("soffice 没装或不在 PATH");
  });

  it("转换器**同步**抛（不是 reject）也走同一条路（`throw` 不是只有 Promise 才有的失败形态）", async () => {
    const r = await legacyExtractor.extract(
      input({
        deps: {
          convertLegacy: () => {
            throw new Error("转换器直接抛了");
          },
        },
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("provider_error");
    expect(r.message).toContain("转换器直接抛了");
  });
});

describe("ooxml.legacy@1：**真的**复用了 ooxml 那一族（不是自己解）", () => {
  it("★ 转换器给的字节不是 zip ⇒ 报错来自 **OOXML 那一族**（`unsupported`），不是我们瞎猜", async () => {
    const r = await legacyExtractor.extract(
      input({ deps: { convertLegacy: async () => new Uint8Array([1, 2, 3, 4]) } }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // `ooxml.ts` 对"不是 zip 也不是 OLE"的答复就是 unsupported（换一个候选试）
    expect(r.code).toBe("unsupported");
    expect(r.message).toContain("OOXML");
  });
});

describe("ooxml.legacy@1：`to` 由抽取器决定（三种格式各一遍，含没有夹具的 pptx）", () => {
  const cases: readonly (readonly [string, string, string, string])[] = [
    ["旧表.xls", EXCEL, "application/vnd.ms-excel", XLSX_MIME],
    ["旧报告.doc", WORD, "application/msword", DOCX_MIME],
    ["旧胶片.ppt", POWERPOINT, "application/vnd.ms-powerpoint", PPTX_MIME],
  ];

  for (const [filename, mime, , wantTo] of cases) {
    it(`${filename}（${mime}）⇒ to = ${wantTo.split(".").pop()}`, async () => {
      const seen: string[] = [];
      const r: ExtractResult = await legacyExtractor.extract(
        input({
          filename,
          mime,
          deps: {
            convertLegacy: async (_bytes, _mime, opts) => {
              seen.push(opts.to);
              return new Uint8Array([1, 2, 3, 4]); // 走到 OOXML 那族会报 unsupported；这里只关心 `to`
            },
          },
        }),
      );
      expect(seen, "转换器必须收到抽取器决定的目标 MIME").toEqual([wantTo]);
      expect(r.ok).toBe(false);
    });
  }
});
