// 查询侧归一化的**跨语言一致性**判据：TS 与 Rust 读**同一份夹具**
// （`tests/normalize-parity.json`，Rust 侧在 `src-tauri/src/textnorm.rs` 的
// `matches_the_shared_cross_language_fixture` 里跑同一份）。
//
// 为什么值得单开一个文件：两侧的口径漂移**没有任何编译期信号**——比如有人在 TS 侧"顺手"改成整串
// `normalize("NFKC")`，中文标点就被折成 ASCII 了，而 Rust 侧不会跟着变；那时"存储侧和查询侧同口径"
// 这句话就成了假话，且只有等到用户搜不到才会有人发现。
//
// 夹具用**十进制码点数组**而不是字符串：两侧对同一份文件里的字面字符做出不同解码假设的风险为零，
// 而且"折了几个字"一眼可见。

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { normalizeForMatch, normalizeForStore } from "./normalize";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const fixturePath = join(root, "tests", "normalize-parity.json");

interface ParityCase {
  name: string;
  in: number[];
  out: number[];
}

const fixture: { cases: ParityCase[] } = JSON.parse(readFileSync(fixturePath, "utf8"));
const toStr = (cps: number[]): string => cps.map((c) => String.fromCodePoint(c)).join("");

describe("查询侧归一化 · 跨语言共用夹具（tests/normalize-parity.json）", () => {
  it("夹具非空（空夹具会让下面每条断言都变成空转）", () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(5);
  });

  it("`normalizeForMatch` 对每一条夹具都一致（与 Rust 侧同口径）", () => {
    const bad: string[] = [];
    for (const c of fixture.cases) {
      const got = normalizeForMatch(toStr(c.in));
      if (got !== toStr(c.out)) {
        bad.push(`${c.name}：得到 [${[...got].map((ch) => ch.codePointAt(0)).join(", ")}]`);
      }
    }
    expect(bad, bad.join("；")).toEqual([]);
  });

  it("`normalizeForStore` 与 `normalizeForMatch` 口径相同（存储侧/查询侧不许分家）", () => {
    for (const c of fixture.cases) {
      expect(normalizeForStore(toStr(c.in))).toBe(normalizeForMatch(toStr(c.in)));
    }
  });

  it("幂等：折过的文本再折一次不变", () => {
    for (const c of fixture.cases) {
      const once = normalizeForMatch(toStr(c.in));
      expect(normalizeForMatch(once)).toBe(once);
    }
  });
});
