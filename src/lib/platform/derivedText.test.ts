// `read_attachment_text`（web 侧）的**行为级**判据 —— 用真 `SqliteStore`（真 sql.js、真 SQL）驱动。
//
// ## 为什么这个文件存在
// 这条分支原先只有**契约级覆盖**：`check-web-commands` 保证"`web.ts` 里有这个分支、参数是 camelCase、
// 形状与 `CommandMap` 一致"，但**一条 SQL 都没跑过**。而这条分支里恰恰全是"跑起来才知道"的东西：
// 参数绑定、缺表、`total` 的算法、越界行为。⇒ 逻辑抽到 `platform/derivedText.ts`（接受一个最小 SQL 句柄），
// 于是可以拿真 store 驱动它。这与我在 `files.search` 上如实报过的覆盖缺口是同一类，
// 也是那条缺口**可复制的修法**（那边还差一步：它带着嵌入逻辑，需要同样的抽取）。

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { SqliteStore, setWasmBytesProvider } from "../platform/sqliteStore";
import { readAttachmentTextVia, MAX_ATT_TEXT_LIMIT } from "./derivedText";

beforeAll(() => {
  const wasm = join(process.cwd(), "node_modules/sql.js/dist/sql-wasm.wasm");
  setWasmBytesProvider(async () => new Uint8Array(readFileSync(wasm)));
});

/** 真 store（`init()` 会把平台自己的 schema 建好 —— `attachments` 是**真表**，别自己再 CREATE 一遍：
 *  那样 `IF NOT EXISTS` 会静默套用平台的表定义，随后 INSERT 的列名对不上才炸，白费一轮）。
 *  派生表 `attachment_text` **故意不建**：缺表那条要单独验，再由 `seed()` 按需建。 */
async function freshDb(withAttachment = true) {
  const store = new SqliteStore({ load: async () => null, save: async () => {} });
  await store.init();
  if (withAttachment) {
    // ⚠️ 列名表**两个平台不一样**：Web 侧是 `path`（附件字节存 blob store 的键），
    //    桌面侧是 `created_at`。这里用 Web 侧那份（本文件测的就是 Web 那条路）。
    store.run(
      `INSERT INTO attachments (id, page_id, name, hash, mime, size, path)
       VALUES ('a1', 'p1', '年报.pdf', 'h', 'application/pdf', 1024, 'blob/a1')`,
    );
  }
  return store;
}

const ATT_TEXT_DDL = `CREATE TABLE IF NOT EXISTS attachment_text (
  att_id TEXT NOT NULL, extractor TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL,
  text TEXT NOT NULL, loc TEXT NOT NULL DEFAULT '', src_hash TEXT NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (att_id, extractor, seq)
)`;

function seed(store: SqliteStore, rows: [string, string, number, string, string][], extractor = "pdf.text@1") {
  store.run(ATT_TEXT_DDL);
  for (const [attId, text, seq, kind, loc] of rows) {
    store.run(
      `INSERT INTO attachment_text (att_id, extractor, seq, kind, text, loc, src_hash, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'h', 0)`,
      [attId, extractor, seq, kind, text, loc],
    );
  }
}

describe("read_attachment_text（web 侧逻辑，真 SQL）", () => {
  it('附件不存在 ⇒ null（"不存在"与"还没抽过"必须分开）', async () => {
    const db = await freshDb();
    expect(readAttachmentTextVia(db, "nope")).toBeNull();
    // 空 id 也按"不存在"处理（命令面在 web.ts 里已明确报参数错误，这里只是兜底不炸）
    expect(readAttachmentTextVia(db, "   ")).toBeNull();
  });

  it("还没抽过（表都不在）⇒ 空段 + total 0，**不是**报错", async () => {
    const db = await freshDb();
    expect(readAttachmentTextVia(db, "a1")).toEqual({ segments: [], total: 0, truncated: false });
  });

  it("有派生文本 ⇒ 逐字段一致，且顺序按 (extractor, seq)", async () => {
    const db = await freshDb();
    seed(db, [
      ["a1", "第二段正文", 1, "text", "p.2"],
      ["a1", "第一段正文", 0, "text", "p.1"],
    ]);
    const page = readAttachmentTextVia(db, "a1")!;
    expect(page.total).toBe(2);
    expect(page.truncated).toBe(false);
    expect(page.segments.map((s) => s.text)).toEqual(["第一段正文", "第二段正文"]);
    expect(page.segments[0]).toEqual({ extractor: "pdf.text@1", kind: "text", text: "第一段正文", loc: "p.1" });
  });

  it("**total 是总段数、不是本页条数**；limit 生效且 truncated 如实", async () => {
    const db = await freshDb();
    seed(db, [
      ["a1", "一", 0, "text", "p.1"],
      ["a1", "二", 1, "text", "p.2"],
      ["a1", "三", 2, "text", "p.3"],
    ]);
    const one = readAttachmentTextVia(db, "a1", 0, 1)!;
    expect(one.segments).toHaveLength(1);
    expect(one.total).toBe(3);
    expect(one.truncated).toBe(true);
  });

  it("offset 翻页：第二页拿到的就是剩下的那些；越界 ⇒ 空段 + 真实 total + truncated=false", async () => {
    const db = await freshDb();
    seed(db, [
      ["a1", "一", 0, "text", "p.1"],
      ["a1", "二", 1, "text", "p.2"],
      ["a1", "三", 2, "text", "p.3"],
    ]);
    const second = readAttachmentTextVia(db, "a1", 1, 2)!;
    expect(second.segments.map((s) => s.text)).toEqual(["二", "三"]);
    expect(second.truncated).toBe(false);

    const beyond = readAttachmentTextVia(db, "a1", 99, 10)!;
    expect(beyond.segments).toEqual([]);
    expect(beyond.total).toBe(3);
    // 越界之后没有可截断的部分 —— 若报 true，调用方会以为"再翻一页还有"
    expect(beyond.truncated).toBe(false);
  });

  it("limit 被夹到上限（注册表里写了上限，代码里也要真的夹）", async () => {
    const db = await freshDb();
    seed(db, [["a1", "一", 0, "text", "p.1"]]);
    // 直接看"夹"这件事的边界：传超大 limit 不该抛，也不该去取比上限更多
    const page = readAttachmentTextVia(db, "a1", 0, 999_999)!;
    expect(page.segments).toHaveLength(1);
    expect(Number.isFinite(MAX_ATT_TEXT_LIMIT)).toBe(true);
    expect(MAX_ATT_TEXT_LIMIT).toBe(1000);
    // 0/负数按 1 处理（不返回全库、也不返回空）
    expect(readAttachmentTextVia(db, "a1", 0, 0)!.segments).toHaveLength(1);
  });

  it("多个抽取器的行**都列出来**并把 extractor 带出（替调用方挑 = 静默丢内容）", async () => {
    const db = await freshDb();
    seed(db, [["a1", "文字层抽的", 0, "text", "p.1"]], "pdf.text@1");
    seed(db, [["a1", "视觉通道抽的", 0, "ocr", "p.1"]], "pdf.ocr@1");
    const page = readAttachmentTextVia(db, "a1")!;
    expect(page.total).toBe(2);
    expect(page.segments.map((s) => s.extractor).sort()).toEqual(["pdf.ocr@1", "pdf.text@1"]);
  });
});
