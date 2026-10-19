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
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { findChrome, launchChrome } from "./lib/launch-chrome.mjs";
import { pinAppLanguage } from "./lib/pin-locale.mjs";
import { desktopCardBadgeChecks } from "./lib/desktopCardBadge.mjs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_URL = (process.env.APP_URL || "http://localhost:5173/").replace(/\/+$/, "") + "/";
const PHONE = { width: 390, height: 844 };   // iPhone 14/15 逻辑分辨率
const DESKTOP = { width: 1280, height: 800 };

/**
 * ⭐ 2026-10-10：手机档**「阅读屏」**（效果图 `docs/plans/mobile/mockups/04-read.svg`，规格 §4.4）
 * 落地带来的**门禁搬家**（台账 R192：以效果图为准 ⇒ 改测试 ✓；⛔ 不许为保住旧断言扭曲产品 ✗）。
 *
 * 事实（逐字）：`App.tsx` 手机分支现在是
 *   `currentId ? (isMobile ? <MobileRead …/> : <NoteEditor …/>) : …`
 * ⇒ **窄视口里开着页时不再渲染桌面编辑器** ⇒ 本节原先"经编辑器工具条开右栏三块面板"
 *   在窄视口上**必然找不到元素** ✗。
 *
 * ⚠️ **判据口径：只看宽度**（`useMobile()` 的真口径）——⛔ 不是"窄**或**矮" ✗。三条依据：
 *   ① `src/hooks/useMobile.ts:26` 逐字 `MOBILE_QUERY = \`(max-width: 768px)\``；同文件 §31-44
 *      逐字写「**只看宽度**…792×360 的横屏手机**仍然放得下**'侧栏 + 正文'两列」；
 *      "窄**或**矮"是**浮层形态**（`isMobileOverlayViewport`）的口径，不是"会不会换掉编辑器" ✗。
 *   ② 本轮实测（Chromium，四个视口）：`390×844`/`320×568` ⇒ `mobile-read` 在、编辑器工具条不在；
 *      **`792×360`（矮但不窄）⇒ 编辑器工具条在、`mobile-read` 不在** ✓。
 */
const REPO_ROOT_LAYOUT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MOBILE_BREAKPOINT_PX = (() => {
  const src = readFileSync(join(REPO_ROOT_LAYOUT, "src", "lib", "platform", "shape.ts"), "utf8");
  const m = src.match(/export const MOBILE_BREAKPOINT_PX\s*=\s*(\d+)/);
  if (!m) throw new Error("读不到 MOBILE_BREAKPOINT_PX（src/lib/platform/shape.ts 改了？）—— 断点必须与源码同源");
  return Number(m[1]);
})();
/** 这个视口里 `useMobile()` 为真 ⇒ 桌面编辑器被 `MobileRead` 取代 ✓（宽度口径，与源码同源 ✓）。 */
/** ⭐ 阶段 0（R203）：粗指针查询串**也只许在 `shape.ts` 里定义** ✓ —— 门禁从源码读出来用 ✓。
 *  ⛔ 门禁里不再留字面量 ✗（原来内联了两处 ✗ —— 一处走 `phone.evaluate`、一处走 `desktop.evaluate` ✓）。 */
const COARSE_POINTER_QUERY = (() => {
  const src = readFileSync(join(REPO_ROOT_LAYOUT, "src", "lib", "platform", "shape.ts"), "utf8");
  const m = src.match(/export const COARSE_POINTER_QUERY\s*=\s*"([^"]+)"/);
  if (!m) throw new Error("读不到 COARSE_POINTER_QUERY（src/lib/platform/shape.ts 改了？）—— 能力查询必须与源码同源");
  return m[1];
})();
const replacesDesktopEditor = (vp) => vp.width <= MOBILE_BREAKPOINT_PX;
/** 挂在**桌面编辑器工具条**上的右栏三块面板（窄视口上它们的入口已不存在 ⇒ 搬到桌面档 ✓）。 */
const RIGHT_PANELS = [
  { kind: "discuss", name: "讨论" },
  { kind: "notify", name: "通知" },
  { kind: "toc", name: "目录" },
];

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

/** 「未实查」记一行（**既不算通过也不算失败** —— 与 `AGENTS.md` §7「跳过 ≠ 通过」同口径 ✓）。 */
const note = (msg) => console.log(`  · ${msg}`);

/**
 * 「通知」只在**团队空间**渲染（规则唯一出处 `lib/syncTag.ts::showsNotifications`）。
 *
 * ⭐ 2026-10-18（owner：「那就去掉通知」）：web 壳里种子空间的 `kind` 是 `null` ⇒ 那条路跑不到
 *    ⇒ 下面 `ensureActiveSpaceTeam` 先把活动空间切成 team，让**原有几何断言一条不少**地照跑；
 *    个人空间那一向由收尾时 `ensureActiveSpacePersonal` ＋ 一条断言来验 ✓。
 *    ⚠️ 只改内存 store，⛔ 不落库 ✗。
 */

/**
 * 把活动空间的 `kind` 改成 `team`（只改内存 store，⛔ 不落库 ✗）。
 *
 * 为什么：「通知」只在团队空间渲染，而 web 壳的种子空间 `kind` 是 `null`
 * ⇒ 不切 team，那条路跑不到，几何断言就会**少一条**（基线"只增不减"当场红 ——
 * 2026-10-18 的 CI 就是这么红的：`mobile-layout 断言数从 69 降到 68`）。
 */
async function ensureActiveSpaceTeam(page) {
  try {
    return await page.evaluate(async () => {
      const loaded = (performance.getEntriesByType?.("resource") ?? [])
        .map((e) => e.name)
        .filter((n) => n.includes("/src/store/space.ts"));
      const m = await import(/* @vite-ignore */ (loaded.length ? loaded[loaded.length - 1] : "/src/store/space.ts"));
      const st = m.useSpaceStore.getState();
      const spaces = st.spaces.map((w) => (w.id === st.activeId ? { ...w, kind: "team" } : w));
      m.useSpaceStore.setState({ spaces });
      return spaces.some((w) => w.id === st.activeId && w.kind === "team");
    });
  } catch {
    return false;
  }
}

