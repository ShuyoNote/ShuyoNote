// 移动端布局验收 · 用真实 Chromium 在窄屏/宽屏两种视口下断言侧栏行为。
//
// 为什么需要它：移动端的侧栏行为全都藏在「CSS 层叠 + matchMedia + z-index +
// localStorage」的交叉处，单测覆盖不到，而且失败起来全是静默的——
//   · 侧栏收不起来（.sidebar{display:flex} 压掉 [hidden]{display:none}）
//   · 触屏没有 hover，收起后找不到展开入口
//   · 移动端自动收起把 sidebarOpen 写进 localStorage，污染桌面端偏好
// 这三类问题都真实发生过，且都不是报错，只是行为不对。
//
// 前置：本机有 Chrome/Chromium（或 PUPPETEER_EXECUTABLE_PATH 指定），
//       以及已启动的 web 开发服务（默认 http://localhost:5173/）。
//
// 用法：
//   pnpm dev:web                       # 另开一个终端
//   pnpm test:mobile-layout            # 有失败即非零退出
//   APP_URL=http://192.168.31.89:5173/ pnpm test:mobile-layout
//   node scripts/verify-mobile-layout.mjs --shots /tmp/shots   # 顺便存图
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { findChrome, launchChrome } from "./lib/launch-chrome.mjs";
import { homedir } from "node:os";
import { join } from "node:path";

const APP_URL = (process.env.APP_URL || "http://localhost:5173/").replace(/\/+$/, "") + "/";
const PHONE = { width: 390, height: 844 };   // iPhone 14/15 逻辑分辨率
const DESKTOP = { width: 1280, height: 800 };

