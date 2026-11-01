// ⭐ 2026-11-01（owner 截图：「版本历史被遮挡」）：临时浮层必须压过右侧常驻目录。
//
// 真因：`.history-popover` 与 `.toc-panel` 都写 `z-index: 40`，而目录在 DOM 里**更靠后** ⇒
// 同层时后写的赢 ⇒ 版本历史右半边被「目录」盖住（文字被截成「每页最多保…」）。
// 判据钉的是一条**层叠纪律**，不是某个像素：
//   · 目录是常驻停靠面板 ⇒ 留在 `z-index: 40`；
//   · 临时锚定浮层（版本历史 / 备份菜单 / 块引用预览）⇒ 必须用 `--z-popover`（700，与搜索/回收站/同步同层）。
// 只读 CSS（`allCssText`：域已经拆到 src/styles 里也能判）。
import { describe, expect, it } from "vitest";

import { allCssText } from "../lib/cssSources";

const css = allCssText();

/** 取某个选择器的**第一条**规则体（选择器可能在注释里出现，要求行首 `{` 前只有空白）。 */
function ruleBody(sel: string): string {
  const re = new RegExp(`(?:^|\\n)\\s*${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([\\s\\S]*?)\\}`);
  const m = re.exec(css);
  expect(m, `找不到 ${sel} 的规则`).not.toBeNull();
  return m![1];
}

/**
 * 取「这个选择器出现的那条规则」的选择器清单 + 规则体。
 *
 * 为什么还要第二个取法（2026-11-01）：`.history-popover.is-sheet` **不是**一条独立规则 ——
 * 它与 `.trash-popover` / `.backup-dropdown` / `.new-menu-dropdown` 写在**同一个逗号组**里
 * （短视口那段媒体查询里）。`ruleBody()` 要求选择器在**行首**，逗号组里的第 2、3、4 个成员都取不到。
 */
function ruleSpanFor(sel: string): { selectors: string; body: string } {
  const re = new RegExp(`(?:^|[\\n,])\\s*${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*(?=[,{])`);
  const m = re.exec(css);
  expect(m, `找不到 ${sel} 所在的选择器组`).not.toBeNull();
  const open = css.indexOf("{", m!.index + m![0].length);
  expect(open, `${sel} 后面没有规则体`).toBeGreaterThan(-1);
  const prevEnd = css.lastIndexOf("}", m!.index);
  return {
    selectors: css.slice(prevEnd + 1, open).trim(),
    body: css.slice(open + 1, css.indexOf("}", open)),
  };
}

describe("浮层层叠：临时浮层压过右侧目录", () => {
  it("① 版本历史用 --z-popover，目录仍是 40 ⇒ 数值上浮层更高", () => {
    const pop = ruleBody(".history-popover");
    expect(pop, "版本历史又退回固定小 z-index 了 ⇒ 会被目录盖住").toMatch(
      /z-index:\s*var\(--z-popover\)/,
    );
    expect(pop, "不许再出现写死的 z-index: 40").not.toMatch(/z-index:\s*40\s*;/);

    const toc = ruleBody(".toc-panel");
    const tocZ = Number(/z-index:\s*(\d+)\s*;/.exec(toc)?.[1]);
    const token = Number(/--z-popover:\s*(\d+)\s*;/.exec(css)?.[1]);
    expect(Number.isFinite(token), "`:root` 里没有 --z-popover 数字").toBe(true);
    expect(Number.isFinite(tocZ), "`.toc-panel` 没有数字 z-index").toBe(true);
    expect(token, `--z-popover(${token}) 必须高于目录(${tocZ})`).toBeGreaterThan(tocZ);
  });

  it("② 备份菜单不再被后面那条重复的 z-index:40 覆盖", () => {
    const body = ruleBody(".backup-dropdown");
    expect(body, "备份菜单也应是临时浮层层级").toMatch(/z-index:\s*var\(--z-popover\)/);
    expect(body, "重复的 z-index:40 会把它拉回目录同层").not.toMatch(/z-index:\s*40\s*;/);
  });

  it("③ 块引用预览同理（它也是临时浮层）", () => {
    expect(ruleBody(".block-ref-preview")).toMatch(/z-index:\s*var\(--z-popover\)/);
  });

  // ⭐ 2026-11-01（F5）：短视口（≤768 宽 **或** ≤520 高，含横屏手机 792×360 与矮窗口）里
  // 版本历史走 `is-sheet` 底部弹层。它原来与回收站/备份菜单/新建菜单**同一组**写死 `1600`，
  // 而 `.confirm-overlay` 只有 `1400` —— 于是点「恢复 / 清空」弹出的确认框被**自家弹层盖住**
  // （现象是「点了没反应」，按 Esc 才看见）。层级契约逐字见 `.confirm-overlay` 上方那段：
  // 「1400 确认 / 输入对话框——由模态内部发起，必须盖住模态」。
  // ⚠️ 这条是**数值关系**判据（不依赖浏览器）；「谁真的在上面」由 `check-panel-layout` 的
  // `elementFromPoint` 夹具量。
  it("④ 短视口 sheet（含回收站/备份/新建菜单）必须低于确认框：1600 会盖住 1400", () => {
    const sheet = ruleSpanFor(".history-popover.is-sheet");
    expect(sheet.body, "sheet 又用回裸数字 1600 ⇒ 短视口下确认框会被它盖住（点了没反应）").not.toMatch(
      /z-index:\s*1600\s*;/,
    );
    expect(sheet.body, "sheet 应当回到 --z-popover 这一档（与搜索/回收站/同步同层）").toMatch(
      /z-index:\s*var\(--z-popover\)/,
    );
    // 一次修一组：这条规则里的三个兄弟选择器也得在（别只把历史那一行改掉）
    for (const sibling of [".trash-popover", ".backup-dropdown", ".new-menu-dropdown"]) {
      expect(sheet.selectors, `${sibling} 不在同一组里了 ⇒ 它会在短视口继续盖住确认框`).toContain(sibling);
    }

    const token = Number(/--z-popover:\s*(\d+)\s*;/.exec(css)?.[1]);
    const confirmZ = Number(/z-index:\s*(\d+)\s*;/.exec(ruleBody(".confirm-overlay"))?.[1]);
    expect(Number.isFinite(token), "`:root` 里没有 --z-popover 数字").toBe(true);
    expect(Number.isFinite(confirmZ), "`.confirm-overlay` 没有数字 z-index").toBe(true);
    expect(token, `确认框(${confirmZ}) 必须盖住底部弹层(${token})`).toBeLessThan(confirmZ);
  });
});
