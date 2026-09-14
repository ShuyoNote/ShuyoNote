// 浮层打开时锁住**真正的那个滚动容器**——不是 `body`。
//
// 为什么不是 body（2026-09-14 实测，390x844 触屏视口）：
//   这个应用的滚动条根本不在 body 上——`.app { overflow: hidden }` 把整页钉死，
//   真正滚的是内容区 `.note-scroll`。所以
//   `document.body.style.overflow = "hidden"` 在这里**一点作用都没有**：
//   搜索面板打开时用手指拖背景，正文照样被拖走 323px（`scrollTop` 实测变化）。
//   凡是"在别的项目里管用"的锁体写法，在这套布局里都是安慰剂。
//
// 语义：
//   - **只要有任意一个浮层开着，内容区就是锁的**（全局计数，不是按元素引用计数）。
//     多个浮层叠着时（「存储 → 设置」「确认框盖在输入框上」），关掉上面那层
//     不能把锁提前解掉——下面那层还在。
//   - **保留并恢复 `scrollTop`**：`overflow:hidden` 通常不丢滚动位置，但"滚动容器
//     在锁住期间被换掉、内容高度骤变"时会 clamp 到 0，所以显式存一份写回去。
//   - **盯住 `.note-scroll` 被重建**：它是 SPA 里的视图节点，切页/重挂载会换成
//     一个新元素。只在"打开那一刻查一次"是不够的——第一次写这个 hook 就是这么写
//    的，验收脚本在长会话里跑到第 10 个浮层时抓到了：那一刻 `.note-scroll` 还没
//     挂上，于是**一个元素都没锁**，之后新挂上来的那个自然也没被锁。
//     现在用一个 MutationObserver 盯新增节点，补锁。它同时保证"浮层开着的时候
//     新出现的滚动容器也归锁管"。
//
// 用法（挂在覆盖层组件里，`active` 就是那个浮层的 open 状态）：
//   useOverlayScrollLock(open);
import { useEffect } from "react";

/** 内容区滚动容器。与 App.css 的 `.note-scroll` 同源，改那边就得改这里。 */
export const SCROLL_CONTAINER_SELECTOR = ".note-scroll";

interface SavedStyle {
  overflowY: string;
  overscrollBehaviorY: string;
  scrollTop: number;
}

/** 当前开着的浮层数（>0 ⇒ 内容区应当被锁）。 */
let activeOwners = 0;
const saved = new Map<HTMLElement, SavedStyle>();
let observer: MutationObserver | null = null;

function applyLock(): void {
  if (typeof document === "undefined") return;
  document.querySelectorAll<HTMLElement>(SCROLL_CONTAINER_SELECTOR).forEach((el) => {
    if (saved.has(el)) return;
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
  });
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

/** 只对"新增的节点里带 `.note-scroll`"这一种变化补锁，避免给每次 DOM 变动买单。 */
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
  // 无论是不是第一个，都要 apply 一次：可能在这期间有新的 `.note-scroll` 挂上来，
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

/**
 * 在 `active` 为真期间锁住内容区滚动，`active` 转假或卸载时恢复。
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
