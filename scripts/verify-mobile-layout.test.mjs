// `mobile-layout` 门禁里「桌面卡片浮标」那条的**计数口径**判据（⭐ owner 2026-10-13 拍的**甲**）。
//
// ## 钉的是什么
// ⭐ **计数与平台无关** ✗：那条判据在**两种 `(hover: none)` 取值下都必须计入总条数** ✓。
// 改前它写成 `if (!hoverNone) { ok(…) } else { console.log("跳过") }` ✗ ⇒ CI 的 headless
// 报 `(hover: none)` ⇒ 门禁数出来 **68**，而下界（`tests/baseline.json:9`）是 **69** ⇒ 挂了半个月的红 ✓。
//
// ## 为什么判据长这样（⛔ 不写成"等于今天"那种随环境变的形状 ✗）
// 期望值**不写死**：由函数按 `hoverNone` 取 ✓（能 hover ⇒ 22px 悬停显形；`(hover: none)` ⇒ 44×44 常驻 ✓，
// CSS 出处写在 `scripts/lib/desktopCardBadge.mjs` 的头注里 ✓）—— 判据注入**两种取值**，两边都要产出
// **同样条数**且各自都通过 ✓。⛔ 这样它换机器／换 CI 都不会变读数 ✓。
//
// ⚠️ 本判据**只钉"计数口径 ＋ 两种形状的期望"** ✗，⛔ 不冒充门禁本体：真 Chromium 那一段
// 只能由 `node scripts/verify-mobile-layout.mjs` 跑（见回话里"没跑成／卡在哪"的如实说明 ✓）。
import { describe, expect, it } from "vitest";

import { desktopCardBadgeChecks } from "./lib/desktopCardBadge.mjs";

describe("mobile-layout：桌面卡片浮标那条的计数口径（与平台无关）", () => {
  it("⭐ 两种 hover 取值下都恰好产出 1 条（⛔ 不许跳过 —— 跳过会让通过数随平台变）", () => {
    const mouse = desktopCardBadgeChecks({ hoverNone: false, boxPos: "absolute", delOpacity: "0", delW: 22 });
    const touch = desktopCardBadgeChecks({ hoverNone: true, boxPos: "absolute", delOpacity: "1", delW: 44 });

    expect(mouse.length, "能 hover 的环境要计入 1 条").toBe(1);
    expect(touch.length, "（hover: none）的环境也要计入 1 条 —— 这就是甲要的").toBe(1);
    expect(mouse.length, "两边的**条数必须相同**（CI 那条红要的就是这个）").toBe(touch.length);

    expect(mouse[0].ok, "能 hover：悬停才出现的 22px 浮标").toBe(true);
    expect(touch[0].ok, "无 hover：`App.css:22665-22687` 那条让它是 44×44 常驻").toBe(true);
    expect(touch[0].msg, "消息里要如实带出本机的 hover 取值（诊断用）").toContain("hover: none");
  });

  it("反向：任一环境写成**另一种环境**的形状 ⇒ 各自都要红（它不是「永远绿」的摆设）", () => {
    expect(
      desktopCardBadgeChecks({ hoverNone: true, boxPos: "absolute", delOpacity: "0", delW: 22 })[0].ok,
      "无 hover 却按悬停态（22px、opacity 0）⇒ 红：触屏上它等于删不掉",
    ).toBe(false);
    expect(
      desktopCardBadgeChecks({ hoverNone: false, boxPos: "absolute", delOpacity: "1", delW: 44 })[0].ok,
      "能 hover 却变成触屏那档（44px 常驻）⇒ 红：桌面那条悬停规则被改了",
    ).toBe(false);
    expect(
      desktopCardBadgeChecks({ hoverNone: false, boxPos: "static", delOpacity: "0", delW: 22 })[0].ok,
      "不是 absolute ⇒ 红",
    ).toBe(false);
  });
});
