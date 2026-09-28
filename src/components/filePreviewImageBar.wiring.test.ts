// GitCode issue #12：**窄屏时内置图片阅览的控制按钮重叠了**
// （Windows 11 / v1.91.26：「打开一张图片，缩小应用窗口」⇒ 控制按钮混乱重叠）。
//
// 根因是**形状**，不是数值：提示胶囊与（旋转 / 查看原图）按钮组各自 `position:absolute`、
// 都钉在 `top:14px`，左边那个还按 `left:50%` ＋ `translateX(-50%)` 居中
// ⇒ 360px 视口下两者必然相交（按当时的规则实算 ~106px）。所以修法不是"把数值调到刚好不撞"
// （换一台机器换个字号又会撞），而是**把它们放进同一条 flex 行**：左边那半放不下就在自己的
// 盒子里截断，右边那组 `flex:none` —— 谁也盖不住谁。
//
// 为什么这里用**文本级**判据：真正的几何证明在 `scripts/verify-mobile-overlays.mjs` 的 (6c)
// （真 Chromium ＋ 三个视口 ＋ `elementFromPoint` 实点）。但那一条挂在 `browser`/`mobile` 组，
// **不在** `pnpm verify` 的默认路径上 —— 本仓 2026-09-22 吃过这个亏（只挂在非默认路径上的门禁
// 在本地一键验收与 CI 的 checks job 里是隐形的）。所以这里钉"形状不许回退"：
// 谁把两组改回两个绝对定位的角标，或忘了 `pointer-events` 的那一对，这几条立刻红。
//
// ⚠️ 边界：这些断言**不**验渲染结果（几何由上面那条真浏览器判据管），它们只回答
// "那段 CSS/JSX 的形状还在不在"。所以注释里的反例也要当心 —— 断言一律对着**代码**匹配，
// 不对着注释（下面用"取出规则体"而不是"全文搜索"正是为此）。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(p, "utf8");

/** 取出 `sel` 的**所有**规则体（同一选择器可能既在基础段、又在 `@media` 里）。 */
function cssBodies(css: string, sel: string): string[] {
  const pat = new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "g");
  return [...css.matchAll(pat)].map((m) => m[1]);
}

/** 取某个 `@media ...` 段的**所有**块体（按花括号配对，够用：这里没有嵌套 `@media`）。 */
function mediaBlocks(css: string, header: string): string[] {
  const out: string[] = [];
  for (let i = css.indexOf(header); i !== -1; i = css.indexOf(header, i + 1)) {
    const open = css.indexOf("{", i);
    if (open === -1) continue;
    let depth = 0;
    for (let j = open; j < css.length; j++) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") {
        depth--;
        if (depth === 0) {
          out.push(css.slice(open + 1, j));
          break;
        }
      }
    }
  }
  return out;
}

/** 从 `from` 处的 `<div` 起按 `<div` / `</div>` 配对切出那个元素（够用：这段里没有自闭合 div）。 */
function divBlock(src: string, from: number): string {
  const re = /<div\b|<\/div>/g;
  re.lastIndex = from;
  let depth = 0;
  for (let m; (m = re.exec(src)); ) {
    if (m[0] === "</div>") {
      depth--;
      if (depth === 0) return src.slice(from, m.index + m[0].length);
    } else depth++;
  }
  throw new Error("`</div>` 没配对上");
}

