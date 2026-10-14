// 阶段 0（R203）：**形态判定的纯函数** ＋ 两条"单一出处"判据。
//
// ⭐ 本文件**全程只喂数值** ✓ —— `isNarrowViewport(w)` / `isShortViewport(h)` /
//    `isMobileOverlayViewport(w, h)` 都能直接吃数字 ✓ ⇒ ⛔ **不需要 stub `matchMedia`** ✗
//    （喂桩 = 测我自己的桩 ✗，不是测真逻辑 ✓）。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  COARSE_POINTER_QUERY,
  MOBILE_BREAKPOINT_PX,
  SHORT_VIEWPORT_MAX_PX,
  isMobileOverlayViewport,
  isNarrowViewport,
  isShortViewport,
} from "./shape";

describe("形态判定：布局看宽度、浮层看宽度和高度", () => {
  it("⭐ 792×360（矮但不窄）⇒ 判「浮层形态」true ✓，但判「换掉编辑器」false ✓", () => {
    // ⭐ 这条就是 R192/R193 的口径：横屏手机要拿到**浮层形态** ✓，
    //    但⛔ **不许**因此把编辑器换成移动端阅读屏 ✗（792 宽放得下"侧栏 + 正文"两列 ✓）。
    expect(isMobileOverlayViewport(792, 360)).toBe(true);
    expect(isNarrowViewport(792)).toBe(false);
    expect(isShortViewport(360)).toBe(true);
  });

  it("窄的边界：320 / 390 是窄 ✓；768 仍是窄 ✓；769 不是 ✗", () => {
    expect(isNarrowViewport(320)).toBe(true);
    expect(isNarrowViewport(390)).toBe(true);
    expect(isNarrowViewport(MOBILE_BREAKPOINT_PX)).toBe(true);
    expect(isNarrowViewport(MOBILE_BREAKPOINT_PX + 1)).toBe(false);
  });

  it("矮的边界：520 是矮 ✓（含边界 ✓）；521 不是 ✗", () => {
    expect(isShortViewport(SHORT_VIEWPORT_MAX_PX)).toBe(true);
    expect(isShortViewport(SHORT_VIEWPORT_MAX_PX + 1)).toBe(false);
    // 矮视口**单独**就能进浮层形态 ✓（不窄也进 ✓）
    expect(isMobileOverlayViewport(1280, 520)).toBe(true);
    expect(isMobileOverlayViewport(1280, 521)).toBe(false);
  });

  it("能力查询是**能力**、不是尺寸：它自己那条串只描述 hover ✓（⛔ 不并进宽度口径 ✗）", () => {
    expect(COARSE_POINTER_QUERY).toBe("(hover: none)");
    // 一个 1280 宽的触屏平板：`(hover: none)` 为真 ✓，而按宽度算**不是**窄 ✓
    expect(isNarrowViewport(1280)).toBe(false);
  });
});

// ───────────────────────── 单一出处（**定义版**） ─────────────────────────
// ⭐ 为什么这条**不会假红**（逐字，Lead 要求写清 ✓）：
//   ① **CSS 侧本来就该有同一个数** ✓ —— `src/App.css` 里的 `@media (max-width: 768px)`
//      与 `(max-height: 520px)` 是**同源的另一半** ✓（门禁另有一条"CSS 侧命中的确实是 768" ✓）
//      ⇒ 但它们**不是"定义"** ✗（没有 `export const` ✓）⇒ 本判据**不数它们** ✓；
//   ② **注释里也会提到这个数** ✓（好几处解释为什么是 768）⇒ 同样不算定义 ✓；
//   ③ 所以本判据只认 **`export const <名字>`** 这一种形状 ✓ ⇒ 它钉的是**真实风险**：
//      **有人再写第二份定义** ✗（那才会让两个真相源打架 ✓）。
const SRC_ROOTS = [resolve(__dirname, ".."), resolve(__dirname, "../../../scripts")];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(p);
  }
  return out;
}

describe("单一出处：三个常量各只许有**一份定义**", () => {
  const files = SRC_ROOTS.flatMap((r) => walk(r));
  const SHAPE = resolve(__dirname, "shape.ts");

  for (const name of ["MOBILE_BREAKPOINT_PX", "SHORT_VIEWPORT_MAX_PX", "COARSE_POINTER_QUERY"]) {
    it(`⭐ \`export const ${name}\` 全仓只出现一次，且在 shape.ts ✓`, () => {
      // ⚠️ 必须**行首锚定**（`^\s*export const`）✗ —— 否则门禁里"读常量的那条正则"
      // （它的源码里就写着 `export const MOBILE_BREAKPOINT_PX\s*=\s*(\d+)` ✓）会被**误判成第二份定义** ✓
      // —— 实测第一版就是这么假红的（4 处 / 2 处 ✓），加锚点后回到 1 处 ✓。
      const re = new RegExp(`^\\s*export const ${name}\\b`, "m");
      const hits = files.filter((f) => re.test(readFileSync(f, "utf8")));
      expect(hits, `${name} 的定义处：${hits.join(", ")}`).toEqual([SHAPE]);
    });
  }
});