/** 把活动空间切回**个人**（验"个人空间里确实没有「通知」"那一向）。 */
async function ensureActiveSpacePersonal(page) {
  try {
    return await page.evaluate(async () => {
      const loaded = (performance.getEntriesByType?.("resource") ?? [])
        .map((e) => e.name)
        .filter((n) => n.includes("/src/store/space.ts"));
      const m = await import(/* @vite-ignore */ (loaded.length ? loaded[loaded.length - 1] : "/src/store/space.ts"));
      const st = m.useSpaceStore.getState();
      const spaces = st.spaces.map((w) => (w.id === st.activeId ? { ...w, kind: "personal" } : w));
      m.useSpaceStore.setState({ spaces });
      return spaces.some((w) => w.id === st.activeId && w.kind === "personal");
    });
  } catch {
    return false;
  }
}

// 在页面里读「竖条 / 侧栏 / 遮罩 / 按钮 / 底栏」的真实几何与计算样式。
const probe = () => {
  const sidebar = document.querySelector(".sidebar");
  const railEl = document.querySelector(".activity-bar");
  const toggle = document.querySelector(".sidebar-toggle-btn");
  const backdrop = document.querySelector(".mobile-sidebar-backdrop");
  const railBackdrop = document.querySelector(".mobile-rail-backdrop");
  const main = document.querySelector(".mshell, .main");
  const tabBar = document.querySelector(".mtab-bar");
  const tabItems = [...document.querySelectorAll(".mtab-item")];
  const fab = document.querySelector(".mtab-fab");
  const disp = (el) => (el ? getComputedStyle(el).display : null);
  const rect = (el) => (el ? el.getBoundingClientRect() : null);
  // 窄屏竖条是浮层：收起时被 translateX(-100%) 推到屏外，display 仍是 flex。
  // 所以判"可见"必须看几何（右边缘是否落在视口内），不能看 display。
  const railRect = railEl?.getBoundingClientRect();
  const barRect = rect(tabBar);
  const fabRect = rect(fab);
  const mainRect = rect(main);
  return {
    mobileMQ: matchMedia("(max-width: 768px)").matches,
    sidebarDisplay: disp(sidebar),
    sidebarHidden: sidebar ? sidebar.hasAttribute("hidden") : null,
    railVisible: !!railRect && railRect.right > 1,
    railRight: railRect ? Math.round(railRect.right) : null,
    mainWidth: mainRect ? Math.round(mainRect.width) : null,
    toggleDisplay: disp(toggle),
    toggleAria: toggle?.getAttribute("aria-expanded") ?? null,
    // ⭐ 2026-10-19 第二刀：☰ 已删 ⇒ 探针换成**底栏 ＋ 浮「＋」**（判据不删，换对象 ✓）。
    tabBarDisplay: disp(tabBar),
    tabCount: tabItems.length,
    tabLabels: tabItems.map((el) => (el.textContent || "").trim()),
    tabBarHeight: barRect ? Math.round(barRect.height) : null,
    tabBarTop: barRect ? Math.round(barRect.top) : null,
    tabMinW: tabItems.length ? Math.min(...tabItems.map((el) => Math.round(el.getBoundingClientRect().width))) : null,
    tabMinH: tabItems.length ? Math.min(...tabItems.map((el) => Math.round(el.getBoundingClientRect().height))) : null,
    contentBottom: mainRect ? Math.round(mainRect.bottom) : null,
    fab: fabRect
      ? {
          w: Math.round(fabRect.width),
          h: Math.round(fabRect.height),
          bottom: Math.round(fabRect.bottom),
          right: Math.round(innerWidth - fabRect.right),
        }
      : null,
    docWidth: document.documentElement.scrollWidth,
    winWidth: innerWidth,
    winHeight: innerHeight,
    backdrop: !!backdrop,
    railBackdrop: !!railBackdrop,
    stored: localStorage.getItem("shuyonote:sidebarOpen"),
  };
};

// 窄屏的右侧工具条**默认不渲染**（2026-09-22 起：它是常驻浮动控制条，窄屏上会压住
// 正文右缘）。所以"抽屉遮罩挡住它"这条要分两种情况：
//   · 工具条**不在 DOM 里** ⇒ 没什么可挡的，这条判据不适用（返回 null，调用方跳过）；
//   · 浮动控制在 ⇒ 它同样必须被抽屉遮罩挡住（z-index 45 < 遮罩 55）。
// ⚠️ **2026-10-19 第二刀**：`.mobile-rail-toggle` 已删 ✓ ⇒ 探针换成底栏那颗浮「＋」
//    （它也是 `position: fixed` 的浮动控制 ✓）。判据本身（"抽屉开着时浮动控制在遮罩之下"）不变 ✓。
const railBlockedByBackdrop = () => {
  const target = document.querySelector(".mtab-fab");
  if (!target) return null;
  const r = target.getBoundingClientRect();
  const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  const blocked = at?.classList?.contains("mobile-sidebar-backdrop") ?? false;
  return { blocked, which: ".mtab-fab" };
};

/**
 * 打开/收起左侧竖条（⭐ 2026-10-19 第二刀）。
 *
 * 为什么不再 `page.click(".mobile-rail-toggle")`：☰ **已按计划删除** ✓ —— 手机上 UI
 * 不再有"展开工具栏"的入口 ✓。但竖条本身没删（`ActivityBar` 一个字没动 ✓），
 * 所以门禁仍要量它的几何 ⇒ 这条测试**显式走 store** 把它打开 ✓（⛔ 不是点一个不存在的元素 ✗）。
 */
async function setRailOpen(page, open) {
  await page.evaluate(async (next) => {
    const loaded = (performance.getEntriesByType?.("resource") ?? [])
      .map((e) => e.name)
      .filter((n) => n.includes("/src/store/activity.ts"));
    const m = await import(/* @vite-ignore */ (loaded.length ? loaded[loaded.length - 1] : "/src/store/activity.ts"));
    m.useActivity.getState().setRailOpen(next);
  }, open);
  await sleep(700);
}

