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

// 断点：**窄（宽 ≤768）或矮（高 ≤520）**。两个数分别与 `useMobile.ts` 的
// `MOBILE_BREAKPOINT_PX` / `SHORT_VIEWPORT_MAX_PX` 同源，都要在这里量一遍。
//
// 三个手机视口：
//   360×640 / 390×844 = 竖屏（窄，不矮）；
//   **792×360 = 横屏**（不窄，但矮）—— 2026-09-15 新增。上一轮只测竖屏，
//   于是"792×360 走宽屏分支 ⇒ `.set-dialog` 的 `min-height:420px` 压过
//   `max-height:calc(100vh-48px)` ⇒ 底边 444、**底部 84px 被裁在屏外**"这一类
//   只在**横屏**出现的坏法完全没被覆盖（断言只量了 min-width，漏了高度轴）。
const PHONES = [
  { name: "360x640", width: 360, height: 640, narrow: true },
  { name: "390x844", width: 390, height: 844, narrow: true },
  { name: "792x360", width: 792, height: 360, narrow: false },
];
// 调试用：`ONLY_VP=792x360` 只跑一档（改脚本时不必等三档跑完）。
// **门禁不许用它**——全量跑才是签收口径。
const ONLY_VP = process.env.ONLY_VP || "";
const ACTIVE_PHONES = ONLY_VP ? PHONES.filter((p) => p.name === ONLY_VP) : PHONES;
if (ONLY_VP && !ACTIVE_PHONES.length) {
  console.error(`ONLY_VP=${ONLY_VP} 不对，可选：${PHONES.map((p) => p.name).join(" / ")}`);
  process.exit(1);
}
const DESKTOP = { name: "1280x800", width: 1280, height: 800 };

/** 矮视口断点（与 useMobile.ts 的 SHORT_VIEWPORT_MAX_PX 同一个数）。 */
const SHORT_VIEWPORT_MAX_PX = 520;

/**
 * 模拟软键盘高度：直接写 `--kb`。
 *
 * 为什么是"注入变量"而不是真的弹键盘：**浏览器里没有软键盘**。
 * 但真机上这个变量由壳层从 IME 窗口 inset 送进来（见 `src/lib/viewportInsets.ts`
 * 与 `scripts/android-mobile-shell.mjs`），CSS 只是消费它——
 * 所以"写 `--kb` 之后底部弹层有没有抬起来"正是**能在这台机器上验的那一半**，
 * 另一半（壳层送不送得进来）只能真机验，报告里会写明。
 */
const KB_PROBE_PX = 260;

/** 注入的假状态栏高度（与真机实测的 41 CSS px 一致）。 */
const STATUS_BAR_PROBE_PX = 41;

const shotsArg = process.argv.indexOf("--shots");
const SHOTS = shotsArg > -1 ? process.argv[shotsArg + 1] : null;

let pass = 0;
let fail = 0;
// PDF 内部分栏的 CSS 级断言只需要跑一次（样式表与视口无关），但要在**已经进过窄屏视口**
// 的页面里查（那段媒体查询只在命中时才出现在 cssRules 里）。
let pdfCssChecked = false;
// 手机上的同步入口同理：只在一个窄屏视口里查一次就够（它是个固定定位的小控件）。
let mobileSyncChecked = false;
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
 *
 * `fullscreen: true` = §4.1.1 分类里的「**全屏 + 内部滚动**」那一族（大面板 / 右栏抽屉）：
 * 该族必须**真的铺满**——遮罩铺满视口、盒子铺满遮罩内容盒。
 * ⚠️ 这一族此前只有"四边在视口内"那条断言，而它**挡不住被压窄**（72px 宽的
 * `.fm-preview-overlay` 四边也都在视口里、912 条断言全绿）。见下面 (1b)。
 * 底部弹层那一族（`sheet: true`）**不标**：它们本来就只在底部、本来就不该铺满。
 */
const OVERLAYS = [
  { id: "settings", label: "设置面板", root: ".set-overlay", box: ".set-dialog", sheet: false, fullscreen: true },
  { id: "confirm", label: "确认框", root: ".confirm-overlay", box: ".confirm-box", sheet: true },
  { id: "input", label: "输入框", root: ".confirm-overlay", box: ".confirm-box", sheet: true },
  { id: "search", label: "搜索浮层", root: ".search-popover", box: ".search-popover", sheet: true, sheetClass: true },
  { id: "trash", label: "回收站", root: ".trash-popover", box: ".trash-popover", sheet: true, sheetClass: true },
  { id: "sync", label: "同步面板", root: ".sync-popover", box: ".sync-popover", sheet: true, sheetClass: true },
  { id: "pluginManager", label: "插件管理", root: ".plugin-manager-overlay", box: ".plugin-manager", sheet: false, fullscreen: true },
  { id: "storage", label: "存储 / 空间管理", root: ".stg-overlay", box: ".stg-panel", sheet: false, optional: true, fullscreen: true },
  { id: "palette", label: "命令面板", root: ".palette-overlay", box: ".palette", sheet: false, fullscreen: true },
  { id: "shortcuts", label: "快捷键", root: ".shortcuts-overlay", box: ".shortcuts", sheet: true },
  { id: "about", label: "关于", root: ".shortcuts-overlay", box: ".about", sheet: true },
  { id: "communitySave", label: "社区保存", root: ".community-save-overlay", box: ".community-save-box", sheet: true },
  { id: "formula", label: "公式编辑器", root: ".formula-editor-overlay", box: ".formula-editor", sheet: false, fullscreen: true },
  { id: "emoji", label: "图标选择器", root: ".emoji-picker-overlay", box: ".emoji-picker", sheet: true },
  { id: "toc", label: "目录", root: ".toc-panel", box: ".toc-panel", sheet: false, fullscreen: true },
  { id: "ai", label: "AI 助手", root: ".ai-panel", box: ".ai-panel", sheet: false, fullscreen: true },
  { id: "comments", label: "评论 / 通知", root: ".comments-drawer", box: ".comments-drawer", sheet: false, fullscreen: true },
  { id: "markdownImport", label: "Markdown 导入", root: ".markdown-import-overlay", box: ".markdown-import", sheet: true, optional: true },
  { id: "cover", label: "题头图", root: ".cover-overlay", box: ".cover-picker", sheet: true, optional: true },
  // 2026-09-15 第二轮：`.history-popover` 原来是 `position:absolute` 的 320px 锚定浮层，
  // 窄屏**没走** §4.1.3 的 is-sheet 形态 ⇒ 360×640 实测左边缘 = **−6px**（越界）。
  // 改成 `usePopover` + `is-sheet` 之后才有资格进这份清单（`sheetClass` 钉住 JS 侧分支）。
  { id: "history", label: "版本历史", root: ".history-popover", box: ".history-popover", sheet: true, sheetClass: true },
  // 2026-09-15 第三轮：`.fm-preview-overlay` 的 `left: calc(--activity-w + --sidebar-w)`
  // 在窄屏**没被覆盖**，而 `--sidebar-w` 是**桌面**侧栏宽度——窄屏的侧栏早已收成抽屉，
  // 变量却仍是 240px ⇒ 360×640 实测这个文件预览浮层只有 **72px 宽**
  // （= 360 − 48 竖条 − 240 侧栏），文件预览在手机上等于打不开（与 `.set-dialog`
  // 的 `min-width:640px` 同一类："功能不可用，而且不报错"）。
  // 改成 §4.1.1 的"大面板 → 全屏 + 内部滚动"（遮罩加 inset padding）后才进的这份清单。
  { id: "filePreview", label: "文件预览", root: ".fm-preview-overlay", box: ".fm-preview", sheet: false, fullscreen: true },
];

