// Android 图标"背景/内容"分层的判据 —— 直接读那份**源矢量**，不读栅格产物
// （owner 2026-09-21：「安卓的应用图标中间的书本太大了，小一点」）。
//
// 为什么要有这条：图标是**手工跑一条命令**出来的产物，改大小这件事以前没有任何东西守着 ——
// 书顶满画布（内容占 53.9%）时没人红，只有人肉看图才发现。现在"书多大"等于
// `android-foreground.svg` / `android-legacy.svg` 里那层 `scale(...)`，判据钉住它。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (rel) => readFileSync(resolve(process.cwd(), rel), "utf8");

const FG = "design/logo/android-foreground.svg";
const BG = "design/logo/android-background.svg";
const LEGACY = "design/logo/android-legacy.svg";
const ADAPTIVE_XML = "src-tauri/icons/android/mipmap-anydpi-v26/ic_launcher.xml";
const MANIFEST = "design/logo/android-icon.json";

/** 画布 1024×1024；两页笔记的原始包围盒（与 `shuyonote-mark.svg` 同一套坐标）。 */
const CANVAS = 1024;
const CENTER = CANVAS / 2;
const PAGES = { x0: 248, x1: 776, y0: 318, y1: 706 };

function scaleOf(svg) {
  // ⚠️ 必须锚在**元素属性**上：文件头注释里也写着一句 `scale(.76)`（解释用的），
  // 早先那条 `scale\(...\)` 会先命中注释 ⇒ 改了真正的 transform 判据照样绿（假判据，实测踩到）。
  const m = /<g[^>]*\btransform="[^"]*\bscale\(\s*([0-9.]+)\s*\)/.exec(svg);
  expect(m, "SVG 里要有一层 <g transform=\"… scale(k) …\"> 作为「内容多大」的旋钮").not.toBeNull();
  return Number(m[1]);
}

describe("Android 图标：背景满幅、书待在安全区", () => {
  it("书的大小在 0.6–0.8 之间（原先是 1.0：顶满画布，可见区内约 77%）", () => {
    const k = scaleOf(read(FG));
    expect(k).toBeGreaterThanOrEqual(0.6);
    expect(k).toBeLessThanOrEqual(0.8);
    // 旧式图标（Android 7 的 ic_launcher.png）必须与自适应前景**同一个大小**，否则两种机型观感不一致
    expect(scaleOf(read(LEGACY))).toBe(k);
  });

  it("缩放后两页仍落在 66% 安全区内（并留出四周留白）", () => {
    const k = scaleOf(read(FG));
    const half = (CANVAS * 0.66) / 2; // 安全的半宽/半高（66dp/108dp 那一圈）
    const halfW = ((PAGES.x1 - PAGES.x0) / 2) * k;
    const halfH = ((PAGES.y1 - PAGES.y0) / 2) * k;
    expect(halfW).toBeLessThan(half);
    expect(halfH).toBeLessThan(half);
    // 而且要有**可观**的留白：书最多占画布 42%（原来 51.6%）
    expect((halfW * 2) / CANVAS).toBeLessThanOrEqual(0.43);
  });

  it("背景层只有底，内容层只有书（别把蓝底又画回前景里）", () => {
    const bg = read(BG);
    const fg = read(FG);
    // 背景：有渐变底、没有白色的书
    expect(bg).toContain("linearGradient");
    expect(bg).not.toContain("#FFFFFF");
    // 前景：有书、没有任何渐变底
    expect(fg).toContain("#FFFFFF");
    expect(fg).not.toContain("linearGradient");
  });

  it("自适应图标 XML 同时引用**背景图**与**前景图**（不是只引用前景/或退回白色）", () => {
    const xml = read(ADAPTIVE_XML);
    expect(xml).toContain('android:drawable="@mipmap/ic_launcher_foreground"');
    expect(xml).toContain('android:drawable="@mipmap/ic_launcher_background"');
    expect(xml).not.toContain("@color/ic_launcher_background"); // 旧的 #fff 颜色兜底已废弃
  });

  it("manifest 三层齐全（default / android_bg / android_fg）", () => {
    const m = JSON.parse(read(MANIFEST));
    expect(Object.keys(m).sort()).toEqual(["android_bg", "android_fg", "bg_color", "default"]);
    for (const rel of [m.default, m.android_bg, m.android_fg]) {
      expect(() => read(resolve("design/logo", rel)), `${rel} 要在 design/logo/ 下存在`).not.toThrow();
    }
  });
});