const shotsArg = process.argv.indexOf("--shots");
const SHOTS = shotsArg > -1 ? process.argv[shotsArg + 1] : null;

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.error(`  ✗ ${msg}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 找一个可用的 Chrome。puppeteer-core 不带浏览器，所以这里自己找；
// 找不到就明确报错，而不是静默跳过（否则这个验收脚本会假装通过）。

// 在页面里读「竖条 / 侧栏 / 遮罩 / 按钮」的真实几何与计算样式。
const probe = () => {
  const sidebar = document.querySelector(".sidebar");
  const railEl = document.querySelector(".activity-bar");
  const toggle = document.querySelector(".sidebar-toggle-btn");
  const railToggle = document.querySelector(".mobile-rail-toggle");
  const backdrop = document.querySelector(".mobile-sidebar-backdrop");
  const railBackdrop = document.querySelector(".mobile-rail-backdrop");
  const main = document.querySelector(".main");
  const disp = (el) => (el ? getComputedStyle(el).display : null);
  // 窄屏竖条是浮层：收起时被 translateX(-100%) 推到屏外，display 仍是 flex。
  // 所以判"可见"必须看几何（右边缘是否落在视口内），不能看 display。
  const railRect = railEl?.getBoundingClientRect();
  return {
    mobileMQ: matchMedia("(max-width: 768px)").matches,
    sidebarDisplay: disp(sidebar),
    sidebarHidden: sidebar ? sidebar.hasAttribute("hidden") : null,
    railVisible: !!railRect && railRect.right > 1,
    railRight: railRect ? Math.round(railRect.right) : null,
    mainWidth: main ? Math.round(main.getBoundingClientRect().width) : null,
    toggleDisplay: disp(toggle),
    toggleAria: toggle?.getAttribute("aria-expanded") ?? null,
    railToggleDisplay: disp(railToggle),
    backdrop: !!backdrop,
    railBackdrop: !!railBackdrop,
    stored: localStorage.getItem("shuyonote:sidebarOpen"),
  };
};

// 抽屉打开时，右侧悬浮工具栏（.right-rail）应该是被遮罩挡住、点不到的。
const railBlockedByBackdrop = () => {
  const rail = document.querySelector(".right-rail");
  if (!rail) return null;
  const r = rail.getBoundingClientRect();
  const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return at?.classList?.contains("mobile-sidebar-backdrop") ?? false;
};

async function main() {
  const executablePath = findChrome();
  if (!executablePath) {
    console.error("找不到 Chrome/Chromium。请安装 Google Chrome，或用 PUPPETEER_EXECUTABLE_PATH 指定路径。");
    process.exit(1);
  }
  console.log(`浏览器: ${executablePath}`);

  let reachable = false;
  try {
    const r = await fetch(APP_URL, { signal: AbortSignal.timeout(5000) });
    reachable = r.ok;
  } catch {
    /* 下面统一报错 */
  }
  if (!reachable) {
    console.error(`应用地址不可达：${APP_URL}\n请先启动：pnpm dev:web（或设置 APP_URL 指向已运行的服务）。`);
    process.exit(1);
  }
  console.log(`应用地址: ${APP_URL}\n`);

  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await launchChrome({ executablePath: chrome });
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  const shot = async (page, name) => {
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  };

  try {
    // ---------- 手机视口：用独立 context，保证 localStorage 从零开始 ----------
    const phoneCtx = await browser.createBrowserContext();
    const phone = await phoneCtx.newPage();
    const pageErrors = [];
    phone.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 200)));
    await phone.setViewport({ ...PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await phone.goto(APP_URL, { waitUntil: "networkidle2", timeout: 60000 });
    await sleep(3000);

    console.log(`【手机 ${PHONE.width}x${PHONE.height} · 初始】`);
    let s = await phone.evaluate(probe);
    ok(s.mobileMQ, "命中窄屏媒体查询");
    ok(s.sidebarDisplay === "none", `侧栏默认收起（display=${s.sidebarDisplay}）——hidden 未被 .sidebar 的 display:flex 压掉`);
    ok(s.sidebarHidden === true, "侧栏带 hidden 属性");
    ok(s.railVisible === false, `左侧竖条默认收起（浮层，右边缘=${s.railRight} 在屏外）`);
    ok(s.mainWidth === PHONE.width, `主区拿到全宽 ${PHONE.width}px（实际 ${s.mainWidth}）——竖条不再常驻吃掉 12% 宽度`);
    ok(s.railToggleDisplay !== "none", `显示浮层唤出按钮（display=${s.railToggleDisplay}）`);
    ok(!s.backdrop && !s.railBackdrop, "初始无任何遮罩");
    ok(s.stored === null, `移动端自动收起不写 localStorage（实际 ${JSON.stringify(s.stored)}）——否则会污染桌面端偏好`);
    await shot(phone, "01-phone-closed");

    console.log(`\n【手机 · 点唤出按钮 → 竖条滑入】`);
    await phone.click(".mobile-rail-toggle");
    await sleep(800);
    s = await phone.evaluate(probe);
    ok(s.railVisible === true, `竖条滑入（右边缘=${s.railRight}）`);
    ok(s.railBackdrop, "出现浮层遮罩");
    ok(s.mainWidth === PHONE.width, `主区宽度不受影响（仍 ${s.mainWidth}px）——浮层不挤内容`);
    ok(s.toggleDisplay !== "none", "竖条里的侧栏开合按钮可见");
    await shot(phone, "02-phone-rail-open");

    console.log(`\n【手机 · 点竖条里的侧栏开合按钮】`);
    await phone.click(".sidebar-toggle-btn");
    await sleep(900);
    s = await phone.evaluate(probe);
    ok(s.sidebarDisplay === "flex", `侧栏抽屉打开（display=${s.sidebarDisplay}）`);
    ok(s.sidebarHidden === false, "hidden 属性已摘除");
    ok(s.railVisible === false, "竖条自动收起（选完就把整屏交还内容）");
    ok(s.toggleAria === "true", `开合按钮 aria-expanded=true（实际 ${s.toggleAria}）`);
    ok((await phone.evaluate(railBlockedByBackdrop)) === true, "遮罩挡住右侧悬浮工具栏（抽屉打开时不该点得到）");
    await shot(phone, "03-phone-sidebar-open");

    console.log(`\n【手机 · 点遮罩收起侧栏】`);
    // 遮罩是 inset:0 的整屏元素，但侧栏（更宽、z-index 更高）盖住了它左侧一大块，
    // 元素中心点落在侧栏上——必须点右侧真正露出来的区域。
    await phone.mouse.click(PHONE.width - 20, 500);
    await sleep(900);
    s = await phone.evaluate(probe);
    ok(s.sidebarDisplay === "none", "抽屉关闭");
    ok(!s.backdrop, "侧栏遮罩消失");
    ok(s.toggleAria === "false", "开合按钮状态复位");
    await shot(phone, "04-phone-backdrop-closed");

    console.log(`\n【手机 · 再开竖条，点遮罩收起】`);
    await phone.click(".mobile-rail-toggle");
    await sleep(800);
    s = await phone.evaluate(probe);
    ok(s.railVisible === true, "竖条再次滑入");
    await phone.mouse.click(PHONE.width - 20, 500);
    await sleep(800);
    s = await phone.evaluate(probe);
    ok(s.railVisible === false, "点遮罩后竖条收起");
    ok(!s.railBackdrop, "浮层遮罩消失");
    console.log(`\n【手机 · 竖条里点非活动按钮（设置）】`);
    await phone.click(".mobile-rail-toggle");
    await sleep(700);
    const endBtns = await phone.$$(".activity-group-end .activity-btn");
    // .activity-group-end 顺序：回收站 / 模板中心 / 设置 / 关于
    await endBtns[2]?.click();
    await sleep(900);
    s = await phone.evaluate(probe);
    ok(s.railVisible === false, "点竖条里的非活动按钮也会收起浮层（不只是活动图标）");
    await phone.keyboard.press("Escape");
    await sleep(600);

    ok(pageErrors.length === 0, `页面无 JS 报错${pageErrors.length ? "：" + pageErrors.join(" | ") : ""}`);

    // ---------- 手机 · 右侧面板叠加：主区不该被"让位"内边距挤压 ----------
    // 桌面端 TOC/AI 是固定宽侧板，主区靠 padding-right 让位；窄屏它们是全屏叠加，
    // 再让位就会把主区内容盒挤成 0 宽，并把 .main 撑出 .app-body
    // （flex 项缩不到 padding 以下，宽度被顶成 380px > 视口 342px）。
    const RIGHT_PANELS = [
      { index: 0, name: "AI 助手" },
      { index: 1, name: "评论 / 通知" },
      { index: 2, name: "目录" },
    ];
    const mainGeometry = () => {
      const main = document.querySelector(".main");
      if (!main) return null;
      const r = main.getBoundingClientRect();
      return {
        right: Math.round(r.right),
        paddingRight: getComputedStyle(main).paddingRight,
        docWidth: document.documentElement.scrollWidth,
        winWidth: innerWidth,
      };
    };
    for (const p of RIGHT_PANELS) {
      // 每次重新加载，避免上一个面板的开关状态串进来
      await phone.goto(APP_URL, { waitUntil: "networkidle2", timeout: 60000 });
      await sleep(2000);
      const btns = await phone.$$(".right-rail button");
      if (!btns[p.index]) {
        ok(false, `${p.name}：右侧悬浮栏没有第 ${p.index} 个按钮`);
        continue;
      }
      await btns[p.index].click();
      await sleep(1400);
      const g = await phone.evaluate(mainGeometry);
      console.log(`\n【手机 · 打开「${p.name}」】`);
      ok(g.paddingRight === "0px", `主区不让位（padding-right=${g.paddingRight}）`);
      ok(g.right <= g.winWidth, `主区不超出视口（right=${g.right} ≤ ${g.winWidth}）`);
      ok(g.docWidth <= g.winWidth, `无横向溢出（文档宽=${g.docWidth}）`);
      await shot(phone, `05-phone-panel-${p.index}`);
    }
    await phoneCtx.close();

    // ---------- 桌面视口：独立 context，默认偏好（侧栏展开）----------
    const deskCtx = await browser.createBrowserContext();
    const desktop = await deskCtx.newPage();
    await desktop.setViewport(DESKTOP);
    await desktop.goto(APP_URL, { waitUntil: "networkidle2", timeout: 60000 });
    await sleep(2500);

    console.log(`\n【桌面 ${DESKTOP.width}x${DESKTOP.height}】`);
    s = await desktop.evaluate(probe);
    ok(!s.mobileMQ, "不命中窄屏媒体查询");
    ok(s.sidebarDisplay === "flex", `侧栏常驻可见（display=${s.sidebarDisplay}）`);
    ok(s.railVisible === true, `桌面竖条常驻在布局流内（右边缘=${s.railRight}）`);
    ok(s.railToggleDisplay === null, "桌面根本不渲染浮层唤出按钮（元素不存在，不只是 display:none）");
    // 这条断言 2026-09 反转了：开合按钮此前桌面 display:none（理由"点活动图标也能开合"），
    // 但那是**隐式约定**（提示只有 hover 才出现），而且拖分隔条收起侧栏后同样没有可见入口——
    // "收起来就找不回"是真实可达的状态。现在按钮桌面常驻，所以这里断言它**可见**，
    // 并且顺手把承诺验掉：点它真的能收起，再点真的能展开。
    ok(s.toggleDisplay !== "none", `桌面也常驻开合按钮（display=${s.toggleDisplay}）——侧栏收起后靠它找回来`);
    ok(!s.backdrop, "桌面无移动端遮罩");

    console.log(`\n【桌面 · 点开合按钮收起 → 再点展开】`);
    await desktop.click(".sidebar-toggle-btn");
    await sleep(700);
    s = await desktop.evaluate(probe);
    ok(s.sidebarDisplay === "none" || s.sidebarHidden === true, `点一下收起侧栏（display=${s.sidebarDisplay}, hidden=${s.sidebarHidden}）`);
    ok(!s.backdrop, "桌面收起不引入移动端遮罩");
    await shot(desktop, "05-desktop-collapsed");

    await desktop.click(".sidebar-toggle-btn");
    await sleep(700);
    s = await desktop.evaluate(probe);
    ok(s.sidebarDisplay === "flex" && s.sidebarHidden === false, `再点一下展开（display=${s.sidebarDisplay}）——"收起来找不回"就此闭环`);
    await shot(desktop, "06-desktop-expanded");
    await deskCtx.close();
  } finally {
    await browser.close();
  }

  console.log(`\n[结果] ${pass} 通过 / ${fail} 失败`);
  if (fail) {
    console.error("存在失败项：移动端布局验收未通过。");
    process.exit(1);
  }
  console.log("移动端布局验收全部通过 ✅");
  if (SHOTS) console.log(`截图已保存到 ${SHOTS}`);
}

main().catch((e) => {
  console.error("验收脚本异常:", e);
  process.exit(1);
});
