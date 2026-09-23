// 桌面 store 适配器的判据。
//
// 三条要守的东西，按重要性排：
//   1. **发出去的 op 与运输契约逐字相同**（命令名、op tag、字段名）—— 漂了就是"命令报 missing field"；
//   2. **`needsExtract` 的判定与同步实现逐条一致** —— 这条是"两份实现别漂"的正面判据：
//      喂**同样的行**给两个实现，答案必须相同（不是"看起来像"，是同一批用例逐一比）；
//   3. `ensureSchema` 在桌面**是 no-op**（schema 归 Rust 的 migrate）—— 顺手钉住"别在 TS 侧再建一次表"。

import { describe, expect, it } from "vitest";
import { desktopDerivedStores, needsExtractFromRows } from "./derivedStores";
import type { DerivedInvoker, DerivedOp, DerivedQuery } from "./derivedTransport";

/** 记录调用的假 invoker；`rows` 决定读命令返回什么。 */
function fakeInvoker(rows: unknown = []) {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  const invoker: DerivedInvoker = {
    async invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
      calls.push(args === undefined ? { cmd } : { cmd, args });
      return rows as T;
    },
  };
  return { invoker, calls };
}

const opsOf = (calls: { args?: Record<string, unknown> }[]): DerivedOp[] =>
  (calls[0]?.args?.ops as DerivedOp[]) ?? [];
const queryOf = (calls: { args?: Record<string, unknown> }[]): DerivedQuery | undefined =>
  calls[0]?.args?.query as DerivedQuery | undefined;

describe("desktopDerivedStores：op 发射与读映射", () => {
  it("text.replace ⇒ 一条 replaceAttachmentText（字段名与契约一致，loc 原样带过去）", async () => {
    const { invoker, calls } = fakeInvoker();
    const s = desktopDerivedStores(invoker);
    await s.text.replace("att-1", "pdf.text@1", "sha256:abc", [
      { kind: "text", text: "第一段", loc: "p1" },
      { kind: "text", text: "第二段", loc: "" },
    ], 1_758_259_200_000);

    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("derived_apply");
    expect(opsOf(calls)).toEqual([
      {
        op: "replaceAttachmentText",
        attId: "att-1",
        extractor: "pdf.text@1",
        srcHash: "sha256:abc",
        now: 1_758_259_200_000,
        // ★ 不传覆盖度 ⇒ 线上是 `''`（＝**未知**），**不是** `{"complete":true}`
        coverage: "",
        segments: [
          { kind: "text", text: "第一段", loc: "p1" },
          { kind: "text", text: "第二段", loc: "" },
        ],
      },
    ]);
  });

  it("★ text.replace 带覆盖度 ⇒ 线上是**一段 JSON 字符串**（序列化只在 TS 这一处做）", async () => {
    const { invoker, calls } = fakeInvoker();
    const s = desktopDerivedStores(invoker);
    await s.text.replace(
      "att-1",
      "pdf.text@1",
      "sha256:abc",
      [{ kind: "text", text: "第一段", loc: "p1" }],
      1,
      { complete: false, gapIndexes: [1], note: "跳过 p.2" },
    );
    const op = opsOf(calls)[0] as { coverage: string };
    expect(op.coverage).toBe('{"complete":false,"gapIndexes":[1],"note":"跳过 p.2"}');
    // 关键：线上过去的是**字符串**，不是嵌套对象 —— 解析/口径在 `storedCoverageFrom` 一处。
    expect(typeof op.coverage).toBe("string");
  });

  it("chunks.replace ⇒ 一条 replaceChunks（owner 两种形状都覆盖）", async () => {
    const { invoker, calls } = fakeInvoker();
    const s = desktopDerivedStores(invoker);
    await s.chunks.replace({ kind: "page", pageId: "p1" }, [
      { id: "p:p1#0", pageId: "p1", attId: null, ord: 0, loc: "", lang: "", text: "正文", hash: "h0" },
    ]);
    expect(opsOf(calls)[0]).toMatchObject({ op: "replaceChunks", owner: { kind: "page", pageId: "p1" } });

    const b = fakeInvoker();
    const s2 = desktopDerivedStores(b.invoker);
    await s2.chunks.remove({ kind: "attachment", attId: "a1" });
    expect(opsOf(b.calls)[0]).toEqual({ op: "removeChunks", owner: { kind: "attachment", attId: "a1" } });
  });

  it("读命令：segmentsOf / chunksOf / stats 各发一条对应 query（只读，不发写命令）", async () => {
    const { invoker, calls } = fakeInvoker([]);
    const s = desktopDerivedStores(invoker);
    await s.text.segmentsOf("att-1");
    await s.chunks.chunksOf({ kind: "attachment", attId: "att-1" });
    await s.chunks.stats();
    await s.text.stats();

    expect(calls.map((c) => c.cmd)).toEqual([
      "derived_query",
      "derived_query",
      "derived_query",
      "derived_query",
    ]);
    expect(calls.map((c) => (queryOf([c]) as { op: string }).op)).toEqual([
      "attachmentTextSegments",
      "chunkRows",
      "chunkStats",
      "attachmentTextStats",
    ]);
  });

  it("★ text.coverageOf ⇒ 发 attachmentTextCoverage，并**走共用纯函数**解析（`''`/坏 JSON ⇒ 未知）", async () => {
    const { invoker, calls } = fakeInvoker([
      { extractor: "pdf.ocr@1", coverage: '{"complete":true}' },
      { extractor: "pdf.text@1", coverage: "" }, // 未知
      { extractor: "text.plain@1", coverage: "{不是 json" }, // 坏 ⇒ 也只算未知
    ]);
    const s = desktopDerivedStores(invoker);
    const got = await s.text.coverageOf("att-1");

    expect(queryOf(calls)).toEqual({ op: "attachmentTextCoverage", attId: "att-1" });
    expect(got).toEqual([
      { extractor: "pdf.ocr@1", coverage: { complete: true } },
      { extractor: "pdf.text@1" },
      { extractor: "text.plain@1" },
    ]);
    // 桌面这半边的判据就到这里：**解析口径不在这里**（那是 `store.ts::storedCoverageFrom` 的判据），
    // 这里只钉"发对了 query、且没有自己再造一套解析"。
    expect("coverage" in got[1]!).toBe(false);
  });

  it("ensureSchema 在桌面是 no-op（schema 归 Rust 的 migrate）—— 一条命令都不发", async () => {
    const { invoker, calls } = fakeInvoker();
    const s = desktopDerivedStores(invoker);
    await s.text.ensureSchema(["CREATE TABLE x"]);
    await s.chunks.ensureSchema(["CREATE TABLE y"]);
    expect(calls).toEqual([]);
  });
});

