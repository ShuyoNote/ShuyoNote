// `avTranscript.ts` 的判据（纯函数 ＋ 注入假实现；**不碰真模型**）。
//
// 这三条对着契约的三条不变量与一条口径：
//   ① 没注入 `transcribe` ⇒ `provider_error`（**不许抛**、也不许自己发请求）；
//   ② 注入假实现 ⇒ 段是 `kind:"transcript"`、`loc` 是**时间戳**（`HH:MM:SS`）—— 这是它与其它抽取器最本质的区别；
//   ③ 空转写 ⇒ `empty`（不是 `provider_error`：端点好、内容空，调度器处置不同）。
import { describe, expect, it } from "vitest";

import { DEFAULT_ASR_MODEL, avTranscriptExtractor, hhmmss } from "./avTranscript";
import type { TranscribeFn } from "./avTranscript";
import type { ExtractDeps, ExtractInput } from "./types";

/** ⚠️ 契约落地前 `transcribe` 还不在 `ExtractDeps` 上：这里与模块**共用同一个局部窄类型**
 *  （`ExtractDeps.transcribe?` 一进契约，这个别名和模块里那个一起删掉）。 */
type DepsForTest = ExtractDeps & { transcribe?: TranscribeFn };

function inputWith(deps: DepsForTest): ExtractInput {
  return {
    bytes: new Uint8Array([1, 2, 3]),
    filename: "meeting.m4a",
    mime: "audio/mp4",
    hash: "deadbeef",
    deps,
  };
}

/** 假转写：记下被怎么调的，返回预设形状。 */
function fakeTranscribe(result: { text: string; segments?: { start: number; end: number; text: string }[] }) {
  const calls: { mime: string; model?: string }[] = [];
  const fn = async (_audio: Uint8Array, mime: string, opts: { model?: string }) => {
    calls.push({ mime, model: opts.model });
    return result;
  };
  return { fn, calls };
}

describe("hhmmss", () => {
  it("秒 → HH:MM:SS（不四舍五入到分钟）", () => {
    expect(hhmmss(0)).toBe("00:00:00");
    expect(hhmmss(1)).toBe("00:00:01");
    expect(hhmmss(61)).toBe("00:01:01");
    expect(hhmmss(3723)).toBe("01:02:03");
    expect(hhmmss(-5)).toBe("00:00:00"); // 负数/NaN 归零，不吐 `-1:-1:-1`
  });
});

describe("av.transcript@1", () => {
  it("★ 没注入 transcribe ⇒ provider_error（**不抛**、也不自建请求）", async () => {
    const r = await avTranscriptExtractor.extract(inputWith({}));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.code).toBe("provider_error");
    expect(r.extractor).toBe("av.transcript@1");
  });

  it("★ 有 segments ⇒ 每段 kind=transcript、loc=时间戳", async () => {
    const { fn, calls } = fakeTranscribe({
      text: "今天天气不错，我们下午三点开会。",
      segments: [
        { start: 0, end: 2, text: "今天天气不错，" },
        { start: 3723, end: 3725, text: "我们下午三点开会。" },
      ],
    });
    const r = await avTranscriptExtractor.extract(inputWith({ transcribe: fn }));
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.segments.map((s) => s.kind)).toEqual(["transcript", "transcript"]);
    expect(r.segments.map((s) => s.loc)).toEqual(["00:00:00", "01:02:03"]);
    // 假实现被怎么调的也要能被核对（默认模型 + 原件 mime）
    expect(calls).toEqual([{ mime: "audio/mp4", model: DEFAULT_ASR_MODEL }]);
  });

  it("没有 segments 时退成**一段**（loc 为空 —— 无定位就别编一个）", async () => {
    const { fn } = fakeTranscribe({ text: "  只有一整段  " });
    const r = await avTranscriptExtractor.extract(inputWith({ transcribe: fn }));
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]!.text).toBe("只有一整段"); // 前后空白要归一
    expect(r.segments[0]!.loc).toBe("");
  });

  it("空转写 ⇒ empty（不是 provider_error）", async () => {
    const { fn } = fakeTranscribe({ text: "   " });
    const r = await avTranscriptExtractor.extract(inputWith({ transcribe: fn }));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.code).toBe("empty");
  });

  it("转写抛错 ⇒ 收成 provider_error（**不让异常穿出去**）", async () => {
    const r = await avTranscriptExtractor.extract(
      inputWith({
        transcribe: async () => {
          throw new Error("超时（120s）");
        },
      } as ExtractDeps),
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.code).toBe("provider_error");
    expect(r.message).toContain("超时");
  });
});
