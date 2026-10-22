// 判据：浮「＋」必须**进「快速记录」屏**，⛔ 不许再"建空页"（那会落到只读阅读屏 = 死路）。
//
// 来由（owner 2026-10-22）：「底部浮动按钮设计目的是什么？跟快速记录有何区别？」
//   实测差异：主卡 → capture 屏（能写字）；浮「＋」→ createPage 空页 → MobileRead（只读，没输入框）
//   ⇒ 点「＋」等于给你一张纸却不给笔 ✗
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(resolve(__dirname, "MobileTabBar.tsx"), "utf8");
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const fab = code.slice(code.indexOf("export function MobileComposeFab"));

describe("移动端浮「＋」：必须通向「能写字的地方」", () => {
  it("① 点它 = setScreen(\"capture\")", () => {
    expect(fab, "浮＋ 应当进「快速记录」屏").toMatch(/setScreen\(\s*"capture"\s*\)/);
  });

  it("② ⛔ 不许自己建空页（createPage）", () => {
    // 建空页 ⇒ currentId 有值 ⇒ App 落到 MobileRead（只读）⇒ 死路
    expect(fab, "浮＋ 里不许出现 createPage（否则又造空壳页）").not.toMatch(/createPage\s*\(/);
  });

  it("③ 与首页主卡同一个动作（两处都进 capture，形态不同、目的地相同）", () => {
    const home = readFileSync(resolve(__dirname, "MobileHome.tsx"), "utf8");
    expect(home, "首页主卡应当进 capture").toMatch(/setScreen\(\s*"capture"\s*\)/);
  });
});
