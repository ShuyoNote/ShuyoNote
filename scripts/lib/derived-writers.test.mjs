// `derived-writers` 的判据：**生产代码写派生表必须被抓到，测试夹具不许误伤**。
//
// 这一组的存在理由：这条规则的价值全在"测试里的 INSERT 不算"这一步上 ——
// Rust 侧今天就有两处 INSERT 在 `#[cfg(test)]` 里（播种夹具），判据若不做区域判定，
// 一开始就红，真回归会被淹没；反过来，若切得太狠（把生产代码也切掉），规则就形同虚设。
import { describe, expect, it } from "vitest";

import { findDerivedWrites, scanDerivedWriters } from "./derived-writers.mjs";

describe("findDerivedWrites：认得三种写法", () => {
  it("INSERT INTO / INSERT OR REPLACE INTO / REPLACE INTO（大小写不敏感）", () => {
    const text = [
      'c.execute("INSERT INTO chunks (id) VALUES (?1)", []).unwrap();',
      'c.execute("insert into attachment_text (id) VALUES (?1)", []).unwrap();',
      'c.execute("INSERT OR REPLACE INTO chunks (id) VALUES (?1)", []).unwrap();',
      'c.execute("REPLACE INTO attachment_text (id) VALUES (?1)", []).unwrap();',
    ].join("\n");
    const hits = findDerivedWrites(text);
    expect(hits.map((h) => h.table)).toEqual(["chunks", "attachment_text", "chunks", "attachment_text"]);
    expect(hits.map((h) => h.line)).toEqual([1, 2, 3, 4]);
  });

  it("别的表 / 只是 SELECT 不算", () => {
    const text = [
      'c.execute("INSERT INTO pages (id) VALUES (?1)", []).unwrap();',
      'c.execute("SELECT content FROM chunk_text_view", []).unwrap();',
      'let _ = "chunks"; // 只是提到表名',
      'c.execute("SELECT id FROM chunks WHERE id = ?1", []).unwrap();',
    ].join("\n");
    expect(findDerivedWrites(text)).toEqual([]);
  });

  it("同一行两次也算两次（不漏）", () => {
    const text = 'let _ = ("INSERT INTO chunks", "INSERT INTO attachment_text");';
    expect(findDerivedWrites(text).length).toBe(2);
  });

  it("★ 跨行写法必须抓住（`INSERT INTO` ⏎ `  chunks (…)`）—— 逐行扫会静默漏过", () => {
    // Windows 2026-09-19 复核实测：逐行扫时这一格 exit 0（假绿）。本仓自己的长 INSERT 就爱这么折行。
    const text = ['let sql = "INSERT INTO', '  chunks (id) VALUES (?1)";', 'c.execute(sql, []).unwrap();'].join("\n");
    const hits = findDerivedWrites(text);
    expect(hits).toEqual([{ table: "chunks", line: 1 }]);
  });

  it("★ 跨行 + 大写 + OR REPLACE 的组合也抓住", () => {
    const text = ["c.execute(", '  "INSERT OR REPLACE INTO', '     attachment_text (att_id) VALUES (?1)",', "  [],", ");"].join("\n");
    expect(findDerivedWrites(text)).toEqual([{ table: "attachment_text", line: 2 }]);
  });

  it("跨行写法下，行号报的是 `INSERT` 那一行（不是表名那一行）", () => {
    const text = ["fn a() {}", "fn b() {}", 'let s = "REPLACE INTO', '   chunk_embeddings (id) VALUES (?1)";'].join("\n");
    expect(findDerivedWrites(text)).toEqual([{ table: "chunk_embeddings", line: 3 }]);
  });

  it("`chunk_embeddings` 也在清单里（Windows 建议：今天两侧都没有生产写入者，加了不会红）", () => {
    expect(findDerivedWrites('x("INSERT INTO chunk_embeddings (id)")')).toEqual([{ table: "chunk_embeddings", line: 1 }]);
  });
});

describe("scanDerivedWriters：按文件汇总，路径带出来", () => {
  it("多文件多命中", () => {
    const out = scanDerivedWriters([
      { path: "src-tauri/src/a.rs", text: 'x("INSERT INTO chunks")' },
      { path: "src-tauri/src/b.rs", text: "y()" },
    ]);
    expect(out).toEqual([{ path: "src-tauri/src/a.rs", table: "chunks", line: 1 }]);
  });

  it("空输入 ⇒ 空结果（判据本身不许把'没扫到'当成绿）", () => {
    expect(scanDerivedWriters([])).toEqual([]);
  });
});
