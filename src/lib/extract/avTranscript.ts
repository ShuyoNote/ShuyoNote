// 音视频转写抽取器：音视频 → 带**时间戳**的文本段（`kind: "transcript"`、`loc: "HH:MM:SS"`）。
//
// 为什么它在契约里早有位置：`types.ts` 的 `SegmentKind` 一直写着
// `| "transcript"; // 音视频转写：loc = 'HH:MM:SS'`，`depsCatalog.ts` 的 `usedBy` 里也早挂着
// `av.transcript@1（待落地）` —— 所以本文件是**填空**，不是发明形状。
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

/** 默认走带标点的那个（更适合直接进正文）。 */
export const DEFAULT_ASR_MODEL = "funasr-nano";

/** 转写回调的形状 —— **下一轮**会作为 `ExtractDeps.transcribe?` 正式进契约；
 *  在契约落地前，用这个局部窄类型让本文件先能编译（契约一落地就删掉它）。 */
export type TranscribeFn = (
  audio: Uint8Array,
  mime: string,
  opts: { model?: string; language?: string },
) => Promise<{
  text: string;
  segments?: readonly { start: number; end: number; text: string }[];
}>;

type DepsWithTranscribe = ExtractDeps & { transcribe?: TranscribeFn };

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
    const transcribe = (input.deps as DepsWithTranscribe).transcribe;
    if (!transcribe) {
      return fail(
        AV_ID,
        "provider_error",
        "未注入 deps.transcribe（ASR 端点不可达或未配置）—— 抽取层不自建网络客户端",
      );
    }

    let raw: Awaited<ReturnType<TranscribeFn>>;
    try {
      raw = await transcribe(input.bytes, input.mime, { model: DEFAULT_ASR_MODEL });
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
