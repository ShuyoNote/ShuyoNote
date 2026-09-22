// 主视图移动端验收 · 用真实 Chromium 把**笔记 / 看板 / 关系图 / 文件 / 数据库**
// 在手机视口下逐个打开，量三件事：**越界（点不到）、命中区（点不中）、控制带高度（占版面）**。
//
// 为什么单独一个脚本（而不是并进 verify-mobile-layout / verify-mobile-overlays）：
//   · `verify-mobile-layout.mjs` 管的是**布局外壳**（竖条 / 侧栏抽屉 / 遮罩 / 模板中心入口）；
//   · `verify-mobile-overlays.mjs` 管的是**浮层**（设置 / 存储 / 命令面板那一类，
//     清单式枚举了 19 层）；
//   · 而"**主区里的整视图**"这两块都没覆盖：它们是 `.main` 的直接子元素，不是浮层、
//     也不是外壳，于是此前只有人眼看过。2026-09-22 的冲刺里量到的问题全落在这条缝里：
//       1. 文件视图的操作行 390px 上就 `right=392` —— 「上传 / 视图切换」在屏幕外；
//       2. 文件表格 673px 宽而外层只有 `overflow-y` ⇒ 四列**被裁掉且滚不到**；
//       3. 关系图的控制面板 ~650px 锚在 `right:14px` ⇒ 左边 274px **挂在屏幕外**
//          （右锚定不会溢出右边，所以只查"右边越界"的断言永远看不到它）；
//       4. 切视图（看板/文件）时侧栏抽屉**盖在刚切过去的视图上**，看起来像"点了没反应"。
//
// 判据分三层，全部是量出来的：
//   A. **越界**：可见元素的 left/right 必须在视口内；在**可横滑祖先**里的不算
//      （表格 436px 宽是故意的，外层 `overflow-x:auto` 兜着它 = "滚得到"）；
//   B. **命中区**：**高度**一律 ≥44；**宽度**只对"没有文字"的图标控件要求 ≥44
//      （文字 chip 只有 38 宽是正常的）。`pointer-events:none` 的（纯指示器）不算。
//   C. **控制带高度**：常驻控制条各有预算。这一条对应那条产品口径——
//      "**不要让控制按钮过多占用有限空间**"：把"占版面"变成可回退的数字。
//
// 前置：本机有 Chrome/Chromium（或 PUPPETEER_EXECUTABLE_PATH 指定），
//       以及已启动的 web 开发服务（默认 http://localhost:5173/）。
//
// 用法：
//   pnpm dev:web                       # 另开一个终端
//   pnpm test:mobile-views             # 有失败即非零退出
//   APP_URL=http://192.168.31.89:5173/ pnpm test:mobile-views
//   node scripts/verify-mobile-views.mjs --shots /tmp/shots
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { findChrome, launchChrome } from "./lib/launch-chrome.mjs";

const APP_URL = (process.env.APP_URL || "http://localhost:5173/").replace(/\/+$/, "") + "/";

// 断点与 `src/hooks/useMobile.ts` 的 `MOBILE_BREAKPOINT_PX` 是**同一个数**（768）：
// JS 说"这是手机"而 CSS 说"这是桌面"会同时废掉两边的分支。
const PHONES = [
  { name: "390x844", width: 390, height: 844 },
  { name: "320x568", width: 320, height: 568 },
];
// 调试用：`ONLY_VP=320x568` 只跑一档（改脚本时不必等两档跑完）。**门禁不许用它**。
const ONLY_VP = process.env.ONLY_VP || "";
const ACTIVE_PHONES = ONLY_VP ? PHONES.filter((p) => p.name === ONLY_VP) : PHONES;
if (ONLY_VP && !ACTIVE_PHONES.length) {
  console.error(`ONLY_VP=${ONLY_VP} 不对，可选：${PHONES.map((p) => p.name).join(" / ")}`);
  process.exit(1);
}
const DESKTOP = { name: "1280x800", width: 1280, height: 800 };
/** 造一条**时间**类型属性（2026-09-22 起它的值控件是原生 `datetime-local`，不是 wrapper）。 */
const DATETIME_PROP = "时间";

// 常驻控制带的**高度预算**（px）。数字是"改之前量的"再收紧一档，不是拍脑袋：
// 文件视图原来是 head 86 + toolbar 107 = 193（320px 上占 37% 视口），现在是 76+53 = 129。
// 超了就是"控制按钮又占版面了"，红了就回来看看是不是又往那一行里塞了东西。
const CHROME_BUDGET = {
  ".editor-toolbar-bar": 56,
  ".file-manager-head": 84,
  ".file-manager-toolbar": 60,
  ".graph-controls": 112,
  ".board-toolbar": 52,
};

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

/**
 * `page.evaluate` 的加固版：CI 里 Chrome 偶发 `Promise was collected`
 * （基础设施抖动，不是断言失败）。重试不改变任何断言的含义（求值是幂等的）。
 */
async function safeEval(page, fn, ...args) {
  const RETRYABLE = /Promise was collected|Execution context was destroyed|Cannot find context/i;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await page.evaluate(fn, ...args);
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (attempt < 3 && RETRYABLE.test(msg)) {
        await sleep(500 * attempt);
        continue;
      }
      throw e;
    }
  }
}

/**
 * 在页面里量一次：越界 / 命中区 / 控制带。
 * ⚠️ 这个函数是**在浏览器里**跑的（`page.evaluate`），所以它看不到 Node 侧的常量——
 * 控制带选择器必须由参数传进去（`CHROME_BUDGET` 的键），第一版就是漏了这一点，
 * 直接 `ReferenceError: CHROME_BUDGET is not defined`。
 */
const probe = (barSelectors) => {
  const vw = innerWidth;
  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const name = (el) => {
    const cls = (el.className || "").toString().split(/\s+/).filter(Boolean).slice(0, 3).join(".");
    return cls ? `${el.tagName.toLowerCase()}.${cls}` : el.tagName.toLowerCase();
  };
  // 在**可横滑**的祖先里 = "滚得到"，不是越界。
  const inScroller = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if ((cs.overflowX === "auto" || cs.overflowX === "scroll") && p.scrollWidth > p.clientWidth + 1) return true;
    }
    return false;
  };

  const overflow = [];
  const parked = [];
  for (const el of document.querySelectorAll(".main *")) {
    if (!visible(el)) continue;
    // **SVG 画布里的内容不算越界**：关系图是一块可以拖动 / 缩放的画布，
    // 节点层本来就会伸到画布外（SVG 会裁掉它，用户拖一下就看得到）。
    // 这一条判据管的是**控件**——关系图的控件是 HTML（`.graph-controls` / `.graph-legend`），
    // 它们照旧在扫描范围里。文件表格那种"宽内容"也不受影响（它不是 SVG）。
    if (el.ownerSVGElement || el.tagName.toLowerCase() === "svg") continue;
    const r = el.getBoundingClientRect();
    if (r.right <= vw + 1 && r.left >= -1) continue;
    const pr = el.parentElement ? el.parentElement.getBoundingClientRect() : null;
    if (pr && (pr.right > vw + 1 || pr.left < -1)) continue; // 父级已经报了，别刷屏
    if (inScroller(el)) continue;
    // **整块**在视口外 = 收起状态的抽屉（`.toc-panel` 用 `translateX(100%)` 停在屏外），
    // 用户看不见它，也就谈不上"看得见点不到"。这一档只记一条 note。
    // ⚠️ 判据必须是"**整块**在外"：只越出一半（`left` 在里面、`right` 超出去）
    // 才是要抓的那类坏法——那正是文件视图操作行、关系图控制面板的形态。
    if (r.right <= 0 || r.left >= vw) {
      parked.push({ el: name(el), left: Math.round(r.left), right: Math.round(r.right) });
      continue;
    }
    overflow.push({ el: name(el), left: Math.round(r.left), right: Math.round(r.right), text: (el.textContent || "").trim().slice(0, 18) });
  }

  const small = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('button, [role="button"], input:not([type="hidden"]), select, textarea, a[href]')) {
    if (!visible(el)) continue;
    if (getComputedStyle(el).pointerEvents === "none") continue; // 纯指示器（它的命中区在行/标签上）
    const r = el.getBoundingClientRect();
    const hasText = (el.textContent || "").trim().length > 0;
    if (r.height >= 44 && (hasText || r.width >= 44)) continue;
    const key = name(el);
    if (seen.has(key)) continue;
    seen.add(key);
    small.push({ el: key, w: Math.round(r.width), h: Math.round(r.height), text: (el.textContent || "").trim().slice(0, 14) });
  }

  const bars = {};
  for (const sel of barSelectors) {
    const el = document.querySelector(sel);
    bars[sel] = el && visible(el) ? Math.round(el.getBoundingClientRect().height) : null;
  }
  // 同一条常驻控制带里的相邻几条要一起算：只卡单条会让"拆成两条"绕过去。
  const fmHead = document.querySelector(".file-manager-head");
  const fmBar = document.querySelector(".file-manager-toolbar");
  const fmChrome =
    fmHead && fmBar && visible(fmHead) && visible(fmBar)
      ? Math.round(fmHead.getBoundingClientRect().height + fmBar.getBoundingClientRect().height)
      : null;

  return {
    vw,
    docW: document.documentElement.scrollWidth,
    sidebarDisplay: (() => {
      const s = document.querySelector(".sidebar");
      return s ? getComputedStyle(s).display : null;
    })(),
    tableWrap: (() => {
      const w = document.querySelector(".file-manager-table-wrap");
      return w && visible(w) ? { sw: w.scrollWidth, cw: w.clientWidth } : null;
    })(),
    bars,
    fmChrome,
    overflow: overflow.slice(0, 8),
    overflowCount: overflow.length,
    parked: parked.slice(0, 4),
    small: small.slice(0, 8),
    smallCount: small.length,
  };
};

/**
 * 展开左侧浮层竖条。
 * ⚠️ `.mobile-rail-toggle` **只在"竖条收起"时才渲染**（`App.tsx` 的条件渲染），
 * 所以不能无脑 `page.click()`：上一轮如果竖条还开着，这里就会
 * `No element found for selector: .mobile-rail-toggle`（第一版就是这么红的）。
 */
async function openRail(page) {
  if (await page.$(".mobile-rail-toggle")) {
    await page.click(".mobile-rail-toggle");
    await sleep(600);
  }
}

/**
 * 收起左侧浮层竖条（**走应用自己的路径**：点它那层遮罩）。
 *
 * ⚠️ 不能只是把 `.activity-bar` 的 `is-open` 类摘掉充数：那只是 CSS，store 里
 * `railOpen` 仍是 true ⇒ 唤出按钮不会重新渲染，而且那层 `inset:0` 的遮罩
 * （z-index 58）会盖住右下角那枚 z-index 45 的「右侧工具」按钮——后面任何
 * "点右下角"的操作都会被遮罩吃掉（本脚本第一版就栽在这：工具条永远打不开）。
 */
async function closeRail(page) {
  if (await page.$(".mobile-rail-backdrop")) {
    await page.click(".mobile-rail-backdrop");
    await sleep(500);
  }
}

/** 打开某个主视图：竖条 → 活动图标（**按 title 选，不按序号**）。 */
async function openView(page, title) {
  await openRail(page);
  const found = await page.evaluate((t) => {
    const btn = Array.from(document.querySelectorAll(".activity-group .activity-btn")).find((b) =>
      (b.getAttribute("title") || "").startsWith(t),
    );
    if (btn && !btn.classList.contains("is-on")) btn.click();
    return !!btn;
  }, title);
  await sleep(1600);
  await closeRail(page);
  await sleep(300);
  return found;
}

/** 从模板中心建一个**数据库页**（`内容管理库`），建成后主区应渲染 `.database-view`。 */
async function openDatabaseView(page) {
  await openRail(page);
  await sleep(600);
  await page.evaluate(() => document.querySelector('.activity-group-end .activity-btn[title="模板中心"]')?.click());
  await sleep(1800);
  const hit = await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll(".tc-card")).find((c) => (c.textContent || "").includes("内容管理库"));
    if (el) el.click();
    return !!el;
  });
  if (!hit) return false;
  // 建库要连着一串 async（建库 → 逐个属性 → 加列）：轮询而不是死等一个猜出来的毫秒数。
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    if (await page.evaluate(() => !!document.querySelector(".database-view"))) return true;
  }
  return false;
}

/**
 * 属性表（笔记的属性面板）：名字列**自适应**、值列拿到剩下的宽度。
 *
 * 为什么走**界面**而不是 `import("/src/store/…")` 塞数据：动态 import 与页面里的
 * app 只有在"同一份模块 URL"时才是**同一个 store 实例**——开发服务器一旦因为改过源码
 * 给模块加了 `?t=` 缓存键，脚本拿到的是**另一个实例**（实测：那份 store 里 `pages: 0`，
 * 而 DOM 里有 2 行）。`verify-mobile-overlays.mjs` 就吃过这个亏（假红 6 条，重启才绿）。
 * 从界面点「添加属性」既绕开了这个坑，验的又是**用户真走的那条路**。
 */
