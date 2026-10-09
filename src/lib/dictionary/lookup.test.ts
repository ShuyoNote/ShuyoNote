// 「文案如实」的机器判据（评估文档 §3-③/§3-④）。
//
// 这一层要钉住的是**界面不会把"没查到"说成"查到了"**、也**不会静默空白**：
//   ⛔ 空白浮层 = 用户以为查过了（与"编造释义"是同一类问题）
//   ⛔ 把后端那句"未收录"丢掉/改写成一句含糊话 = 同一类问题
//
// ⚠️ 这里**不**断言"ECDICT 里到底有没有 apple" —— 那是数据的事，
// 判据在 `scripts/dictionary-bench.mjs`（数据层）与 `cargo test --lib dictionary`（Rust 层）。

import { describe, expect, it } from "vitest";
import {
  EMPTY_SELECTION_MESSAGE,
  aiHintForMiss,
  dictionaryStatus,
  hasLookupChars,
  lookupWord,
  normalizeSelection,
  presentOutcome,
  type DictionaryInvoker,
} from "./lookup";
import type { DictionaryLookupOutcome } from "../platform/commands";

/** 记下"发了哪些命令"的假 invoker（判据要能看见**没发**命令这件事）。 */
function fakeInvoker(
  handler: (cmd: string, args?: Record<string, unknown>) => unknown,
): DictionaryInvoker & { calls: { cmd: string; args?: Record<string, unknown> }[] } {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  return {
    calls,
    async invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
      calls.push({ cmd, args });
      return handler(cmd, args) as T;
    },
  };
}

/** 一条正常词条的假结果（字段形状与 Rust `DictEntry` 一致）。 */
const found: DictionaryLookupOutcome = {
  status: "found",
  query: "apple",
  matched: "apple",
  entry: {
    word: "apple",
    phonetic: "ˈæpl",
    translation: "n. 苹果",
    definition: "a round fruit",
    pos: "n",
    tag: "zk gk",
    exchange: "",
  },
};

describe("presentOutcome：三种状态各自的形状", () => {
  it("查到 ⇒ tone=found，标题是词条原形，正文是译文（优先）", () => {
    const p = presentOutcome(found);
    expect(p.tone).toBe("found");
    expect(p.title).toBe("apple");
    expect(p.body).toBe("n. 苹果");
    expect(p.meta).toContain("ˈæpl");
    expect(p.aiHint).toBe(false);
  });

  it("词条只有词形（没有译文/定义）⇒ 如实说，⛔ 不留空", () => {
    const p = presentOutcome({
      ...found,
      entry: { ...found.entry, translation: "", definition: "" },
    });
    expect(p.body.length).toBeGreaterThan(0);
    expect(p.body).toContain("不补写");
  });

  it("中文术语未收录 ⇒ 明说「英汉词典」＋「走 AI」（评估文档 §3-③ 的两个例子）", () => {
    for (const zh of ["方法论", "核聚变"]) {
      const outcome: DictionaryLookupOutcome = {
        status: "not_found",
        query: zh,
        kind: "not_english",
        // 与 Rust `dictionary::miss_message` 同口径的那句人话。
        message: `本地词典是英汉词典，不含中文词条：「${zh}」未收录 ⇒ 需要解释请走 AI（这里不编造本地释义）。`,
      };
      const p = presentOutcome(outcome);
      expect(p.tone).toBe("miss");
      expect(p.body).toContain("英汉");
      expect(p.body).toContain("AI");
      expect(p.aiHint).toBe(true);
      // ⭐ 原样透传：前端**不许**把后端这句话改写/吞掉。
      expect(p.body).toBe(outcome.message);
    }
  });

  it("词典不在 ⇒ tone=unavailable，且**与「未收录」不是同一档**", () => {
    const p = presentOutcome({
      status: "unavailable",
      message: "本地英汉词典未安装（env SHUYONOTE_ECDICT_DB / app data / 资源目录三处都没有 ecdict.db）",
    });
    expect(p.tone).toBe("unavailable");
    expect(p.body).toContain("未安装");
    // ⛔ 不许出现"未收录"这种说法 —— 那会让人以为查过了。
    expect(p.body).not.toContain("未收录于");
    expect(p.aiHint).toBe(true);
  });

  it("⭐ 不变量：任何状态都**不许静默空白**（标题与正文不许同时为空）", () => {
    const kinds = ["empty", "not_english", "not_found", "too_long"] as const;
    const all: DictionaryLookupOutcome[] = [
      found,
      { ...found, entry: { ...found.entry, translation: "", definition: "" } },
      ...kinds.map(
        (kind): DictionaryLookupOutcome => ({
          status: "not_found",
          query: kind === "empty" ? "" : "方法论",
          kind,
          message: `（${kind} 的那句人话）`,
        }),
      ),
      { status: "unavailable", message: "（未安装的那句人话）" },
    ];
    for (const outcome of all) {
      const p = presentOutcome(outcome);
      expect(`${p.title}${p.body}`.length, `状态 ${outcome.status} 的浮层不许是空的`).toBeGreaterThan(0);
      expect(p.body.trim().length, `状态 ${outcome.status} 的正文不许是空白`).toBeGreaterThan(0);
    }
  });

  it("⛔ 未收录/未安装的结果里**不许**混进任何「像释义」的东西", () => {
    const p = presentOutcome({
      status: "not_found",
      query: "zzqxwv",
      kind: "not_found",
      message: "「zzqxwv」未收录于本地英汉词典（ECDICT） ⇒ 可走 AI 解释；这里不猜。",
    });
    // 释义只可能来自 `found` 那条分支 —— 未收录的展示里不许出现词条字段。
    expect(Object.keys(p)).not.toContain("entry");
    expect(Object.keys(p)).not.toContain("translation");
    for (const leaked of ["苹果", "fruit", "n. "]) {
      expect(p.body).not.toContain(leaked);
    }
  });
});