/**
 * 回到移动端首页（⭐ 第二刀的底栏**只在** `wrapMobile` 两处外壳里渲染 ✓：首页/快速记录/搜索 ＋ 设置）。
 *
 * 为什么需要：种子空间启动时会**自动打开一页**（`mobile-read` ⇒ 阅读屏，不在底栏外壳里 ✓）。
 * 这里走**真用户路径**「‹ 首页」✓（⛔ 不是硬改 store ✗）；没有打开页时它是 no-op ✓。
 */
async function gotoMobileHome(page) {
  if (await page.$(".mnote-home")) {
    await page.click(".mnote-home");
    await sleep(900);
  }
}

async function main() {
  const executablePath = findChrome();
  if (!executablePath) {
    console.error("找不到 Chrome/Chromium。请安装 Google Chrome，或用 PUPPETEER_EXECUTABLE_PATH 指定路径。");
    console.error("⇒ 环境不具备：**不算通过**（exit 2）—— 这**不是**「有发现」，别读成代码有问题。");
    process.exit(2);
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
    console.error("⇒ 环境不具备：**不算通过**（exit 2）—— 这**不是**「有发现」，别读成代码有问题。");
    process.exit(2);
  }
  console.log(`应用地址: ${APP_URL}\n`);

  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await launchChrome({ executablePath });
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  const shot = async (page, name) => {
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  };

  try {
    // ---------- 手机视口：用独立 context，保证 localStorage 从零开始 ----------
    const phoneCtx = await browser.createBrowserContext();
    const phone = await phoneCtx.newPage();
    await pinAppLanguage(phone);
    const pageErrors = [];
    phone.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 200)));
    await phone.setViewport({ ...PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await phone.goto(APP_URL, { waitUntil: "networkidle2", timeout: 60000 });
    await sleep(3000);
    // 种子空间会自动打开一页 ⇒ 先回首页，底下才量得到底栏（见 `gotoMobileHome` 注释 ✓）。
    await gotoMobileHome(phone);

    console.log(`【手机 ${PHONE.width}x${PHONE.height} · 初始】`);
    let s = await phone.evaluate(probe);
    ok(s.mobileMQ, "命中窄屏媒体查询");
    ok(s.sidebarDisplay === "none", `侧栏默认收起（display=${s.sidebarDisplay}）——hidden 未被 .sidebar 的 display:flex 压掉`);
    ok(s.sidebarHidden === true, "侧栏带 hidden 属性");
    ok(s.railVisible === false, `左侧竖条默认收起（浮层，右边缘=${s.railRight} 在屏外）`);
    ok(s.mainWidth === PHONE.width, `主区拿到全宽 ${PHONE.width}px（实际 ${s.mainWidth}）——竖条不再常驻吃掉 12% 宽度`);
    // ⭐ 2026-10-19 第二刀：☰ 删了 ⇒ 这一格换成**底栏 ＋ 浮「＋」**的几何（仍是 1 条断言 ✓，
    //    读数写进 note ✓）：栏高 56–64、每项触区 ≥44、内容底不被栏遮、浮＋大小/位置、无横向溢出。
    note(
      `底栏读数：display=${s.tabBarDisplay} 项=${s.tabCount}（${s.tabLabels.join("/")}）` +
        ` 高=${s.tabBarHeight} 每项最小=${s.tabMinW}×${s.tabMinH}` +
        ` 内容底=${s.contentBottom} 栏顶=${s.tabBarTop}` +
        ` 浮＋=${s.fab ? `${s.fab.w}×${s.fab.h} 底=${s.fab.bottom} 右=${s.fab.right}` : "不在"}` +
        ` 文档宽=${s.docWidth} 视口=${s.winWidth}`,
    );
    ok(
      s.tabBarDisplay === "flex" &&
        s.tabCount === 3 &&
        s.tabLabels.join("/") === "笔记/搜索/我的" &&
        s.tabBarHeight >= 56 &&
        s.tabBarHeight <= 64 &&
        s.tabMinW >= 44 &&
        s.tabMinH >= 44 &&
        s.contentBottom <= s.tabBarTop &&
        s.fab !== null &&
        s.fab.w >= 44 &&
        s.fab.h >= 44 &&
        s.fab.bottom <= s.tabBarTop - 8 &&
        s.docWidth <= s.winWidth,
      `底栏三项（${s.tabLabels.join("/")}）高 ${s.tabBarHeight}（56–64）、触区 ≥44、内容底 ${s.contentBottom} ≤ 栏顶 ${s.tabBarTop}、` +
        `浮＋ ${s.fab?.w}×${s.fab?.h} 在栏上方、文档宽 ${s.docWidth} ≤ ${s.winWidth}`,
    );
    ok(!s.backdrop && !s.railBackdrop, "初始无任何遮罩");
    ok(s.stored === null, `移动端自动收起不写 localStorage（实际 ${JSON.stringify(s.stored)}）——否则会污染桌面端偏好`);
    await shot(phone, "01-phone-closed");

    console.log(`\n【手机 · 经 store 打开竖条 → 滑入】`);
    await setRailOpen(phone, true);
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
    const blockedByBackdrop = await phone.evaluate(railBlockedByBackdrop);
    // ⚠️ 2026-10-19 第二刀：浮动控制从 ☰ 换成底栏那颗浮「＋」（`.mtab-fab` ✓）。
    //    判据**换对象不换语义**：抽屉打开时它必须被遮罩挡住（z 45/46 < 遮罩 55）✓。
    ok(
      blockedByBackdrop === null || blockedByBackdrop.blocked === true,
      blockedByBackdrop === null
        ? "抽屉打开时没有可误触的**浮动**控制（底栏浮＋不在？）"
        : `底栏浮「＋」（${blockedByBackdrop.which}）在抽屉遮罩之下（blocked=${blockedByBackdrop.blocked}）——⛔ 不许从右下角戳出另一套操作`,
    );
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

    console.log(`\n【手机 · 再开竖条（store），点遮罩收起】`);
    await setRailOpen(phone, true);
    s = await phone.evaluate(probe);
    ok(s.railVisible === true, "竖条再次滑入");
    await phone.mouse.click(PHONE.width - 20, 500);
    await sleep(800);
    s = await phone.evaluate(probe);
    ok(s.railVisible === false, "点遮罩后竖条收起");
    ok(!s.railBackdrop, "浮层遮罩消失");
    console.log(`\n【手机 · 竖条里点非活动按钮（设置）】`);
    await setRailOpen(phone, true);
    // ⚠️ 按**标题**选，不按序号。⚠️ **2026-10-04 又一次**：模板中心那颗**独立按钮**
    // 已并进 `.activity-group` 的 `ITEMS`（第 7 个 view）⇒ 底部 `.activity-group-end`
    // 现在只剩「设置」；本脚本原来按 `.activity-group-end` 找模板中心 ⇒ **找不到元素、
    // 整个验收在 5 秒内异常退出** ✗（2026-10-05 CI 的 `mobile-layout` 就是这么红的）。
    // ⇒ 找模板中心一律用 **`.activity-group`**（分组无关时直接按 title 找也行）。
    await phone.click('.activity-group-end .activity-btn[title="设置"]');
    await sleep(900);
    s = await phone.evaluate(probe);
    ok(s.railVisible === false, "点竖条里的非活动按钮也会收起浮层（不只是活动图标）");
    await phone.keyboard.press("Escape");
    await sleep(600);

    // ---------- 手机 · 模板中心：它是 `.main` 里的整视图，不是浮层 ----------
    // 2026-09-22：`TemplateCenterView` 此前只有桌面样式，390px 上量到三处问题
    //（前两处是**功能不可用**，而且都不报错，只是"看得见 / 以为点得到"）：
    //   1. `.tc-head` 一行里塞着**固定 240px** 的搜索框 + 导入 + 关闭，加间距 ~368px
    //      > 可用 326px（视口 390 − 左右各 32）⇒ 横向溢出，「关闭」被推出屏幕
    //      ⇒ 模板中心在手机上**关不掉**（与 `.set-dialog{min-width:640px}` 同一类坏法）；
    //   2. `.tc-tabs` 六个分类 ~420px ⇒ 「健康 / 我的模板」落在屏外，**切不过去**。
    //   3. 卡片操作只在 `:hover` 显形——触屏没有 hover，导出 / 删除等于不存在。
    // 前两处量真几何；第三处只能量**只带类名的探针节点**：Web 端 `save_as_template`
    // 是 no-op（`lib/platform/web.ts`），用户模板进不了 DOM，`.tc-card-actions` 根本不渲染
    //（`.plugin-panel` 那条宽度断言用的是同一个办法）。
    console.log(`\n【手机 · 打开模板中心】`);
    await setRailOpen(phone, true);
    await phone.click('.activity-group .activity-btn[title="模板中心"]');
    await sleep(1600);

    const tc = await phone.evaluate(() => {
      const rect = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          x: Math.round(r.x),
          right: Math.round(r.right),
          w: Math.round(r.width),
          h: Math.round(r.height),
        };
      };
      const hits = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !!at && (el === at || el.contains(at));
      };
      const tabsEl = document.querySelector(".tc-tabs");
      const tabs = Array.from(document.querySelectorAll(".tc-tab"));
      const closeBtn = document.querySelector(".tc-close");
      const grid = document.querySelector(".tc-grid");
      const cols = grid ? getComputedStyle(grid).gridTemplateColumns.split(/\s+/).filter(Boolean).length : null;
      return {
        open: !!document.querySelector(".template-center"),
        winWidth: innerWidth,
        docWidth: document.documentElement.scrollWidth,
        search: rect(document.querySelector(".tc-search-input")),
        importBtn: rect(document.querySelector(".tc-import")),
        closeBtn: rect(closeBtn),
        closeHits: hits(closeBtn),
        tabCount: tabs.length,
        tabH: tabs.length ? Math.round(tabs[0].getBoundingClientRect().height) : null,
        tabsClientW: tabsEl ? tabsEl.clientWidth : null,
        tabsScrollW: tabsEl ? tabsEl.scrollWidth : null,
        tabsOverflowX: tabsEl ? getComputedStyle(tabsEl).overflowX : null,
        cols,
      };
    });
    ok(tc.open, "点竖条里的「模板中心」打开了模板画廊");
    await shot(phone, "05-phone-template-center");
    ok(tc.docWidth <= tc.winWidth, `无横向溢出（文档宽 ${tc.docWidth} ≤ 视口 ${tc.winWidth}）`);
    ok(
      !!tc.search && !!tc.importBtn && !!tc.closeBtn && tc.closeBtn.right <= tc.winWidth,
      `头部三个控件全在视口内（搜索 right=${tc.search?.right} / 导入 right=${tc.importBtn?.right} / ` +
        `关闭 right=${tc.closeBtn?.right} ≤ ${tc.winWidth}）——固定 240px 的搜索框会把「关闭」挤出屏幕`,
    );
    ok(tc.closeHits === true, "「关闭」是它自己中心点上的命中元素（看得见 = 点得到）");
    ok(
      tc.tabCount === 6 && (tc.tabsScrollW <= tc.tabsClientW + 1 || /auto|scroll/.test(tc.tabsOverflowX ?? "")),
      `六个分类页签都在，且"放得下就直接显示 / 放不下就能横滑"（${tc.tabCount} 个：` +
        `scrollWidth ${tc.tabsScrollW} vs clientWidth ${tc.tabsClientW}，overflow-x=${tc.tabsOverflowX}）` +
        `——"溢出且滚不到"才是 bug（「健康 / 我的模板」永远切不过去）；` +
        `⚠️ 2026-09-22：Linux runner 字体更窄，六个页签正好放得下（362 = 362），原来那条"必须溢出"在 CI 上恒红`,
    );
    ok(tc.tabH >= 44, `页签命中区 ≥44（实际 ${tc.tabH}）`);
    ok(tc.cols === 2, `390px 下卡片是两列（实际 ${tc.cols} 列）——桌面那条 minmax(240px,1fr) 只剩一列、每张卡占满整屏`);

    // 最后一个页签：`scrollWidth > clientWidth` 只说"能滑"，还要滑到底之后真的进得来。
    const lastTab = await phone.evaluate(() => {
      const el = document.querySelector(".tc-tabs");
      if (!el) return null;
      el.scrollLeft = el.scrollWidth;
      const tabs = Array.from(document.querySelectorAll(".tc-tab"));
      const t = tabs[tabs.length - 1];
      const r = t.getBoundingClientRect();
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return {
        name: t.textContent,
        right: Math.round(r.right),
        winWidth: innerWidth,
        hits: !!at && (t === at || t.contains(at)),
      };
    });
    ok(
      !!lastTab && lastTab.right <= lastTab.winWidth && lastTab.hits,
      `滑到底后最后一个页签「${lastTab?.name}」在视口内且可点（right=${lastTab?.right} ≤ ${lastTab?.winWidth}，命中=${lastTab?.hits}）`,
    );

    // 卡片操作（导出 / 删除）：常驻 + 命中区 ≥44，而且**不许占版面**。
    // "不占版面"是可量的：把两张同款卡片放进一个**块级**容器（不是 grid，否则
    // `align-items: stretch` 会把高度抹平，量了等于没量）——带操作行的那张必须
    // 与不带操作行的那张**一样高**。第一版把它们改成"卡片底部一行"就是因为没有这条
    // 断言：功能全绿，但每张自建模板多出一条 54px 的行、网格还错落。
    const tcActions = await phone.evaluate((coarseQuery) => {
      const make = (withActions) => {
        const card = document.createElement("div");
        card.className = "tc-card";
        if (withActions) {
          const box = document.createElement("div");
          box.className = "tc-card-actions";
          for (const glyph of ["⬇", "×"]) {
            const b = document.createElement("button");
            b.className = "tc-card-del";
            b.textContent = glyph;
            box.appendChild(b);
          }
          card.appendChild(box);
        }
        card.insertAdjacentHTML(
          "beforeend",
          '<div class="tc-preview"><div class="tc-preview-cover"></div>' +
            '<div class="tc-pv-card tc-pv-content"><div class="tc-pv-text">会议主题</div></div></div>' +
            '<div class="tc-card-body"><span class="tc-card-name">我的会议纪要</span>' +
            '<span class="tc-card-tag">我的模板</span></div>',
        );
        return card;
      };
      const host = document.createElement("div");
      host.style.cssText = "position:fixed;left:-9999px;top:0;width:170px;display:block";
      const withA = make(true);
      const without = make(false);
      host.append(withA, without);
      document.body.appendChild(host);
      const box = withA.querySelector(".tc-card-actions");
      const btn = withA.querySelector(".tc-card-del");
      const cs = getComputedStyle(btn);
      const r = btn.getBoundingClientRect();
      // ⚠️ 计算样式会把 `circle 15px at 50% 50%` 规范化成 `radial-gradient(15px at 50% 50%, …)`
      //    ——`circle` 关键字在有长度时会被省掉，所以两个形态都要认。
      const radius = cs.backgroundImage.match(/radial-gradient\(\s*(?:circle\s+)?(\d+(?:\.\d+)?)px/);
      const out = {
        opacity: cs.opacity,
        w: Math.round(r.width),
        h: Math.round(r.height),
        // 视觉半径：从渐变里读（"看着小、摸着大"就是靠它）。
        visualR: radius ? Number(radius[1]) : null,
        circle: cs.backgroundImage.replace(/\s+/g, " ").slice(0, 46),
        boxPos: getComputedStyle(box).position,
        boxDir: getComputedStyle(box).flexDirection,
        withH: Math.round(withA.getBoundingClientRect().height),
        withoutH: Math.round(without.getBoundingClientRect().height),
        hoverNone: matchMedia(coarseQuery).matches,
      };
      host.remove();
      return out;
    }, COARSE_POINTER_QUERY);
    ok(
      tcActions.opacity === "1" && tcActions.w >= 44 && tcActions.h >= 44,
      `卡片操作常驻且命中区 ≥44×44（opacity=${tcActions.opacity} / ${tcActions.w}×${tcActions.h}）` +
        `——触屏没有 hover，靠 \`:hover\` 显形的 22×22 等于"删不掉、导不出自己的模板"`,
    );
    ok(
      tcActions.boxPos === "absolute" && tcActions.boxDir === "row",
      `操作仍悬浮在封面右上角、两个横排（position=${tcActions.boxPos} / flex-direction=${tcActions.boxDir}）`,
    );
    ok(
      tcActions.withH === tcActions.withoutH,
      `操作按钮**不占卡片高度**（带操作 ${tcActions.withH}px = 不带 ${tcActions.withoutH}px）` +
        `——移动端要简洁：改成卡片底部一行会让每张自建模板多出一条行，网格还会错落`,
    );
    ok(
      tcActions.visualR !== null && tcActions.visualR * 2 < tcActions.w,
      `视觉圆比命中区小（直径 ${(tcActions.visualR ?? 0) * 2}px < 命中区 ${tcActions.w}px）——` +
        `看着是两个小圆、摸着是 44 的按钮（${tcActions.circle}…）`,
    );

    // 关得掉：几何落在视口里只是必要条件，点一下真的关掉才算数。
    await phone.click(".tc-close");
    await sleep(900);
    const tcClosed = await phone.evaluate(() => !document.querySelector(".template-center"));
    ok(tcClosed === true, "点「关闭」之后模板中心真的关上了（而不是「按钮在屏幕外、只能靠返回键离开」）");

    ok(pageErrors.length === 0, `页面无 JS 报错${pageErrors.length ? "：" + pageErrors.join(" | ") : ""}`);

    // ---------- 手机 · 右侧面板叠加：主区不该被"让位"内边距挤压 ----------
    // 桌面端 TOC/AI 是固定宽侧板，主区靠 padding-right 让位；窄屏它们是全屏叠加，
    // 再让位就会把主区内容盒挤成 0 宽，并把 .main 撑出 .app-body
    // （flex 项缩不到 padding 以下，宽度被顶成 380px > 视口 342px）。
    //
    // ⚠️ **2026-10-06（owner：「关闭这个顶部工具栏」）**：右侧面板的**可见**入口从"顶端四颗"
    //    搬到了**编辑器工具条**（「⋯ 更多」里的讨论/通知 ＋ 那一排里的「目录」）。
    //    本节验的仍是同一件事（窄屏上面板是叠加、不许把主区挤走 ✓），只是**开面板的手**换了 ✓。
    // ⚠️ `RIGHT_PANELS` 已**提到文件顶部**（2026-10-10：桌面段也要用它 ⇒ 别再在函数里声明一份 ✗）。
    const mainGeometry = () => {
      const main = document.querySelector(".mshell, .main");
      if (!main) return null;
      const r = main.getBoundingClientRect();
      return {
        right: Math.round(r.right),
        paddingRight: (main ? getComputedStyle(main).paddingRight : "NO-SCREEN-ROOT"),
        docWidth: document.documentElement.scrollWidth,
        winWidth: innerWidth,
      };
    };
    if (replacesDesktopEditor(PHONE)) {
      // ⭐ 2026-10-10 **换对象**（规格 §4.4）：窄视口里开着页时渲染的是移动端**阅读屏** ⇒
      //   原「三块右栏面板」的入口在窄视口上**已不存在**（桌面编辑器不在 ⇒ 没有那条工具条）。
      //   ⛔ 没删断言：**同一批几何断言**（主区不让位 / 不超出视口 / 无横向溢出）改成量**阅读屏** ✓；
      //   那三块面板的**入口存在性**断言**搬到桌面档**（本文件下面桌面段 ✓）。
      await phone.goto(APP_URL, { waitUntil: "networkidle2", timeout: 60000 });
      await sleep(2000);
      const readShot = await phone.evaluate(() => {
        const root = document.querySelector('[data-testid="mobile-read"]');
        const back = document.querySelector(".mread-back");
        const b = back ? back.getBoundingClientRect() : null;
        return { hasRead: !!root, backW: b ? Math.round(b.width) : 0, backH: b ? Math.round(b.height) : 0 };
      });
      ok(readShot.hasRead, '窄视口开着页时渲染移动端阅读屏（[data-testid="mobile-read"]）');
      ok(
        readShot.backW >= 44 && readShot.backH >= 44,
        `阅读屏顶栏返回键命中区 ≥44×44（实际 ${readShot.backW}x${readShot.backH}）`,
      );
      const gRead = await phone.evaluate(mainGeometry);
      console.log(`\n【手机 · 移动端阅读屏（窄视口不再渲染桌面编辑器）】`);
      ok(gRead.paddingRight === "0px", `阅读屏主区不让位（padding-right=${gRead.paddingRight}）`);
      ok(gRead.right <= gRead.winWidth, `阅读屏主区不超出视口（right=${gRead.right} ≤ ${gRead.winWidth}）`);
      ok(gRead.docWidth <= gRead.winWidth, `阅读屏无横向溢出（文档宽=${gRead.docWidth}）`);
      const backClicked = await phone.evaluate(() => {
        const b = document.querySelector(".mread-back");
        if (!b) return false;
        b.click();
        return true;
      });
      await sleep(1000);
      const backHome = await phone.evaluate(() => !!document.querySelector('[data-testid="mobile-home"]'));
      ok(backClicked && backHome, `阅读屏返回键能回到**首页**（点了=${backClicked}，到首页=${backHome}）`);
      await shot(phone, "05-phone-read");
    } else {
    for (const p of RIGHT_PANELS) {
      // 每次重新加载，避免上一个面板的开关状态串进来
      await phone.goto(APP_URL, { waitUntil: "networkidle2", timeout: 60000 });
      await sleep(2000);
      const openedVia = await phone.evaluate((kind) => {
        if (kind === "toc") {
          const b = Array.from(document.querySelectorAll(".toolbar-btn")).find((x) =>
            (x.getAttribute("title") || "").startsWith("目录"),
          );
          if (!b) return "没有「目录」那颗";
          b.click();
          return "工具条·目录";
        }
        const more = document.querySelector(".editor-toolbar-more .toolbar-btn");
        if (!more) return "没有「⋯ 更多」";
        more.click();
        return "menu";
      }, p.kind);
      if (openedVia === "menu") {
        await sleep(400);
        const label = p.kind === "discuss" ? "讨论" : "通知";
        // ⭐ 2026-10-18：**「通知」只在团队空间渲染** ⇒ 先把活动空间切成 team，
        //    让这一档走**原来那条路**（断言一条不少 ✓）；个人空间那一向由收尾那条判 ✓。
        if (p.kind === "notify") {
          const team = await ensureActiveSpaceTeam(phone);
          if (!team) note(`${p.name}：切不到团队空间（读不到 store）⇒ 这一档**未实查**，⛔ 不当通过`);
          await sleep(250);
        }
        const hit = await phone.evaluate((text) => {
          const item = Array.from(document.querySelectorAll(".editor-more-menu .toolbar-menu-item")).find((x) =>
            (x.textContent || "").includes(text),
          );
          if (item) item.click();
          return !!item;
        }, label);
        if (!hit) {
          ok(false, `${p.name}：编辑器工具条「⋯ 更多」里没有这一项`);
          continue;
        }
      } else if (openedVia !== "工具条·目录") {
        ok(false, `${p.name}：找不到入口（${openedVia}）`);
        continue;
      }
      await sleep(1400);
      const g = await phone.evaluate(mainGeometry);
      console.log(`\n【手机 · 打开「${p.name}」（经 ${openedVia}）】`);
      ok(g.paddingRight === "0px", `主区不让位（padding-right=${g.paddingRight}）`);
      ok(g.right <= g.winWidth, `主区不超出视口（right=${g.right} ≤ ${g.winWidth}）`);
      ok(g.docWidth <= g.winWidth, `无横向溢出（文档宽=${g.docWidth}）`);
      await shot(phone, `05-phone-panel-${p.kind}`);
    }
    }
    // ---------- 小屏 320×568：模板中心不许退回"一张卡占满整屏" ----------
    // 390px 只是主流尺寸。320px（iPhone SE / 老 Android）可用宽只有 320 − 14×2 = 292px：
    // 网格下限写 160px 时 2×160+12 = 332 > 292 ⇒ **只剩一列**，一张卡占满 292px
    // 而封面还是 56px 高，版式整个散掉（这一条是照着截图改出来的，不是推出来的）。
    {
      console.log(`\n【小屏 320x568 · 模板中心】`);
      const smallCtx = await browser.createBrowserContext();
      const small = await smallCtx.newPage();
      await pinAppLanguage(small);
      const smallErrors = [];
      small.on("pageerror", (e) => smallErrors.push(String(e).slice(0, 200)));
      await small.setViewport({ width: 320, height: 568, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      await small.goto(APP_URL, { waitUntil: "networkidle2", timeout: 60000 });
      await sleep(2500);
      await setRailOpen(small, true);
      await small.click('.activity-group .activity-btn[title="模板中心"]');
      await sleep(1600);
      const s320 = await small.evaluate(() => {
        const grid = document.querySelector(".tc-grid");
        const closeBtn = document.querySelector(".tc-close");
        const r = closeBtn ? closeBtn.getBoundingClientRect() : null;
        const at = r ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
        return {
          open: !!document.querySelector(".template-center"),
          cols: grid ? getComputedStyle(grid).gridTemplateColumns.split(/\s+/).filter(Boolean).length : null,
          docWidth: document.documentElement.scrollWidth,
          winWidth: innerWidth,
          closeRight: r ? Math.round(r.right) : null,
          closeHits: !!at && (closeBtn === at || closeBtn.contains(at)),
        };
      });
      ok(s320.open, "320px 下也能打开模板中心");
      ok(s320.cols === 2, `320px 下仍是两列（实际 ${s320.cols} 列）——一列时一张卡占满整屏、封面被拉成一条`);
      ok(
        s320.closeRight !== null && s320.closeRight <= s320.winWidth && s320.closeHits,
        `320px 下「关闭」仍在视口内且可点（right=${s320.closeRight} ≤ ${s320.winWidth}，命中=${s320.closeHits}）`,
      );
      ok(s320.docWidth <= s320.winWidth, `320px 下无横向溢出（文档宽 ${s320.docWidth} ≤ ${s320.winWidth}）`);
      await shot(small, "05-phone-320-template-center");
      ok(smallErrors.length === 0, `320px 页面无 JS 报错${smallErrors.length ? "：" + smallErrors.join(" | ") : ""}`);
      await smallCtx.close();
    }

    await phoneCtx.close();

    // ---------- 桌面视口：独立 context，默认偏好（侧栏展开）----------
    const deskCtx = await browser.createBrowserContext();
    const desktop = await deskCtx.newPage();
    await pinAppLanguage(desktop);
    await desktop.setViewport(DESKTOP);
    await desktop.goto(APP_URL, { waitUntil: "networkidle2", timeout: 60000 });
    await sleep(2500);

    console.log(`\n【桌面 ${DESKTOP.width}x${DESKTOP.height}】`);
    s = await desktop.evaluate(probe);
    ok(!s.mobileMQ, "不命中窄屏媒体查询");
    ok(s.sidebarDisplay === "flex", `侧栏常驻可见（display=${s.sidebarDisplay}）`);
    ok(s.railVisible === true, `桌面竖条常驻在布局流内（右边缘=${s.railRight}）`);
    // ⭐ 2026-10-19 第二刀：☰ 已删 ⇒ 这一格换成本刀真正要钉的**桌面不渲染移动底栏**
    //    （换对象不换语义：移动专属 chrome 不许漏到桌面 ✓）。
    ok(s.tabBarDisplay === null, "桌面根本不渲染移动底栏 / 浮「＋」（元素不存在，不只是 display:none）");
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

    // ---------- 桌面 · 模板中心没被上面那套窄屏规则改掉 ----------
    // 断点类改动最容易的失败方式是"顺手把桌面也改了"（`.plugin-panel` 那条
    // `@media(max-width:768px){width:100%}` 当年就因为写在基础规则前面而从未生效，
    // 反向的坑同样存在）。这里在 1280×800 上复核三条桌面形态。
    console.log(`\n【桌面 · 模板中心仍是桌面形态】`);
    await desktop.click('.activity-btn[title="模板中心"]');
    await sleep(1200);
    const dtc = await desktop.evaluate((coarseQuery) => {
      const card = document.createElement("div");
      card.className = "tc-card";
      const box = document.createElement("div");
      box.className = "tc-card-actions";
      const btn = document.createElement("button");
      btn.className = "tc-card-del";
      box.appendChild(btn);
      card.appendChild(box);
      document.body.appendChild(card);
      const tabsEl = document.querySelector(".tc-tabs");
      const grid = document.querySelector(".tc-grid");
      const out = {
        open: !!document.querySelector(".template-center"),
        searchW: Math.round(document.querySelector(".tc-search-input")?.getBoundingClientRect().width ?? 0),
        cols: grid ? getComputedStyle(grid).gridTemplateColumns.split(/\s+/).filter(Boolean).length : null,
        tabsScrollW: tabsEl ? tabsEl.scrollWidth : null,
        tabsClientW: tabsEl ? tabsEl.clientWidth : null,
        boxPos: getComputedStyle(box).position,
        delOpacity: getComputedStyle(btn).opacity,
        delW: Math.round(btn.getBoundingClientRect().width),
        hoverNone: matchMedia(coarseQuery).matches,
      };
      card.remove();
      return out;
    }, COARSE_POINTER_QUERY);
    ok(dtc.open, "桌面能打开模板中心");
    ok(dtc.searchW === 240, `桌面搜索框仍是固定 240px（实际 ${dtc.searchW}）——窄屏那条 width:100% 不许漏到桌面`);
    ok(dtc.cols >= 3, `桌面卡片仍是多列（实际 ${dtc.cols} 列，1280px 下至少 3 列）`);
    ok(
      dtc.tabsScrollW <= dtc.tabsClientW,
      `桌面页签装得下、不需要横滑（scrollWidth ${dtc.tabsScrollW} ≤ clientWidth ${dtc.tabsClientW}）`,
    );
    // ⭐ 2026-10-13（owner 拍"甲"）：这条判据**在两种平台上都计入总条数** ✓ ——
    //    原来写成 `if (!dtc.hoverNone) { ok(…) } else { console.log("跳过") }` ✗ ⇒ **通过数随平台变**
    //    （CI 的 headless 报 `(hover: none)` ⇒ 数出来 68，而 `tests/baseline.json:9` 的下界是 69
    //    ⇒ "只增不减"那条**人拍的**硬约束永远对不上，红了半个月 ✓）。
    //    ⛔ 不走"乙"（把平台相关的差写进基线 ✗ —— 那样另一个平台永远对不上 ✓）。
    //    ⇒ 两边都跑**同一条** `ok()`，只是期望值按 `(hover: none)` 取 ✓：能 hover ⇒ 22px 悬停显形；
    //      `(hover: none)` ⇒ `src/App.css:22665-22687` 那条让它 44×44 常驻 ✓。
    //    ⚠️ 定义只有一份：`scripts/lib/desktopCardBadge.mjs` ✓（计数口径的判据在
    //      `scripts/verify-mobile-layout.test.mjs` ✓）。
    for (const c of desktopCardBadgeChecks(dtc)) ok(c.ok, c.msg);
    await shot(desktop, "07-desktop-template-center");

    // ⭐ 2026-10-10 **搬家（不删）**：原先在**窄视口**验的那三块右栏面板（讨论 / 通知 / 目录）
    //   的「入口真的在、点得开」，现在跑在**桌面档** ✓ —— 窄视口里开着页时渲染的是移动端
    //   **阅读屏**（规格 §4.4），那条编辑器工具条**根本不在** ✗ ⇒ 入口断言必须跟着编辑器走 ✓。
    //   ⚠️ 这里**不重复**窄屏那套「叠加 / `padding-right=0`」几何：桌面是**固定侧板**、
    //      本来就该让位 ⇒ 硬搬会造**假红** ✗（那三条仍在窄视口上量，只是对象换成了阅读屏 ✓）。
    for (const p of RIGHT_PANELS) {
      await desktop.goto(APP_URL, { waitUntil: "networkidle2", timeout: 60000 });
      await sleep(1800);
      await desktop.evaluate(() => {
        const row = document.querySelector('.tree-row[data-node-kind="page"]');
        if (row) row.click();
      });
      await sleep(1300);
      const openedVia = await desktop.evaluate((kind) => {
        if (kind === "toc") {
          const b = Array.from(document.querySelectorAll(".toolbar-btn")).find((x) =>
            (x.getAttribute("title") || "").startsWith("目录"),
          );
          if (!b) return "没有「目录」那颗";
          b.click();
          return "工具条·目录";
        }
        const more = document.querySelector(".editor-toolbar-more .toolbar-btn");
        if (!more) return "没有「⋯ 更多」";
        more.click();
        return "menu";
      }, p.kind);
      if (openedVia === "menu") {
        await sleep(400);
        const label = p.kind === "discuss" ? "讨论" : "通知";
        // ⭐ 2026-10-18：同手机上那条 —— 先把活动空间切成 team，走原来那条路 ✓
        if (p.kind === "notify") {
          const team = await ensureActiveSpaceTeam(desktop);
          if (!team) note(`桌面 · ${p.name}：切不到团队空间（读不到 store）⇒ 这一档**未实查**，⛔ 不当通过`);
          await sleep(250);
        }
        const hit = await desktop.evaluate((text) => {
          const item = Array.from(document.querySelectorAll(".editor-more-menu .toolbar-menu-item")).find((x) =>
            (x.textContent || "").includes(text),
          );
          if (item) item.click();
          return !!item;
        }, label);
        if (!hit) {
          ok(false, `桌面 · ${p.name}：编辑器工具条「⋯ 更多」里没有这一项`);
          continue;
        }
      } else if (openedVia !== "工具条·目录") {
        ok(false, `桌面 · ${p.name}：找不到入口（${openedVia}）`);
        continue;
      }
      await sleep(1100);
      const dg = await desktop.evaluate(mainGeometry);
      console.log(`\n【桌面 · 打开「${p.name}」（经 ${openedVia}）】`);
      ok(dg.right <= dg.winWidth, `桌面主区不超出视口（right=${dg.right} ≤ ${dg.winWidth}）`);
      ok(dg.docWidth <= dg.winWidth, `桌面无横向溢出（文档宽=${dg.docWidth}）`);
      await shot(desktop, `07-desktop-panel-${p.kind}`);
    }

    // ⭐ 2026-10-18（owner：「那就去掉通知」）**收尾那一向**：切回个人空间 ⇒ 「通知」必须**不出现**。
    //    为什么要有这一条：上面那一档为了让几何断言跑全，把空间**临时切成 team** 了 ⇒
    //    如果不验"个人空间里确实没有"，这条产品口径就**一条判据都没有** ✓。
    const backPersonal = await ensureActiveSpacePersonal(desktop);
    if (backPersonal) {
      await desktop.evaluate(() => {
        const more = document.querySelector(".editor-toolbar-more .toolbar-btn");
        if (more) more.click();
      });
      await sleep(400);
      const stillThere = await desktop.evaluate(() =>
        Array.from(document.querySelectorAll(".editor-more-menu .toolbar-menu-item")).some((x) =>
          (x.textContent || "").includes("通知"),
        ),
      );
      ok(!stillThere, "桌面 · 个人空间里「通知」**按设计不出现**（团队空间才有）");
      await desktop.evaluate(() => {
        const more = document.querySelector(".editor-toolbar-more .toolbar-btn");
        if (more) more.click();
      });
    } else {
      note("桌面 · 个人空间那一向读不到 store ⇒ **未实查**，⛔ 不当通过");
    }

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