/** 主要操作按钮的文案（验收口径写在任务里，别改）。 */
const ACTION_TEXT = ["确定", "取消", "保存", "关闭", "完成", "创建", "应用"];

// ---------------------------------------------------------------------------
// 在页面里跑的探针。`page.evaluate` 会把函数序列化过去，所以这里不能引用外部变量。
// ---------------------------------------------------------------------------

/**
 * 打开一层。走应用**自己的 store**（与界面同一条路），而不是往 DOM 里塞假节点。
 *
 * ⚠️ 取模块必须**按 app 实际加载过的 URL**（`store()` 里那三行），不能直接
 * `import("/src/store/notes.ts")`：Vite 在源码改过之后会给模块 URL 挂 `?t=<mtime>`
 * 缓存键，裸路径会解析成**另一个模块实例**（一个新的 zustand store）——脚本在它上面
 * `setSidebarOpen(true)` / `setManagerOpen(true)`，界面上那份 store 毫不知情，
 * 症状就是"opened=true 但元素不在 DOM 里"。实测证据：那份 store 里 `pages.length === 0`
 * 而 DOM 里有页面树；只影响**依赖 store 的层**（插件管理 / 文件预览 / 同步面板），
 * 792×360 反倒不红（那个宽度侧栏不是抽屉，用不着靠 store 打开）。
 * 本脚本 2026-09-22 先后假红过 6 条和 2 条，两次都是这个原因，所以修在源头。
 *
 * ⚠️ 这段函数体是**在浏览器里**跑的（`page.evaluate` 只带源码过去，看不到模块作用域里
 * 的任何东西），所以那三行必须**内联**在这里，不能抽成外部帮助函数（抽了就
 * `ReferenceError: storeLoader is not defined`——本轮的 `CHROME_BUDGET` / `tag` 都踩过）。
 */
