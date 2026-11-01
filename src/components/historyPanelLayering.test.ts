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
});
