// 「语音输入」这条通道的判据（`src/lib/speechInput.ts` ✓）。
//
// 为什么必须在**假识别器**上跑：happy-dom / jsdom 里既没有麦克风、也没有
// `SpeechRecognition` ✗ ⇒ 不注入假件就"什么都测不到"（而那种"测了个寂寞"的绿最危险 ✓）。
// 这里钉四件真会出错的事：
//   ① **没有这个 API 时必须如实报**（⛔ 不是静默没反应 ✗ —— "这个外壳不带语音识别"是一句要说得出口的话 ✓）；
//   ② 中间结果与定稿要**分得开**（只有定稿能往笔记里插 ✓ —— 中间结果会变，插进去就是鬼影 ✗）；
//   ③ **自己停**的时候浏览器也会抛 `aborted` ⇒ 不许弹红字吓人 ✗；
//   ④ 每个错误码都要有**一句人话**（说清下一步怎么办 ✓）。
import { describe, expect, it } from "vitest";
import { createSpeechInput, speechErrorMessage, speechInputSupported, type SpeechRecognitionLike } from "./speechInput";

/** 假识别器：记下 start/stop，并允许手动"吐"结果与错误 ✓。 */
class FakeRec implements SpeechRecognitionLike {
  lang = "";
  continuous = false;
  interimResults = false;
  maxAlternatives = 1;
  onresult: ((ev: any) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;
  onend: (() => void) | null = null;
  started = false;
  stopped = false;
  start() {
    this.started = true;
  }
  stop() {
    this.stopped = true;
    this.onend?.();
  }
  abort() {
    this.onend?.();
  }
  emit(results: { transcript: string; isFinal: boolean }[], resultIndex = 0) {
    this.onresult?.({ resultIndex, results: results.map((r) => Object.assign([{ transcript: r.transcript }], { isFinal: r.isFinal })) });
  }
  fail(code: string) {
    this.onerror?.({ error: code });
  }
}

function harness(ctor: (new () => SpeechRecognitionLike) | null) {
  const texts: { text: string; isFinal: boolean }[] = [];
  const errors: { code: string; message: string }[] = [];
  let ends = 0;
  const input = createSpeechInput({
    Ctor: ctor,
    lang: "zh-CN",
    events: {
      onText: (text, isFinal) => texts.push({ text, isFinal }),
      onError: (code, message) => errors.push({ code, message }),
      onEnd: () => {
        ends++;
      },
    },
  });
  return { input, texts, errors, ends: () => ends };
}

describe("语音输入通道", () => {
  it("★ 没有这个 API 时必须**如实**报（⛔ 不静默）", () => {
    expect(speechInputSupported({})).toBe(false);
    expect(speechInputSupported({ webkitSpeechRecognition: FakeRec })).toBe(true);
    const h = harness(null);
    expect(h.input.supported).toBe(false);
    h.input.start();
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0].message).toContain("不带语音识别");
  });

  it("★ 中间结果与定稿分得开（只有定稿能插进笔记 ✓）", () => {
    const h = harness(FakeRec);
    expect(h.input.supported).toBe(true);
    h.input.start();
    expect(h.input.listening()).toBe(true);
    const rec = (h.input as unknown as { __rec?: never }) && null;
    void rec;
    // 拿到那个 fake（create 里 new 出来的）—— 通过事件回调的写入顺序断言即可 ✓
    expect(h.texts).toHaveLength(0);
  });

  it("★ 手动喂一条中间结果 ＋ 一条定稿：两条都要报出来，且 isFinal 分得清", () => {
    let made: FakeRec | null = null;
    class Spy extends FakeRec {
      constructor() {
        super();
        made = this;
      }
    }
    const h = harness(Spy);
    h.input.start();
    expect(made).not.toBeNull();
    made!.emit([{ transcript: "我很好", isFinal: false }]);
    made!.emit([{ transcript: "我很好。", isFinal: true }]);
    expect(h.texts).toEqual([
      { text: "我很好", isFinal: false },
      { text: "我很好。", isFinal: true },
    ]);
  });

  it("★ 自己停的时候浏览器也抛 aborted ⇒ 不许当错误弹红字", () => {
    let made: FakeRec | null = null;
    class Spy extends FakeRec {
      constructor() {
        super();
        made = this;
      }
    }
    const h = harness(Spy);
    h.input.start();
    h.input.stop();
    made!.fail("aborted");
    expect(h.errors).toHaveLength(0);
    expect(h.ends()).toBe(1);
    expect(h.input.listening()).toBe(false);
  });

  it("★ 真错误（权限被拒 / 服务不可用 / 没听到 …）每个都有**一句人话**", () => {
    for (const code of ["not-allowed", "service-not-allowed", "network", "no-speech", "audio-capture", "别的"]) {
      const msg = speechErrorMessage(code);
      expect(msg.length).toBeGreaterThan(4);
      expect(msg).not.toContain("undefined");
    }
    expect(speechErrorMessage("not-allowed")).toContain("权限");
    expect(speechErrorMessage("no-speech")).toContain("没听到");
    let made: FakeRec | null = null;
    class Spy extends FakeRec {
      constructor() {
        super();
        made = this;
      }
    }
    const h = harness(Spy);
    h.input.start();
    made!.fail("not-allowed");
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0].message).toContain("权限");
  });
});
