// 派生层运输契约的判据（TS 侧那一半）。
//
// 跨语言漂移是这一族最容易出、最难查的问题：命令收的是 serde 的 tag 枚举，字段名靠
// `rename_all = "camelCase"` 的**约定**对齐。漂了以后症状是"命令报 missing field"，
// 或者更糟 —— 字段静默落到 `#[serde(default)]`（比如 `loc`/`lang` 变成空串）。
// 所以这里钉两件事：
//   1. **构造函数发出去的 payload 与跨语言夹具逐字相同**（夹具同时被 Rust 测试反序列化）；
//   2. 命令名与参数键（`derived_apply` / `ops`、`derived_query` / `query`）不许改名。

import { describe, expect, it } from "vitest";
import fixture from "../../../tests/derived-transport-ops.json";
import {
  applyOps,
  queryRows,
  type DerivedChunk,
  type DerivedInvoker,
  type DerivedOp,
  type DerivedQuery,
  type DerivedSegment,
} from "./derivedTransport";

/** 记录调用的假 invoker（真命令在桌面才存在；这里只验"发出去什么"）。 */
function recorder(): { invoker: DerivedInvoker; calls: { cmd: string; args?: Record<string, unknown> }[] } {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  return {
    calls,
    invoker: {
      async invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
        calls.push(args === undefined ? { cmd } : { cmd, args });
        return { ops: 0, rows: 0 } as unknown as T;
      },
    },
  };
}

const seg = (kind: string, text: string, loc = ""): DerivedSegment => ({ kind, text, loc });

const chunk: DerivedChunk = {
  id: "att:att-1#0",
  pageId: null,
  attId: "att-1",
  ord: 0,
  loc: "p1",
  lang: "zh",
  text: "第一块",
  hash: "h0",
};

/** 与 `tests/derived-transport-ops.json` 的 `ops` 一一对应（顺序也要一致）。 */
const OPS: DerivedOp[] = [
  {
    op: "replaceAttachmentText",
    attId: "att-1",
    extractor: "pdf.text@1",
    srcHash: "sha256:abc",
    now: 1758259200000,
    coverage: '{"complete":false,"gapIndexes":[1]}',
    segments: [seg("para", "第一段", "p1"), seg("para", "第二段  with spaces")],
  },
  { op: "removeAttachmentText", attId: "att-1" },
  { op: "replaceChunks", owner: { kind: "attachment", attId: "att-1" }, chunks: [chunk] },
  { op: "removeChunks", owner: { kind: "page", pageId: "p-1" } },
];

const QUERIES: DerivedQuery[] = [
  { op: "attachmentTextSegments", attId: "att-1" },
  { op: "attachmentTextCoverage", attId: "att-1" },
  { op: "chunkRows", owner: { kind: "attachment", attId: "att-1" } },
  { op: "chunkStats" },
  { op: "attachmentTextStats" },
];

describe("派生层运输契约（与 Rust 的 serde 形状对齐）", () => {
  it("★ 构造出来的 ops 与跨语言夹具**逐字相同**（Rust 侧同一份夹具必须能反序列化）", () => {
    expect(OPS).toEqual(fixture.ops);
  });

  it("★ 查询同样逐字相同", () => {
    expect(QUERIES).toEqual(fixture.queries);
  });

  it("发出去的命令名与参数键不许改（改了 Rust 侧就是 missing field / not found）", async () => {
    const { invoker, calls } = recorder();
    await applyOps(invoker, OPS);
    expect(calls[0]).toEqual({ cmd: "derived_apply", args: { ops: OPS } });

    const { invoker: inv2, calls: calls2 } = recorder();
    await queryRows(inv2, QUERIES[0]);
    expect(calls2[0]).toEqual({ cmd: "derived_query", args: { query: QUERIES[0] } });
  });

  it("一批 op 只发**一次**调用（一次事务；逐条发就丢了原子性）", async () => {
    const { invoker, calls } = recorder();
    await applyOps(invoker, OPS);
    expect(calls).toHaveLength(1);
  });
});