describe("aiHintForMiss：只有「有一个词值得解释」时才给 AI 入口", () => {
  it("中文词条 / 英文未收录 ⇒ 给", () => {
    expect(aiHintForMiss("not_english")).toBe(true);
    expect(aiHintForMiss("not_found")).toBe(true);
  });
  it("没选中 / 选太长 ⇒ 不给（前者没有对象，后者该先缩小选择）", () => {
    expect(aiHintForMiss("empty")).toBe(false);
    expect(aiHintForMiss("too_long")).toBe(false);
  });
});

describe("lookupWord：值不值得发命令 ＋ 失败也要说人话", () => {
  it("空白/纯标点 ⇒ **一条命令都不发**，直接给「没选中」", async () => {
    const inv = fakeInvoker(() => {
      throw new Error("不该被调用");
    });
    for (const raw of ["", "   ", "\n", "，", "。", "—"]) {
      const out = await lookupWord(inv, raw);
      expect(out).toEqual({
        status: "not_found",
        query: normalizeSelection(raw),
        kind: "empty",
        message: EMPTY_SELECTION_MESSAGE,
      });
    }
    expect(inv.calls, `不该发任何命令，实际发了 ${JSON.stringify(inv.calls)}`).toHaveLength(0);
  });

  it("中文术语照样发出去（语言判断归词典，不在这里判）", async () => {
    const inv = fakeInvoker(() => ({
      status: "not_found",
      query: "方法论",
      kind: "not_english",
      message: "本地词典是**英汉**词典……",
    }));
    const out = await lookupWord(inv, "  方法论 ");
    expect(inv.calls).toEqual([{ cmd: "dictionary_lookup", args: { word: "方法论" } }]);
    expect(out.status).toBe("not_found");
  });

  it("命令面出错 ⇒ 归到 unavailable，且明说「没查到」而不是编一个", async () => {
    const inv = fakeInvoker(() => {
      throw new Error("command dictionary_lookup not found");
    });
    const out = await lookupWord(inv, "apple");
    expect(out.status).toBe("unavailable");
    if (out.status === "unavailable") {
      expect(out.message).toContain("没查到");
      expect(out.message).toContain("不编造");
      expect(out.message).toContain("not found");
    }
  });
});

describe("dictionaryStatus：读数失败也不假装就绪", () => {
  it("失败 ⇒ available=false ＋ 说清是按「未安装」处理", async () => {
    const inv = fakeInvoker(() => {
      throw new Error("boom");
    });
    const st = await dictionaryStatus(inv);
    expect(st.available).toBe(false);
    expect(st.entries).toBeNull();
    expect(st.message).toContain("未安装");
  });
  it("成功 ⇒ 原样透传", async () => {
    const real = {
      available: true,
      path: "C:/x/ecdict.db",
      bytes: 123,
      entries: 4,
      source: "env",
      verified: true,
      message: "就绪",
    };
    const inv = fakeInvoker(() => real);
    expect(await dictionaryStatus(inv)).toEqual(real);
  });
  it("⭐「没装」与「装了但完整性没过」必须能分开（verified 那一格）", async () => {
    // 前端拿到的这两种状态**不能长得一样** —— 否则界面只能说一句含糊的话，
    // 而"请重新下载"与"请先下载"是两句不同的话（owner 第 ④ 条）。
    const notInstalled = await dictionaryStatus(fakeInvoker(() => {
      throw new Error("no pack");
    }));
    expect(notInstalled.available).toBe(false);
    expect(notInstalled.verified).toBeNull();

    const broken = {
      available: false,
      path: "C:/x/packs/ecdict-en-zh/ecdict-en-zh.bin",
      bytes: 12,
      entries: null,
      source: "pack",
      verified: false,
      message: "词库文件在，但完整性没过（半包/指纹不符）⇒ 按「未就绪」处理，请重新下载。",
    };
    const st = await dictionaryStatus(fakeInvoker(() => broken));
    expect(st.available).toBe(false);
    expect(st.verified).toBe(false);
    expect(st.message).toContain("重新下载");
  });
});

describe("hasLookupChars / normalizeSelection", () => {
  it("只有字母数字才算可查（中文也算 —— 由词典去说「没有中文词条」）", () => {
    expect(hasLookupChars("apple")).toBe(true);
    expect(hasLookupChars("方法论")).toBe(true);
    expect(hasLookupChars("give up")).toBe(true);
    expect(hasLookupChars("123")).toBe(true);
    expect(hasLookupChars(" —— ")).toBe(false);
    expect(hasLookupChars("。，!?")).toBe(false);
  });
  it("规范化只去首尾空白（大小写/标点是词典的事）", () => {
    expect(normalizeSelection("  Apple. ")).toBe("Apple.");
  });
});
