// `deps`（平台能力注入点）的**能力登记表** —— 一处定义，其余地方引用它。
//
// 为什么要有这张表（AMD 侧 2026-09-17 提的请求，理由对）：
// "哪些能力存在、叫什么、缺了报什么"原先散在**契约注释 + `types.ts` + `isolated.test.ts`** 三处。
// 而"同一个口径写两遍必然漂移"这件事**今天已经反复验证过**（社区 logo 的 `?v=9→11`、
// 备份路径文档 vs `ExecStart`、`cargo test --lib` 用错两次……）。所以收成一处。
//
// ⚠️ 关键设计：**这不是"约定"，是编译期强制的**（见文件末尾的 `_DEP_EXHAUSTIVE`）——
// 往 `ExtractDeps` 加一个字段而忘了登记，**`tsc` 直接报错**，不靠人记得。

import type { ExtractDeps } from "./types";

export interface DepCapability {
  /** `ExtractDeps` 上的字段名。 */
  name: keyof ExtractDeps;
  /** 一句话职责（给人看）。 */
  purpose: string;
  /** 缺失时**必须**的行为。目前所有能力都是这一条。 */
  whenAbsent: "provider_error";
  /** 谁构造它。**永远是平台层**（抽取层禁止 import 平台，见 `isolated.test.ts`）。 */
  injectedBy: "platform";
  /** 形状（给人看的签名；以 `types.ts` 为准）。 */
  signature: string;
  /** 会用到它的抽取器（举例，不必穷尽）。 */
  usedBy: readonly string[];
}

export const DEP_CAPABILITIES = [
  {
    name: "vision",
    purpose: "视觉模型调用：图片、视频关键帧、扫描件页 → 文字",
    whenAbsent: "provider_error",
    injectedBy: "platform",
    signature: "(prompt: string, image: Uint8Array, mime: string) => Promise<string>",
    usedBy: ["image.ocr@1", "pdf.ocr@1"],
  },
  {
    name: "rasterize",
    purpose: "把 PDF 的某一页（0 基）渲染成**编码图** —— 扫描件要「页 → 编码图」才能走 vision",
    whenAbsent: "provider_error",
    injectedBy: "platform",
    // ⚠️ 2026-09-22 订正（AMD 报的漂移，我核过 §15.8 第 1b 条）：出口是**编码图 `RasterizedPage`**
    //   （`bytes` ＋ `mime` ＋ `width/height`），不是裸 RGBA。`types.ts` 的 `RasterizedPage` 是唯一口径；
    //   这里原先是 `{ rgba; width; height }`，早于那次裁定 —— 会让人照错的形状写下游。
    signature:
      "(bytes: Uint8Array, pageIndex: number, scale: number) => Promise<RasterizedPage>（编码图：bytes ＋ mime ＋ width/height）",
    usedBy: ["pdf.ocr@1"],
  },
  {
    name: "transcribe",
    purpose: "语音转写：音视频 → 文本（可带时间戳的分段；不是 vision 的一种 —— 形状与端点都不同）",
    whenAbsent: "provider_error",
    injectedBy: "platform",
    signature:
      "(audio: Uint8Array, mime: string, opts: { model?: string; language?: string }) => Promise<{ text: string; segments?: readonly { start: number; end: number; text: string }[] }>",
    usedBy: ["av.transcript@1"],
  },
  {
    name: "convertLegacy",
    purpose:
      "旧二进制 Office（.doc/.xls/.ppt，OLE 复合文档）→ 现代 OOXML：抽取层解不了旧格式，" +
      "这一步只有平台能做（桌面 LibreOffice headless；Web 没有这条路）",
    whenAbsent: "provider_error",
    injectedBy: "platform",
    signature:
      "(bytes: Uint8Array, mime: string, opts: { to: string }) => Promise<Uint8Array>" +
      "（to = **目标 MIME**，由抽取器决定；刻意不返回 mime。任何失败一律 reject ⇒ 抽取器映射 provider_error）",
    usedBy: ["ooxml.legacy@1"],
  },
] as const satisfies readonly DepCapability[];

/** 登记表里出现过的能力名。 */
export type RegisteredDepName = (typeof DEP_CAPABILITIES)[number]["name"];

/**
 * **编译期穷尽性检查**（这张表存在的核心价值）。
 *
 * 若 `ExtractDeps` 上出现了一个没登记的能力，`Exclude<...>` 就不再是 `never`，
 * 下面这行的类型要求给出该字段 ⇒ **`tsc` 报错**。
 * 反过来，登记表里写了 `ExtractDeps` 上不存在的名字，`name: keyof ExtractDeps` 会拦住。
 * ⇒ **两个方向都不会漂移，且不靠人记得。**
 */
export const _DEP_EXHAUSTIVE: Record<Exclude<keyof ExtractDeps, RegisteredDepName>, never> = {};

/** 按名字取登记项（找不到返回 `undefined`，不要把"没登记"变成运行时异常）。 */
export function depCapability(name: string): DepCapability | undefined {
  return DEP_CAPABILITIES.find((c) => c.name === name) as DepCapability | undefined;
}
