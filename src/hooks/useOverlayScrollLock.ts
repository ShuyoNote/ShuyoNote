// 浮层打开时锁住**真正的那些滚动容器**——不是 `body`。
//
// ## 为什么不是 body（2026-09-14 实测，390x844 触屏视口）
//
//   这个应用的滚动条根本不在 body 上——`.app { overflow: hidden }` 把整页钉死，
//   真正滚的是内容区。所以 `document.body.style.overflow = "hidden"`
//   在这里**一点作用都没有**：搜索面板打开时用手指拖背景，正文照样被拖走 323px
//   （`scrollTop` 实测变化）。凡是"在别的项目里管用"的锁体写法，在这套布局里都是安慰剂。
//
// ## ⚠️ 2026-09-15 修正：锁的对象**不止** `.note-scroll`（上一版就是错在这里）
//
//   真机复验时抓到：**当前视图的滚动容器不一定是 `.note-scroll`**——
//   切到「文件」视图时 `.note-scroll` **根本不在 DOM 里**，内容区换成了
//   `.file-manager-table-wrap`；侧栏抽屉打开时滚的是 `.sidebar-tree`。
//   只锁 `.note-scroll` ⇒ 那种视图下**一个元素都没锁到**，锁静默失效
//   （"背景拖不动"当时是 `overscroll-behavior: contain` 挡住的，不是这把锁）。
//
//   所以改成**结构化发现**，而不是写死一个选择器：
//
//     应用外壳（`.app`）内、`overflow-y` 是 auto/scroll 且内容确实溢出，
//     并且**没有任何 `position: fixed` 祖先**的元素 —— 全部锁上。
//
//   `position: fixed` 那一条是**关键**：它恰好把"浮层自己的滚动区"排除掉。
//   实测（`tmp/probe-scrollers2.mjs`，390x844）：设置 / 命令面板 / 插件管理 / 图标选择器
//   打开时，浮层内部的滚动区（`.palette-list` / `.ep-main` / `.set-body-scroll`…）
//   **无一例外**都有 `position: fixed` 祖先；而外壳的滚动区（`.note-scroll`）没有。
//   于是"锁外壳、不锁浮层内部"可以只靠这一条结构事实判定，不必逐个列举类名。
//   锁 `.sidebar-tree` 是**故意**的：窄屏侧栏是抽屉，浮层开着时它就是背景。
//
// ## 语义
//
//   - **只要有任意一个浮层开着，外壳就是锁的**（全局计数，不是按元素引用计数）。
//     多个浮层叠着时（「存储 → 设置」「确认框盖在输入框上」），关掉上面那层
//     不能把锁提前解掉——下面那层还在。
//   - **保留并恢复 `scrollTop`**：`overflow:hidden` 通常不丢滚动位置，但"滚动容器
//     在锁住期间被换掉、内容高度骤变"时会 clamp 到 0，所以显式存一份写回去。
//   - **盯住视图节点被重建**：SPA 切页/切视图会换掉滚动容器。只在"打开那一刻查一次"
//     是不够的——第一次写这个 hook 就是这么写的，验收脚本在长会话里跑到第 10 个浮层时
//     抓到了：那一刻容器还没挂上，于是**一个元素都没锁**。现在用一个 MutationObserver
//     盯新增节点补锁（只在"新增的子树里出现了候选滚动容器"时才重扫，避免给每次 DOM
//     变动买单——编辑器里每敲一个字都会产生 DOM 变动）。
//
// 用法（挂在覆盖层组件里，`active` 就是那个浮层的 open 状态）：
//   useOverlayScrollLock(open);
import { useEffect } from "react";

/**
 * 外壳的候选滚动容器（给 MutationObserver 用的**廉价预筛**，不是锁的清单）。
 *
 * 真正的锁对象由 `findBackgroundScrollers()` 结构化发现；
 * 这里只是"新挂上来的节点值不值得重扫一遍"的判断依据。
 */
export const SCROLL_CONTAINER_SELECTOR =
  '.note-scroll, .sidebar-tree, [class*="scroll"], [data-scroll-container]';

/** 应用外壳根。锁只在外壳里找，绝不下手到浮层内部。 */
export const APP_SHELL_SELECTOR = ".app";

interface SavedStyle {
  overflowY: string;
  overscrollBehaviorY: string;
  scrollTop: number;
}

/** 当前开着的浮层数（>0 ⇒ 外壳应当被锁）。 */
let activeOwners = 0;
const saved = new Map<HTMLElement, SavedStyle>();
let observer: MutationObserver | null = null;