describe("needsExtract：桌面实现与同步实现**逐条一致**（防两份实现漂）", () => {
  // 用例表：`rows` 是库里已有的行，`srcHash`/`ids` 是这次要问的
  const cases = [
    { name: "库里没有这一页的行", rows: [], srcHash: "h1", ids: ["pdf.text@1"], want: true },
    { name: "行在且 hash 一致", rows: [{ extractor: "pdf.text@1", src_hash: "h1" }], srcHash: "h1", ids: ["pdf.text@1"], want: false },
    { name: "行在但 hash 旧了", rows: [{ extractor: "pdf.text@1", src_hash: "h0" }], srcHash: "h1", ids: ["pdf.text@1"], want: true },
    {
      name: "两个抽取器只来了一个",
      rows: [{ extractor: "pdf.text@1", src_hash: "h1" }],
      srcHash: "h1",
      ids: ["pdf.text@1", "pdf.ocr@1"],
      want: true,
    },
    {
      name: "多出一个旧 hash 的行 ⇒ 整体重抽（残段防护）",
      rows: [
        { extractor: "pdf.text@1", src_hash: "h1" },
        { extractor: "pdf.ocr@1", src_hash: "h0" },
      ],
      srcHash: "h1",
      ids: ["pdf.text@1"],
      want: true,
    },
    { name: "没给抽取器 ⇒ 一律 false", rows: [], srcHash: "h1", ids: [], want: false },
  ];

  it.each(cases)("$name", async ({ rows, srcHash, ids, want }) => {
    // 桌面实现：读命令返回同样的行，判定必须与 expected 一致
    const { invoker } = fakeInvoker(rows);
    const desktop = desktopDerivedStores(invoker);
    expect(await desktop.text.needsExtract("att-1", srcHash, ids)).toBe(want);
    // 同一套规则的纯函数（同步实现用的就是这条）也必须是同一个答案
    expect(needsExtractFromRows(rows, srcHash, ids)).toBe(want);
  });
});
