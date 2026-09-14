// 移动端浮层 / 弹窗验收 · 用真实 Chromium 在**两个手机视口**上把每一层都打开，
// 量几何、量滚动、量命中区。
//
// 为什么需要它（三个根因全是"功能直接不可用"，而且都不会报错）：
//   1. `.set-dialog{min-width:640px}` **压过** `max-width` ⇒ 390px 视口上面板右边缘
//      越界 274px（360px 上 304px），「关闭设置」不在视口里 —— 设置面板**关不上**。
//      `min-width` 胜 `max-width` 是这一类坏法的总根因，公式编辑器同理（溢出 35~50px）。
//   2. 窄屏收起的左侧竖条带 `transform`，于是成了搜索/回收站浮层（`position:fixed`）
//      的**包含块**，算出来 `left:8` 实际落在 **-40px**（对照：注入 `transform:none`
//      之后回到 8）。
//   3. **没有任何滚动锁**：搜索面板打开时触摸拖动能把背景正文拖走 323px。
//      真正滚动的是 `.note-scroll`（`.app{overflow:hidden}`），锁 `body` 无效。
//
// 判据分两类，刻意混着用：
//   · **几何/计算样式**（左边界、越界、overflow-y、min-width）——确定、可复现；
//   · **行为**（触摸拖动之后 `scrollTop` 有没有变）——慢一点，但它是"用户真的能不能
//     把背景拖走"的唯一直接证据。
//
// 前置：本机有 Chrome/Chromium（或 PUPPETEER_EXECUTABLE_PATH 指定），
//       以及已启动的 web 开发服务（默认 http://localhost:5173/）。
//
// 用法：
//   pnpm dev:web                       # 另开一个终端
//   pnpm test:mobile-overlays          # 有失败即非零退出
//   APP_URL=http://192.168.31.89:5173/ pnpm test:mobile-overlays
//   node scripts/verify-mobile-overlays.mjs --shots /tmp/shots
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { findChrome, launchChrome } from "./lib/launch-chrome.mjs";

const APP_URL = (process.env.APP_URL || "http://localhost:5173/").replace(/\/+$/, "") + "/";

// 断点 768px（与 useMobile.ts 的 MOBILE_BREAKPOINT_PX 同一个数）。
// 两个手机视口：360 是本轮新增的更窄那一档（此前只有 390）——`.set-dialog` 的
// 越界量正是从 390 的 274px 长到 360 的 304px，只测一个宽度就看不到这个趋势。
const PHONES = [
  { name: "360x640", width: 360, height: 640 },
  { name: "390x844", width: 390, height: 844 },
];
const DESKTOP = { name: "1280x800", width: 1280, height: 800 };

const shotsArg = process.argv.indexOf("--shots");
const SHOTS = shotsArg > -1 ? process.argv[shotsArg + 1] : null;

