// 判据：**打字屏（快速记录）不挂底栏**，而且它自己必须留一条回家的路。
//
// 来由（owner 2026-10-22 手机实拍）：「web 移动端编辑时，底部标签不该显示吧？」
//   实况：键盘弹起时「笔记/搜索/我的」三条横在快捷工具栏与键盘之间 ——
//   ① 把工具栏顶上去、挤掉输入区；② "正在写"时那三个导航项本来也用不上；
//   ③ 效果图 `02-capture.svg` 里本来就没有底栏（只有左上「‹」＋居中标题＋「存」）。
//   ⚠️ 但底栏也是这一屏当时**唯一**的回家路 ⇒ 拿掉它必须同时补一条显式的（否则就是死路，
//   与 2026-10-10 那次"除 pm clear 无路可回"同族）。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const APP = strip(readFileSync(resolve(__dirname, "..", "App.tsx"), "utf8"));
const CAP = strip(readFileSync(resolve(__dirname, "MobileCapture.tsx"), "utf8"));

describe("移动端「快速记录」屏：不挂底栏 ＋ 自带回家路", () => {
  it("① wrapMobile 认 showTabs（默认开 ⇒ 其它屏行为不变）", () => {
    expect(APP, "wrapMobile 应当支持 showTabs").toMatch(/showTabs\?: boolean/);
    expect(APP, "默认必须渲染底栏（只在显式 false 时隐藏）").toMatch(/showTabs === false \? null : <MobileTabBar \/>/);
  });

  it("② capture 屏传 showTabs:false（别的屏照旧）", () => {
    expect(APP, "capture 屏应当关掉底栏").toMatch(/showTabs:\s*mobileScreen !== "capture"/);
  });

  it("③ 那一屏必须自己有一条回家的路（左上「‹ 返回」→ 首页）", () => {
    expect(CAP, "缺 mcap-back 这颗返回键").toMatch(/className="mcap-back"/);
    expect(CAP, "返回键必须真的回首页").toMatch(/setScreen\("home"\)/);
    expect(CAP, "返回键要有可访问名（图标按钮不能只有 ‹）").toMatch(/aria-label="返回首页"/);
  });

  // ⭐ 2026-10-23 第二刀（owner 手机实拍「红圈那截不合适」）：底栏摘掉后**让位必须一起摘**。
  //   实测症状：`.m-tabshell` 仍留 `padding-bottom: 64px` ⇒ 键盘弹起时那 64px 变成一截死白；
  //   而 `.mcap-bar` 没写 `flex: none` ⇒ 被压缩到比内容矮 ⇒「段落/标题/列表」下半截被切。
  it("④ 没有底栏就不许再让位（让位与底栏同生共死）", () => {
    expect(APP, "未打 --no-tabs 修饰类").toMatch(/m-tabshell m-tabshell--no-tabs/);
    const css = readFileSync(resolve(__dirname, "..", "App.css"), "utf8");
    expect(css, "缺 --no-tabs 的 padding 归零").toMatch(/\.m-tabshell--no-tabs\s*\{\s*padding-bottom:\s*0;/);
    expect(css, "快捷工具栏不许被压缩（flex: none）").toMatch(/\.mcap-bar\s*\{[^}]*flex:\s*none;/);
  });
});
