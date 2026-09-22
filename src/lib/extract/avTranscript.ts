// 音视频转写抽取器：音视频 → 带**时间戳**的文本段（`kind: "transcript"`、`loc: "HH:MM:SS"`）。
//
// 为什么它在契约里早有位置：`types.ts` 的 `SegmentKind` 一直写着
// `| "transcript"; // 音视频转写：loc = 'HH:MM:SS'` —— 所以本文件是**填空**，不是发明形状。
// 与它同批（原子）进契约的有四处：`ExtractDeps.transcribe?`、`DEP_CAPABILITIES` 的 `transcribe`
// 条目、方案 §15.8、`registry.ts` 的登记；另加 conformance 夹具 —— 少一处判据就红
// （见 `docs/plans/2026-09-22-asr-wiring-plan.md` §5.0）。
//
// ⚠️ 三条契约不变量（§15.3）：
//   1. **不自建网络客户端**：转写一律经注入的 `deps.transcribe`；没注入 ⇒ `provider_error`，**不许抛**；
//   2. **不 import `src/lib/platform/**`**（有源码级断言 `isolated.test.ts` 守着）；
//   3. 产物只做「格式 → 带定位的段」，**不做分块**（分块是 P2 的职责）。
//
// ⚠️ 归一的一条口径（见 `docs/plans/2026-09-22-asr-wiring-plan.md` §2）：
//   **标点不能成为隐式依赖** —— 两个本地 ASR（`funasr-nano` 带标点 / `sherpa-onnx-paraformer-zh-small` 裸文本）
//   在同一段音频上内容逐字一致、只差标点 ⇒ 这里**不替下游猜**，原样保留模型给的文本。

import {
  fail,
  ok,
  type ExtractDeps,
  type ExtractInput,
  type ExtractResult,
  type ExtractedSegment,
  type Extractor,
} from "./types";

const AV_ID = "av.transcript@1";

/** 本线的**默认 ASR 模型**（owner 2026-09-22 拍板：**带标点**，更适合直接进正文）。
 *
 *  ⚠️ 抽取器**刻意不在每次调用里传它**（`transcribe(bytes, mime, {})`）—— 这是 2026-09-22 与 macOS 侧
 *  对完口径后改的（方案 §6.5）：契约里 `opts.model` 是「**本次调用**要用的模型」，优先级是
 *  **本次调用 > 注入方构造时给的 > 默认**。抽取器每轮都塞一个默认值 ⇒ 把**注入方配置的模型**
 *  永远盖掉（实测：`localTranscribe(config, { model: "sherpa-onnx-paraformer-zh-small" })` 里的模型不生效
 *  ⇒ 「用户可配 ASR 模型」这件事根本做不到，而它**不报错**，只是安静地用回默认）。
 *  ⇒ 默认值由**注入方**采用；本常量是它的**唯一来源**（`src/lib/ai/localTranscribe.ts` import 它），
 *  所以"默认是哪个模型"仍然只有一处可改。 */
export const DEFAULT_ASR_MODEL = "funasr-nano";

/** 秒 → `HH:MM:SS`（超过 24h 也照样进位；不四舍五入到分钟，免得两段落到同一 loc）。 */
export function hhmmss(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

export const avTranscriptExtractor: Extractor = {
  id: AV_ID,
  mimes: [
    "audio/wav",
    "audio/x-wav",
    "audio/mpeg",
    "audio/mp4",
    "audio/x-m4a",
    "audio/ogg",
    "audio/flac",
    "video/mp4",
    "video/quicktime",
  ],
  extensions: [".wav", ".mp3", ".m4a", ".ogg", ".flac", ".mp4", ".mov"],
  cost: "gpu",
  async extract(input: ExtractInput): Promise<ExtractResult> {
    const transcribe = input.deps.transcribe;
    if (!transcribe) {
      return fail(
        AV_ID,
        "provider_error",
        "未注入 deps.transcribe（ASR 端点不可达或未配置）—— 抽取层不自建网络客户端",
      );
    }

    let raw: Awaited<ReturnType<NonNullable<ExtractDeps["transcribe"]>>>;
    try {
      // ⚠️ **不传 model**（也刻意不传语言）：把"用哪个模型"留给注入方 —— 见 `DEFAULT_ASR_MODEL` 的注释。
      raw = await transcribe(input.bytes, input.mime, {});
    } catch (e) {
      return fail(
        AV_ID,
        "provider_error",
        `转写失败：${e instanceof Error ? e.message : String(e)}`,
      );
    }

    const text = (raw.text ?? "").trim();
    const segments: ExtractedSegment[] = raw.segments?.length
      ? raw.segments.map((s) => ({
          kind: "transcript" as const,
          text: (s.text ?? "").trim(),
          loc: hhmmss(s.start),
        }))
      : [{ kind: "transcript" as const, text, loc: "" }];

    const kept = segments.filter((s) => s.text.length > 0);
    if (kept.length === 0) {
      // 合法但没内容（静音 / 识别不出）⇒ 用 `empty` 而不是 `provider_error`：
      // 前者是"端点好、内容空"，调度器对这两者的处置不同（见 §15.2 的错误码表）。
      return fail(AV_ID, "empty", "转写结果为空（静音或识别不出内容）");
    }
    return ok(AV_ID, kept);
  },
};