describe("图片预览顶栏（issue #12）· 形状不许回退", () => {
  const tsx = read("src/components/FilePreviewDialog.tsx");
  const css = read("src/App.css");

  it("① 提示与按钮组是**同一个** `.fm-img-bar` 的子节点（不是两个各自定位的角标）", () => {
    const at = tsx.indexOf('className="fm-img-bar"');
    expect(at, "找不到 `.fm-img-bar` —— 两组又变回各自绝对定位了？").toBeGreaterThan(-1);
    // 配对切出那一个元素，再要求两组都在它**里面**（只查"全文有这个类名"是不够的：
    // 那正是"把 `</div>` 提前关掉、两组其实各在各的容器里"这种回退能混过去的地方）。
    const block = divBlock(tsx, tsx.lastIndexOf("<div", at));
    expect(block, "`.fm-img-bar` 里没有提示胶囊").toContain('className="fm-img-hint"');
    expect(block, "`.fm-img-bar` 里没有按钮组").toContain('className="fm-img-actions"');
  });

  it("② 两者都不再是绝对定位（重叠的成因就是它俩都钉在 `top:14px`）", () => {
    for (const sel of [".fm-img-hint", ".fm-img-actions"]) {
      const bodies = cssBodies(css, sel);
      expect(bodies.length, `\`${sel}\` 一条规则都没取到`).toBeGreaterThan(0);
      for (const b of bodies) {
        expect(b, `\`${sel}\` 又变成绝对定位了（issue #12 的重叠形状）`).not.toMatch(/position:\s*absolute/);
      }
    }
    // 提示那条原来是 `left:50%` ＋ `translateX(-50%)` 居中：现在它是 flex 行里的左半。
    for (const b of cssBodies(css, ".fm-img-hint")) {
      expect(b, "`.fm-img-hint` 又用 `left:50%` 居中（行内元素不该有它）").not.toMatch(/left:\s*50%/);
    }
  });

  it("③ 那一行是 flex、且左边那半**放不下能截断**（`min-width:0`），右边那组不缩", () => {
    const bar = cssBodies(css, ".fm-img-bar").join("\n");
    expect(bar, "`.fm-img-bar` 不是 flex 行").toMatch(/display:\s*flex/);
    const hint = cssBodies(css, ".fm-img-hint").join("\n");
    expect(hint, "`.fm-img-hint` 少了 `min-width:0` ⇒ flex 子项不肯收缩，照样把按钮挤出去").toMatch(/min-width:\s*0/);
    expect(hint, "`.fm-img-hint` 少了省略号 —— 截断才不会压到右边的按钮").toMatch(/text-overflow:\s*ellipsis/);
    expect(cssBodies(css, ".fm-img-actions").join("\n"), "右边那组必须 `flex:none`（缩的是左边）").toMatch(/flex:\s*none/);
  });

  it("④ `pointer-events` 那一对必须成对：bar 放行、按钮组收回（少一半就是按钮点不到）", () => {
    // bar 不吃指针事件 ⇒ 空白处的滚轮缩放 / 拖动平移照旧落在图片上；
    // 但按钮组必须把 `auto` 收回来，否则**整组按钮点不动**（`pointer-events:none` 会继承）。
    expect(cssBodies(css, ".fm-img-bar").join("\n"), "`.fm-img-bar` 少了 `pointer-events:none`").toMatch(/pointer-events:\s*none/);
    expect(cssBodies(css, ".fm-img-actions").join("\n"), "`.fm-img-actions` 没把指针事件收回来 ⇒ 按钮点不动").toMatch(/pointer-events:\s*auto/);
  });

  it("⑤ 那条**桌面手势**提示只在触屏那一档藏起来（窄**或**矮），按钮组照旧", () => {
    // 断点是"窄**或**矮"（App.css 自己的口径：792×360 的横屏手机也走这一档）——
    // 若只按宽度写，横屏手机上那条提示会留在屏上，而它同样是触屏、同样没有滚轮。
    const touch = mediaBlocks(css, "@media (max-width: 768px), (max-height: 520px)");
    expect(touch.length, "找不到触屏那一档媒体查询（断点被人改了？）").toBeGreaterThan(0);
    expect(
      touch.some((b) => /\.fm-img-hint\s*\{[^}]*display:\s*none/.test(b)),
      "触屏那一档没把「滚轮缩放 · 拖动平移」那条提示藏起来 —— 它会被截成半句，而触屏上没有滚轮",
    ).toBe(true);
    // 反过来也要钉：**基础规则**（不在任何媒体查询里那条，也是文件里第一条）不许藏它。
    // 少了这一条，"干脆全局 `display:none`" 会一路绿 —— 而桌面那条提示是有用的。
    const bodies = cssBodies(css, ".fm-img-hint");
    expect(bodies.length, "`.fm-img-hint` 一条规则都没取到").toBeGreaterThan(0);
    expect(bodies[0], "基础规则就 `display:none` ⇒ 桌面也看不到提示了").not.toMatch(/display:\s*none/);
    // 触屏那一档的 44×44 命中区必须还在（藏提示 ≠ 把按钮也收拾了）。
    expect(touch.some((b) => /\.fm-img-btn/.test(b) && /44px/.test(b)), "触屏那一档的命中区那条没了").toBe(true);
    // 只剩按钮组一个子项时，`space-between` 会把它推到左边 ⇒ 靠 `margin-left:auto` 钉在右边。
    expect(cssBodies(css, ".fm-img-actions").join("\n"), "少了 `margin-left:auto`（触屏上按钮会跑到左边）").toMatch(/margin-left:\s*auto/);
  });
});