async function openOverlay(which) {
  const store = (p) => {
    const loaded = (performance.getEntriesByType?.("resource") ?? [])
      .map((e) => e.name)
      .filter((n) => n.includes(p));
    // 取最后一个：HMR 之后同一个模块可能既加载过裸路径、也加载过带缓存键的那份。
    return import(/* @vite-ignore */ (loaded.length ? loaded[loaded.length - 1] : p));
  };
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
        let t = null;
        for (let i = 0; i < 30 && !t; i++) {
          await new Promise((r) => setTimeout(r, 150));
          const btns = [...document.querySelectorAll(".set-dialog .set-btn")];
          t = btns.find((b) => (b.textContent || "").includes("打开")) || null;
        }
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
        // 需要先有打开的页面（工具栏才在）。建页是异步的，所以**轮询**等触发器出现，
        // 而不是睡固定时长。
        const n = await store("/src/store/notes.ts");
        if (!n.useNotes.getState().currentId) await n.useNotes.getState().createPage(null);
        let t = null;
        for (let i = 0; i < 40 && !t; i++) {
          await new Promise((r) => setTimeout(r, 150));
          t = [...document.querySelectorAll(".toolbar-btn")].find((b) =>
            /Markdown/i.test(b.getAttribute("title") || ""),
          ) || null;
        }
        if (!t) return false;
        t.click();
        return true;
      }
      case "cover": {
        // 按钮的文案是**写死的中文**（`添加题头图` / `更换题头图`），不跟 i18n 走，
        // 所以这个匹配与语言无关。
        const n = await store("/src/store/notes.ts");
        if (!n.useNotes.getState().currentId) await n.useNotes.getState().createPage(null);
        let t = null;
        for (let i = 0; i < 40 && !t; i++) {
          await new Promise((r) => setTimeout(r, 150));
          t = [...document.querySelectorAll(".page-action-btn")].find((b) =>
            /封面|题头图/.test(
              `${b.getAttribute("title") || ""}${b.getAttribute("aria-label") || ""}${b.textContent || ""}`,
            ),
          ) || null;
        }
        if (!t) return false;
        t.click();
        return true;
      }
      case "history": {
        // 版本历史挂在**编辑器工具条**上（`HistoryPanel`），所以先要有打开的页面；
        // 建页是异步的 ⇒ 轮询等那个按钮出现，而不是睡固定时长。
        const n = await store("/src/store/notes.ts");
        if (!n.useNotes.getState().currentId) await n.useNotes.getState().createPage(null);
        let t = null;
        for (let i = 0; i < 40 && !t; i++) {
          await new Promise((r) => setTimeout(r, 150));
          t = document.querySelector('button[aria-label="版本历史"]');
        }
        if (!t) return false;
        t.click();
        return true;
      }
      case "filePreview": {
        // 走应用**自己的 store**（与界面同一条路），不是往 DOM 里塞假节点。
        // `open()` 收的就是一份 `AttachmentMeta` **元数据**，浮层完全由它渲染——
        // **不需要真的读文件**（这一点此前记错了：`EXEMPT_FROM_MOBILE_PASS` 里原写
        // "需要一份真实附件才渲染"，那说的是 `.md` 分支要读字节；`target` 一落，
        // 浮层就出来了）。
        // 选 `image/*` 是因为它顺带渲染右上角那组按钮（窄屏 ≥44×44 那条断言的对象）；
        // `path` 是**假路径**，web 平台的 `convertFileSrc` 只是原样返回字符串、不碰磁盘，
        // 图片加载失败不影响几何——本层要量的是浮层自己的盒子。
        const m = await store("/src/store/filePreview.ts");
        m.useFilePreview.getState().open({
          id: "vp-file-preview",
          name: "示例图片.png",
          hash: "",
          mime: "image/png",
          size: 1024,
          path: "/tmp/示例图片.png",
        });
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
  // 同上：按 app 实际加载过的 URL 取模块（内联，理由见 `openOverlay` 的注释）。
  const store = (p) => {
    const loaded = (performance.getEntriesByType?.("resource") ?? [])
      .map((e) => e.name)
      .filter((n) => n.includes(p));
    return import(/* @vite-ignore */ (loaded.length ? loaded[loaded.length - 1] : p));
  };
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
  (await store("/src/store/filePreview.ts")).useFilePreview.getState().close();
  const rp = (await store("/src/store/rightPanel.ts")).useRightPanel.getState();
  rp.openToc(false);
  rp.openAi(false);
  rp.openComments(false);
  // usePopover 驱动的这几个（搜索 / 回收站 / 同步 / 版本历史）：它们是**组件本地状态**，
  // 既没有 store 也不一定吃 Escape，最稳的是再点一次触发器关掉（`.click()` 对隐藏元素也生效）。
  // 不关的话它们会一直留在浮层栈里（它们都会登记），后面的
  // "栈空 ⇒ handle() 返回 false" 就永远量不到。
  for (const [box, trigger] of [
    [".search-popover", ".search-panel .activity-btn"],
    [".trash-popover", ".btn-trash"],
    [".sync-popover", ".btn-sync"],
    // 版本历史本轮起也吃 Escape（并登记了返回栈），这里再显式点一次触发器兜底。
    [".history-popover", 'button[aria-label="版本历史"]'],
  ]) {
    if (document.querySelector(box)) document.querySelector(trigger)?.click();
  }
  // ⚠️ **`optional` 的那两层此前根本没人关**（2026-09-15 第三轮抓到）。
  // `.markdown-import-overlay` 不吃 Escape、也不在上面那张触发器表里，
  // 于是它一开就**再也没关过**：它组件里的 `useOverlayScrollLock()` 永久留着一把锁，
  // 后面每一层看到的"外壳被锁 / 锁住：note-scroll"其实都是**它泄漏的那把锁**满足的——
  // 假绿（实测：只有文件预览开着时 `overlayScrollLockCount()` = 0，而在整轮里同一个
  // 浮层却"通过"了锁断言）。关干净是后面每一条锁断言有意义的前提。
  if (document.querySelector(".markdown-import-overlay")) {
    document.querySelector(".markdown-import-cancel")?.click();
  }
  if (document.querySelector(".cover-overlay")) {
    document.querySelector(".cover-overlay")?.click();
  }
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
  // 锁的**真实对象**：我们只给锁到的容器写内联 `overflow-y:hidden`，
  // 所以"内联是 hidden"就是"被这把锁锁住了"的判据（不受视图换了容器影响）。
  const inlineLocked = [];
  const overlayOwnScrollers = [];
  document.querySelectorAll(".app *").forEach((el) => {
    const cls = String(el.className || el.tagName).slice(0, 40);
    if (el.style && el.style.overflowY === "hidden") inlineLocked.push(cls);
  });
  root.querySelectorAll("*").forEach((el) => {
    const cs = getComputedStyle(el);
    if (cs.overflowY !== "auto" && cs.overflowY !== "scroll") return;
    if (el.scrollHeight <= el.clientHeight + 4) return;
    overlayOwnScrollers.push({
      cls: String(el.className || el.tagName).slice(0, 40),
      inlineOverflowY: el.style.overflowY || "",
    });
  });
  return {
    found: true,
    innerW,
    innerH,
    root: { left: r1(rr.left), right: r1(rr.right), top: r1(rr.top), bottom: r1(rr.bottom) },
    box: { left: r1(br.left), right: r1(br.right), top: r1(br.top), bottom: r1(br.bottom) },
    // `root === box`（右栏抽屉那种"自己就是自己遮罩"的层）：横向铺满要按**视口**算，
    // 而不是按"遮罩的内容盒"——否则它自己的 padding 会被当成安全区多减一遍。
    rootIsBox: root === box,
    // 遮罩**自己**的 padding：安全区（`--sat/--sar/--sab/--sal/--kb`）就写在这里，
    // 所以"盒子该有多宽" = 遮罩的内容盒，不用在脚本里另抄一遍那些变量。
    rootPad: {
      left: parseFloat(getComputedStyle(root).paddingLeft) || 0,
      right: parseFloat(getComputedStyle(root).paddingRight) || 0,
      top: parseFloat(getComputedStyle(root).paddingTop) || 0,
      bottom: parseFloat(getComputedStyle(root).paddingBottom) || 0,
    },
    boxMinWidth: getComputedStyle(box).minWidth,
    // 高度轴：上一轮只量了 min-width，`min-height:420px` 就是在那个盲区里活下来的。
    boxMinHeight: getComputedStyle(box).minHeight,
    boxPosition: getComputedStyle(box).position,
    rootClass: String(root.className || ""),
    docScrollWidth: document.documentElement.scrollWidth,
    clipped: clipped.slice(0, 6),
    buttons,
    noteScrollOverflowY: noteScroll ? getComputedStyle(noteScroll).overflowY : null,
    noteScrollTop: noteScroll ? noteScroll.scrollTop : null,
    hasNoteScroll: !!noteScroll,
    inlineLocked: inlineLocked.slice(0, 8),
    inlineLockedCount: inlineLocked.length,
    overlayOwnScrollers: overlayOwnScrollers.slice(0, 6),
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
    for (const vp of ACTIVE_PHONES) {
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
        jsInnerHeight: window.innerHeight,
        minWidth760: matchMedia("(max-width: 760px)").matches,
        minWidth769: matchMedia("(max-width: 769px)").matches,
        shortMatches: matchMedia("(max-height: 520px)").matches,
        shortMinusOne: matchMedia("(max-height: 519px)").matches,
      }));
      if (vp.narrow) {
        ok(mq.cssMatches, `命中窄屏媒体查询（innerWidth=${mq.jsInnerWidth} ≤ 768）`);
        ok(mq.minWidth769, "断点确实是 768（`max-width:769px` 也命中）——不是残留的 760");
      } else {
        // 横屏：**故意**不命中窄屏查询——布局仍走两列（`isNarrowViewport` 只看宽度）。
        ok(
          !mq.cssMatches,
          `横屏不命中窄屏查询（innerWidth=${mq.jsInnerWidth} > 768）——布局按宽度走两列是对的`,
        );
      }
      // ---- 矮视口轴：JS 与 CSS 也必须是同一个数（520） ----
      // 这一条是 2026-09-15 新增的：**浮层形态看"窄或矮"**，只按宽度判会漏掉横屏。
      // 注意**不能**用 `matchMedia("(max-height:519px)")` 去"反证断点是 520"——
      // 在 360 高的视口上它当然也命中。要证明阈值，只能把视口卡在 520/521 两侧各量一次，
      // 并同时量 JS（`isShortViewport()`）与 CSS（`matchMedia`）——这才是
      // "JS 与 CSS 是同一个数"的真正判据。
      const bracket = await safeEval(page, async () => {
        const m = await import(/* @vite-ignore */ "/src/hooks/useMobile.ts");
        return {
          at520: { js: m.isShortViewport(520), css: true },
          at521: { js: m.isShortViewport(521), css: false },
          const: m.SHORT_VIEWPORT_MAX_PX,
        };
      });
      ok(
        bracket.const === SHORT_VIEWPORT_MAX_PX,
        `useMobile.ts 的 SHORT_VIEWPORT_MAX_PX = ${bracket.const}（脚本里也写死同一个数）`,
      );
      ok(
        bracket.at520.js === true && bracket.at521.js === false,
        `JS 侧阈值确实卡在 520/521（520 ⇒ ${bracket.at520.js}，521 ⇒ ${bracket.at521.js}）`,
      );
      if (vp.height <= SHORT_VIEWPORT_MAX_PX) {
        ok(
          mq.shortMatches,
          `命中矮视口查询（innerHeight=${mq.jsInnerHeight} ≤ ${SHORT_VIEWPORT_MAX_PX}）——浮层据此收敛成整屏`,
        );
      } else {
        ok(!mq.shortMatches, `竖屏不命中矮视口查询（innerHeight=${mq.jsInnerHeight} > ${SHORT_VIEWPORT_MAX_PX}）`);
      }
      // CSS 侧的实际命中：把视口卡到 521 高，`max-height:520px` 必须**不**命中；
      // 再恢复。只改高度，不触碰宽度，所以不影响断点 768 那一条。
      await page.setViewport({ ...vp, height: SHORT_VIEWPORT_MAX_PX + 1, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      await sleep(300);
      const cssAt521 = await safeEval(page, () => matchMedia("(max-height: 520px)").matches);
      await page.setViewport({ ...vp, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      await sleep(300);
      ok(
        cssAt521 === false,
        `CSS 侧阈值也卡在 520/521（视口高 ${SHORT_VIEWPORT_MAX_PX + 1} 时 \`max-height:${SHORT_VIEWPORT_MAX_PX}px\` 不命中）` +
          `——JS 说矮而 CSS 说"不矮"会同时废掉两边`,
      );

      // ---- PDF 阅读器的内部分栏：窄/矮视口下必须是**抽屉**，不能是并排的列 ----
      // 这条是 2026-09-15 真机量出来的第二个问题：阅读器**能打开**了，但 360 宽下目录栏
      // 仍以 240px 常驻在左侧、批注栏并排 ⇒ 页面图 x=99/宽 306 **右边溢出屏幕**，正文被挤没。
      // 判据放在 CSS 层（这一层不需要真 PDF 就能验）：窄屏段里 `.pdf-outline-col` /
      // `.pdf-sidebar-col` 必须是 `position: absolute`，正文区必须吃掉整宽。
      // 真机几何（页面图不出屏、两栏默认收起）另在设备上验。
      if (!pdfCssChecked) {
        pdfCssChecked = true;
        const rules = await safeEval(page, () => {
          // ⚠️ 三处容易写错，第一版全踩了：
          //  1. 同一个类在窄屏段里出现在**多条**规则里（一条给 position、一条只给 left/box-shadow）
          //     ⇒ 必须**全收集**，只留最后一条会把值覆盖成空串；
          //  2. 段里还有 `@keyframes` 这类**没有 `.style`** 的对象 ⇒ 读 `inner.style.position` 直接抛；
          //  3. 这个仓库的窄/矮是**同一条** `@media (max-width:768px), (max-height:520px)`
          //     ⇒ 不要按"窄"或"矮"分桶，要看那条 conditionText 是否**两个轴都写了**。
          const out = [];
          for (const sheet of Array.from(document.styleSheets)) {
            let list;
            try {
              list = Array.from(sheet.cssRules);
            } catch {
              continue;
            }
            for (const r of list) {
              if (!r.conditionText) continue;
              if (!/max-width:\s*768px/.test(r.conditionText) && !/max-height:\s*520px/.test(r.conditionText)) continue;
              for (const inner of Array.from(r.cssRules || [])) {
                const st = inner.style || null;
                if (!st) continue;
                const sel = inner.selectorText || "";
                if (!sel) continue; // @keyframes 之类没有 selectorText 的，跳过
                // ⚠️ **不要**在这里加"只收某些选择器"的白名单：这个白名单连着坑了两次
                // （先漏 `.pdf-reader-head`/`.pdf-annot-toolbar`，再漏 `.pdf-reader-overlay`）
                // ——白名单漏了，断言看不到规则就只会假红，排查成本还高。全收，筛选放到断言里。
                out.push({
                  sel: sel.trim(),
                  cond: r.conditionText.replace(/\s+/g, " "),
                  position: st.position,
                  display: st.display,
                  width: st.width,
                  minWidth: st.minWidth,
                  minHeight: st.minHeight,
                  flexWrap: st.flexWrap,
                  overflowX: st.overflowX,
                  padding: st.padding,
                });
              }
            }
          }
          return out;
        });
        const cols = rules.filter((e) => /\.pdf-(outline|sidebar)-col/.test(e.sel));
        const drawer = cols.filter((e) => /^(absolute|fixed)$/.test(e.position));
        ok(
          /\.pdf-outline-col/.test(drawer.map((e) => e.sel).join(",")),
          `窄屏段里 PDF 目录栏是抽屉（${cols.map((e) => `${e.sel} → ${e.position || "（无 position）"}`).join("；")}）——并排的列会把正文挤出屏`,
        );
        ok(
          /\.pdf-sidebar-col/.test(drawer.map((e) => e.sel).join(",")),
          `窄屏段里 PDF 批注栏也是抽屉（${cols.map((e) => `${e.sel} → ${e.position || "（无 position）"}`).join("；")}）`,
        );
        ok(
          drawer.length > 0 && drawer.every((e) => /max-height:\s*520px/.test(e.cond)),
          `抽屉规则挂在"窄**或**矮"那同一条查询里（cond=${drawer[0]?.cond ?? "（没有抽屉规则）"}）` +
            `——只写 max-width 的话，横屏手机（792×360）又会回到并排的列`,
        );
        ok(
          cols.some((e) => /86vw|100%/.test(e.width)) && rules.some((e) => /pdf-reader-stage-wrap/.test(e.sel) && /100%/.test(e.width)),
          `抽屉宽度有上限、正文区吃整宽（抽屉 ${cols.map((e) => e.width || "-").join(" / ")}；正文 ${rules.filter((e) => /stage-wrap/.test(e.sel)).map((e) => e.width || "-").join(" / ")}）`,
        );
        // 同一层真机上量到的第三处：头部工具条 730px 宽、外层 overflow:hidden ⇒ 关闭/导出/护眼
        // 整排被裁在屏外点不到；批注工具行 489px 同理。这里钉住"允许换行 + 触摸目标 ≥44"。
        const wrapHead = rules.filter((e) => /\.pdf-reader-head$/.test(e.sel) && /wrap/.test(e["flexWrap"] ?? ""));
        ok(
          wrapHead.length > 0,
          `窄屏段里阅读器头部允许换行（不换行 = 右边那排按钮被 overflow:hidden 裁掉，真机实测 730 > 360）`,
        );
        // 只让 head 换行是不够的：内层 `.pdf-reader-controls` 自己是 603px 宽的行
        // （真机实测），换行发生在子元素这一级 ⇒ 它必须也能换行。
        const wrapControls = rules.filter((e) => /\.pdf-reader-controls$/.test(e.sel) && /wrap/.test(e["flexWrap"] ?? ""));
        ok(
          wrapControls.length > 0,
          `窄屏段里阅读器头部的**内层** .pdf-reader-controls 也允许换行（真机实测它单独就有 603px）`,
        );
        const bigTouch = rules.filter((e) => /\.pdf-reader-head button|\.pdf-annot-toolbar button/.test(e.sel) && /44px/.test(`${e["minWidth"] ?? ""} ${e["minHeight"] ?? ""}`));
        ok(
          bigTouch.length > 0,
          `阅读器内部按钮命中区 ≥44（原来 28×28，手机点不中）`,
        );
        // 头部第一行原来落在状态栏那一条带里（fixed inset:0 + 不让位）⇒ 目录开关这类按钮
        // **物理点不到**（真机 y=96 < 状态栏 123）。判据：浮层形态必须带 --sat 让位。
        const insetPad = rules.filter((e) => /\.pdf-reader-overlay/.test(e.sel) && /--sat/.test(e["padding"] ?? ""));
        ok(
          insetPad.length > 0,
          `浮层形态的阅读器用 --sat 让开系统栏（${insetPad.map((e) => e.sel).join("；") || "没找到规则"}）` +
            `——不让位的话第一行按钮在状态栏那一条带里，物理点不到（真机 y=96 < 123）`,
        );
        // 矮视口（横屏）**反过来**：换行会把正文挤没——真机实测 head 215 + annot 157 > 阅读器总高 319，
        // 正文区只剩 40px、页面图整页在屏外 ⇒ 改成单行横向滚动，并让「关闭」sticky 常驻。
        // ⚠️ 这条必须只看 **max-height 单独**那条查询（带 max-width 的是上面那套换行规则）。
        const shortOnly = rules.filter((e) => /max-height:\s*520px/.test(e.cond) && !/max-width/.test(e.cond));
        const headNowrap = shortOnly.filter(
          // ⚠️ 别用 `/\.pdf-reader-head$/`：那条规则是**分组选择器**（头部 + 内层 + 批注行写在一起），
          // selectorText 以逗号结尾 ⇒ 锚 `$` 永远不匹配（这条断言第一版就是这么假红的）。
          (e) => /\.pdf-reader-head\b/.test(e.sel) && /nowrap/.test(e["flexWrap"] ?? "") && /auto/.test(e["overflowX"] ?? ""),
        );
        ok(
          headNowrap.length > 0,
          `矮视口（横屏）里阅读器头部改成单行横向滚动（${headNowrap.map((e) => e.sel).join("；") || "没找到规则"}）` +
            `——横屏换行会把正文挤没（实测 215+157 > 319，页面图在屏外）`,
        );
        const closeSticky = shortOnly.filter((e) => /\.pdf-reader-close$/.test(e.sel) && /sticky/.test(e.position ?? ""));
        ok(
          closeSticky.length > 0,
          `矮视口里「关闭」sticky 常驻（${closeSticky.map((e) => e.sel).join("；") || "没找到规则"}）——它是"离开"的唯一入口，不能跟着横滑走`,
        );

        // ---- 2026-09-22：控制条把正文挤没（用户真窗口截图，8 行 chrome） ----
        // 阅读器**要一份真 PDF 才会渲染内部**（测试工作区里没有），所以这一层与上面几条一样
        // 是 **CSS 级**断言：钉的是"规则真的把低频控件收起来了"。
        // 几何效果另有一条探针节点量（下面 `pdfChromeProbe`）。
        const moreBtn = rules.filter((e) => /^\.pdf-reader-more$/.test(e.sel));
        ok(
          moreBtn.some((e) => /inline-flex/.test(e.display ?? "")),
          `窄屏段里「更多工具」入口放出来了（${moreBtn.map((e) => e.display || "-").join(" / ") || "没找到规则"}）` +
            `——它的基础规则是 display:none（桌面不需要），窄屏必须显式放出来，否则手机上根本点不到`,
        );
        const hiddenSecondary = rules.filter(
          (e) => /\.pdf-reader-head:not\(\.tools-open\)/.test(e.sel) && /none/.test(e.display ?? ""),
        );
        const hiddenSel = hiddenSecondary.map((e) => e.sel).join(" | ");
        for (const cls of ["pdf-reader-maximize", "pdf-reader-sidebar-toggle", "pdf-reader-ask", "pdf-eye-wrap", "pdf-export-btn"]) {
          ok(
            new RegExp(cls.replace(/-/g, "\\-")).test(hiddenSel),
            `低频头部控件「${cls}」默认收起（展开走 .tools-open）：${hiddenSel.slice(0, 120)}`,
          );
        }
        const toolsNowrap = rules.filter(
          (e) => /^\.pdf-annot-tools$/.test(e.sel) && /nowrap/.test(e["flexWrap"] ?? "") && /auto/.test(e["overflowX"] ?? ""),
        );
        ok(
          toolsNowrap.length > 0,
          `窄屏段里批注工具行改成单行横滑（${toolsNowrap.map((e) => e.sel).join("；") || "没找到规则"}）` +
            `——换行会白吃 44px 正文高度`,
        );
        // 注：这里原来还有一条"窄屏段里那句说明（.pdf-annot-tip）不再占一行"的断言。
        // 2026-09-22 那句说明**整体删掉**了（桌面也删），标记与它的 CSS 规则一起移除，
        // 所以这条 CSS 级断言没有对象可钉，随之删除（不是"改成永远通过"）。
      }

      // ---- 手机上的同步入口：主界面必须有一个（不能只藏在侧栏抽屉里） ----
      // 为什么值得钉：手机上 `TitleBar` **整个不渲染**（`!desktop` 时 return null），
      // 桌面那个 `.titlebar-sync` 根本不存在 ⇒ 一旦忘记补这个入口，同步就只剩
      // "开侧栏抽屉 → 同步"，而且**没有任何报错**（纯粹是找不到）。
      if (!mobileSyncChecked && vp.narrow) {
        mobileSyncChecked = true;
        const sync = await safeEval(page, () => {
          const slot = document.querySelector(".mobile-sync-slot");
          const btn = slot ? slot.querySelector("button") : null;
          const r = btn ? btn.getBoundingClientRect() : null;
          return {
            hasSlot: !!slot,
            label: btn ? (btn.textContent || "").trim() : null,
            w: r ? Math.round(r.width) : 0,
            h: r ? Math.round(r.height) : 0,
          };
        });
        ok(
          sync.hasSlot && !!sync.label,
          `手机上主界面有同步入口（${sync.label ?? "（没有）"}）——TitleBar 在手机端不渲染，否则只能开抽屉才点得到`,
        );
        ok(sync.h >= 44, `同步入口命中区高度 ≥44（实测 ${sync.h}×${sync.w}）`);
        const clicked = await safeEval(page, () => {
          const btn = document.querySelector(".mobile-sync-slot button");
          if (!btn) return false;
          btn.click();
          return true;
        });
        await sleep(700);
        const pop = await safeEval(page, () => ({
          inDom: !!document.querySelector(".sync-popover"),
          isSheet: !!document.querySelector(".sync-popover.is-sheet"),
        }));
        ok(clicked && pop.inDom, `点它就能打开同步面板（inDom=${pop.inDom}，底部弹层=${pop.isSheet}）`);
        // 收起来，别影响后面的层验收
        await safeEval(page, () => {
          document.querySelector(".mobile-sync-slot button")?.click();
        });
        await sleep(300);
      }

      // ---- 系统 inset 变量：无壳层报送时必须全是 0px（不许凭空多出边距） ----
      const varsProbe = await safeEval(page, () => {
        const cs = getComputedStyle(document.documentElement);
        return {
          sat: cs.getPropertyValue("--sat").trim(),
          sab: cs.getPropertyValue("--sab").trim(),
          kb: cs.getPropertyValue("--kb").trim(),
          ovh: cs.getPropertyValue("--ovh").trim(),
        };
      });
      ok(
        varsProbe.sat === "0px" && varsProbe.sab === "0px" && varsProbe.kb === "0px",
        `未接壳层时 inset 变量全是 0px（--sat ${varsProbe.sat} / --sab ${varsProbe.sab} / --kb ${varsProbe.kb}）` +
          `——浏览器里 env() 本来也是 0，行为不变`,
      );

      // ---- 返回键桥：壳层 `evaluateJavascript` 调的就是它 ----
      const backBridge = await safeEval(page, () => {
        const b = window.__SHUYONOTE_BACK__;
        if (!b) return null;
        return { depth: b.depth(), ids: b.ids(), handle: b.handle(), handleType: typeof b.handle() };
      });
      ok(
        backBridge !== null,
        "返回键桥已装（window.__SHUYONOTE_BACK__）——没有它，Android 上返回键只能退出应用",
      );
      ok(
        backBridge !== null && backBridge.handleType === "boolean",
        "handle() 返回**真布尔**（壳层用 `=== true` 判定；返回 undefined 会被当成「没关掉」，返回键就再也退不出去）",
      );

      // ---- 竖条浮层化（只对窄屏有意义；横屏走的是常驻竖条） ----
      if (vp.narrow) {
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
      }

      // ---- 浮层打开时内容区的滚动锁 ----
      for (const layer of OVERLAYS) {
        // 单层出错（含 CI 里 Chrome 偶发的 CDP 抖动）只算这一层失败，
        // 不能把整轮跑挂掉——挂掉就没有汇总，等于白跑一次。
        try {
          const opened = await safeEval(page, openOverlay, layer.id);
          // 两段等待，缺一不可：
          //   1) **下限时长**让滑入动画/过渡停稳。侧栏、竖条、TOC、AI、评论都是
          //      `translateX(100%)` / `ai-slide-in` 进场的，量在滑动途中会得到
          //      "盒子在屏外"这种**假红**——而且它们"没打开时也有几何"，
          //      所以光靠"有没有渲染出来"判断不出该不该量。
          //   2) **轮询**等它真的渲染出来。冷启动的 CI runner 上固定时长未必够，
          //      那会把"还没画出来"记成"这一层坏了"。
          await sleep(layer.id === "settings" || layer.id === "pluginManager" ? 900 : 600);
          let m = { found: false };
          for (let attempt = 0; attempt < 20; attempt++) {
            m = await safeEval(page, probeLayer, layer.root, layer.box);
            if (m.found) break;
            await sleep(200);
          }
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

          // (1b) **形态**：标了 `fullscreen` 的层必须**真的铺满**。
          //
          // ⚠️ 这条是 2026-09-15 第三轮补的，原因很实在：上面那条"四边都在视口内"
          // **只挡越界，挡不住被压窄**——实测把 `.fm-preview-overlay` 加进 `OVERLAYS` 时，
          // 它只有 **72px 宽**（`x 288..360`），四边**全都在视口里**，
          // 于是那一轮 912 条断言**全部通过**：清单加上了、几何也"量到了"，缺陷照样活着。
          // 判据取"盒子横向铺满**遮罩的内容盒**"：安全区就写在遮罩的 padding 上
          // （`--sat/--sar/--sab/--sal/--kb`），所以这里不需要另抄一遍那些变量。
          if (layer.fullscreen) {
            const expLeft = m.rootIsBox ? 0 : m.root.left + m.rootPad.left;
            const expRight = m.rootIsBox ? m.innerW : m.root.right - m.rootPad.right;
            const rd = (n) => Math.round(n * 10) / 10;
            ok(
              m.rootIsBox || (m.root.left <= 0.5 && m.root.right >= m.innerW - 0.5),
              `全屏层的遮罩横向铺满视口（root x ${m.root.left}..${m.root.right}，视口宽 ${m.innerW}）`,
            );
            ok(
              Math.abs(m.box.left - expLeft) <= 1 && Math.abs(m.box.right - expRight) <= 1,
              `全屏层的盒子横向铺满遮罩内容盒（盒 x ${m.box.left}..${m.box.right}，期望 ${rd(expLeft)}..${rd(expRight)}` +
                `，实际宽 ${rd(m.box.right - m.box.left)}）——` +
                `"四边在视口内"挡不住被压窄：72px 宽的浮层四边也都在视口里`,
            );
          }
          // 总根因：min-width 不许压过 max-width
          ok(
            m.boxMinWidth === "0px" || m.boxMinWidth === "auto",
            `盒子 min-width 已清零（min-width=${m.boxMinWidth}）——min-width 会压过 max-width`,
          );
          // **高度轴同理**（2026-09-15 补）。上一轮只断言了 min-width，
          // 于是 `.set-dialog{min-height:420px}` 一路活到横屏：792×360 下
          // min-height 压过 `max-height:calc(100vh-48px)`，盒子高 420、底边 444，
          // **底部 84px 被裁在屏外**（"保存 / 关闭"就在那一段里）。
          ok(
            m.boxMinHeight === "0px" || m.boxMinHeight === "auto",
            `盒子 min-height 已清零（min-height=${m.boxMinHeight}）——min-* 压 max-* 与轴无关，高度轴同样要清`,
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

          // (5) 打开任一层 ⇒ 外壳被锁，且触摸拖动拖不走背景
          //
          // ⚠️ 判据 2026-09-15 修正：**不能只看 `.note-scroll`**。
          // 它只是"编辑器视图"的滚动容器；切到「文件」视图时它**不在 DOM 里**，
          // 内容区换成 `.file-manager-table-wrap`，侧栏抽屉打开时滚的是 `.sidebar-tree`。
          // 只锁 `.note-scroll` ⇒ 那些视图下**一个容器都没锁到**（上一版就是这样，
          // 而"背景拖不动"当时其实是 `overscroll-behavior:contain` 挡住的，不是这把锁）。
          // 现在的判据：**内联 `overflow-y:hidden` 的容器列表非空**（那就是被这把锁锁住的），
          // 并且它必须包含 `.note-scroll`（若该视图有它）。
          ok(
            m.inlineLockedCount > 0,
            `外壳至少锁到一个真实滚动容器（锁住：${m.inlineLocked.join(", ") || "无"}）` +
              `——只认 .note-scroll 的旧写法在别的视图下会一个都锁不到`,
          );
          ok(
            m.hasNoteScroll && m.noteScrollOverflowY === "hidden",
            `内容区被锁（.note-scroll overflow-y=${m.noteScrollOverflowY}）——锁 body 无效，真正的滚动容器是它`,
          );
          if (m.hasNoteScroll) {
            ok(
              m.inlineLocked.some((c) => c.includes("note-scroll")),
              "锁的对象里确实包含 .note-scroll（不是「锁了别的、漏了正主」）",
            );
          }
          // 反向：**不许锁到浮层自己的滚动区**（设置正文、命令面板列表、图标网格…）。
          // 判据来自结构事实：浮层内部的滚动区一定有 `position: fixed` 祖先。
          ok(
            m.overlayOwnScrollers.every((s) => s.inlineOverflowY !== "hidden"),
            m.overlayOwnScrollers.length
              ? `浮层自己的滚动区没被误锁（${m.overlayOwnScrollers
                  .map((s) => `${s.cls}:${s.inlineOverflowY || "auto"}`)
                  .join(" ")}）`
              : "本层没有自带滚动区（跳过反向断言）",
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

      // ---------------------------------------------------------------------
      // 系统 inset / 软键盘：**注入变量**量 CSS 这一半（2026-09-15 新增）
      //
      // 真机上 `--sat/--kb` 由壳层从窗口 inset 送进来（Kotlin 侧见
      // `scripts/android-mobile-shell.mjs`）。这里验的是"变量变了、布局会不会跟着让位"——
      // 那正是能在浏览器里验、也必须在这里钉住的一半：**变量接上了但 CSS 没消费**
      // 是很容易犯的错（写完 bridge 就以为完事了）。
      // ---------------------------------------------------------------------
      console.log(`\n【${vp.name} · 状态栏 inset（注入 --sat=${STATUS_BAR_PROBE_PX}px）】`);
      await safeEval(page, openOverlay, "settings");
      await sleep(700);
      const satProbe = await safeEval(
        page,
        (sat) => {
          document.documentElement.style.setProperty("--sat", `${sat}px`);
          const appEl = document.querySelector(".app");
          const dlg = document.querySelector(".set-dialog");
          const rail = document.querySelector(".set-rail");
          const r = (el) => (el ? el.getBoundingClientRect() : null);
          // "顶部再没有可交互 UI"才是这条修复的真正判据（见下面的说明）。
          const offenders = [...document.querySelectorAll("button, input, textarea, select, a[href], [role='button']")]
            .map((el) => ({ el, r: el.getBoundingClientRect() }))
            .filter(({ r }) => r.width > 1 && r.height > 1 && r.top >= -1 && r.top < sat - 0.5)
            .map(({ el, r }) => {
              const fixed = (() => {
                for (let n = el; n && n !== document.body; n = n.parentElement) {
                  if (getComputedStyle(n).position === "fixed") return String(n.className || n.tagName).slice(0, 24);
                }
                return null;
              })();
              return {
                cls: String(el.className || el.tagName).slice(0, 40),
                top: Math.round(r.top * 10) / 10,
                fixedIn: fixed,
              };
            })
            .slice(0, 4);
          return {
            satVar: getComputedStyle(document.documentElement).getPropertyValue("--sat").trim(),
            appPaddingTop: appEl ? getComputedStyle(appEl).paddingTop : null,
            // ⚠️ `.app` 的 padding **不会**改变它自己的 border box 的 top
            // （getBoundingClientRect 量的是 border box）——上一版断言写成
            // "app.top ≥ 41" 是量错了对象，量出来永远是 0。要看的是 padding 与**子元素**。
            firstInteractiveTop: offenders.length ? offenders[0].top : null,
            offenders,
            dlgTop: r(dlg) ? r(dlg).top : null,
            dlgBottom: r(dlg) ? r(dlg).bottom : null,
            railTop: r(rail) ? r(rail).top : null,
            innerH: window.innerHeight,
          };
        },
        STATUS_BAR_PROBE_PX,
      );
      ok(
        satProbe.appPaddingTop === `${STATUS_BAR_PROBE_PX}px`,
        `外壳用 padding 让开了状态栏（.app padding-top=${satProbe.appPaddingTop}）——` +
          `对应真机上的"标题压住系统时间"`,
      );
      // 真正的判据：**状态栏那一条带里不许有任何可交互元素**。
      // 那一带归 SystemUI 的窗口，应用**永远收不到那里的触摸**（真机实测：
      // tap 在 y≤123 设备 px 时 0 个 DOM 事件，y=130 时 100+ 个），
      // 所以修法只能是"别把 UI 放进去"，不是想办法穿透它。
      ok(
        satProbe.offenders.length === 0,
        `顶部再没有可交互元素落在状态栏里（最高的一个 y=${satProbe.firstInteractiveTop} ≥ ${STATUS_BAR_PROBE_PX}）` +
          `——修前编辑器工具条 6 个按钮的中心在 y=20，整条都在死区里，点不到` +
          (satProbe.offenders.length
            ? `；越界的：${satProbe.offenders
                .map((o) => `${o.cls}@y=${o.top}${o.fixedIn ? `(在 fixed 的 ${o.fixedIn} 里)` : ""}`)
                .join(" ")}`
            : ""),
      );
      ok(
        satProbe.dlgTop !== null && satProbe.dlgTop >= STATUS_BAR_PROBE_PX - 0.5,
        `全屏面板顶部也让开了状态栏（.set-dialog top=${satProbe.dlgTop} ≥ ${STATUS_BAR_PROBE_PX}）——` +
          `浮层是 position:fixed，不会跟着 .app 的 padding 走，必须自己让位`,
      );
      ok(
        satProbe.railTop !== null && satProbe.railTop >= STATUS_BAR_PROBE_PX - 0.5,
        `设置面板**第一个按钮所在的那条分类栏**在状态栏之下（.set-rail top=${satProbe.railTop}）——` +
          `修前它在 y≈6，整条落在触摸死区里`,
      );
      ok(
        satProbe.dlgBottom !== null && satProbe.dlgBottom <= satProbe.innerH + 0.5,
        `加 inset 之后面板仍装得下（bottom=${satProbe.dlgBottom} ≤ ${satProbe.innerH}）`,
      );
      await safeEval(page, closeAllOverlays);
      await safeEval(page, () => document.documentElement.style.removeProperty("--sat"));
      await sleep(300);

      console.log(`\n【${vp.name} · 软键盘（注入 --kb=${KB_PROBE_PX}px）】`);
      // 用「社区保存」当底部弹层的样本：它由 store 驱动，`closeAllOverlays` 能确定地关掉
      // （搜索/回收站/同步是 usePopover 的本地状态，Escape 关不掉，会污染后面几步）。
      await safeEval(page, openOverlay, "communitySave");
      await sleep(700);
      const kbProbe = await safeEval(
        page,
        (kb) => {
          document.documentElement.style.setProperty("--kb", `${kb}px`);
          const sheet = document.querySelector(".community-save-box");
          const r = sheet ? sheet.getBoundingClientRect() : null;
          return {
            found: !!sheet,
            bottom: r ? r.bottom : null,
            innerH: window.innerHeight,
            kbVar: getComputedStyle(document.documentElement).getPropertyValue("--kb").trim(),
          };
        },
        KB_PROBE_PX,
      );
      ok(kbProbe.found, "量到了底部弹层样本（.community-save-box 已打开）");
      ok(
        kbProbe.found && kbProbe.bottom <= kbProbe.innerH - KB_PROBE_PX + 0.5,
        `底部弹层抬到了键盘之上（bottom=${kbProbe.bottom} ≤ ${kbProbe.innerH - KB_PROBE_PX}）——` +
          `真机上键盘盖住 CSS y≥468 而弹层钉在 bottom:0，输入框正好被盖住；` +
          `**web 层自己察觉不到键盘**（edge-to-edge 下 adjustResize 空转，` +
          `innerHeight 与 visualViewport.height 都不变），所以 --kb 只能由壳层送`,
      );
      // 全屏面板也要跟着缩：`--ovh` 里已经扣掉 max(--sab, --kb)。
      await safeEval(page, openOverlay, "settings");
      await sleep(700);
      const kbFull = await safeEval(
        page,
        (kb) => {
          document.documentElement.style.setProperty("--kb", `${kb}px`);
          const dlg = document.querySelector(".set-dialog");
          const r = dlg ? dlg.getBoundingClientRect() : null;
          return { bottom: r ? r.bottom : null, innerH: window.innerHeight };
        },
        KB_PROBE_PX,
      );
      ok(
        kbFull.bottom !== null && kbFull.bottom <= kbFull.innerH - KB_PROBE_PX + 0.5,
        `全屏面板也缩到了键盘之上（bottom=${kbFull.bottom} ≤ ${kbFull.innerH - KB_PROBE_PX}）——` +
          `它的高度取自 --ovh，写死 100dvh 的话底部那截（「关闭设置」）会被键盘盖住`,
      );
      await safeEval(page, closeAllOverlays);
      await safeEval(page, () => document.documentElement.style.removeProperty("--kb"));
      await sleep(300);

      // ---- 返回键：一次只关一层，关完栈空才返回 false（壳层据此退出应用） ----
      //
      // 先把栈清干净：`closeAllOverlays` 关不掉 usePopover 驱动的那些（搜索/回收站/同步，
      // 它们是组件本地状态、Escape 无效），而本轮它们**也会登记进浮层栈**了。
      // 不清干净，"栈空 ⇒ false"这条就量不到（量出来是"还有 3 层"）。
      // 清干净之后再看**契约**：`handle()` 必须等价于 `depth > 0`。
      console.log(`\n【${vp.name} · 返回键 → 浮层栈】`);
      await safeEval(page, closeAllOverlays);
      await safeEval(page, () => {
        const b = window.__SHUYONOTE_BACK__;
        if (!b) return 0;
        // 上限只是防死循环：正常情况下几层就到底。
        for (let i = 0; i < 12 && b.handle(); i++) { /* 排空 */ }
        return b.depth();
      });

      await safeEval(page, openOverlay, "settings");
      await sleep(800);
      const back1 = await safeEval(page, () => {
        const b = window.__SHUYONOTE_BACK__;
        if (!b) return null;
        const before = b.depth();
        const handled = b.handle();
        return { before, handled, after: b.depth() };
      });
      ok(
        back1 !== null && back1.before > 0 && back1.handled === true && back1.after === back1.before - 1,
        back1
          ? `返回键关掉了最上层浮层：深度 ${back1.before} → ${back1.after}，handle() 返回 ${back1.handled}`
          : "返回键桥不在",
      );
      const settingsGone = await safeEval(page, () => !document.querySelector(".set-dialog"));
      ok(settingsGone, "设置面板确实被关掉了（不是只把栈弹空了）");
      await sleep(400);
      // 排空剩下的（如果有），再验"空栈 ⇒ false"。
      const drained = await safeEval(page, () => {
        const b = window.__SHUYONOTE_BACK__;
        if (!b) return { depth: -1, handled: null, ids: [] };
        for (let i = 0; i < 12 && b.depth() > 0; i++) b.handle();
        return { depth: b.depth(), handled: b.handle(), ids: b.ids() };
      });
      ok(
        drained.depth === 0 && drained.handled === false,
        `栈空时 handle() 返回 ${drained.handled}（深度 ${drained.depth}）——**false 才会放行返回键去退出应用**；` +
          `如果这里返回 true，返回键就永远退不出应用了`,
      );

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

      // ---- PDF 阅读器顶部控制条：`⋯` 到底省下几行（几何，探针节点） ----
      // 阅读器**要一份真 PDF 才会渲染内部**（测试工作区里没有真的 PDF 附件），所以这里与
      // `.plugin-panel` 同一个办法：塞一份**只带类名**的复刻（结构与 `PdfReader` 的头部一致），
      // 量"收起 / 展开"两种状态的高度差，以及批注工具行是不是真的单行。
      const pdfProbe = await safeEval(page, () => {
        const head = document.createElement("div");
        head.className = "pdf-reader-head";
        head.style.cssText = "position:fixed;left:0;right:0;top:0;z-index:-1";
        const btn = (cls, txt) => {
          const b = document.createElement("button");
          b.className = `pdf-reader-btn ${cls}`;
          b.textContent = txt;
          return b;
        };
        const mk = (cls, html) => {
          const d = document.createElement("div");
          d.className = cls;
          d.innerHTML = html;
          return d;
        };
        head.append(
          btn("pdf-reader-outline-toggle", "☰"),
          Object.assign(document.createElement("span"), { className: "pdf-reader-name", textContent: "小马白话期权.pdf" }),
          mk(
            "pdf-reader-controls",
            '<div class="pdf-reader-nav"><button class="pdf-reader-btn">‹</button>' +
              '<span class="pdf-reader-page">第 1 / 17 页</span><button class="pdf-reader-btn">›</button></div>' +
              '<div class="pdf-reader-zoom"><button class="pdf-reader-btn">−</button>' +
              '<button class="pdf-reader-btn pdf-zoom-btn"><span class="pdf-reader-pct">适合宽度</span></button>' +
              '<button class="pdf-reader-btn">+</button></div>' +
              '<button class="pdf-reader-btn pdf-reader-maximize">⤢</button>' +
              '<button class="pdf-reader-btn pdf-reader-sidebar-toggle">▯</button>' +
              '<button class="pdf-reader-btn pdf-reader-ask">∿</button>' +
              '<div class="pdf-eye-wrap"><button class="pdf-reader-btn">◉</button></div>',
          ),
          btn("pdf-export-btn", "导出带批注副本"),
          btn("pdf-reader-more", "⋯"),
          btn("pdf-reader-close", "×"),
        );
        document.body.appendChild(head);
        const collapsed = head.getBoundingClientRect().height;
        head.classList.add("tools-open");
        const expanded = head.getBoundingClientRect().height;
        head.remove();

        // 批注工具行：6 个按钮（4 工具 + 撤销 + 导出批注）。
        // ⚠️ 这里**故意把容器压到 280px** 再量：在 360/390 上这 6 个按钮本来就排得下，
        //    "排得下"证明不了"不换行"；压到 280 才能证明它**该换行时不换行、改为横滑**。
        const tools = document.createElement("div");
        tools.className = "pdf-annot-tools";
        tools.style.cssText = "position:fixed;left:0;width:280px;top:0;z-index:-1";
        for (const t of ["选择", "高亮", "画笔", "便签", "撤销", "导出批注"]) {
          const b = document.createElement("button");
          b.className = "pdf-annot-tool";
          b.textContent = t;
          tools.appendChild(b);
        }
        document.body.appendChild(tools);
        const toolsH = Math.round(tools.getBoundingClientRect().height);
        const toolsScrollable = tools.scrollWidth > tools.clientWidth + 1;
        const toolsW = Math.round(tools.getBoundingClientRect().width);
        tools.remove();

        // 桌面那两条基础规则（`⋯` 必须藏起来）在**桌面视口**里另测，见脚本末尾 —
        // 这里是窄屏视口，`⋯` 本来就该显示（第一版把这条写在这里，三个档全假红）。
        return { collapsed: Math.round(collapsed), expanded: Math.round(expanded), toolsH, toolsScrollable, toolsW, innerW: window.innerWidth };
      });
      console.log(`\n【${vp.name} · PDF 顶部控制条】`);
      if (pdfProbe.innerW <= 480) {
        ok(
          pdfProbe.expanded - pdfProbe.collapsed >= 40,
          `「⋯」收起时头部矮 ${pdfProbe.expanded - pdfProbe.collapsed}px（收起 ${pdfProbe.collapsed} / 展开 ${pdfProbe.expanded}）` +
            `——收起的是整排低频控件（最大化/批注侧栏/提问/护眼/导出），至少省一行 44`,
        );
      } else {
        // 792×360 这种"宽而矮"：横向放得下，收起与否都只占一行 ⇒ 高度不变是对的，
        // 只断言"没有变高"（第一版在这里要求 ≥40，在这个档上假红）。
        ok(
          pdfProbe.expanded >= pdfProbe.collapsed,
          `宽视口（${pdfProbe.innerW}px）下头部收起/展开都是一行（${pdfProbe.collapsed} / ${pdfProbe.expanded}）——横向放得下，不该变更高`,
        );
      }
      ok(
        pdfProbe.toolsH <= 56,
        `批注工具行在 ${pdfProbe.toolsW}px 宽下是**一行**（高 ${pdfProbe.toolsH} ≤ 56，6 个按钮）` +
          `——原来会折成两行（改前实测多占 44px 正文高度）`,
      );
      ok(
        pdfProbe.toolsScrollable,
        `容器窄到 ${pdfProbe.toolsW}px 时这一行**横滑**而不是换行（scrollWidth > clientWidth）——不换行不是靠裁掉按钮`,
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
    // ---- 桌面：PDF 阅读器的「⋯」入口必须**藏起来**（桌面一次放得下，不该多一个入口） ----
    // ⚠️ 这条必须在**桌面视口**里测：窄屏那段把它显式放出来了，在窄屏里测必然假红
    //    （第一版就写在窄屏循环里，三个档全假红）。
    const pdfMoreOnDesk = await safeEval(desk, () => {
      const b = document.createElement("button");
      b.className = "pdf-reader-btn pdf-reader-more";
      document.body.appendChild(b);
      const disp = getComputedStyle(b).display;
      b.remove();
      return disp;
    });
    ok(
      pdfMoreOnDesk === "none",
      `桌面视口里 PDF 的「⋯」入口是 display:none（实际 ${pdfMoreOnDesk}）——桌面一次放得下，不需要它`,
    );
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
