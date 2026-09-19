// 归一化的判据 —— 钉住"中文兼容形搜不到"那条（Mac 侧在真 PDF 上实测出来的）。
//
// 单独一个文件而不是塞进 `store.test.ts`：那份文件是**多人协作在改的**
// （Mac 侧这轮就改过它），把这条跨轴不变量放进去会平白增加冲突面。

import { describe, expect, it } from "vitest";

import { normalizeForMatch, normalizeForStore } from "./normalize";
import { extractAndStore } from "./pipeline";
import { ok, type Extractor } from "./types";
import { createAttachmentTextStore, type SqlRunner } from "./store";
import { DERIVED_SCHEMA_DDL } from "./schema";

/** 最小可用的内存 SQL 假体 —— 本文件只关心"落库的文本长什么样"，不测 SQL 语义（那由 store.test.ts 用真 sqlite 覆盖）。 */
function memStore() {
  const rows: { att: string; ext: string; seq: number; kind: string; text: string; hash: string }[] = [];
  const db: SqlRunner = {
    run(sql, params = []) {
      // ⚠️ 只处理后两者：`ensureSchema` 在没有 `exec` 时会用 `run(DDL)` 建表，
      //    第一版没排除它 ⇒ DDL 被当成 INSERT 塞了一行全 undefined 的假数据，
      //    于是断言读到 'undefined'（**假数据造出的假失败**）。
      if (!sql.startsWith("INSERT") && !sql.startsWith("DELETE")) return;
      if (sql.startsWith("DELETE")) {
        const [att, ext] = params as string[];
        for (let i = rows.length - 1; i >= 0; i--) {
          if (rows[i].att === att && (ext === undefined || rows[i].ext === ext)) rows.splice(i, 1);
        }
        return;
      }
      const p = params as (string | number)[];
      rows.push({
        att: String(p[0]), ext: String(p[1]), seq: Number(p[2]),
        kind: String(p[3]), text: String(p[4]), hash: String(p[6]),
      });
    },
    query<T>(sql: string, params: readonly unknown[] = []) {
      if (sql.includes("DISTINCT extractor")) {
        return rows
          .filter((r) => r.att === String(params[0]))
          .map((r) => ({ extractor: r.ext, src_hash: r.hash })) as unknown as T[];
      }
      return [] as T[];
    },
  };
  const store = createAttachmentTextStore(db);
  // 这里的 store 是**同步**的 sql.js 实现（Awaitable<void> 允许同步）⇒ 不 await 也立刻生效。
  store.ensureSchema(DERIVED_SCHEMA_DDL);
  return { store, rows };
}

/** 一个"抽出什么就说什么"的假抽取器，用来把归一化前后的差异钉住。 */
function echoExtractor(text: string): Extractor {
  return {
    id: "echo@1",
    mimes: [],
    extensions: [".echo"],
    cost: "cpu",
    extract: async () => ok("echo@1", [{ kind: "text", text, loc: "" }]),
  };
}

describe("落库归一化（NFKC）", () => {
  it("**康熙部首 ⇒ 常字**：`第⼀段`(U+2F00) 落库后能被 `第一段`(U+4E00) 搜到", async () => {
    const kangxi = "第\u2F00段"; // 「⼀」康熙部首
    const normal = "第一段"; // 常字
    expect(kangxi).not.toBe(normal);
    expect(kangxi.includes(normal)).toBe(false); // 修之前确实搜不到（先证伪，再修）

    expect(normalizeForStore(kangxi)).toBe(normal);
    expect(normalizeForStore(kangxi).includes(normal)).toBe(true); // 修之后能搜到
    // 查询侧同一口径 —— 用户从 PDF 里粘一个兼容形来搜也要能命中
    expect(normalizeForMatch(kangxi)).toBe(normal);
  });

  it("落库时**由管道层**施加（抽取器不必自己做）", async () => {
    const { store, rows } = memStore();
    const outcome = await extractAndStore({
      attId: "a1",
      bytes: new Uint8Array([1]),
      filename: "x.echo",
      mime: "",
      hash: "h",
      store,
      registry: [echoExtractor("第\u2F00段 １２３")],
    });
    expect(outcome).toMatchObject({ status: "stored" });
    expect(rows[0].text).toBe("第一段 １２３"); // 康熙部首折了；**全角数字保留**（见下一条）
  });

  it("**刻意不折叠全角标点/字母数字**：那是「最小惊讶」的取舍，不是遗漏", async () => {
    // 全量 NFKC 会把 `，`(U+FF0C) 转成 `,`，而 `。`(U+3002) 不变 ⇒ 同一句里标点风格混杂。
    // 对中文文档这是**可见的质量退化**，所以只折叠兼容表意字：
    const s = "甲，乙。丙１２３ＡＢＣ";
    expect(normalizeForStore(s)).toBe(s);
    // 对照：全量 NFKC 会把它改成什么样（写出来是为了让"我们为什么没那么做"一眼可见）
    expect(s.normalize("NFKC")).toBe("甲,乙。丙123ABC");
  });

  it("不改写别的：换行 / 制表 / 中文标点 / 常见括号都不受影响", async () => {
    const s = "甲\t乙\n丙，丁〔2026〕戊";
    expect(normalizeForStore(s)).toBe(s);
  });

  it("**钉住「窄口径」的边界**：只折兼容表意字，别的一律不碰", async () => {
    // 康熙部首 → 常字（本次要修的那个）
    expect(normalizeForStore("\u2F00")).toBe("\u4E00");
    // CJK 兼容表意字 → 统一表意字
    expect(normalizeForStore("\uF900")).toBe("\u8C48");
    // 不在区间内的：全角数字 / 带圈数字 / 括号字 / 连字，**一律不动**
    for (const s of ["１２３", "①", "㈱", "ﬁ"]) {
      expect(normalizeForStore(s)).toBe(s);
    }
  });
});
