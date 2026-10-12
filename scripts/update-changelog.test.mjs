// `scripts/update-changelog.mjs` 的**段头日期**判据 —— 钉「新段日期取本机**本地日**，⛔ 不是 UTC 日」✗。
//
// ## 为什么要有它（真坑，不是假想）
// 原实现逐字是：
//     const today = new Date().toISOString().slice(0, 10);   // ⛔ UTC 日
// ⇒ ⭐ **CST（UTC+8）00:00–07:59 之间发版会把段头日期写成"前一天"** ✗。
//    （今晚 20:30 发版没踩到，但那是**运气**：CST 16:00 之后两者才同日 ✓。）
// ⭐ **先红后绿（2026-10-12 实测）**：改前本条 ① 的原文逐字是
//    `AssertionError: …: expected '2026-10-11' to be '2026-10-12'`（`Tests 1 failed | 1 passed`）✓。
//
// ## 判据为什么必须**与环境无关**
// CI 跑在 **UTC**（两边同日 ⇒ 旧实现也能过 ✗）、本机在 **CST**（傍晚之外也可能同日 ⇒ 也会假绿 ✗）
// ⇒ ⛔ **绝不能写成"断言等于今天"** ✗（那是随环境变的判据 ✗）。这里一律用**固定时刻 ＋ 点名时区** ✓。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { dateStampInZone, localTimeZone, todayStamp } from "./update-changelog.mjs";

describe("CHANGELOG 段头日期：取本地日，⛔ 不用 UTC 日", () => {
  it("① 上海时间 2026-10-12 凌晨发的版 ⇒ 段头必须写 2026-10-12（⛔ 不是 10-11 ✗）", () => {
    // 2026-10-11T18:00:00Z ＝ 上海 2026-10-12 02:00 ✓（正落在 00:00–07:59 那个窗口里 ✓）
    const at = new Date("2026-10-11T18:00:00Z");
    expect(
      dateStampInZone(at, "Asia/Shanghai"),
      "CST 00:00–07:59 发版 ⇒ 段头被写成**前一天** ✗（这条就是那个坑）",
    ).toBe("2026-10-12");
  });

  it("② 点名的时区说了算：同一个时刻在 UTC 是 10-11、在上海是 10-12", () => {
    const at = new Date("2026-10-11T18:00:00Z");
    expect(dateStampInZone(at, "UTC"), "UTC 侧是 10-11 ✓").toBe("2026-10-11");
    expect(dateStampInZone(at, "Asia/Shanghai"), "上海侧是 10-12 ✓").toBe("2026-10-12");
  });

  it("③ 边界：CST 的 24:00 那一刻就翻页（16:00Z ⇒ 次日；15:59:59Z ⇒ 当日）", () => {
    expect(dateStampInZone(new Date("2026-10-11T16:00:00Z"), "Asia/Shanghai")).toBe("2026-10-12");
    expect(dateStampInZone(new Date("2026-10-11T15:59:59Z"), "Asia/Shanghai")).toBe("2026-10-11");
  });

  it("④ ⛔ 源码里不许再出现 UTC 那一行（改回去 ⇒ 这条当场红 ✗）", () => {
    const src = readFileSync("scripts/update-changelog.mjs", "utf8");
    // ⚠️ **只扫代码行** ✗：文件里有**注释**在讲"为什么不再用它"（引了那一行 ✓）——
    //    不剥注释这条判据就会**自绊** ✗（第一版实测逐字就是这么红的 ✓；同族坑见 `relayStatus.test.ts` ②）。
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, "") // 块注释（含 JSDoc）
      .split("\n")
      .filter((l) => !/^\s*\/\//.test(l)) // 整行 `//` 注释（⛔ 不碰行尾 `//`，免得切掉字符串里的 URL ✗）
      .join("\n");
    expect(
      codeOnly.includes("toISOString()"),
      "代码里又用 `toISOString()` 取日期了 ⇒ CST 00:00–07:59 发版会把段头写错一天 ✗",
    ).toBe(false);
  });

  it("⑤ `todayStamp()` 与「本机时区」自洽（⛔ 不写死任何具体日期 ⇒ 随环境也不假红 ✗）", () => {
    const now = new Date("2026-10-11T18:00:00Z");
    expect(todayStamp(now)).toBe(dateStampInZone(now, localTimeZone()));
    expect(todayStamp(now), "形状必须是 YYYY-MM-DD").toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
