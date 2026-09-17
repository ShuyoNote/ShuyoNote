// **覆盖度驱动的调度**判据 —— 钉住"混合文档静默丢页"那条（Mac 侧实测）。
//
// 背景（方案 §15.2 的 `ExtractCoverage`）：正文是文字、中间夹了几页扫描的 PDF，
// 会让 `pdf.text` 返回 `ok` 却**跳过了空页而不报告** ⇒ 后面的 `pdf.ocr` 永远不被调度
// ⇒ 那几页**静默没有内容**。不报错、不红，只是少了一块，且没有任何地方能看出来。
//
// 这里用**记录型假 store**：本文件测的是**调度器的决策**（用谁的结果、试了几个），
// 不是 SQL 语义（那由 `store.test.ts` / `platformWiring.test.ts` 用真 sqlite 覆盖）。

import { describe, expect, it } from "vitest";

import { extractAndStore } from "./pipeline";
import type { AttachmentTextStore } from "./store";
import { ok, type ExtractInput, type Extractor, type ExtractResult } from "./types";

interface Written {
  extractor: string;
  texts: string[];
}

/** 只记录"谁的结果被落库了"。 */
function recordingStore() {
  const written: Written[] = [];
  const store = {
    ensureSchema: () => {},
    needsExtract: () => true,
    replace: (_attId: string, extractorId: string, _hash: string, segments: { text: string }[]) => {
      written.push({ extractor: extractorId, texts: segments.map((s) => s.text) });
    },
    removeAttachment: () => {},
    segmentsOf: () => [],
    stats: () => ({ attachments: 0, segments: 0 }),
  } as unknown as AttachmentTextStore;
  return { store, written };
}

/** 假抽取器：按声明产出结果，并记录自己被调用了几次。 */
function fakeExtractor(id: string, result: ExtractResult, calls: string[]): Extractor {
  return {
    id,
    mimes: ["application/x-test"],
    extensions: [".t"],
    cost: "cpu",
    extract: async (_input: ExtractInput): Promise<ExtractResult> => {
      calls.push(id);
      return result;
    },
  };
}

const input = {
  attId: "a",
  bytes: new Uint8Array([1]),
  filename: "x.t",
  mime: "application/x-test",
  hash: "h",
};

describe("覆盖度驱动调度（静默丢页的修法）", () => {
  it("**不完整 ⇒ 继续试下一个；完整的那份胜出**（这就是混合文档该走的路）", async () => {
    const calls: string[] = [];
    const partial = fakeExtractor(
      "pdf.text@1",
      ok("pdf.text@1", [{ kind: "text", text: "只有文字页", loc: "p.1" }], {
        complete: false,
        gapIndexes: [1],
        note: "跳过 p.2",
      }),
      calls,
    );
    const full = fakeExtractor(
      "pdf.ocr@1",
      ok("pdf.ocr@1", [
        { kind: "text", text: "只有文字页", loc: "p.1" },
        { kind: "ocr", text: "扫描页识别出来的字", loc: "p.2" },
      ]),
      calls,
    );

    const { store, written } = recordingStore();
    const out = await extractAndStore({ ...input, store, registry: [partial, full] });

    expect(calls).toEqual(["pdf.text@1", "pdf.ocr@1"]); // 真的去试了第二个
    expect(out).toMatchObject({ status: "stored", extractor: "pdf.ocr@1", segments: 2 });
    expect(written).toHaveLength(1); // **整体替换**，不是合并两份
    expect(written[0].texts).toContain("扫描页识别出来的字");
  });

  it("**完整覆盖 ⇒ 立刻收工**，不去白跑第二个（顺序即优先级）", async () => {
    const calls: string[] = [];
    const first = fakeExtractor("a@1", ok("a@1", [{ kind: "text", text: "够了", loc: "" }]), calls);
    const second = fakeExtractor("b@1", ok("b@1", [{ kind: "text", text: "不该被跑", loc: "" }]), calls);

    const { store, written } = recordingStore();
    const out = await extractAndStore({ ...input, store, registry: [first, second] });

    expect(calls).toEqual(["a@1"]);
    expect(out).toMatchObject({ extractor: "a@1" });
    expect(written[0].texts).toEqual(["够了"]);
  });

  it("两个都不完整 ⇒ 留**缺口更少**的那个；缺口一样多 ⇒ 留先到的", async () => {
    const calls: string[] = [];
    const worse = fakeExtractor(
      "w@1",
      ok("w@1", [{ kind: "text", text: "缺两页", loc: "" }], { complete: false, gapIndexes: [1, 2] }),
      calls,
    );
    const better = fakeExtractor(
      "b@1",
      ok("b@1", [{ kind: "text", text: "缺一页", loc: "" }], { complete: false, gapIndexes: [2] }),
      calls,
    );
    const tie = fakeExtractor(
      "t@1",
      ok("t@1", [{ kind: "text", text: "也缺一页", loc: "" }], { complete: false, gapIndexes: [3] }),
      calls,
    );

    const r1 = recordingStore();
    await extractAndStore({ ...input, store: r1.store, registry: [worse, better] });
    expect(r1.written[0].texts).toEqual(["缺一页"]); // 缺口少的胜出

    const r2 = recordingStore();
    await extractAndStore({ ...input, store: r2.store, registry: [better, tie] });
    expect(r2.written[0].texts).toEqual(["缺一页"]); // 并列 ⇒ 先到的
  });

  it("**只有不完整的结果时也要落库**（少而标注清楚 > 整体失败什么都没留下）", async () => {
    const calls: string[] = [];
    const only = fakeExtractor(
      "p@1",
      ok("p@1", [{ kind: "text", text: "只覆盖了前 50 页", loc: "p.1" }], {
        complete: false,
        note: "只覆盖 p.1–p.50（源 2000 页，超单次上限）",
      }),
      calls,
    );

    const { store, written } = recordingStore();
    const out = await extractAndStore({ ...input, store, registry: [only] });

    expect(out).toMatchObject({ status: "stored", extractor: "p@1" });
    expect(written[0].texts).toEqual(["只覆盖了前 50 页"]);
  });

  it("不完整的结果**不会**把后面的失败当成终局（失败不覆盖已拿到的部分）", async () => {
    const calls: string[] = [];
    const partial = fakeExtractor(
      "p@1",
      ok("p@1", [{ kind: "text", text: "半份", loc: "" }], { complete: false, gapIndexes: [1] }),
      calls,
    );
    const boom = fakeExtractor(
      "q@1",
      { ok: false, extractor: "q@1", code: "provider_error", message: "视觉端点不可达" },
      calls,
    );

    const { store, written } = recordingStore();
    const out = await extractAndStore({ ...input, store, registry: [partial, boom] });

    expect(calls).toEqual(["p@1", "q@1"]);
    expect(out).toMatchObject({ status: "stored", extractor: "p@1" }); // 保住半份，而不是报 failed
    expect(written[0].texts).toEqual(["半份"]);
  });
});
