// `check-dead-code-receipts` 的判据：**"收据"这件事不许靠人自觉**。
//
// 这组用例里有两类，缺一不可：
//   · **定向用例**（1–8）：把"什么是收据 / 什么不是"钉死，包括**实测踩到过的两个假判定**——
//     ① 缩进过的 `///` 文档注释被当成"代码"⇒ 明明写了带日期的收据却判红（`hlc.rs::observe` 现场）；
//     ② 注释里**提到** `#[allow(dead_code)]`（仓库里有十几处讲这件事的注释）被 grep 式扫描算成命中。
//   · **变异用例**（9–11）：拿**真实文件**的文本做变异（删掉收据里的日期），要求它**当场变红** ——
//     只证明"现在绿"是不够的：判据塌掉的方式正是"它什么都不看"（扫描范围为空、正则失配、掩码全跳过），
//     而那种塌法在绿读数里看不出来。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  EXEMPT,
  check,
  findAllowDeadCode,
  offendersOf,
  receiptBlock,
} from "./check-dead-code-receipts.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const lines = (...xs) => xs.join("\n") + "\n";

describe("什么是收据", () => {
  it("同行带日期 ⇒ 有收据", () => {
    expect(offendersOf(lines('#[allow(dead_code)] // ★ 2026-09-25 收据：还没接线，接完就删', "pub fn f() {}"))).toEqual([]);
  });

  it("上面带日期的文档注释 ⇒ 有收据", () => {
    const src = lines(
      "/// 为什么留着：判据在用。",
      "/// ⚠️ 2026-09-25 收据：删除条件 = 判据改走别处的那天。",
      "#[allow(dead_code)]",
      "pub fn f() {}",
    );
    expect(offendersOf(src)).toEqual([]);
  });

  it("**缩进过的** `///` 也算注释（`hlc.rs::observe` 那个实测假红）", () => {
    const src = lines(
      "impl Hlc {",
      "    /// ★ 2026-09-25 收据：收侧还没接 observe。",
      "    #[cfg_attr(not(test), allow(dead_code))]",
      "    pub fn observe(&mut self) {}",
      "}",
    );
    expect(offendersOf(src)).toEqual([]);
  });

  it("属性上面空一行仍算紧邻（视觉分组不该判红）", () => {
    const src = lines(
      "/// 2026-09-25 收据：说明。",
      "",
      "#[allow(dead_code)]",
      "pub fn f() {}",
    );
    expect(offendersOf(src)).toEqual([]);
  });

  it("模块级 `#![allow(dead_code)]` 由 `//!` 头部当收据", () => {
    const src = lines(
      "//! 这一片还没接线（施工单 §x）。",
      "//! ⚠️ 2026-09-25 收据：接线那天删掉本行。",
      "#![allow(dead_code)]",
      "",
      "pub fn f() {}",
    );
    expect(offendersOf(src)).toEqual([]);
  });
});

describe("什么不是收据", () => {
  it("裸豁免 ⇒ 红", () => {
    expect(offendersOf(lines("#[allow(dead_code)]", "pub fn f() {}")).map((o) => o.line)).toEqual([1]);
  });

  it("日期在**别的代码**上面 ⇒ 不算（必须长在这条属性旁边）", () => {
    const src = lines(
      "// 2026-09-25 收据：这是**别的**函数上面的说明。",
      "pub fn unrelated() {}",
      "",
      "#[allow(dead_code)]",
      "pub fn f() {}",
    );
    expect(offendersOf(src).map((o) => o.line)).toEqual([4]);
  });

  it("`cfg_attr(…, allow(dead_code))` 同样要收据", () => {
    expect(offendersOf(lines("#[cfg_attr(feature = \"x\", allow(dead_code))]", "pub fn f() {}")).length).toBe(1);
  });

  it("**注释里提到**它不算命中（仓库里那十几处讲这件事的注释）", () => {
    const src = lines(
      "// ★ 2026-09-25：原来这里有一行 `#[allow(dead_code)]`，已删。",
      "/// 收据兑现了：删掉 `lib.rs` 里 `mod hlc;` 上面那行 `#[allow(dead_code)]`。",
      "pub fn f() {}",
    );
    expect(findAllowDeadCode(src)).toEqual([]);
    expect(offendersOf(src)).toEqual([]);
  });
});

describe("变异实测：判据塌掉就当场红", () => {
  it("把真实文件里的日期抹掉 ⇒ 那一条立刻变成违规（`hlc.rs::observe` 现场）", () => {
    const rel = "src-tauri/src/hlc.rs";
    const text = readFileSync(resolve(root, rel), "utf8");
    expect(offendersOf(text)).toEqual([]); // 现状绿
    const hit = findAllowDeadCode(text).find((h) => /allow\(dead_code\)/.test(text.split("\n")[h.line - 1]) && h.line > 100);
    expect(hit, "`observe` 那条豁免必须在（它是这组用例的被测对象）").toBeTruthy();
    // 只动收据里的日期：说明文字一字不改 —— 这一格红的理由必须是"没有日期"，不是"没写理由"
    const mutated = text.replace(/2026-09-25 的实况/, "不明日期的实况");
    expect(mutated).not.toBe(text);
    const bad = offendersOf(mutated);
    expect(bad.map((o) => o.line)).toContain(hit.line);
  });

  it("缩进注释那条：把日期拿掉 ⇒ 红（否则上面那条可能只是「注释被判成代码」而假绿）", () => {
    const src = lines(
      "impl Hlc {",
      "    /// ⚠️ 实况：收侧还没接 observe。",
      "    #[cfg_attr(not(test), allow(dead_code))]",
      "    pub fn observe(&mut self) {}",
      "}",
    );
    expect(offendersOf(src).map((o) => o.line)).toEqual([3]);
  });

  it("`receiptBlock` 里必须真的看得到上面那几行（不能只回属性自己那行）", () => {
    const src = lines("/// 2026-09-25 收据：在。", "#[allow(dead_code)]", "pub fn f() {}");
    const hit = findAllowDeadCode(src)[0];
    expect(receiptBlock(src, hit.index)).toContain("2026-09-25");
  });
});

describe("全仓自洽", () => {
  it("本仓当前零违规，且**真的扫到了东西**（防「扫 0 个文件也绿」）", () => {
    const { files, occurrences, offenders } = check(root);
    expect(offenders).toEqual([]);
    expect(files.length).toBeGreaterThan(40);
    expect(occurrences.length).toBeGreaterThan(5);
  });

  it("生成物进 `exempt` 而不是被当成合规（既要放过、也要每次都亮出来）", () => {
    const { occurrences, exempt } = check(root);
    const generated = "src-tauri/src/capabilities_gen.rs";
    expect([...EXEMPT.keys()]).toContain(generated);
    expect(exempt.map((e) => e.file)).toContain(generated);
    expect(occurrences.map((o) => o.file)).not.toContain(generated);
  });
});