/**
 * 找出"外壳里真正在滚"的元素（导出是为了验收脚本能直接量锁的对象对不对）。
 *
 * 判定顺序刻意从便宜到贵：先看布局（`scrollHeight`，不触发样式解析），
 * 再做一次 `getComputedStyle`，最后才走祖先链找 `position: fixed`。
 */
export function findBackgroundScrollers(doc: Document = document): HTMLElement[] {
  const root = doc.querySelector(APP_SHELL_SELECTOR) ?? doc.body;
  if (!root) return [];
  const out: HTMLElement[] = [];
  root.querySelectorAll<HTMLElement>("*").forEach((el) => {
    // ① 内容确实溢出（不溢出的容器锁不锁都一样，跳过能省掉绝大多数元素）
    if (el.scrollHeight <= el.clientHeight + 4) return;
    // ② 它自己是可滚的
    if (getComputedStyle(el).overflowY !== "auto" && getComputedStyle(el).overflowY !== "scroll") return;
    // ③ 它不属于任何浮层（浮层内部的滚动区必须保持可滚）
    for (let n: HTMLElement | null = el; n && n !== doc.body; n = n.parentElement) {
      if (getComputedStyle(n).position === "fixed") return;
    }
    out.push(el);
  });
  return out;
}

function applyLock(): void {
  if (typeof document === "undefined") return;
  for (const el of findBackgroundScrollers()) {
    if (saved.has(el)) continue;
    saved.set(el, {
      overflowY: el.style.overflowY,
      overscrollBehaviorY: el.style.overscrollBehaviorY,
      scrollTop: el.scrollTop,
    });
    // 内联样式（而不是给类加 class）：它与 App.css 里 `.note-scroll{overflow-y:auto}`
    // 的层叠无关，所以不受"窄屏规则被后置基础规则压掉"那类问题影响。
    el.style.overflowY = "hidden";
    // 锁住之后也不许把滚动"传染"给祖先（iOS 上的橡皮筋）。
    el.style.overscrollBehaviorY = "contain";
  }
}

function releaseAll(): void {
  // 遍历 map 而不是 DOM：元素可能在锁住期间已经被移出文档，
  // 但它的内联样式仍要还原（否则下次复用时带着 hidden）。
  saved.forEach((state, el) => {
    el.style.overflowY = state.overflowY;
    el.style.overscrollBehaviorY = state.overscrollBehaviorY;
    el.scrollTop = state.scrollTop;
  });
  saved.clear();
}

/** 只在"新增的节点里出现了候选滚动容器"时重扫，避免给每次 DOM 变动买单。 */
function onMutations(records: MutationRecord[]): void {
  for (const rec of records) {
    for (const node of rec.addedNodes) {
      if (node.nodeType !== 1) continue;
      const el = node as HTMLElement;
      if (el.matches?.(SCROLL_CONTAINER_SELECTOR) || el.querySelector?.(SCROLL_CONTAINER_SELECTOR)) {
        applyLock();
        return;
      }
    }
  }
}

function startWatching(): void {
  if (observer || typeof MutationObserver === "undefined" || typeof document === "undefined") return;
  observer = new MutationObserver(onMutations);
  observer.observe(document.body, { childList: true, subtree: true });
}

function stopWatching(): void {
  observer?.disconnect();
  observer = null;
}

function acquire(): void {
  activeOwners += 1;
  // 无论是不是第一个，都要 apply 一次：可能在这期间有新的滚动容器挂上来，
  // 或者这一份锁对应的是另一个视图节点。
  applyLock();
  startWatching();
}

function release(): void {
  activeOwners -= 1;
  if (activeOwners > 0) return;
  activeOwners = 0;
  stopWatching();
  releaseAll();
}

/** 仅供测试 / 验收读取：当前开着的浮层数（0 = 没锁）。 */
export function overlayScrollLockCount(): number {
  return activeOwners;
}

/** 仅供测试 / 验收读取：当前被我们改写过的滚动容器数。 */
export function overlayScrollLockedElements(): number {
  return saved.size;
}

/** 仅供测试 / 验收读取：被锁住的容器类名（验收脚本据此断言"锁对了对象"）。 */
export function overlayScrollLockedClasses(): string[] {
  return [...saved.keys()].map((el) => String(el.className || el.tagName)).slice(0, 12);
}

/**
 * 在 `active` 为真期间锁住外壳滚动，`active` 转假或卸载时恢复。
 *
 * 默认 `active = true`：调用方通常只在"浮层已打开"时才渲染这个 hook 所在的
 * 组件（或已经在外面短路了），此时传一个常量 true 更贴近意图。
 */
export function useOverlayScrollLock(active = true): void {
  useEffect(() => {
    if (!active) return;
    acquire();
    return release;
  }, [active]);
}