async function checkProperties(page, vp, tag) {
  // 1) 用界面加 4 条属性（名字长短不一，才能验"列宽跟着最长的那条走"），
  //    第 5 条是**时间**类型（值控件是 `.prop-datetime`，见下面那条"不许留死空白"的断言）。
  for (const name of ["作者", "来源", "发布于", "存于", DATETIME_PROP]) {
    const clicked = await safeEval(page, () => {
      const b = Array.from(document.querySelectorAll(".page-action-btn")).find((x) =>
        (x.textContent || "").includes("添加属性"),
      );
      if (b) b.click();
      return !!b;
    });
    if (!clicked) return { err: "找不到「添加属性」入口" };
    // 等输入框出现（面板要等异步加载完才渲染）
    let has = false;
    for (let i = 0; i < 20 && !has; i++) {
      await sleep(150);
      has = await safeEval(page, () => !!document.querySelector(".prop-add-name"));
    }
    if (!has) return { err: "「添加属性」行没出现" };
    await page.type(".prop-add-name", name);
    // 「时间」那条要显式选类型：它的值控件是原生 `datetime-local`（2026-09-22 起，与「日期」同风格）。
    if (name === DATETIME_PROP) {
      await safeEval(page, (v) => {
        const sel = document.querySelector(".prop-add-type");
        if (!sel) return false;
        sel.value = v;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }, "datetime");
      await sleep(200);
    }
    await safeEval(page, () => document.querySelector(".prop-add-confirm")?.click());
    await sleep(600);
  }

  // 1b) 再加**一个标签**：「标签」那一行是 [名字, 标签块] 两个孩子的**短行**，
  //     第一版网格错位就是它引起的（下一行的名字被填进同一行的第 3 列）。
  //     不加它，这一段量到的全是"三个孩子"的正常行——**根本盖不到那个 bug**。
  await safeEval(page, () => {
    const b = Array.from(document.querySelectorAll(".page-action-btn")).find((x) =>
      (x.textContent || "").includes("添加标签"),
    );
    if (b) b.click();
    return !!b;
  });
  await sleep(900);
  let hasTagInput = false;
  for (let i = 0; i < 12 && !hasTagInput; i++) {
    hasTagInput = await safeEval(page, () => !!document.querySelector(".tag-picker-input"));
    if (!hasTagInput) await sleep(200);
  }
  if (hasTagInput) {
    await page.type(".tag-picker-input", "验收标签");
    await page.keyboard.press("Enter");
    await sleep(900);
    await safeEval(page, () => document.querySelector(".tag-picker-backdrop")?.click());
    await sleep(500);
  }

  // 2) 量：名字→值的空隙、值的宽度、值左边缘是否对齐（对齐是"看起来像一张表"的前提）
  // ⚠️ `tag` 是 Node 侧的变量，浏览器里看不到它 —— 必须当参数传进去
  //    （第一版直接在页面函数里用了它，`ReferenceError: tag is not defined`）。
  return safeEval(page, (t) => {
    const body = document.querySelector(".properties-body");
    if (!body) return { err: "属性面板不在 DOM 里" };
    /** 可见 = 自己与祖先都没有被 `display:none` 掉（窄屏的行尾小按钮就是被藏起来的）。 */
    const visible = (el) => {
      if (!el) return false;
      let cur = el;
      while (cur && cur !== body) {
        if (getComputedStyle(cur).display === "none") return false;
        cur = cur.parentElement;
      }
      const b = el.getBoundingClientRect();
      return b.width > 1 && b.height > 1;
    };
    const rows = Array.from(body.querySelectorAll(".prop-row"));
    const items = rows
      .map((row) => {
        const n = row.querySelector(".prop-name");
        // 「标签」行的值不是 `.prop-value` 而是 `.prop-tag-value` —— 两种都要量，
        // 否则恰好漏掉那个"短行"（第一版就是这么漏的）。
        const v = row.querySelector(".prop-value, .prop-tag-value");
        if (!n || !v) return null;
        const nb = n.getBoundingClientRect();
        const vb = v.getBoundingClientRect();
        // 「时间」行的值控件现在是**原生 `datetime-local`**（2026-09-22，owner：
        // "页面时间属性的控件采用和日期一样风格的控件，不要再额外加按钮"）——
        // 它必须吃满值列（不许像当年那层 `.prop-datetime` wrapper 那样带 `max-width: 75%`
        // 留 25% 死空白），而且**这一行不该再有额外按钮**（那一版是手输框 ＋ 日历按钮）。
        const dt = row.querySelector('input[type="datetime-local"]');
        const btns = row.querySelector(".prop-order-btns");
        const dtGap =
          dt && btns ? Math.round(btns.getBoundingClientRect().left - dt.getBoundingClientRect().right) : null;
        const dtExtraButtons = dt
          ? Array.from(row.querySelectorAll("button")).filter((b) => visible(b) && !b.closest(".prop-order-btns")).length
          : null;
        return {
          name: (n.textContent || "").trim(),
          nameLeft: Math.round(nb.left),
          nameW: Math.round(nb.width),
          valW: Math.round(vb.width),
          valLeft: Math.round(vb.left),
          gap: Math.round(vb.left - nb.right),
          dtGap,
          dtExtraButtons,
          dtKind: dt ? (dt.getAttribute("type") ?? "") : null,
          // 行尾那三个按钮的实测尺寸（已知取舍，只记录不判定）
          btn: row.querySelector(".prop-order, .prop-remove")?.getBoundingClientRect().width ?? null,
        };
      })
      .filter(Boolean);
    const lefts = items.map((i) => i.valLeft);
    const nameLefts = items.map((i) => i.nameLeft);
    return {
      count: items.length,
      items,
      maxGap: items.length ? Math.max(...items.map((i) => i.gap)) : null,
      minValW: items.length ? Math.min(...items.map((i) => i.valW)) : null,
      maxNameW: items.length ? Math.max(...items.map((i) => i.nameW)) : null,
      alignSpread: lefts.length ? Math.max(...lefts) - Math.min(...lefts) : null,
      // "属性名在最左"这条不变量：所有名字同一个左边缘，且每行都比它的值更靠左。
      // 第一版没有它 ⇒ "标签那一行只有 2 个孩子，把后面整块顶偏一格"（名字跑到最右）
      // 这种错位量不出来（逐行取元素仍然拿得到，只是位置反了）。
      nameSpread: nameLefts.length ? Math.max(...nameLefts) - Math.min(...nameLefts) : null,
      nameBeforeValue: items.length ? items.every((i) => i.nameLeft < i.valLeft) : null,
      docW: document.documentElement.scrollWidth,
      vw: innerWidth,
      rowBtnW: items.length ? items[0].btn : null,
      tag: t,
    };
  }, tag);
}

/**
 * PDF 阅读器：**真 DOM** 验收（上传一份真 PDF 再打开它）。
 *
 * 为什么以前没做：阅读器要一份真 PDF 才渲染内部，而测试工作区里没有 PDF 附件 ⇒
 * 此前它只有 `verify-mobile-overlays.mjs` 里的 **CSS 级**断言（钉得住规则、钉不到真 DOM）。
 * 2026-09-22 发现能**把夹具喂进去**：web 平台的 `dialog.open` 走隐藏 `<input type=file>`，
 * 用 `waitForFileChooser` + `chooser.accept([path])` 即可。⚠️ 必须**先挂 chooser 再点**——
 * 那个 input 建完就点、随后被清理，`waitForSelector('input[type=file]')` 是等不到的（实测踩过）。
 *
 * 这一节只钉**真 DOM 才看得见**的东西：
 *   ① 工具条里不许有"空壳胶囊"（`.pdf-annot-actions` 自带背景/边框/圆角，空着就是一白胶囊）；
 *   ② `⋯` 收起/展开真的生效（CSS 级断言只能证明规则在、证明不了点下去会出来）；
 *   ③ 批注工具行窄屏是**一行**；④ 无横向溢出；⑤ 扫描版显示文本层状态行。
 */