let pass = 0;
let fail = 0;
const notes = [];
const ok = (cond, msg) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.error(`  ✗ ${msg}`);
  }
};
/** 只记录、不判定 —— 用于"先记基线"的指标（命中区数量这类）。 */
const note = (msg) => {
  notes.push(msg);
  console.log(`  · ${msg}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * `page.evaluate` 的加固版。
 *
 * CI 里 Chrome/Edge 偶发抛 `ProtocolError: Promise was collected`——被求值的 promise
 * 在中途被回收（基础设施抖动，不是断言失败）。这属于**同一类 flake**：
 * `scripts/lib/launch-chrome.mjs` 里的启动重试就是为它加的。
 * 重试不改变任何断言的含义（求值本身是幂等的），所以这里也重试，而不是把一次抖动
 * 记成"这一层坏了"。重试仍失败才抛出去，由调用方记成一条失败断言。
 */
async function safeEval(page, fn, ...args) {
  const RETRYABLE = /Promise was collected|Execution context was destroyed|Cannot find context/i;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await page.evaluate(fn, ...args);
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (attempt < 3 && RETRYABLE.test(msg)) {
        console.error(`  [flake] page.evaluate 第 ${attempt} 次被打断（${msg.split("\n")[0]}），重试…`);
        await sleep(500 * attempt);
        continue;
      }
      throw e;
    }
  }
}

/**
 * 每一层：怎么打开、根元素、盒子元素。
 * `optional` 的那些需要一个已经打开的页面 / 更深一层的入口，取不到触发器时
 * 记一条 note 并跳过（不算通过、也不算失败）——它们是**未验证项**，会写在报告里。
 */
const OVERLAYS = [
  { id: "settings", label: "设置面板", root: ".set-overlay", box: ".set-dialog", sheet: false },
  { id: "confirm", label: "确认框", root: ".confirm-overlay", box: ".confirm-box", sheet: true },
  { id: "input", label: "输入框", root: ".confirm-overlay", box: ".confirm-box", sheet: true },
  { id: "search", label: "搜索浮层", root: ".search-popover", box: ".search-popover", sheet: true, sheetClass: true },
  { id: "trash", label: "回收站", root: ".trash-popover", box: ".trash-popover", sheet: true, sheetClass: true },
  { id: "sync", label: "同步面板", root: ".sync-popover", box: ".sync-popover", sheet: true, sheetClass: true },
  { id: "pluginManager", label: "插件管理", root: ".plugin-manager-overlay", box: ".plugin-manager", sheet: false },
  { id: "storage", label: "存储 / 空间管理", root: ".stg-overlay", box: ".stg-panel", sheet: false, optional: true },
  { id: "palette", label: "命令面板", root: ".palette-overlay", box: ".palette", sheet: false },
  { id: "shortcuts", label: "快捷键", root: ".shortcuts-overlay", box: ".shortcuts", sheet: true },
  { id: "about", label: "关于", root: ".shortcuts-overlay", box: ".about", sheet: true },
  { id: "communitySave", label: "社区保存", root: ".community-save-overlay", box: ".community-save-box", sheet: true },
  { id: "formula", label: "公式编辑器", root: ".formula-editor-overlay", box: ".formula-editor", sheet: false },
  { id: "emoji", label: "图标选择器", root: ".emoji-picker-overlay", box: ".emoji-picker", sheet: true },
  { id: "toc", label: "目录", root: ".toc-panel", box: ".toc-panel", sheet: false },
  { id: "ai", label: "AI 助手", root: ".ai-panel", box: ".ai-panel", sheet: false },
  { id: "comments", label: "评论 / 通知", root: ".comments-drawer", box: ".comments-drawer", sheet: false },
  { id: "markdownImport", label: "Markdown 导入", root: ".markdown-import-overlay", box: ".markdown-import", sheet: true, optional: true },
  { id: "cover", label: "题头图", root: ".cover-overlay", box: ".cover-picker", sheet: true, optional: true },
];

/** 主要操作按钮的文案（验收口径写在任务里，别改）。 */
const ACTION_TEXT = ["确定", "取消", "保存", "关闭", "完成", "创建", "应用"];

// ---------------------------------------------------------------------------
// 在页面里跑的探针。`page.evaluate` 会把函数序列化过去，所以这里不能引用外部变量。
// ---------------------------------------------------------------------------

/** 打开一层。走应用**自己的 store**（与界面同一条路），而不是往 DOM 里塞假节点。 */
async function openOverlay(which) {
  const store = (p) => import(/* @vite-ignore */ p);
  const click = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    el.click();
    return true;
  };
  try {
    switch (which) {
      case "settings": {
        const m = await store("/src/store/editor.ts");
        m.useEditorStore.getState().openSettings("appearance");
        return true;
      }
      case "confirm": {
        const m = await store("/src/store/confirm.ts");
        void m.confirmDialog({
          title: "删除页面",
          message: "确定要删除这一页吗？删除后可以在回收站里恢复。",
        });
        return true;
      }
      case "input": {
        const m = await store("/src/store/input.ts");
        m.inputDialog({ title: "重命名", defaultValue: "示例标题" });
        return true;
      }
      case "search":
        return click(".search-panel .activity-btn");
      case "trash":
        return click(".btn-trash");
      case "sync": {
        // 同步面板挂在**侧栏**里（PageTree 底部的 SyncPanel），而窄屏侧栏是抽屉、
        // 默认是 `hidden` ⇒ 得先把抽屉打开，它的浮层才量得到真实几何。
        const a = await store("/src/store/activity.ts");
        a.useActivity.getState().setSidebarOpen(true, { persist: false });
        await new Promise((r) => setTimeout(r, 500));
        return click(".btn-sync");
      }
      case "pluginManager": {
        const m = await store("/src/store/plugins.ts");
        m.usePlugins.getState().setManagerOpen(true);
        return true;
      }
      case "storage": {
        // 存储面板在「设置 → 数据」里，是个普通按钮。
        const m = await store("/src/store/editor.ts");
        m.useEditorStore.getState().openSettings("data");
        await new Promise((r) => setTimeout(r, 400));
        const btns = [...document.querySelectorAll(".set-dialog .set-btn")];
        const t = btns.find((b) => (b.textContent || "").includes("打开"));
        if (!t) return false;
        t.click();
        return true;
      }
      case "palette": {
        const m = await store("/src/store/palette.ts");
        m.usePalette.getState().setOpen(true);
        return true;
      }
      case "shortcuts": {
        const m = await store("/src/store/editor.ts");
        m.useEditorStore.getState().openShortcuts();
        return true;
      }
      case "about": {
        const m = await store("/src/store/editor.ts");
        m.useEditorStore.getState().openAbout();
        return true;
      }
      case "communitySave": {
        const m = await store("/src/store/communitySave.ts");
        m.useCommunitySave.getState().openDialog();
        return true;
      }
      case "formula": {
        const m = await store("/src/store/formulaEditor.ts");
        m.useFormulaEditorStore.getState().openEditor({ initial: "E = mc^2", onCommit: () => {} });
        return true;
      }
      case "emoji": {
        const m = await store("/src/store/iconPicker.ts");
        m.useIconPicker.getState().openIconPicker(() => {});
        return true;
      }
      case "toc": {
        const m = await store("/src/store/rightPanel.ts");
        m.useRightPanel.getState().openToc(true);
        return true;
      }
      case "ai": {
        const m = await store("/src/store/rightPanel.ts");
        m.useRightPanel.getState().openAi(true);
        return true;
      }
      case "comments": {
        const m = await store("/src/store/rightPanel.ts");
        m.useRightPanel.getState().openComments(true);
        return true;
      }
      case "markdownImport": {
        // 需要先有打开的页面（工具栏才在）。
        const n = await store("/src/store/notes.ts");
        if (!n.useNotes.getState().currentId) await n.useNotes.getState().createPage(null);
        await new Promise((r) => setTimeout(r, 1200));
        const btns = [...document.querySelectorAll(".toolbar-btn")];
        const t = btns.find((b) => /Markdown/i.test(b.getAttribute("title") || ""));
        if (!t) return false;
        t.click();
        return true;
      }
      case "cover": {
        const n = await store("/src/store/notes.ts");
        if (!n.useNotes.getState().currentId) await n.useNotes.getState().createPage(null);
        await new Promise((r) => setTimeout(r, 1200));
        const btns = [...document.querySelectorAll(".page-action-btn")];
        const t = btns.find((b) => /封面|题头图/.test(`${b.getAttribute("title") || ""}${b.getAttribute("aria-label") || ""}${b.textContent || ""}`));
        if (!t) return false;
        t.click();
        return true;
      }
      default:
        return false;
    }
  } catch (e) {
    return `error: ${String(e).slice(0, 160)}`;
  }
}

/** 关掉所有已知的浮层，让下一层的测量从干净状态开始。 */
async function closeAllOverlays() {
  const store = (p) => import(/* @vite-ignore */ p);
  const ed = await store("/src/store/editor.ts");
  const s = ed.useEditorStore.getState();
  s.closeSettings?.();
  s.closeShortcuts?.();
  s.closeAbout?.();
  (await store("/src/store/confirm.ts")).useConfirmStore.getState().close(false);
  (await store("/src/store/input.ts")).useInputStore.getState().close();
  (await store("/src/store/palette.ts")).usePalette.getState().setOpen(false);
  (await store("/src/store/communitySave.ts")).useCommunitySave.getState().close();
  (await store("/src/store/formulaEditor.ts")).useFormulaEditorStore.getState().close();
  (await store("/src/store/iconPicker.ts")).useIconPicker.getState().close();
  (await store("/src/store/plugins.ts")).usePlugins.getState().setManagerOpen(false);
  const rp = (await store("/src/store/rightPanel.ts")).useRightPanel.getState();
  rp.openToc(false);
  rp.openAi(false);
  rp.openComments(false);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  return true;
}

/**
 * 量一层：几何、越界、被裁却滚不动的容器、操作按钮、命中区、滚动锁。
 * 全部返回数字/布尔，判定留在 Node 侧（好读、好改）。
 */
function probeLayer(rootSel, boxSel) {
  const root = document.querySelector(rootSel);
  const box = document.querySelector(boxSel);
  const innerW = window.innerWidth;
  const innerH = window.innerHeight;
  // 元素在 DOM 里但**没有几何**（自身或某个祖先 `display:none`）= 这一层其实没渲染出来。
  // 只判 `!root` 是不够的：那样会拿一个 0x0 的盒子去断言"四边都在视口内"而假绿。
  const rendered = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  if (!rendered(root) || !rendered(box)) return { found: false, innerW, innerH };

  const isVisible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  const rr = root.getBoundingClientRect();
  const br = box.getBoundingClientRect();
  const r1 = (n) => Math.round(n * 10) / 10;

  // 「被裁掉却滚不动」：自身 overflow 不是 visible（= 它自己在裁内容），
  // 内容又比它高，但它的 overflow-y 不是 auto/scroll ⇒ 那一段**永远够不到**。
  // `.sync-popover` 的「保存」跑到屏外 121px 就是这个形状。
  const clipped = [];
  root.querySelectorAll("*").forEach((el) => {
    const cs = getComputedStyle(el);
    if (cs.overflowY === "visible") return;
    const dy = el.scrollHeight - el.clientHeight;
    if (dy > 4 && cs.overflowY !== "auto" && cs.overflowY !== "scroll") {
      clipped.push({
        cls: String(el.className || el.tagName).slice(0, 48),
        dy,
        overflowY: cs.overflowY,
      });
    }
  });

  const buttons = [...root.querySelectorAll("button")].filter(isVisible).map((b) => {
    const cs = getComputedStyle(b);
    const r = b.getBoundingClientRect();
    const cls = String(b.className || "");
    const inView = r.left >= -0.5 && r.right <= innerW + 0.5 && r.top >= -0.5 && r.bottom <= innerH + 0.5;
    // 不在视口里的按钮，只要它在浮层内部有一个**真的能滚**的祖先，用户就够得到。
    // 反过来，"被 overflow:hidden 裁掉又没有可滚祖先"（`.sync-popover` 的「保存」
    // 当初就是这样跑到屏外 121px 的）在这里仍然是不可达 ⇒ 断言照样红。
    let scrollable = false;
    for (let n = b.parentElement; n && n !== root.parentElement; n = n.parentElement) {
      const acs = getComputedStyle(n);
      if ((acs.overflowY === "auto" || acs.overflowY === "scroll") && n.scrollHeight > n.clientHeight + 4) {
        scrollable = true;
        break;
      }
    }
    return {
      text: (b.textContent || "").trim().slice(0, 12),
      cls: cls.slice(0, 40),
      title: (b.getAttribute("title") || "").slice(0, 20),
      aria: (b.getAttribute("aria-label") || "").slice(0, 20),
      isClose: /close/.test(cls) || /^关闭/.test(b.getAttribute("aria-label") || "") || /^关闭/.test(b.getAttribute("title") || ""),
      w: r1(r.width),
      h: r1(r.height),
      inView,
      reachable: inView || scrollable,
    };
  });

  const noteScroll = document.querySelector(".note-scroll");
  return {
    found: true,
    innerW,
    innerH,
    root: { left: r1(rr.left), right: r1(rr.right), top: r1(rr.top), bottom: r1(rr.bottom) },
    box: { left: r1(br.left), right: r1(br.right), top: r1(br.top), bottom: r1(br.bottom) },
    boxMinWidth: getComputedStyle(box).minWidth,
    boxPosition: getComputedStyle(box).position,
    rootClass: String(root.className || ""),
    docScrollWidth: document.documentElement.scrollWidth,
    clipped: clipped.slice(0, 6),
    buttons,
    noteScrollOverflowY: noteScroll ? getComputedStyle(noteScroll).overflowY : null,
    noteScrollTop: noteScroll ? noteScroll.scrollTop : null,
    hasNoteScroll: !!noteScroll,
  };
}

/** 触摸拖动：从 (x, y) 往上拖 `dy` 像素。返回拖动前后的 `scrollTop`。 */
function scrollTopNow() {
  const el = document.querySelector(".note-scroll");
  return el ? el.scrollTop : null;
}

// ---------------------------------------------------------------------------

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
  const browser = await launchChrome({ executablePath });
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  const shot = async (page, name) => {
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  };

  try {
    for (const vp of PHONES) {
      const ctx = await browser.createBrowserContext();
      const page = await ctx.newPage();
      const pageErrors = [];
      page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 200)));
      await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      await page.goto(APP_URL, { waitUntil: "networkidle2", timeout: 60000 });
      await sleep(3000);
      const cdp = await page.createCDPSession();

      console.log(`\n【${vp.name} · 前提】`);
      // ---- 断点一致性：JS 与 CSS 必须是同一个数（767 不该算手机、769 该算） ----
      const mq = await safeEval(page, () => ({
        cssMatches: matchMedia("(max-width: 768px)").matches,
        jsInnerWidth: window.innerWidth,
        minWidth760: matchMedia("(max-width: 760px)").matches,
        minWidth769: matchMedia("(max-width: 769px)").matches,
      }));
      ok(mq.cssMatches, `命中窄屏媒体查询（innerWidth=${mq.jsInnerWidth} ≤ 768）`);
      ok(mq.minWidth769, "断点确实是 768（`max-width:769px` 也命中）——不是残留的 760");

      // ---- 根因 2 的现场：竖条收起时**不许**再建立包含块 ----
      const rail = await safeEval(page, () => {
        const el = document.querySelector(".activity-bar");
        if (!el) return null;
        const cs = getComputedStyle(el);
        return { transform: cs.transform, left: cs.left, isOpen: el.classList.contains("is-open") };
      });
      ok(rail !== null, "量到了左侧竖条");
      ok(
        rail && rail.transform === "none",
        `收起状态竖条不带 transform（transform=${rail && rail.transform}）——带 transform 会成为浮层包含块，` +
          `把算好的 left:8 顶到 -40px`,
      );
      ok(rail && parseFloat(rail.left) <= 0, `竖条收起时在屏外（left=${rail && rail.left}）`);

      // ---- 浮层打开时内容区的滚动锁 ----
      for (const layer of OVERLAYS) {
        // 单层出错（含 CI 里 Chrome 偶发的 CDP 抖动）只算这一层失败，
        // 不能把整轮跑挂掉——挂掉就没有汇总，等于白跑一次。
        try {
          const opened = await safeEval(page, openOverlay, layer.id);
          await sleep(layer.id === "settings" || layer.id === "pluginManager" ? 900 : 500);
          const m = await safeEval(page, probeLayer, layer.root, layer.box);
          if (!m.found) {
            if (layer.optional) {
              note(`${vp.name} · ${layer.label}：未取到触发器（opened=${JSON.stringify(opened)}），本轮**未验证**`);
              await safeEval(page, closeAllOverlays);
              await sleep(300);
              continue;
            }
            ok(false, `${vp.name} · ${layer.label}：没能打开（${layer.root} / ${layer.box} 不在 DOM 里，opened=${JSON.stringify(opened)}）`);
            await safeEval(page, closeAllOverlays);
            await sleep(300);
            continue;
          }
          console.log(`\n【${vp.name} · ${layer.label}】`);

          // (1) 每层四边都在视口内 —— 钉住 -40 与 640px 撑出屏外
          ok(
            m.root.left >= -0.5 && m.root.right <= m.innerW + 0.5 && m.root.top >= -0.5 && m.root.bottom <= m.innerH + 0.5,
            `根元素在视口内（x ${m.root.left}..${m.root.right} / y ${m.root.top}..${m.root.bottom}，视口 ${m.innerW}x${m.innerH}）`,
          );
          ok(
            m.box.left >= -0.5 && m.box.right <= m.innerW + 0.5 && m.box.top >= -0.5 && m.box.bottom <= m.innerH + 0.5,
            `盒子在视口内（x ${m.box.left}..${m.box.right} / y ${m.box.top}..${m.box.bottom}）`,
          );
          // 总根因：min-width 不许压过 max-width
          ok(
            m.boxMinWidth === "0px" || m.boxMinWidth === "auto",
            `盒子 min-width 已清零（min-width=${m.boxMinWidth}）——min-width 会压过 max-width`,
          );

          // (2) 文档不许横向溢出
          ok(
            m.docScrollWidth <= m.innerW,
            `documentElement.scrollWidth ≤ innerWidth（${m.docScrollWidth} ≤ ${m.innerW}）`,
          );

          // (2b) usePopover 驱动的浮层：窄屏必须走 `is-sheet`（不锚定触发按钮）。
          //      这一条钉的是 **JS 分支**（CSS 那条由下面的几何断言管）。
          if (layer.sheetClass) {
            ok(
              m.rootClass.includes("is-sheet"),
              `走 is-sheet 分支、不再锚定触发按钮（class="${m.rootClass}"）`,
            );
          }

          // (3) 超高内容必须落在**可滚**容器里
          ok(
            m.clipped.length === 0,
            m.clipped.length === 0
              ? "被裁的内容都在可滚容器里"
              : `有内容被裁却滚不动：${m.clipped.map((c) => `${c.cls}(+${c.dy}px, overflow-y:${c.overflowY})`).join(" | ")}`,
          );

          // (4) 主要操作按钮必须够得到：四边在视口内，**或者**它落在浮层内部一个
          //     真的能滚的容器里（长表单本来就要滚）。"被裁掉又滚不动"仍然算失败。
          const actions = m.buttons.filter((b) => ACTION_TEXT.includes(b.text));
          ok(
            actions.every((b) => b.reachable),
            actions.length
              ? `主要操作按钮都够得到（${actions
                  .map((b) => `${b.text}@${b.inView ? "视口内" : b.reachable ? "屏外但可滚到" : "✗够不到"}`)
                  .join(" ")}）`
              : "本层没有主要操作按钮（跳过）",
          );

          // (5) 打开任一层 ⇒ 内容区 `overflow-y:hidden`，且触摸拖动拖不走背景
          ok(
            m.hasNoteScroll && m.noteScrollOverflowY === "hidden",
            `内容区被锁（.note-scroll overflow-y=${m.noteScrollOverflowY}）——锁 body 无效，真正的滚动容器是它`,
          );
          if (m.hasNoteScroll) {
            // 拖动点选在"根元素之内、盒子之外"的那道缝里（没有缝就落在盒子顶部的
            // 头部区域）：那里既不是滚动容器，事件又要穿过浮层——正是把背景拖走的路径。
            const gapX = m.box.left > 6 ? Math.max(3, m.box.left - 6) : m.root.left + 3;
            const gapY = m.box.top > 14 ? Math.max(8, m.box.top - 8) : m.root.top + 8;
            await safeEval(page, () => {
              const el = document.querySelector(".note-scroll");
              if (el) el.scrollTop = 120;
            });
            const before = await safeEval(page, scrollTopNow);
            await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: gapX, y: gapY }] });
            for (let i = 1; i <= 12; i++) {
              await cdp.send("Input.dispatchTouchEvent", {
                type: "touchMove",
                touchPoints: [{ x: gapX, y: gapY - (300 * i) / 12 }],
              });
            }
            await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
            await sleep(250);
            const after = await safeEval(page, scrollTopNow);
            ok(
              before !== null && after !== null && Math.abs(after - before) <= 4,
              `触摸向上拖 300px 后背景没被拖走（scrollTop ${before} → ${after}，变化 ${Math.abs((after ?? 0) - (before ?? 0))}px ≤ 4）`,
            );
          }

          // (6) 命中区：关闭类按钮严格 ≥44×44；其余可见按钮先记基线
          const closes = m.buttons.filter((b) => b.isClose);
          ok(
            closes.every((b) => b.w >= 44 && b.h >= 44),
            closes.length
              ? `关闭类按钮 ≥44×44（${closes.map((b) => `${b.w}x${b.h}`).join(" ")}）`
              : "本层没有关闭类按钮（跳过）",
          );
          const small = m.buttons.filter((b) => b.w < 44 && b.h < 44);
          note(`${vp.name} · ${layer.label}：可见按钮 ${m.buttons.length} 个，其中 ${small.length} 个窄于/矮于 44px（基线）`);

          // (6b) 设置面板专有：分类栏在窄屏必须变成**顶部横向条**。
          //      它原来是 224px 的竖排栏，在 360px 视口上会把正文挤到只剩 136px
          //      （"看得见设置、改不了设置"）。这条断言直接量正文区宽度。
          if (layer.id === "settings") {
            const body = await safeEval(page, () => {
              const el = document.querySelector(".set-body");
              const rail = document.querySelector(".set-rail");
              const dlg = document.querySelector(".set-dialog");
              if (!el || !rail || !dlg) return null;
              return {
                bodyW: Math.round(el.getBoundingClientRect().width),
                railH: Math.round(rail.getBoundingClientRect().height),
                railW: Math.round(rail.getBoundingClientRect().width),
                flexDir: getComputedStyle(dlg).flexDirection,
                innerW: window.innerWidth,
              };
            });
            ok(
              body !== null && body.bodyW >= body.innerW * 0.7,
              body
                ? `设置正文区没被分类栏挤掉（正文宽 ${body.bodyW} ≥ ${Math.round(body.innerW * 0.7)}；` +
                  `分类栏 ${body.railW}x${body.railH}、弹层 ${body.flexDir}）`
                : "量不到设置正文区",
            );
          }

          // (7) 浮层打开时内容区不许横向溢出（`.palette-list` 横向溢出 46~73px 那类）
          await shot(page, `${vp.width}-${layer.id}`);

          await safeEval(page, closeAllOverlays);
          await sleep(350);
        } catch (e) {
          ok(false, `${vp.name} · ${layer.label}：本层验收过程中出错（${String((e && e.message) || e).split("\n")[0].slice(0, 120)}）`);
          try { await safeEval(page, closeAllOverlays); } catch { /* 忽略 */ }
          await sleep(300);
        }
      }

      // ---- `.plugin-panel` 的窄屏规则是否真的生效 ----
      // 它只在"插件声明了 rail 视图"时才进 DOM，全新实例里没有，所以这里塞一个
      // **只有类名**的探针节点进去量计算宽度——钉的正是"窄屏规则被后置基础规则压掉"。
      const panel = await safeEval(page, () => {
        const el = document.createElement("div");
        el.className = "plugin-panel";
        el.id = "__probe_plugin_panel";
        document.body.appendChild(el);
        const cs = getComputedStyle(el);
        const w = el.getBoundingClientRect().width;
        const out = { width: w, innerW: window.innerWidth, minWidth: cs.minWidth, maxWidth: cs.maxWidth };
        el.remove();
        return out;
      });
      console.log(`\n【${vp.name} · 插件面板（rail）宽度】`);
      ok(
        panel.width >= panel.innerW - 1,
        `.plugin-panel 在 768px 下占满宽（${Math.round(panel.width)} ≥ ${panel.innerW}-1）——` +
          `钉的是"窄屏 width:100% 被文件后面那条基础规则压掉"（那时只有 100vw-64px = ${panel.innerW - 64}px）`,
      );

      // ---- 视口变宽时，窄屏规则必须让位（不许把桌面也变成弹层） ----
      ok(pageErrors.length === 0, `页面无 JS 报错${pageErrors.length ? "：" + pageErrors.join(" | ") : ""}`);
      await ctx.close();
    }

    // ---------- 桌面视口：浮层仍是"锚定浮层"，没被窄屏规则一起改掉 ----------
    const deskCtx = await browser.createBrowserContext();
    const desk = await deskCtx.newPage();
    await desk.setViewport({ width: DESKTOP.width, height: DESKTOP.height });
    await desk.goto(APP_URL, { waitUntil: "networkidle2", timeout: 60000 });
    await sleep(2500);
    console.log(`\n【桌面 ${DESKTOP.name} · 锚定浮层没被窄屏规则改掉】`);

    await safeEval(desk, openOverlay, "search");
    await sleep(700);
    const dSearch = await safeEval(desk, probeLayer, ".search-popover", ".search-popover");
    ok(dSearch.found, "桌面也打开了搜索浮层");
    if (dSearch.found) {
      // 桌面锚定：左侧留白 ≥8 且**贴不到底**（贴底就说明被当成底部弹层了）
      ok(
        dSearch.box.left >= 8,
        `桌面搜索浮层仍锚定在触发按钮旁（left=${dSearch.box.left} ≥ 8，不是贴底的弹层）`,
      );
      ok(
        dSearch.box.bottom < dSearch.innerH - 40,
        `桌面搜索浮层不贴底（bottom=${dSearch.box.bottom} < ${dSearch.innerH - 40}）`,
      );
      ok(
        dSearch.boxPosition === "fixed",
        `桌面浮层仍是 position:fixed（${dSearch.boxPosition}）`,
      );
    }
    await safeEval(desk, closeAllOverlays);
    await sleep(300);

    await safeEval(desk, openOverlay, "settings");
    await sleep(900);
    const dSet = await safeEval(desk, probeLayer, ".set-overlay", ".set-dialog");
    if (dSet.found) {
      ok(
        dSet.box.right <= dSet.innerW && dSet.box.left >= 0,
        `桌面设置面板仍在视口内（x ${dSet.box.left}..${dSet.box.right}）`,
      );
      ok(
        dSet.box.bottom < dSet.innerH - 40,
        `桌面设置面板不是整屏（bottom=${dSet.box.bottom} < ${dSet.innerH - 40}）`,
      );
      ok(dSet.boxMinWidth === "640px", `桌面仍保留 min-width:640px（${dSet.boxMinWidth}）——窄屏清零只作用于 <=768px`);
    } else {
      ok(false, "桌面没能打开设置面板");
    }
    await safeEval(desk, closeAllOverlays);
    await deskCtx.close();
  } finally {
    await browser.close();
  }

  if (notes.length) {
    console.log(`\n[基线记录] ${notes.length} 条：`);
    for (const n of notes) console.log(`  · ${n}`);
  }
  console.log(`\n[结果] ${pass} 通过 / ${fail} 失败`);
  if (fail) {
    console.error("存在失败项：移动端浮层验收未通过。");
    process.exit(1);
  }
  console.log("移动端浮层验收全部通过 ✅");
  if (SHOTS) console.log(`截图已保存到 ${SHOTS}`);
}

main().catch((e) => {
  console.error("验收脚本异常:", e);
  // 即使中途异常也要给出汇总：否则"跑挂了"和"跑红了"从输出上看不出区别，
  // 而一次 CDP 抖动（`Promise was collected`）不该让整轮结果无法解读。
  console.log(`\n[结果] ${pass} 通过 / ${fail} 失败（脚本异常中止，计数只覆盖已跑完的部分）`);
  process.exit(1);
});