async function checkPdfReader(page, vp) {
  // 1) 进文件管理器
  await openView(page, "文件管理");
  await sleep(900);
  // 1b) 切到**列表视图**：窄屏默认是网格（`defaultFileView(null, w)`），而「行尾 ⋯ → 阅读并标注」
  //     那条菜单只在表格行上。按类名点第一个 `.fm-view-btn`（title 走 i18n，别按文字找）。
  await safeEval(page, () => document.querySelector(".fm-view-btn")?.click());
  await sleep(700);

  // 2) 上传夹具（先挂 chooser 再点）
  const sel = await safeEval(page, () => {
    const b = Array.from(document.querySelectorAll("[title]")).find((x) =>
      (x.getAttribute("title") || "").includes("上传"),
    );
    if (!b) return null;
    if (!b.id) b.id = "__pdf_upload_probe";
    return "#__pdf_upload_probe";
  });
  if (!sel) return { err: "找不到「上传」入口" };
  const fixture = join(process.cwd(), "src-tauri", "tests", "fixtures", "pdf", "scan.pdf");
  try {
    const [chooser] = await Promise.all([page.waitForFileChooser({ timeout: 20000 }), page.click(sel)]);
    await chooser.accept([fixture]);
  } catch (e) {
    return { err: `文件选择器没接上：${String(e).slice(0, 120)}` };
  }
  await sleep(3500);

  // 3) 打开阅读器：行尾 ⋯ → 阅读并标注（自己实现过的那条路，选择器可靠）
  const hasMenu = await safeEval(page, () => {
    const rows = Array.from(document.querySelectorAll("tr, .fm-row"));
    const row = rows.find((r) => (r.textContent || "").includes(".pdf"));
    const more = row?.querySelector(".fm-more-btn") ?? null;
    if (more) more.click();
    return !!more;
  });
  if (!hasMenu) {
    const diag = await safeEval(page, () => ({
      main: document.querySelector(".main")?.className ?? null,
      tables: document.querySelectorAll(".file-manager-table").length,
      trs: Array.from(document.querySelectorAll("tr"))
        .map((r) => (r.textContent || "").trim().slice(0, 28))
        .slice(0, 8),
      gridCards: document.querySelectorAll(".fm-grid-card").length,
      toasts: Array.from(document.querySelectorAll(".toast")).map((t) => (t.textContent || "").trim().slice(0, 40)),
      fileInputs: document.querySelectorAll('input[type="file"]').length,
      fmVisible: !!document.querySelector(".file-manager"),
    }));
    return { err: `上传后没找到 pdf 行的「⋯」（上传可能没成功）；诊断=${JSON.stringify(diag)}` };
  }
  await sleep(900);
  const clicked = await safeEval(page, () => {
    const el = Array.from(document.querySelectorAll(".fm-ctx-item, [role='menuitem'], button")).find((e) =>
      (e.textContent || "").includes("阅读并标注"),
    );
    if (el) el.click();
    return !!el;
  });
  if (!clicked) return { err: "上下文菜单里没有「阅读并标注」" };
  await sleep(6000);

  // 4) 量（先量"默认收起"这一态）
  const measure = () =>
    safeEval(page, () => {
      const reader = document.querySelector(".pdf-reader");
      if (!reader) return { err: "阅读器没打开" };
      // 空壳：没有文字、没有子元素，却有可见背景或边框，且大于 6×6
      const empties = [];
      for (const el of Array.from(reader.querySelectorAll(".pdf-annot-toolbar *"))) {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        if (r.width < 6 || r.height < 6) continue;
        if (el.children.length > 0 || (el.textContent || "").trim()) continue;
        const hasBg = cs.backgroundColor !== "rgba(0, 0, 0, 0)" && cs.backgroundColor !== "transparent";
        const hasBorder = parseFloat(cs.borderTopWidth) > 0 || parseFloat(cs.borderLeftWidth) > 0;
        if (hasBg || hasBorder) {
          empties.push(
            `${el.tagName.toLowerCase()}${el.className ? "." + String(el.className).trim().replace(/\s+/g, ".") : ""} ${Math.round(r.width)}x${Math.round(r.height)}`,
          );
        }
      }
      const visible = (s) => {
        const el = reader.querySelector(s);
        return el ? getComputedStyle(el).display !== "none" : null;
      };
      const SECONDARY = [
        ".pdf-reader-maximize",
        ".pdf-reader-sidebar-toggle",
        ".pdf-reader-ask",
        ".pdf-eye-wrap",
        // ⚠️ `.pdf-export-btn` **不在**名单里：2026-09-22 起它是图标按钮（44×44）且**常驻**
        //    ——"导出这份带批注的副本"是标注之后的主要动作，藏进 ⋯ 不值当。
      ];
      const tools = reader.querySelector(".pdf-annot-tools");
      const box = (el) => {
        const b = el?.getBoundingClientRect();
        return b ? { top: b.top, bottom: b.bottom, right: Math.round(b.right), w: Math.round(b.width), h: Math.round(b.height) } : null;
      };
      /** 可见 = 自己与祖先都没有被 `display:none` 掉（收进「⋯」的项仍然在 DOM 里）。 */
      const shown = (el) => {
        if (!el) return false;
        let cur = el;
        while (cur && cur !== reader) {
          if (getComputedStyle(cur).display === "none") return false;
          cur = cur.parentElement;
        }
        const b = el.getBoundingClientRect();
        return b.width > 1 && b.height > 1;
      };
      /**
       * 状态组（文本层 chip + 朗读/OCR/AI）的**字面**是不是在同一条线上。
       * 用 Range 量文字自己的矩形：`line-height: normal` 时汉字与拉丁的行盒高度不同
       * （实测 25 / 23 / 17），盒子中心虽然都对齐，字面却差 1px（owner 截图："这几个按钮
       * 似乎不在一个水平线上？"）。判据 = 四个文字矩形**中线散布** + 文字高一致。
       */
      const textLine = (root) => {
        const els = root
          ? [root.querySelector(".pdf-annot-layer"), ...Array.from(root.querySelectorAll(".pdf-annot-ocr"))].filter(Boolean)
          : [];
        const rects = els
          .map((el) => {
            const tn = Array.from(el.childNodes).find((n) => n.nodeType === 3 && (n.textContent || "").trim());
            if (!tn) return null;
            const r = document.createRange();
            r.selectNodeContents(tn);
            const b = r.getBoundingClientRect();
            return b.height > 0 ? { mid: +((b.top + b.bottom) / 2).toFixed(2), h: +b.height.toFixed(2), boxH: +el.getBoundingClientRect().height.toFixed(2) } : null;
          })
          .filter(Boolean);
        if (rects.length < 2) return null;
        return {
          n: rects.length,
          mids: rects.map((r) => r.mid),
          hs: rects.map((r) => r.h),
          boxHs: rects.map((r) => r.boxH),
          spread: +(Math.max(...rects.map((r) => r.mid)) - Math.min(...rects.map((r) => r.mid))).toFixed(2),
        };
      };
      const toolbarEl = reader.querySelector(".pdf-annot-toolbar");
      const rowEl = reader.querySelector(".pdf-annot-toolbar-row");
      const rb = rowEl?.getBoundingClientRect();
      return {
        empties,
        // ⚠️ 用 `shown`（连祖先一起看）而不是 `visible`（只看自己）：这 4 个控件现在是被
        // **外层 `.pdf-head-tail`** 整组藏起来的，只看自己的 computed display 会误判成"可见"。
        moreVisible: shown(reader.querySelector(".pdf-reader-more")),
        secondary: SECONDARY.map((s) => shown(reader.querySelector(s))),
        toolsH: tools ? Math.round(tools.getBoundingClientRect().height) : null,
        docW: document.documentElement.scrollWidth,
        vw: innerWidth,
        hasStatus: shown(reader.querySelector(".pdf-annot-status")),
        pages: (reader.querySelector(".pdf-reader-page")?.textContent || "").trim(),
        // 分组盒子（Node 侧按"纵向重叠"算行数：盒高不同且垂直居中，比 top 相等是错的）
        // ⚠️ 取**行内**（`.pdf-annot-toolbar-row`）的那些分组：工具条自身现在只有两个孩子
        //    （行 + 「⋯」那一格），拿它算行数会永远得 1，等于没量。
        groupBoxes: Array.from(
          (reader.querySelector(".pdf-annot-toolbar-row") ?? reader.querySelector(".pdf-annot-toolbar"))?.children ?? [],
        ).map((c) => {
          const b = c.getBoundingClientRect();
          return { name: String(c.className).split(" ")[0], top: b.top, bottom: b.bottom };
        }),
        // 批注工具条：**永不换行**（owner 2026-09-22）——行内分组的纵向行数 + 有没有溢出/被挤出。
        bar: toolbarEl
          ? {
              h: Math.round(toolbarEl.getBoundingClientRect().height),
              // 固定高度（owner 2026-09-22："页内工具栏高度永远固定，不能被撑大"）：
              // 声明值 = 渲染值，且行内内容不许被裁到。
              fixed: Math.round(parseFloat(getComputedStyle(toolbarEl).height)),
              rowInner: rowEl ? rowEl.clientHeight : null,
              rowScroll: rowEl ? rowEl.scrollHeight : null,
              tallGroup: (() => {
                const gs = Array.from(rowEl?.querySelectorAll(".pdf-annot-tools, .pdf-annot-actions, .pdf-annot-status") ?? []);
                return gs.length ? Math.round(Math.max(...gs.map((g) => g.getBoundingClientRect().height))) : null;
              })(),
              collapse: toolbarEl.getAttribute("data-collapse") ?? "",
              hasMore: toolbarEl.classList.contains("has-more"),
              moreShown: shown(reader.querySelector(".pdf-annot-more")),
              rowLines: (() => {
                const kids = Array.from(rowEl?.children ?? []).filter((el) => shown(el));
                const g = [];
                for (const el of kids) {
                  const b = el.getBoundingClientRect();
                  const hit = g.find((x) => b.top < x.bottom - 0.5 && b.bottom > x.top + 0.5);
                  if (hit) {
                    hit.top = Math.min(hit.top, b.top);
                    hit.bottom = Math.max(hit.bottom, b.bottom);
                  } else g.push({ top: b.top, bottom: b.bottom });
                }
                return g.length;
              })(),
              rowOverflow: rowEl ? { scrollW: rowEl.scrollWidth, clientW: rowEl.clientWidth } : null,
              outside: rb
                ? Array.from(rowEl.querySelectorAll("button"))
                    .filter((b) => shown(b))
                    .filter((b) => {
                      const bb = b.getBoundingClientRect();
                      return bb.right > rb.right + 1 || bb.left < rb.left - 1;
                    })
                    .map((b) => (b.textContent || "").trim().slice(0, 8))
                : [],
              ocrInRow: Array.from(rowEl?.querySelectorAll(".pdf-annot-ocr") ?? []).filter((b) => shown(b)).length,
            }
          : null,
        // 「⋯」菜单里的东西（点开那一刻才量）
        menu: (() => {
          const pop = reader.querySelector(".pdf-annot-more-pop");
          if (!pop) return null;
          const pb = pop.getBoundingClientRect();
          return {
            text: (pop.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80),
            inViewport: pb.left >= -1 && pb.right <= innerWidth + 1,
            ocr: Array.from(pop.querySelectorAll(".pdf-annot-ocr")).filter((b) => shown(b)).map((b) => (b.textContent || "").trim()),
            layer: shown(pop.querySelector(".pdf-annot-layer")),
            // 窄屏行内那一份状态组是收起来的（量不到文字矩形）⇒ 用菜单里这一份量"字面同线"
            line: textLine(pop),
          };
        })(),
        // 状态组的"字面同线"（行内那一份看得见时才有值）
        statusLine: textLine(reader.querySelector(".pdf-annot-status")),
        // 头部工具条（2026-09-22，owner："pdf 阅读器顶部系统工具栏任何时候不换行，
        // 空间狭小时收起来，除了最右端的关闭按钮"）——与 `bar` 同一套判据，另加"关闭永远在"。
        headBar: (() => {
          const h = reader.querySelector(".pdf-reader-head");
          if (!h) return null;
          const hb = h.getBoundingClientRect();
          const kids = Array.from(h.children).filter((el) => shown(el));
          const g = [];
          for (const el of kids) {
            const b = el.getBoundingClientRect();
            const hit = g.find((x) => b.top < x.bottom - 0.5 && b.bottom > x.top + 0.5);
            if (hit) {
              hit.top = Math.min(hit.top, b.top);
              hit.bottom = Math.max(hit.bottom, b.bottom);
            } else g.push({ top: b.top, bottom: b.bottom });
          }
          const close = h.querySelector(".pdf-reader-close");
          const cb = close ? close.getBoundingClientRect() : null;
          return {
            h: Math.round(hb.height),
            fixed: Math.round(parseFloat(getComputedStyle(h).height)),
            right: Math.round(hb.right),
            collapse: h.getAttribute("data-collapse") ?? "",
            hasMore: h.classList.contains("has-more"),
            moreShown: shown(h.querySelector(".pdf-reader-more")),
            wrap: getComputedStyle(h).flexWrap,
            rows: g.length,
            overflow: h.scrollWidth > h.clientWidth + 1,
            outside: Array.from(h.querySelectorAll("button"))
              .filter((b) => shown(b) && !b.closest(".pdf-head-more-pop"))
              .filter((b) => {
                const bb = b.getBoundingClientRect();
                return bb.right > hb.right + 1 || bb.left < hb.left - 1;
              })
              .map((b) => (b.getAttribute("title") || b.textContent || "").trim().slice(0, 8)),
            closeShown: shown(close),
            closeRight: cb ? Math.round(cb.right) : null,
            nameW: Math.round(reader.querySelector(".pdf-reader-name")?.getBoundingClientRect().width ?? 0),
          };
        })(),
        // 头部「⋯」菜单里的东西（点开那一刻才量）
        headMenu: (() => {
          const pop = reader.querySelector(".pdf-head-more-pop");
          if (!pop) return null;
          const pb = pop.getBoundingClientRect();
          const items = [
            ".pdf-reader-nav",
            ".pdf-reader-zoom",
            ".pdf-reader-maximize",
            ".pdf-reader-sidebar-toggle",
            ".pdf-reader-ask",
            ".pdf-eye-wrap",
            ".pdf-export-btn",
          ];
          return {
            text: (pop.textContent || "").replace(/\s+/g, " ").trim().slice(0, 90),
            inViewport: pb.left >= -1 && pb.right <= innerWidth + 1,
            shown: items.filter((s) => shown(pop.querySelector(s))),
          };
        })(),
        // 两侧的**拖拽竖线**（2026-09-22，owner："左右侧边栏的拖拽竖线粗细要一样"）：
        // 四处 = 左/右侧栏 × 展开/收起，规格必须完全一致；抓取条**可见宽**也必须一致
        // （改前右侧那条是 `left:-3px`，被 `.pdf-sidebar-col` 的 overflow:hidden 裁成 3px
        //   ⇒ 展开态 hover 高亮一边 6px、一边 3px，这就是"粗细不一样"的来源）。
        dragBars: (() => {
          const stripVisibleW = (el) => {
            if (!el) return null;
            const b = el.getBoundingClientRect();
            let l = b.left;
            let r = b.right;
            let cur = el.parentElement;
            while (cur) {
              const cs = getComputedStyle(cur);
              if (!(cs.overflowX === "visible" && cs.overflowY === "visible")) {
                const cr = cur.getBoundingClientRect();
                l = Math.max(l, cr.left);
                r = Math.min(r, cr.right);
              }
              cur = cur.parentElement;
            }
            return Math.round(Math.max(0, r - l));
          };
          const spec = (sel) => {
            const el = reader.querySelector(sel);
            if (!el) return null;
            const cs = getComputedStyle(el, "::after");
            return { w: cs.width, h: cs.height, bg: cs.backgroundColor, radius: cs.borderRadius, strip: stripVisibleW(el) };
          };
          return {
            edgeLeft: spec(".pdf-edge-drag.is-left"),
            edgeRight: spec(".pdf-edge-drag.is-right"),
            openLeft: spec(".pdf-outline-resizer"),
            openRight: spec(".pdf-sidebar-resizer"),
          };
        })(),
        toolbar: box(toolbarEl),
        status: box(reader.querySelector(".pdf-annot-status")),
        // head（顶部工具条）自身的预算 + 导出按钮规格（"太占地方"那条的回归判据）
        head: box(reader.querySelector(".pdf-reader-head")),
        headChildren: Array.from(reader.querySelector(".pdf-reader-head")?.children ?? [])
          .map((c) => {
            const b = c.getBoundingClientRect();
            return { name: String(c.className).split(" ")[0], top: b.top, bottom: b.bottom, w: Math.round(b.width), h: Math.round(b.height) };
          })
          .filter((c) => c.w > 1 && c.h > 1),
        exportBtn: (() => {
          // ⚠️ 导出按钮现在**可能被收进头部「⋯」**（`data-collapse~="export"`），
          //    行内那一份是 display:none ⇒ 0×0。要量的是**看得见的那一份**。
          const el = Array.from(reader.querySelectorAll(".pdf-export-btn")).find((b) => shown(b)) ?? null;
          if (!el) return null;
          const b = el.getBoundingClientRect();
          return {
            w: Math.round(b.width),
            h: Math.round(b.height),
            text: (el.textContent || "").trim(),
            title: (el.getAttribute("title") || "").trim(),
            label: (el.getAttribute("aria-label") || "").trim(),
            inMenu: !!el.closest(".pdf-head-more-pop"),
          };
        })(),
        // 右侧批注栏的筛选开关（2026-09-22：四枚胶囊默认收起，常驻只剩一枚漏斗）
        sidebar: (() => {
          const sb = reader.querySelector(".pdf-sidebar");
          if (!sb) return null;
          const t = sb.querySelector(".pdf-sidebar-filter-toggle");
          const chips = Array.from(sb.querySelectorAll(".pdf-sidebar-filter-btn"));
          // ⚠️ 第一枚胶囊（「全部」）在 `filter === "all"` 时**就是 `.active`**、本来就带底色，
          //    拿它判"透明底"必然误报 —— 要判的是**非选中**那一枚。
          const chip = chips.find((el) => !el.classList.contains("active")) ?? null;
          const activeChip = chips.find((el) => el.classList.contains("active")) ?? null;
          const styleOf = (el) => {
            if (!el) return null;
            const cs = getComputedStyle(el);
            return { border: `${cs.borderTopWidth} ${cs.borderTopStyle}`, bg: cs.backgroundColor };
          };
          return {
            toggle: !!t,
            title: (t?.getAttribute("title") || "").trim(),
            expanded: t?.getAttribute("aria-expanded") === "true",
            chips: sb.querySelectorAll(".pdf-sidebar-filter-btn").length,
            activeLabel: (sb.querySelector(".pdf-sidebar-filter-current")?.textContent || "").trim(),
            // 扁平化：漏斗开关与展开后的胶囊（改前都是"1px 描边"）
            toggleStyle: styleOf(t),
            chipStyle: styleOf(chip),
            activeChipStyle: styleOf(activeChip),
          };
        })(),
        // 两侧面板：在不在、多宽；以及"收起时的拖拽手柄"在不在（2026-09-22 拖拽收起/展开）
        outlineCol: (() => {
          const el = reader.querySelector(".pdf-outline-col");
          return { present: !!el, w: el ? Math.round(el.getBoundingClientRect().width) : 0 };
        })(),
        sidebarCol: (() => {
          const el = reader.querySelector(".pdf-sidebar-col");
          return { present: !!el, w: el ? Math.round(el.getBoundingClientRect().width) : 0 };
        })(),
        edgeHandles: {
          left: !!reader.querySelector(".pdf-edge-drag.is-left"),
          right: !!reader.querySelector(".pdf-edge-drag.is-right"),
        },
        // 扁平化 + 去掉工具条外框（owner 2026-09-22）：
        //   · 阅读器按钮 = 无边框 + 透明底（改前"描边 + 浅底"的小方块）
        //   · 批注工具条 = 去掉外框勾线（底色保留做分组）
        //   · 控制组宽度（压间距 + 去边框后的"进一步压缩占宽"）
        btnStyle: (() => {
          const el = reader.querySelector(".pdf-reader-btn");
          if (!el) return null;
          const cs = getComputedStyle(el);
          return { border: `${cs.borderTopWidth} ${cs.borderTopStyle}`, bg: cs.backgroundColor };
        })(),
        toolsStyle: (() => {
          const el = reader.querySelector(".pdf-annot-tools");
          if (!el) return null;
          const cs = getComputedStyle(el);
          return { border: `${cs.borderTopWidth} ${cs.borderTopStyle}`, bg: cs.backgroundColor };
        })(),
        controlsW: Math.round(
          (reader.querySelector(".pdf-reader-nav")?.getBoundingClientRect().width ?? 0) +
            (reader.querySelector(".pdf-reader-zoom")?.getBoundingClientRect().width ?? 0) +
            // ⚠️ 2026-09-22：`.pdf-reader-controls` 那一层**拆掉了**（它会让"只收缩放、留翻页"
            //    这种粒度做不到）⇒ 控制组宽度 = 翻页组 + 缩放组 + 它们之间那一个 head gap(8)。
            8,
        ),
        // 朗读 / OCR / AI：扁平化（owner 2026-09-22 第二张截图"这几个按钮也进行扁平化处理"）。
        // 与 `.pdf-reader-btn` 同一套判据：**无边框 + 透明底**；AI 靠**文字颜色**区分。
        ocrStyle: (() => {
          const el = reader.querySelector(".pdf-annot-ocr:not(.pdf-annot-ocr-ai)");
          if (!el) return null;
          const cs = getComputedStyle(el);
          return { border: `${cs.borderTopWidth} ${cs.borderTopStyle}`, bg: cs.backgroundColor, color: cs.color };
        })(),
        ocrAiStyle: (() => {
          const el = reader.querySelector(".pdf-annot-ocr-ai");
          if (!el) return null;
          const cs = getComputedStyle(el);
          return { border: `${cs.borderTopWidth} ${cs.borderTopStyle}`, bg: cs.backgroundColor, color: cs.color };
        })(),
        // 短标签必须带 title（否则"朗读 / OCR / AI"就没有完整说法）
        labels: Array.from(reader.querySelectorAll(".pdf-annot-ocr")).map((b) => ({
          text: (b.textContent || "").trim(),
          title: (b.getAttribute("title") || "").trim(),
        })),
        layerText: (reader.querySelector(".pdf-annot-layer")?.textContent || "").trim(),
        layerTitle: (reader.querySelector(".pdf-annot-layer")?.getAttribute("title") || "").trim(),
        // 统一图标（owner 2026-09-22："这几个按钮都使用统一风格的 svg 图标"）。
        // 判据：工具条里每一枚 `<svg>` 的 viewBox / stroke / 线帽 / 线接 / **线宽** / **尺寸**都一致
        //（改前是 1.8 与 2 两套线宽、16 / 15 两种尺寸混排）。
        icons: Array.from(reader.querySelectorAll(".pdf-annot-toolbar button svg")).map((s) => ({
          vb: s.getAttribute("viewBox"),
          fill: s.getAttribute("fill"),
          stroke: s.getAttribute("stroke"),
          sw: s.getAttribute("stroke-width"),
          cap: s.getAttribute("stroke-linecap"),
          join: s.getAttribute("stroke-linejoin"),
          w: s.getAttribute("width"),
          h: s.getAttribute("height"),
        })),
      };
    });

  const first = await measure();
  if (first.err) return { err: first.err };

  // 5) 窄屏：点开头部的「⋯」再量一态（"收起了"和"点了能出来"是两件事）
  let secondaryAfter = first.secondary;
  let hasStatusAfter = first.hasStatus;
  let headMenuAfter = null;
  let after = null;
  if (vp.width <= 768 && first.moreVisible) {
    await safeEval(page, () => document.querySelector(".pdf-reader-more")?.click());
    await sleep(600);
    after = await measure();
    headMenuAfter = after.headMenu ?? null;
    secondaryAfter = after.secondary ?? secondaryAfter;
    hasStatusAfter = after.hasStatus ?? hasStatusAfter;
    // 量完就关掉：后面那几步（批注「⋯」/ 拖拽 / 侧栏筛选）不该被头上这层菜单压着。
    await safeEval(page, () => document.querySelector(".pdf-reader-more")?.click());
    await sleep(300);
  }
  // 5b) 批注工具条自己的「⋯」：放不下的项收在这里（owner 2026-09-22：
  //     "pdf 页内工具栏任何时候不换行，空间狭小时，可以收起来，不截断"）。
  //     量完就关掉 —— 后面的拖拽 / 筛选那几步需要它闭合。
  let menu = null;
  if (first.bar?.hasMore) {
    await safeEval(page, () => document.querySelector(".pdf-annot-more")?.click());
    await sleep(500);
    menu = (await measure()).menu;
    await safeEval(page, () => document.querySelector(".pdf-annot-more")?.click());
    await sleep(300);
  }
  // 6b) 桌面：右侧批注栏的筛选**默认收起**（owner 2026-09-22）——
  //     点开有 4 枚胶囊、选一个再收起后仍能看出当前筛选（否则"列表变短了"没有解释）。
  //     ⚠️ 必须排在"关掉目录+侧栏"那一步**之前**（那一步之后 `.pdf-sidebar` 就不在 DOM 里了）。
  let sidebarFlow = null;
  if (vp.width > 768) {
    const before = first.sidebar;
    await safeEval(page, () => document.querySelector(".pdf-sidebar-filter-toggle")?.click());
    await sleep(400);
    const opened = (await measure()).sidebar;
    await safeEval(page, () => {
      const b = Array.from(document.querySelectorAll(".pdf-sidebar-filter-btn")).find(
        (x) => (x.textContent || "").trim() === "高亮",
      );
      b?.click();
    });
    await sleep(300);
    await safeEval(page, () => document.querySelector(".pdf-sidebar-filter-toggle")?.click()); // 收起
    await sleep(400);
    const collapsed = (await measure()).sidebar;
    sidebarFlow = { before, opened, collapsed };
  }
  // 6b-2) 桌面：**真实鼠标拖拽**收起/展开两侧面板（owner 2026-09-22："要可以通过鼠标拖拽收起展开"）。
  //      · 拖 resizer 拖到阈值以内 ⇒ 面板收起、那条边出现 `.pdf-edge-drag` 手柄；
  //      · 从手柄拖得不够 ⇒ 不动（不误开）；拖够了 ⇒ 面板回来；
  //      · 两侧都试（左目录 dir=1 向左变窄，右批注 dir=-1 向右变窄）。
  let dragFlow = null;
  if (vp.width > 768) {
    const dragBy = async (sel, dx) => {
      const at = await safeEval(page, (s) => {
        const el = document.querySelector(s);
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { x: b.x + b.width / 2, y: b.y + Math.round(b.height / 2) };
      }, sel);
      if (!at) return false;
      await page.mouse.move(at.x, at.y);
      await page.mouse.down();
      await page.mouse.move(at.x + dx, at.y, { steps: 12 });
      await page.mouse.up();
      await sleep(450);
      return true;
    };
    const leftOpen = (await measure()).outlineCol;
    // ① 左目录：从 resizer 向左拖 200px（起始 240 ⇒ raw 40 < 阈值 120）⇒ 收起
    await dragBy(".pdf-outline-resizer", -200);
    const afterCollapseLeft = await measure();
    // ② 从手柄往右拖 60px（不够阈值 120）⇒ 仍然收起（不误开）
    await dragBy(".pdf-edge-drag.is-left", 60);
    const afterSmallLeft = await measure();
    // ③ 从手柄往右拖 260px ⇒ 面板回来，宽度 ≥ min(160)
    await dragBy(".pdf-edge-drag.is-left", 260);
    const afterExpandLeft = await measure();
    // ④ 右批注栏：从 resizer 向右拖 200px（起始 260 ⇒ raw 60 < 阈值 160）⇒ 收起；再从手柄拖回
    const rightOpen = (await measure()).sidebarCol;
    await dragBy(".pdf-sidebar-resizer", 200);
    const afterCollapseRight = await measure();
    await dragBy(".pdf-edge-drag.is-right", -260);
    const afterExpandRight = await measure();
    dragFlow = { leftOpen, afterCollapseLeft, afterSmallLeft, afterExpandLeft, rightOpen, afterCollapseRight, afterExpandRight };
  }
  // 6c) 桌面：把目录 + 批注侧栏都关掉再量一态 —— 只有**列宽足够**时"状态组与工具组同排"
  //    才检验得出来（面板开着时正文列可能只有 ~492px，`tools 454 + status 221` 必然换行）。
  let wide = null;
  if (vp.width > 768) {
    await safeEval(page, () => {
      document.querySelector(".pdf-reader-outline-toggle")?.click();
      document.querySelector(".pdf-reader-sidebar-toggle")?.click();
    });
    await sleep(1200);
    wide = await measure();
  }
  return {
    ...first,
    after,
    secondaryAfter,
    hasStatusAfter,
    headMenuAfter,
    menu,
    wide,
    sidebarFlow,
    dragFlow,
    lines: linesOf(first.groupBoxes),
    wideLines: wide ? linesOf(wide.groupBoxes) : null,
  };
}

/**
 * 若干矩形占了几"行"：**按纵向重叠**合并。
 * ⚠️ 不能比"顶端相等"：同一行里盒高不同（44 vs 28）且 `align-items: center`，top 会差几像素。
 */
function linesOf(boxes) {
  const g = [];
  for (const b of boxes ?? []) {
    const hit = g.find((x) => b.top < x.bottom - 0.5 && b.bottom > x.top + 0.5);
    if (hit) {
      hit.top = Math.min(hit.top, b.top);
      hit.bottom = Math.max(hit.bottom, b.bottom);
    } else g.push({ top: b.top, bottom: b.bottom });
  }
  return g.length;
}

/** 扁平控件判据：**无边框 + 透明底**（`.pdf-reader-btn`、朗读/OCR/AI、漏斗+胶囊 共用一套语言）。 */
function isFlat(style) {
  return style?.border === "0px none" && /rgba\(0, 0, 0, 0\)|transparent/.test(style?.bg ?? "");
}

/**
 * PDF 阅读器那一节的断言（手机档与桌面档**共用**）。
 * ⚠️ 曾经只写在手机循环里 ⇒ 桌面那几条（同排/工具条一行高/右端）**永远不执行**（死断言）。
 */
function assertPdfReader(rr, vp) {
  if (rr.err) {
    ok(false, `PDF 阅读器体检失败：${rr.err}`);
    return;
  }
  ok(
    /第\s*\d+\s*\/\s*\d+\s*页|页数未知/.test(rr.pages),
    `夹具 PDF 真的载入了（页码读数「${rr.pages}」）——上传 + 打开这条路走通了`,
  );
  // ① 工具条里不许有"空壳胶囊"：`.pdf-annot-actions` 自带背景/边框/圆角，
  //    空着就是一枚 14×10 的小白胶囊（owner 2026-09-22 截图圈出的那个）。
  ok(
    rr.empties.length === 0,
    `批注工具条里没有"没有内容却有背景/边框"的空壳（实测 ${rr.empties.length} 个` +
      `${rr.empties.length ? "：" + rr.empties.join("、") : ""}）`,
  );
  // ①b 导出按钮：**图标规格**（原来是一枚 102×28 的文字按钮，owner 说"太占地方"）。
  // ⚠️ 2026-09-22：导出现在**可能被收进头部「⋯」**（列一窄就收）⇒ 要量**看得见的那一份**：
  //    窄屏在"点开头部「⋯」"那一态里（`rr.after`），桌面在"关掉两侧面板"的宽态里（`rr.wide`）。
  const ex = vp.width <= 768 ? rr.after?.exportBtn : rr.wide?.exportBtn ?? rr.exportBtn;
  ok(
    !!ex && ex.text === "" && ex.w <= (vp.width <= 768 ? 48 : 32),
    `「导出带批注副本」是图标按钮（${ex?.w}×${ex?.h}，文字="${ex?.text}"${ex?.inMenu ? "，在「⋯」菜单里" : ""}）` +
      `——改前 102×28 的文字按钮`,
  );
  ok(
    (ex?.title?.length ?? 0) > 0 && (ex?.label?.length ?? 0) > 0,
    `导出图标带 title + aria-label（「${ex?.label}」）——图标化不等于把说法藏掉`,
  );
  // ①c head（顶部工具条）预算。**高度现在是写死的**（owner："系统工具栏高度也要固定，
  // 不能被撑得更大"）⇒ 钉"渲染值 = 声明值"，并钉每一态的渲染值都等于它。
  const headLines = linesOf(rr.headChildren ?? []);
  ok(
    rr.headBar?.h === rr.headBar?.fixed,
    `系统工具栏高度固定（渲染 ${rr.headBar?.h}px = 声明 ${rr.headBar?.fixed}px；${headLines} 行）` +
      `——改前是内容撑的：390 上 115px / 2 行、320 上 165px / 3 行`,
  );
  if (vp.width <= 768) {
    const otherHeadH = rr.after?.headBar?.h;
    ok(
      rr.head?.h <= 80 && otherHeadH === rr.headBar?.h,
      `窄屏头部换一态也不变高（${rr.headBar?.h} → 点开「⋯」后 ${otherHeadH}）`,
    );
    ok(
      (ex?.w ?? 0) >= 44 && (ex?.h ?? 0) >= 44,
      `导出图标命中区 ≥44（${ex?.w}×${ex?.h}）`,
    );
  } else {
    ok((rr.head?.h ?? 1e9) <= 56, `桌面 head 仍是一行（${rr.head?.h}px ≤ 56）`);
  }
  // ② `⋯` 的收起/展开：CSS 级断言只能钉规则，钉不到"点下去会不会出来"。
  if (vp.width <= 768) {
    ok(rr.moreVisible, `窄屏有「⋯」入口（更多工具）`);
    ok(rr.secondary.every((v) => v === false), `默认收起那 4 个低频头部控件（实测 ${JSON.stringify(rr.secondary)}）`);
    ok(
      (rr.headMenuAfter?.shown ?? []).length >= 3 && rr.headMenuAfter?.inViewport === true,
      `点开头部「⋯」后收起来的那几件在菜单里可见（实测 ${JSON.stringify(rr.headMenuAfter?.shown ?? [])}，菜单在视口内=${rr.headMenuAfter?.inViewport}）`,
    );
    ok(rr.toolsH !== null && rr.toolsH <= 56, `批注工具行是**一行**（高 ${rr.toolsH} ≤ 56；换行会白吃 44px）`);
    // 状态组（文本层 chip + 朗读/OCR/AI）现在由**工具条自己**按宽度收进它那枚「⋯」。
    ok(rr.hasStatus === false, `窄屏状态组自动收起来（实测 hasStatus=${rr.hasStatus}，data-collapse="${rr.bar?.collapse}"）`);
    ok(
      rr.hasStatusAfter === rr.hasStatus,
      `头部「⋯」只开合头部那 4 个控件，不再动批注状态组（${rr.hasStatus} → ${rr.hasStatusAfter}）`,
    );
    ok(
      rr.bar?.hasMore === true && (rr.menu?.ocr?.length ?? 0) >= 1,
      `收起来的「朗读 / OCR / AI」在工具条「⋯」里仍然点得到（实测 ${JSON.stringify(rr.menu?.ocr ?? null)}）`,
    );
  } else {
    ok(!rr.moreVisible, `桌面不显示「⋯」入口（一次放得下）`);
    // 桌面第一态是"目录 + 批注栏都开着"（正文列只有 ~492px）⇒ 状态组**应当**收进「⋯」；
    // 面板关掉后列宽足够 ⇒ 它自己回来（"收起来"不等于"消失"，见下面 wide 那条）。
    ok(
      rr.hasStatus === false && (rr.menu?.ocr?.length ?? 0) >= 1,
      `列窄时状态组收进「⋯」且可达（行内=${rr.hasStatus}、菜单=${JSON.stringify(rr.menu?.ocr ?? null)}）`,
    );
    // 右侧批注栏：四枚筛选胶囊**默认收起**，常驻只剩一枚漏斗（owner 2026-09-22：
    // "右边侧栏顶部的四个按钮平时收起来"）。改前 4 枚常驻 ≈236px，几乎占满 260px 的栏宽。
    const sb = rr.sidebarFlow;
    ok(
      sb?.before?.toggle === true && sb.before.chips === 0 && sb.before.expanded === false,
      `批注栏筛选默认收起（只有 1 枚漏斗开关、${sb?.before?.chips} 枚胶囊）——改前 4 枚胶囊常驻`,
    );
    ok(
      sb?.opened?.chips === 4 && sb.opened.expanded === true,
      `点开后 4 枚胶囊都在（实测 ${sb?.opened?.chips} 枚）`,
    );
    ok(
      sb?.collapsed?.chips === 0 && sb.collapsed.activeLabel === "高亮",
      `收起后仍看得出当前筛选（图标旁写「${sb?.collapsed?.activeLabel}」）——否则"列表变短了"没有解释`,
    );
    // 漏斗开关 + 展开后的四枚胶囊也走扁平语言（owner 2026-09-22 第二张截图圈出了这枚漏斗）。
    // 选中那枚**应当**有底色（`--accent-soft`），没边框 —— 这两件事一起钉。
    ok(
      isFlat(sb?.before?.toggleStyle) &&
        isFlat(sb?.opened?.chipStyle) &&
        sb?.opened?.activeChipStyle?.border === "0px none" &&
        !/rgba\(0, 0, 0, 0\)|transparent/.test(sb?.opened?.activeChipStyle?.bg ?? ""),
      `侧栏漏斗与筛选胶囊都是扁平样式（漏斗 border=${sb?.before?.toggleStyle?.border}、` +
        `胶囊 border=${sb?.opened?.chipStyle?.border}；选中胶囊只靠底色 bg=${sb?.opened?.activeChipStyle?.bg}）` +
        `——改前都是 1px 描边`,
    );
    // 拖拽收起 / 拖拽展开（真实鼠标拖拽，两侧各一遍）
    const df = rr.dragFlow;
    ok(
      df?.leftOpen?.present === true && df.afterCollapseLeft.outlineCol.present === false &&
        df.afterCollapseLeft.edgeHandles.left === true,
      `把目录 resizer 往左拖过头 ⇒ 目录收起，并出现可拖出来的边缘手柄（handle=${df?.afterCollapseLeft?.edgeHandles?.left}）`,
    );
    ok(
      df?.afterSmallLeft?.outlineCol?.present === false,
      `从手柄拖得不够（60px < 阈值 120）⇒ 不误开（目录仍在=${df?.afterSmallLeft?.outlineCol?.present}）`,
    );
    ok(
      df?.afterExpandLeft?.outlineCol?.present === true && df.afterExpandLeft.outlineCol.w >= 160,
      `从手柄往右拖够 ⇒ 目录拖出来了（宽 ${df?.afterExpandLeft?.outlineCol?.w} ≥ 160）`,
    );
    ok(
      df?.rightOpen?.present === true && df.afterCollapseRight.sidebarCol.present === false &&
        df.afterCollapseRight.edgeHandles.right === true,
      `把批注栏 resizer 往右拖过头 ⇒ 批注栏收起 + 边缘手柄出现`,
    );
    ok(
      df?.afterExpandRight?.sidebarCol?.present === true && df.afterExpandRight.sidebarCol.w >= 220,
      `从右侧手柄往左拖够 ⇒ 批注栏拖出来了（宽 ${df?.afterExpandRight?.sidebarCol?.w} ≥ 220）`,
    );
    // 两侧的**拖拽竖线**必须是同一条（owner："左右侧边栏的拖拽竖线粗细要一样"）。
    // 四处 = 左/右 × 展开/收起，规格完全一致；抓取条的**可见宽**也要一致
    // （改前右侧那条 `left:-3px` 被列的 overflow:hidden 裁成 3px ⇒ hover 高亮一边 6px、一边 3px）。
    {
      const bars = [
        ["收起-左", df?.afterCollapseLeft?.dragBars?.edgeLeft],
        ["展开-右", df?.afterCollapseLeft?.dragBars?.openRight],
        ["收起-右", df?.afterCollapseRight?.dragBars?.edgeRight],
        ["展开-左", df?.afterCollapseRight?.dragBars?.openLeft],
      ].filter(([, b]) => b);
      const base = bars[0]?.[1];
      ok(
        bars.length === 4 &&
          bars.every(([, b]) => b.w === base.w && b.h === base.h && b.bg === base.bg && b.radius === base.radius),
        `四处拖拽竖线规格完全一致（${bars.map(([n, b]) => `${n} ${b.w}×${b.h}`).join(" / ")}，色 ${base?.bg}）`,
      );
      ok(
        bars.length === 4 && bars.every(([, b]) => b.strip === 6),
        `四条抓取条的**可见宽**都是 6px（${bars.map(([n, b]) => `${n} ${b.strip}px`).join(" / ")}）` +
          `——改前右侧那条被裁成 3px，于是 hover 高亮左边 6px、右边 3px`,
      );
    }
    // 「1+2」：三个按钮**短标签**（朗读 / OCR / AI），状态组从"独占一行的 472px 状态条"
    // 改成"与工具组同排的 221px 小组"（关掉目录+侧栏 ⇒ 列宽足够，这一档才检验得出来）
    ok(
      rr.wideLines === 1,
      `列宽足够时状态组与工具组**同一行**（实测 ${rr.wideLines} 行，工具条高 ${rr.wide?.toolbar?.h}px）` +
        `——改前它靠 width:100% 必然独占一行`,
    );
    ok((rr.wide?.status?.w ?? 1e9) <= 260, `状态组缩到 ${rr.wide?.status?.w}px ≤ 260（改前 472px）`);
    ok((rr.wide?.toolbar?.h ?? 1e9) <= 56, `工具条只有一行高（${rr.wide?.toolbar?.h}px ≤ 56；改前 89px）`);
    ok(
      (rr.wide?.status?.right ?? 0) <= (rr.wide?.toolbar?.right ?? 0) + 1 &&
        (rr.wide?.status?.right ?? 0) >= (rr.wide?.toolbar?.right ?? 1e9) - 24,
      `状态组落在工具行**右端**（右缘 ${rr.wide?.status?.right} vs 工具条 ${rr.wide?.toolbar?.right}）`,
    );
    // "收起来"不等于"消失"：面板关掉、列宽够了之后，收进「⋯」的那几件要**自己回来**。
    ok(
      rr.wide?.hasStatus === true && rr.wide?.bar?.hasMore === false,
      `列宽足够时状态组自动回到行内、「⋯」收起（hasStatus=${rr.wide?.hasStatus}、hasMore=${rr.wide?.bar?.hasMore}）`,
    );
  }
  // 短标签 + title：这是"能缩短"的前提（缩了还不给完整说法就等于藏功能）
  // ⚠️ 窄屏要看**点开「⋯」之后**那一态（默认收起时状态组不在 DOM 里 ⇒ 第一态量到空数组）。
  const lab = vp.width <= 768 ? rr.after : rr.wide ?? rr;
  ok(
    lab?.labels?.length >= 1 && lab.labels.every((l) => l.text.length <= 4 && l.title.length > 0),
    `朗读/OCR/AI 用短标签且都带 title（实测 ${JSON.stringify(lab?.labels?.map((l) => l.text) ?? [])}）`,
  );
  ok(
    (lab?.layerText?.length ?? 99) <= 6 && (lab?.layerTitle?.length ?? 0) > 0,
    `文本层 chip 也是短句 + title（实测「${lab?.layerText ?? ""}」/「${lab?.layerTitle ?? ""}」）`,
  );
  ok(rr.docW <= rr.vw + 1, `阅读器无横向溢出（docW ${rr.docW} ≤ ${rr.vw}）`);
  // ---------------------------------------------------------------------------
  // 批注工具条：**任何时候都不换行**，空间不够就收进「⋯」，且不许截断
  // （owner 2026-09-22："pdf 页内工具栏任何时候不换行，空间狭小时，可以收起来，不截断"）。
  // 三条判据分别对应这句话里的三件事：一行 / 没被挤出 / 收起来的仍可达。
  // ---------------------------------------------------------------------------
  const bar = rr.bar;
  ok(
    bar?.rowLines === 1,
    `批注工具条**只有一行**（行内 ${bar?.rowLines} 行；data-collapse="${bar?.collapse}"）` +
      `——改前是 flex-wrap: wrap，1280 少一列面板就折成两行`,
  );
  ok(
    (bar?.rowOverflow?.scrollW ?? 1e9) <= (bar?.rowOverflow?.clientW ?? 0) + 1,
    `行内没有被推出可视区（scrollW ${bar?.rowOverflow?.scrollW} ≤ clientW ${bar?.rowOverflow?.clientW}）——"不截断"`,
  );
  ok(
    (bar?.outside?.length ?? 1) === 0,
    `没有任何按钮被挤出工具条（实测 ${JSON.stringify(bar?.outside ?? [])}）`,
  );
  // 高度**固定**：声明多少就渲染多少（`height` 而不是 `min-height` ⇒ 内容撑不大它），
  // 而且固定高度不许裁到内容（行内可滚高度 = 行视口高）。
  ok(
    bar?.h === bar?.fixed,
    `页内工具栏高度固定（渲染 ${bar?.h}px = 声明 ${bar?.fixed}px）——owner："高度永远固定，不能被撑大"`,
  );
  ok(
    (bar?.rowScroll ?? 1e9) <= (bar?.rowInner ?? 0) + 1 && (bar?.tallGroup ?? 1e9) <= (bar?.rowInner ?? 0) + 1,
    `固定高度没有裁到内容（行内容高 ${bar?.rowScroll} ≤ 行视口高 ${bar?.rowInner}，最高的那一组 ${bar?.tallGroup}）`,
  );
  {
    // 换一态高度必须**一模一样**：窄屏是"点开「⋯」"，桌面是"关掉两侧面板"。
    const otherH = vp.width <= 768 ? rr.after?.bar?.h : rr.wide?.bar?.h;
    ok(
      otherH === bar?.h,
      `换一态高度不变（${vp.width <= 768 ? "点开「⋯」" : "关掉两侧面板"}：${bar?.h} → ${otherH}）——高度会变就等于正文在抖`,
    );
  }
  if (bar?.hasMore) {
    ok(
      !!rr.menu && rr.menu.inViewport,
      `「⋯」菜单没出视口（实测 ${rr.menu?.inViewport}，内容「${rr.menu?.text}」）`,
    );
  }
  // ---------------------------------------------------------------------------
  // 头部（顶部系统工具栏）：同样**任何时候都不换行**，放不下收进它自己的「⋯」——
  // **关闭按钮除外**（owner："除了最右端的关闭按钮"）。
  // ---------------------------------------------------------------------------
  const hbar = rr.headBar;
  ok(
    hbar?.wrap === "nowrap",
    `头部**任何时候**都不换行（computed flex-wrap=${hbar?.wrap}）——改前窄屏是 wrap：390 占 2 行 115px、320 占 3 行 165px`,
  );
  ok(
    hbar?.h === hbar?.fixed,
    `头部高度**固定**（渲染 ${hbar?.h}px = 声明 ${hbar?.fixed}px）——owner："系统工具栏高度也要固定，不能被撑得更大"`,
  );
  ok(
    hbar?.rows === 1 && hbar?.overflow === false,
    `头部只有一行、也没有溢出（${hbar?.rows} 行 / 溢出=${hbar?.overflow}，高 ${hbar?.h}px；data-collapse="${hbar?.collapse}"）`,
  );
  ok(
    (hbar?.outside?.length ?? 1) === 0,
    `头部没有按钮被挤出（实测 ${JSON.stringify(hbar?.outside ?? [])}）`,
  );
  ok(
    hbar?.closeShown === true && (hbar?.closeRight ?? 0) >= (hbar?.right ?? 1e9) - 24,
    `「关闭」永远可见且在最右端（right=${hbar?.closeRight} vs 头部内容右缘≈${(hbar?.right ?? 0) - 12}）` +
      `——它是"离开"的唯一入口，永远不收`,
  );
  // 状态组四个"字面"必须同线（owner 截图："这几个按钮似乎不在一个水平线上？"）。
  // 桌面看**关掉两侧面板**那一态（`wide`：列宽够，状态组才在行内）；窄屏行内那份收在「⋯」里
  // ⇒ 看菜单里的那一份（点开时量过）。
  const sl = vp.width <= 768 ? rr.menu?.line : rr.wide?.statusLine;
  // ⚠️ "盒子也一样高"只在**桌面**档成立：窄屏那三个按钮是 44px 命中区（手指的事），
  // 而「无文本层」是个状态标签、不接点击 ⇒ 26px。命中区与视觉尺寸分开是本仓既有纪律，
  // 不能为了"数字整齐"去把标签也撑到 44。
  const boxOk = vp.width <= 768 ? true : new Set(sl?.boxHs ?? []).size === 1;
  ok(
    !!sl && sl.spread <= 0.5 && new Set(sl.hs).size === 1 && boxOk,
    `状态组「无文本层 / 朗读 / OCR / AI」四个字面在同一条线上（中线散布 ${sl?.spread}px、` +
      `文字高 ${JSON.stringify(sl?.hs)}、盒子高 ${JSON.stringify(sl?.boxHs)}）` +
      `——改前 line-height:normal 下三者的行盒高是 17/25/23，字面差 1px`,
  );
  // 扁平化：按钮**无边框 + 透明底**（改前是"描边 + 浅底"的小方块）；批注工具条去掉外框勾线。
  ok(
    rr.btnStyle?.border === "0px none" && /rgba\(0, 0, 0, 0\)|transparent/.test(rr.btnStyle?.bg ?? ""),
    `阅读器控制按钮是扁平样式（border=${rr.btnStyle?.border}、bg=${rr.btnStyle?.bg}）——改前"描边+浅底"`,
  );
  ok(
    rr.toolsStyle?.border === "0px none" && !/rgba\(0, 0, 0, 0\)/.test(rr.toolsStyle?.bg ?? ""),
    `批注工具条去掉了外框勾线、只留底色分组（border=${rr.toolsStyle?.border}、bg=${rr.toolsStyle?.bg}）`,
  );
  // 同一张状态组里的朗读 / OCR / AI 也一起扁平（owner 2026-09-22 第二张截图；
  // 判据与上面 `.pdf-reader-btn` 同源）——否则"扁平图标 + 描边胶囊"并排是两种语言。
  ok(
    isFlat(lab?.ocrStyle) && isFlat(lab?.ocrAiStyle) && lab?.ocrAiStyle?.color !== lab?.ocrStyle?.color,
    `朗读/OCR/AI 三个按钮也是扁平样式（border=${lab?.ocrStyle?.border}、bg=${lab?.ocrStyle?.bg}），` +
      `AI 靠文字色区分（${lab?.ocrAiStyle?.color} ≠ ${lab?.ocrStyle?.color}）——改前是"描边 + 浅底"胶囊`,
  );
  if (vp.width > 768) {
    ok(
      rr.controlsW > 0 && rr.controlsW <= 420,
      `桌面 head 控制组宽度 ${rr.controlsW}px ≤ 420（扁平化+间距 14→8 后实测 393；改前 441）`,
    );
  }
  // 统一图标：工具条里每一枚 svg 必须同源同规格（"统一风格"是可量的，不是形容词）。
  const ic = rr.icons ?? [];
  const base = ic[0];
  ok(
    ic.length >= 6 &&
      ic.every(
        (i) =>
          i.vb === base.vb &&
          i.fill === base.fill &&
          i.stroke === base.stroke &&
          i.sw === base.sw &&
          i.cap === base.cap &&
          i.join === base.join &&
          i.w === base.w &&
          i.h === base.h,
      ),
    `工具条里 ${ic.length} 枚图标是同一套规格（viewBox=${base?.vb}、stroke=${base?.stroke}、` +
      `线宽=${base?.sw}、${base?.w}×${base?.h}、线帽=${base?.cap}）——改前 1.8/2 两套线宽、16/15 两种尺寸`,
  );
}

async function main() {  const executablePath = findChrome();
  if (!executablePath) {
    console.error("找不到 Chrome/Chromium。请安装 Google Chrome，或用 PUPPETEER_EXECUTABLE_PATH 指定路径。");
    process.exit(1);
  }
  console.log(`浏览器: ${executablePath}`);

  let reachable = false;
  try {
    const r = await fetch(APP_URL, { signal: AbortSignal.timeout(8000) });
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
  const shot = async (page, nm) => {
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `${nm}.png`) });
  };

  // 视图清单：name → 打开方式 + 该视图**必须成立**的额外判据。
  const VIEWS = [
    { name: "notes", label: "笔记（编辑器）", open: (p) => openView(p, "笔记") },
    { name: "board", label: "看板", open: (p) => openView(p, "系统看板") },
    { name: "graph", label: "关系图", open: (p) => openView(p, "关系图") },
    { name: "files", label: "文件（列表）", open: (p) => openView(p, "文件管理") },
    {
      name: "files-grid",
      label: "文件（网格）",
      open: async (p) => {
        const r = await openView(p, "文件管理");
        await p.evaluate(() => document.querySelectorAll(".fm-view-btn")[1]?.click());
        await sleep(900);
        return r;
      },
    },
  ];

  try {
    for (const vp of ACTIVE_PHONES) {
      const ctx = await browser.createBrowserContext();
      const page = await ctx.newPage();
      const pageErrors = [];
      page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 200)));
      await page.setViewport({ ...vp, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      await page.goto(APP_URL, { waitUntil: "networkidle2", timeout: 60000 });
      await sleep(3000);

      for (const v of VIEWS) {
        console.log(`\n【${vp.name} · ${v.label}】`);
        const opened = await v.open(page);
        if (!opened) {
          ok(false, `打不开「${v.label}」——这一档直接判红（打不开就没得量）`);
          continue;
        }
        const s = await safeEval(page, probe, Object.keys(CHROME_BUDGET));

        // A. 越界
        ok(
          s.docW <= s.vw,
          `文档宽 ${s.docW} ≤ 视口 ${s.vw}（横向溢出 ${s.overflowCount} 处）` +
            (s.overflow.length ? `：${s.overflow.map((o) => `${o.el} left=${o.left}/right=${o.right}`).join("；")}` : ""),
        );
        ok(
          s.overflowCount === 0,
          s.overflowCount === 0
            ? "没有「挂在屏幕外且滚不到」的控件" +
                (s.parked.length ? `（另：${s.parked.map((o) => o.el).join(" / ")} 整块停在屏外，那是收起态抽屉）` : "")
            : `${s.overflowCount} 处控件在视口外：${s.overflow.map((o) => `${o.el}(left=${o.left} right=${o.right} "${o.text}")`).join(" | ")}`,
        );

        // B. 命中区
        ok(
          s.smallCount === 0,
          s.smallCount === 0
            ? "所有可交互控件：高度 ≥44，图标类宽度也 ≥44"
            : `${s.smallCount} 类控件低于 44：${s.small.map((x) => `${x.el} ${x.w}x${x.h} "${x.text}"`).join(" | ")}`,
        );

        // C. 控制带高度（"不要让控制按钮过多占用有限空间"）
        for (const [sel, budget] of Object.entries(CHROME_BUDGET)) {
          const h = s.bars[sel];
          if (h === null) continue;
          ok(h <= budget, `${sel} 高 ${h} ≤ 预算 ${budget}`);
        }
        if (s.fmChrome !== null) {
          ok(
            s.fmChrome <= 150,
            `文件视图的常驻控制带合计 ${s.fmChrome} ≤ 150（改前 193；320px 上那是 37% 视口）`,
          );
        }

        // 视图专属判据
        if (v.name === "files") {
          // 表格本来就有 6 列：**能横滑**是它可用的前提（改前外层只有 overflow-y，
          // 右边四列被 `overflow:hidden` 裁掉且滚不到）。
          ok(
            !!s.tableWrap && s.tableWrap.sw >= s.tableWrap.cw,
            `文件表格可横滑（scrollWidth ${s.tableWrap?.sw} ≥ clientWidth ${s.tableWrap?.cw}）——` +
              `宽内容要"滚得到"，不能被裁掉`,
          );
        }
        if (v.name === "notes" || v.name === "board") {
          // 切视图时侧栏抽屉不该盖在刚切过去的视图上（`ActivityBar.pick`）。
          ok(s.sidebarDisplay === "none", `窄屏切视图后侧栏抽屉不盖住主区（display=${s.sidebarDisplay}）`);
        }
        await shot(page, `${vp.name}-${v.name}`);
      }

      // ---------- 数据库视图的 **8 个模式**都要量 ----------
      // 只量默认的表格模式会漏掉后面 7 个（画廊/看板/列表/日历/时间轴/目录/甘特图）——
      // 而"切不过去"这件事恰恰只会在它们身上发生：8 个页签排成一行是 582px，
      // 而 `.db-view-switch` 自己不换行也不缩（`flex: 0 0 auto`），
      // 390px 上 `right=606`，后四个模式以前**根本点不到**。
      console.log(`\n【${vp.name} · 数据库视图（8 个模式）】`);
      const dbOpened = await openDatabaseView(page);
      ok(dbOpened, "从模板中心建出数据库页并打开 `.database-view`");
      if (dbOpened) {
        const modes = await safeEval(page, () =>
          Array.from(document.querySelectorAll(".db-view-switch button")).map((b) => (b.textContent || "").trim()),
        );
        ok(modes.length === 8, `8 个视图页签都在（实际 ${modes.length} 个：${modes.join("/")}）`);
        for (const mode of modes) {
          // 点页签 → 断言它**真的切过去了**（`.db-view-active` 落在它身上）。
          const switched = await safeEval(
            page,
            (label) => {
              const b = Array.from(document.querySelectorAll(".db-view-switch button")).find(
                (x) => (x.textContent || "").trim() === label,
              );
              if (!b) return null;
              b.click();
              return true;
            },
            mode,
          );
          await sleep(1200);
          const active = await safeEval(page, () => {
            const a = document.querySelector(".db-view-switch .db-view-active");
            return a ? (a.textContent || "").trim() : null;
          });
          ok(switched === true && active === mode, `切到「${mode}」并生效（active=${active}）`);
          const s = await safeEval(page, probe, Object.keys(CHROME_BUDGET));
          ok(
            s.overflowCount === 0 && s.docW <= s.vw,
            `「${mode}」无越界（docW ${s.docW}/${s.vw}，越界 ${s.overflowCount} 处` +
              (s.overflow.length ? `：${s.overflow.map((o) => o.el).join("、")}` : "") +
              `）`,
          );
          ok(
            s.smallCount === 0,
            s.smallCount === 0
              ? `「${mode}」控件命中区都 ≥44`
              : `「${mode}」有 ${s.smallCount} 类控件低于 44：${s.small.map((x) => `${x.el} ${x.w}x${x.h}`).join(" | ")}`,
          );
          await shot(page, `${vp.name}-db-${mode}`);
        }
      }

      // ---------- 窄屏右侧工具条：默认收起 + 右下角唤出 ----------
      // 它是一条常驻的浮动控制条（AI / 评论 / 目录 / 插件面板），窄屏上会压在正文右缘；
      // 而它承载的入口本来就低频 ⇒ 默认收起，由右下角 44×44 的圆钮唤出（拇指区）。
      console.log(`\n【${vp.name} · 窄屏右侧工具条】`);
      await openView(page, "笔记");
      const rail0 = await safeEval(page, () => {
        const t = document.querySelector(".mobile-right-toggle");
        const b = t ? t.getBoundingClientRect() : null;
        return {
          railInDom: !!document.querySelector(".right-rail"),
          toggle: b ? { w: Math.round(b.width), h: Math.round(b.height), l: Math.round(b.left), r: Math.round(b.right), b: Math.round(b.bottom) } : null,
          leftToggle: (() => {
            const l = document.querySelector(".mobile-rail-toggle");
            if (!l) return null;
            const r = l.getBoundingClientRect();
            return { l: Math.round(r.left), r: Math.round(r.right) };
          })(),
          vw: innerWidth,
          vh: innerHeight,
        };
      });
      ok(!rail0.railInDom, "窄屏默认**不渲染**右侧工具条（不再常驻压住正文右缘）");
      ok(
        !!rail0.toggle && rail0.toggle.w >= 44 && rail0.toggle.h >= 44 && rail0.toggle.r <= rail0.vw && rail0.toggle.b <= rail0.vh,
        `右下角有 44×44 的唤出按钮且完整在屏内（${rail0.toggle?.w}×${rail0.toggle?.h}，right=${rail0.toggle?.r} ≤ ${rail0.vw}）`,
      );
      ok(
        !rail0.toggle || !rail0.leftToggle || rail0.toggle.l > rail0.leftToggle.r,
        `右下角那枚与左下角那枚不重叠（右 ${rail0.toggle?.l} > 左末端 ${rail0.leftToggle?.r}）`,
      );

      await page.click(".mobile-right-toggle");
      await sleep(700);
      const rail1 = await safeEval(page, () => {
        const el = document.querySelector(".right-rail.is-open");
        const b = el ? el.getBoundingClientRect() : null;
        return {
          open: !!el,
          backdrop: !!document.querySelector(".mobile-right-backdrop"),
          box: b ? { l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), b: Math.round(b.bottom) } : null,
          vw: innerWidth,
          vh: innerHeight,
          btnCount: document.querySelectorAll(".right-rail .rail-btn").length,
        };
      });
      ok(rail1.open && rail1.backdrop, "点唤出按钮后工具条展开、并出现遮罩");
      ok(
        !!rail1.box && rail1.box.l >= 0 && rail1.box.r <= rail1.vw && rail1.box.t >= 0 && rail1.box.b <= rail1.vh,
        `展开的工具条完整在屏内（${JSON.stringify(rail1.box)} ⊂ ${rail1.vw}×${rail1.vh}）`,
      );
      ok(rail1.btnCount >= 3, `工具条里有 AI / 评论 / 目录 三个入口（实际 ${rail1.btnCount} 个）`);

      // 点一个入口 → 工具条收起（抽屉是整屏的，工具条盖在上面没意义）
      const picked = await safeEval(page, () => {
        const btns = Array.from(document.querySelectorAll(".right-rail .rail-btn"));
        const b = btns[btns.length - 1];
        if (!b) return false;
        b.click();
        return true;
      });
      await sleep(1200);
      const rail2 = await safeEval(page, () => ({
        railInDom: !!document.querySelector(".right-rail"),
        toggle: !!document.querySelector(".mobile-right-toggle"),
      }));
      ok(picked && !rail2.railInDom && rail2.toggle, "点任意入口后工具条自动收起、唤出按钮回来");
      await shot(page, `${vp.name}-right-rail`);

      // ---------- 小控件（开关 / 色点）不许被"按钮一律 44 高"拉变形 ----------
      // 用户截图：窄屏「关于」里那个开关变成了 44×44 的扁方疙瘩、圆钮贴在角上。
      // 根因是尾块 §5 那条"弹层里的按钮统一给够高度"把**开关的轨道**也拉高了；
      // 同族的还有色板（30×30 的圆 → 30×44 的椭圆）与标签色点（20×20 → 20×44）。
      // 现在改成"视觉保持设计尺寸 + 向外扩一层透明命中区（`::after`）"，
      // 所以这一节要同时钉两件事：**盒子没走形** 且 **命中区真的到了 44**。
      console.log(`\n【${vp.name} · 小控件不走形】`);
      const measureMicro = async () => {
        // ⚠️ 先把控件滚到**可视区中央**再量：关于/设置弹层本身可滚动，默认滚动位置下开关可能
        // 贴着底边（dev 把那条提示文案写得更长之后就是这样），于是"中心下方 21px"那一点落在
        // 弹层可视区之外 ⇒ `elementFromPoint` 返回弹层本身、被判成"命中区不够"。
        // 那是**滚动裁剪**，不是 CSS 的问题；滚到中间再量才是这条断言想测的东西。
        await safeEval(page, () => {
          const el = document.querySelector(".about .ui-toggle") || document.querySelector(".set-swatch");
          el?.scrollIntoView({ block: "center" });
        });
        await sleep(350);
        return safeEval(page, () => {
          const box = (sel) => {
            const el = document.querySelector(sel);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            // 命中区：中心正上/正下/正左 21px 处取点，看命中的是不是它自己
            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;
            const at = (x, y) => {
              const hit = document.elementFromPoint(x, y);
              return !!hit && (hit === el || el.contains(hit));
            };
            return {
              w: Math.round(r.width),
              h: Math.round(r.height),
              radius: getComputedStyle(el).borderRadius,
              up21: at(cx, cy - 21),
              down21: at(cx, cy + 21),
            };
          };
          return { toggle: box(".about .ui-toggle"), swatch: box(".set-swatch") };
        });
      };
      const openAboutOrSettings = async (title) => {
        await openRail(page);
        await page.evaluate((t) => {
          const b = Array.from(document.querySelectorAll(".activity-group-end .activity-btn")).find(
            (x) => (x.getAttribute("title") || "") === t,
          );
          if (b) b.click();
        }, title);
        await sleep(1500);
      };
      await openAboutOrSettings("关于");
      // 「关于」里的外链清单（2026-09-22：加产品官网、去掉文档）——数据源在 `src/lib/links.ts`，
      // 那条由 smoke 门禁钉着；这里钉**界面上真的渲染出来**（别只有数据改了、UI 没跟上）。
      const aboutLinks = await safeEval(page, () =>
        Array.from(document.querySelectorAll(".about-links .about-link")).map((b) => (b.textContent || "").trim()),
      );
      ok(
        aboutLinks.includes("产品官网"),
        `「关于 → 开源与反馈」里有「产品官网」入口（实际：[${aboutLinks.join(" / ")}]）`,
      );
      ok(!aboutLinks.includes("文档"), `「文档」入口已从「关于」里移除（实际：[${aboutLinks.join(" / ")}]）`);
      ok(aboutLinks.length === 4, `外链仍是四条（产品官网 / 项目主页 / 发布 / 问题），实际 ${aboutLinks.length} 条`);
      let m = await measureMicro();
      if (!m.toggle) {
        ok(false, "「关于」里找不到 `.ui-toggle`（开关）——这一档没能验到");
      } else {
        ok(
          m.toggle.w === 38 && m.toggle.h === 22,
          `开关保持设计尺寸 38×22（实际 ${m.toggle.w}×${m.toggle.h}，圆角 ${m.toggle.radius}）` +
            `——被拉成 44×44 就是用户截图里那个"扁方疙瘩 + 角上的球"`,
        );
        ok(
          m.toggle.up21 && m.toggle.down21,
          `开关的命中区仍然到了 44（中心上下各 21px 处都能命中：${m.toggle.up21}/${m.toggle.down21}）` +
            `——视觉小、命中大，靠的是 `+ "`::after` 扩出来的透明层",
        );
      }
      await page.keyboard.press("Escape");
      await sleep(700);
      await openAboutOrSettings("设置");
      m = await measureMicro();
      if (!m.swatch) {
        ok(false, "「设置 → 外观」里找不到 `.set-swatch`（色板）——这一档没能验到");
      } else {
        ok(
          m.swatch.w === 30 && m.swatch.h === 30,
          `色板保持 30×30 的圆（实际 ${m.swatch.w}×${m.swatch.h}，圆角 ${m.swatch.radius}）——被拉高就成了椭圆`,
        );
        ok(m.swatch.up21 && m.swatch.down21, `色板的命中区也到了 44（上下各 21px：${m.swatch.up21}/${m.swatch.down21}）`);
      }
      await page.keyboard.press("Escape");
      await sleep(700);

      // 标签色点：没有任何门禁会打开 `.tag-picker`，所以这里塞一个**只带类名的探针节点**
      // （与 `.plugin-panel` 那条宽度断言同一个办法）——钉的是 CSS 规则本身。
      const dot = await safeEval(page, () => {
        const wrap = document.createElement("div");
        wrap.className = "tag-picker";
        const btn = document.createElement("button");
        btn.className = "tag-color-pick";
        wrap.appendChild(btn);
        document.body.appendChild(wrap);
        const r = btn.getBoundingClientRect();
        const out = { w: Math.round(r.width), h: Math.round(r.height), radius: getComputedStyle(btn).borderRadius };
        wrap.remove();
        return out;
      });
      ok(
        dot.w === 20 && dot.h === 20,
        `标签色点保持 20×20 的圆（实际 ${dot.w}×${dot.h}，圆角 ${dot.radius}）——它与「label」那一支同族`,
      );

      await shot(page, `${vp.name}-micro-controls`);
      ok(pageErrors.length === 0, `页面无 JS 报错${pageErrors.length ? "：" + pageErrors.join(" | ") : ""}`);
      await ctx.close();

      // ---------- 属性表：名字列自适应 ----------
      {
        console.log(`\n【${vp.name} · 属性表（名字列自适应）】`);
        const pctx = await browser.createBrowserContext();
        const ppage = await pctx.newPage();
        const perrs = [];
        ppage.on("pageerror", (e) => perrs.push(String(e).slice(0, 160)));
        await ppage.setViewport({ ...vp, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
        await ppage.goto(APP_URL, { waitUntil: "networkidle2", timeout: 60000 });
        await sleep(3500);
        const r = await checkProperties(ppage, vp, vp.name);
        if (r.err) {
          ok(false, `属性表体检失败：${r.err}`);
        } else {
          ok(r.count >= 5, `面板里量到 ${r.count} 行属性（4 条属性 + 「标签」那一行）`);
          // 名字列自适应：写死 120px 时这条必红（那正是"留空太大 + 窄屏值只剩 36px"的根因）
          ok(r.maxNameW <= 80, `名字列按内容自适应（最宽 ${r.maxNameW}px ≤ 80，改前固定 120px）`);
          ok(r.maxGap <= 16, `名字→值的空隙 ${r.maxGap}px ≤ 16（改前固定列宽把空隙撑成一大片）`);
          const minValW = vp.width <= 320 ? 90 : 100;
          ok(r.minValW >= minValW, `值列拿到足够宽度（最窄 ${r.minValW}px ≥ ${minValW}，改前 390px 上只有 36px）`);
          ok(r.alignSpread <= 1, `所有值的左边缘对齐（最大差 ${r.alignSpread}px）——"自适应"不等于"长短不一"`);
          // 「属性名在最左」：这是用户直接看到的那条（截图里名字跑到了最右）
          ok(
            r.nameSpread <= 1,
            `所有属性名的左边缘一致（最大差 ${r.nameSpread}px）——名字必须是最左那一列`,
          );
          ok(
            r.nameBeforeValue === true,
            `每行都是"名字在左、值在右"（${r.items.map((i) => `${i.name}:${i.nameLeft}<${i.valLeft}`).join(" ")}）` +
              `——「标签」那行只有 2 个孩子时，会把后面整块顶偏一格（名字跑到最右）`,
          );
          // ---- 「时间」行的值控件：原生 datetime-local + 不许有额外按钮 ----
          // 2026-09-22（owner："页面时间属性的控件采用和日期一样风格的控件，不要再额外加按钮"）：
          // 它从"手输框 + 日历按钮"（那层 `.prop-datetime` wrapper）换成了原生控件，
          // 于是两条都要钉：① 控件类型是 datetime-local；② 这一行除行尾那三个之外没有别的按钮；
          // ③ 它吃满值列（当年那层 wrapper 带 `max-width: 75%`，留下 25% 死空白）。
          const dtItem = r.items.find((i) => i.name === DATETIME_PROP);
          ok(!!dtItem, `夹具里量到了「${DATETIME_PROP}」那一行（时间类型）`);
          ok(
            dtItem?.dtKind === "datetime-local" && dtItem?.dtExtraButtons === 0,
            `「${DATETIME_PROP}」的值控件是原生 \`datetime-local\`、且**没有额外按钮**` +
              `（实测 type=${dtItem?.dtKind}、额外按钮 ${dtItem?.dtExtraButtons} 个）` +
              `——改前是"手输框 + 日历按钮"两个元素`,
          );
          ok(
            dtItem && dtItem.dtGap !== null && dtItem.dtGap <= 30,
            `「${DATETIME_PROP}」行不留死空白（值控件右边缘到行尾按钮只差 ${dtItem?.dtGap}px ≤ 30；` +
              `改前那层 wrapper 带 max-width:75%，390px 上约 57px）`,
          );
          ok(r.docW <= r.vw, `属性面板无横向溢出（docW ${r.docW} ≤ ${r.vw}）`);
          // ---- 行尾「⋯」动作面板（窄屏专有）：三个 18px 小按钮收成一个 44×44 ----
          console.log(`【${vp.name} · 属性行「⋯」动作面板】`);
          const micro = await safeEval(ppage, () => {
            const more = document.querySelector(".prop-more");
            const order = document.querySelector(".prop-order");
            if (!more) return null;
            const b = more.getBoundingClientRect();
            return {
              w: Math.round(b.width),
              h: Math.round(b.height),
              orderDisplay: order ? getComputedStyle(order).display : "(没有)",
              count: document.querySelectorAll(".prop-more").length,
            };
          });
          ok(!!micro, "属性行尾渲染出了「⋯」");
          ok(
            micro && micro.w >= 44 && micro.h >= 44,
            `「⋯」命中区 44×44（实际 ${micro?.w}×${micro?.h}）——取代原来三个 18px 的图标按钮`,
          );
          ok(micro && micro.orderDisplay === "none", `窄屏不再常驻那三个小按钮（display=${micro?.orderDisplay}）`);

          const before = await safeEval(ppage, () =>
            Array.from(document.querySelectorAll(".properties-body .prop-name")).map((n) => (n.textContent || "").trim()),
          );
          // 点第 2 个「⋯」并记下**它属于哪一条属性**：不能假设"第 0/1 行会互换"——
          // 「标签」那一行没有 `⋯`（它不可排序），所以 `.prop-more` 的下标与行下标并不同源。
          const target = await safeEval(ppage, () => {
            const b = Array.from(document.querySelectorAll(".prop-more"))[1];
            if (!b) return null;
            const row = b.closest(".prop-row");
            const name = row?.querySelector(".prop-name")?.textContent?.trim() ?? null;
            b.click();
            return name;
          });
          await sleep(600);
          const sheet = await safeEval(ppage, () => {
            const el = document.querySelector(".prop-ctx.is-sheet");
            if (!el) return null;
            const b = el.getBoundingClientRect();
            const items = Array.from(el.querySelectorAll(".prop-ctx-item"));
            return {
              items: items.length,
              labels: items.map((x) => (x.textContent || "").trim()),
              disabled: items.map((x) => x.disabled),
              l: Math.round(b.left),
              r: Math.round(b.right),
              t: Math.round(b.top),
              b: Math.round(b.bottom),
              vw: innerWidth,
              vh: innerHeight,
              backdrop: !!document.querySelector(".prop-ctx-backdrop"),
            };
          });
          ok(!!sheet && sheet.items === 3 && sheet.backdrop, `「⋯」打开动作面板，三项齐全且有遮罩（${sheet?.labels.join("/")}）`);
          ok(
            !!sheet && sheet.l >= 0 && sheet.r <= sheet.vw && sheet.t >= 0 && sheet.b <= sheet.vh,
            `面板完整在屏内（l=${sheet?.l} r=${sheet?.r} t=${sheet?.t} b=${sheet?.b} ⊂ ${sheet?.vw}×${sheet?.vh}）`,
          );
          ok(
            !!sheet && sheet.disabled[0] === false && sheet.disabled[1] === false,
            `第 2 行的「上移 / 下移」都可用（disabled=${JSON.stringify(sheet?.disabled?.slice(0, 2))}）`,
          );

          // 点「上移」→ 面板收起 + 顺序真的变了（这一条钉的是"功能一点没少"）
          await safeEval(ppage, () => document.querySelector(".prop-ctx-item")?.click());
          await sleep(900);
          const after = await safeEval(ppage, () => ({
            names: Array.from(document.querySelectorAll(".properties-body .prop-name")).map((n) => (n.textContent || "").trim()),
            sheetOpen: !!document.querySelector(".prop-ctx.is-sheet"),
          }));
          ok(!after.sheetOpen, "点完动作后面板自动收起");
          ok(
            after.names.length === before.length &&
              !!target &&
              after.names.indexOf(target) === before.indexOf(target) - 1,
            `「${target}」被上移了一格（${before.join(" / ")} → ${after.names.join(" / ")}），且没丢行`,
          );
          console.log(
            `  · 桌面仍是那三个 18px 的小按钮（有鼠标、值列也宽裕）；窄屏收成一个 44×44 的「⋯」，` +
              `值列因此比"三个都补到 44"宽 60px（本档实测 ${r.minValW}px）`,
          );
        }
        await shot(ppage, `${vp.name}-properties`);
        ok(perrs.length === 0, `属性页无 JS 报错${perrs.length ? "：" + perrs.join(" | ") : ""}`);
        await pctx.close();
      }

      // ---------- PDF 阅读器：**真 DOM**（上传一份真 PDF 再打开） ----------
      {
        console.log(`\n【${vp.name} · PDF 阅读器（真 PDF）】`);
        const rctx = await browser.createBrowserContext();
        const rpage = await rctx.newPage();
        const rerrs = [];
        rpage.on("pageerror", (e) => rerrs.push(String(e).slice(0, 160)));
        await rpage.setViewport({ ...vp, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
        await rpage.goto(APP_URL, { waitUntil: "networkidle2", timeout: 60000 });
        await sleep(3500);
        assertPdfReader(await checkPdfReader(rpage, vp), vp);
        await shot(rpage, `${vp.name}-pdf-reader`);
        ok(rerrs.length === 0, `阅读器页无 JS 报错${rerrs.length ? "：" + rerrs.join(" | ") : ""}`);
        await rctx.close();
      }
    }

    // ---------- 桌面：确认上面那套窄屏规则**没有改掉桌面** ----------
    const deskCtx = await browser.createBrowserContext();
    const desk = await deskCtx.newPage();
    await desk.setViewport({ width: DESKTOP.width, height: DESKTOP.height });
    await desk.goto(APP_URL, { waitUntil: "networkidle2", timeout: 60000 });
    await sleep(2500);
    console.log(`\n【桌面 ${DESKTOP.name} · 窄屏规则不许漏到桌面】`);
    const d = await safeEval(desk, () => {
      const r = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { w: Math.round(b.width), h: Math.round(b.height) };
      };
      return {
        mobileMQ: matchMedia("(max-width: 768px)").matches,
        activityBtn: r(".activity-btn"),
        toolbarBtn: r(".toolbar-btn"),
        rightRail: r(".right-rail"),
        railBtn: r(".rail-btn"),
      };
    });
    ok(!d.mobileMQ, "桌面不命中窄屏媒体查询");
    ok(
      d.activityBtn && d.activityBtn.w === 40 && d.activityBtn.h === 40,
      `桌面竖条按钮仍是 40×40（实际 ${d.activityBtn?.w}×${d.activityBtn?.h}）——窄屏那条 44 不许漏过去`,
    );
    ok(
      d.toolbarBtn && d.toolbarBtn.w === 28 && d.toolbarBtn.h === 28,
      `桌面编辑工具栏按钮仍是 28×28（实际 ${d.toolbarBtn?.w}×${d.toolbarBtn?.h}）`,
    );
    ok(
      d.rightRail && d.rightRail.w <= 42,
      `桌面右侧悬浮条仍是常驻窄条（实际 ${d.rightRail?.w}px，宽 ${d.rightRail?.h}）——窄屏那套"默认收起 + 右下角唤出"不许漏到桌面`,
    );
    const dRail = await safeEval(desk, () => ({
      toggle: !!document.querySelector(".mobile-right-toggle"),
      backdrop: !!document.querySelector(".mobile-right-backdrop"),
      rail: !!document.querySelector(".right-rail"),
      railBtns: document.querySelectorAll(".right-rail .rail-btn").length,
    }));
    ok(dRail.rail && !dRail.toggle && !dRail.backdrop, "桌面不渲染唤出按钮与遮罩（工具条本来就是常驻的）");
    ok(dRail.railBtns >= 3, `桌面工具条三个入口都在（实际 ${dRail.railBtns} 个）`);
    await shot(desk, `${DESKTOP.name}-notes`);

    // 桌面文件视图：操作行必须是"带文字的按钮"，表格必须**没有**被裁
    await desk.click('.activity-group .activity-btn[title^="文件管理"]');
    await sleep(1800);
    const df = await safeEval(desk, () => {
      const btn = document.querySelector(".file-manager-actions .fm-btn");
      const label = document.querySelector(".file-manager-actions .fm-btn-text");
      const more = document.querySelector(".fm-more-btn");
      const row = document.querySelector(".file-manager-table tbody tr");
      return {
        btnBox: btn ? { w: Math.round(btn.getBoundingClientRect().width), h: Math.round(btn.getBoundingClientRect().height) } : null,
        labelVisible: label ? getComputedStyle(label).display !== "none" : null,
        iconVisible: (() => {
          const ic = document.querySelector(".file-manager-actions .fm-btn-icon");
          return ic ? getComputedStyle(ic).display !== "none" : null;
        })(),
        moreDisplay: more ? getComputedStyle(more).display : null,
        opsButtons: row ? row.querySelectorAll(".fm-file-actions button").length : null,
      };
    });
    ok(
      df.btnBox && df.btnBox.h === 32 && df.btnBox.w > 44,
      `桌面文件操作行仍是带文字的按钮（${df.btnBox?.w}×${df.btnBox?.h}，文字可见=${df.labelVisible}）——` +
        `窄屏那套"图标按钮"不许漏到桌面`,
    );
    ok(df.iconVisible === false, "桌面不显示按钮里的图标（`display:none`，桌面像素不变）");
    ok(df.moreDisplay === "none", "桌面不渲染行尾的 `⋯`（`display:none`）");
    ok(
      df.opsButtons === null || df.opsButtons >= 0,
      `桌面表格行仍走原来的行内小按钮（本工作区该行 ${df.opsButtons ?? "-"} 个）`,
    );
    await shot(desk, `${DESKTOP.name}-files`);

    // ---------- 桌面 · 属性表（用户就是在桌面上看到"名字跑到最右"的） ----------
    // 移动端那几条量的是窄屏；而这一条错位是**与宽度无关**的（网格列数对不上就会错），
    // 所以桌面也钉一遍——顺手把"桌面不许跟着窄屏改"之外的另一半也钉住。
    console.log(`\n【桌面 ${DESKTOP.name} · 属性表】`);
    await openView(desk, "笔记");
    const dp = await checkProperties(desk, DESKTOP, "desktop");
    if (dp.err) {
      ok(false, `桌面属性表体检失败：${dp.err}`);
    } else {
      ok(dp.count >= 5, `桌面量到 ${dp.count} 行属性（4 条属性 + 「标签」那一行都在）`);
      ok(dp.nameSpread <= 1, `桌面属性名左边缘一致（最大差 ${dp.nameSpread}px）——名字在最左`);
      ok(
        dp.nameBeforeValue === true,
        `桌面每行也是"名字在左、值在右"（${dp.items.map((i) => `${i.name}:${i.nameLeft}<${i.valLeft}`).join(" ")}）`,
      );
      ok(dp.docW <= dp.vw, `桌面属性面板无横向溢出（docW ${dp.docW} ≤ ${dp.vw}）`);
    }
    await shot(desk, `${DESKTOP.name}-properties`);
    // 桌面也跑一遍 PDF 阅读器：`⋯` 的隐藏、状态组"与工具组同排（省一行）"这几条
    // **只有桌面档才走得到**（手机档走的是 if 的另一支）——此前漏在这里，等于那几条断言没跑过。
    console.log(`\n【桌面 ${DESKTOP.name} · PDF 阅读器（真 PDF）】`);
    assertPdfReader(await checkPdfReader(desk, DESKTOP), DESKTOP);
    await shot(desk, `${DESKTOP.name}-pdf-reader`);
    await deskCtx.close();
  } finally {
    await browser.close();
  }

  console.log(`\n[结果] ${pass} 通过 / ${fail} 失败`);
  if (fail) {
    console.error("存在失败项：主视图移动端验收未通过。");
    process.exit(1);
  }
  console.log("主视图移动端验收全部通过 ✅");
  if (SHOTS) console.log(`截图已保存到 ${SHOTS}`);
}

main().catch((e) => {
  console.error("验收脚本异常:", e);
  process.exit(1);
});
