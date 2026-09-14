import { useCallback, useEffect, useRef, useState } from "react";
import { isNarrowViewport } from "./useMobile";

// Position a popover as `position: fixed` anchored to its trigger button, so
// it is not clipped by an ancestor's `overflow: hidden`. Also closes the
// popover when clicking outside the trigger or the popover content.
//
// `width`/`minSpace` describe the popover's own box so the clamping matches it:
// a wider panel must be pulled further left to stay on screen, and a taller one
// needs more room below before it may open downward.
//
// ── 2026-09-14：坐标改成**相对包含块**，并加上窄屏的底部弹层分支 ──────────
//
// 为什么（实测）：`position: fixed` 并不总是相对视口——只要有一个祖先带了
// `transform` / `filter` / `will-change` / `contain`，那个祖先就成了包含块。
// 窄屏收起的左侧竖条正是这样：`.activity-bar { transform: translateX(-100%) }`
// 让它（宽 48px、在视口 x = -48 处）成了搜索/回收站浮层的包含块，
// 于是代码里算出来的 `left: 8` 实际落在 **-40px**——浮层被切掉左侧 48px。
// 对照实验：给竖条注入 `transform: none` 之后，同一个 `left: 8` 就回到 8。
//
// 两条一起修（只修一条都会留后患）：
//   1. App.css 里窄屏竖条改用 `left: -48px` 收起（`left` **不建立**包含块），
//      把这类坑从源头上掐掉；
//   2. 这里仍然按包含块折算坐标——它同时管住了"以后谁再给某个祖先加
//      transform"的情况。**不选 createPortal(document.body) 的理由**：
//      那 5 个浮层都靠"打开时顺手把竖条收起来"这个 DOM 位置与层叠上下文
//      （`--z-popover` / 遮罩 z-index）协作，搬到 body 之后点击穿透与
//      层叠顺序都要重新设计一遍，收益却与折算坐标等同。
//
// 另外：打开期间监听 `resize` 与 `visualViewport.resize`（软键盘弹出、
// 旋转、拖分隔条都会触发）并重算——此前只在 toggle 时算一次，
// 键盘一弹浮层就停在旧坐标上。
export function usePopover<T extends HTMLElement = HTMLButtonElement>(
  opts: { width?: number; minSpace?: number } = {},
) {
  const { width = 340, minSpace = 360 } = opts;
  const [open, setOpen] = useState(false);
  const [isSheet, setIsSheet] = useState<boolean>(() => isNarrowViewport());
  // 窄屏走底部弹层：`pos` 为空对象，内联样式什么都不设，
  // 位置全部交给 App.css 里的 `@media (max-width: 768px)` 段。
  const [pos, setPos] = useState<{ top?: number; left?: number; bottom?: number }>({ left: 0 });
  const triggerRef = useRef<T | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  const place = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    // 窄屏：不锚定，走底部弹层。
    if (isNarrowViewport()) {
      setIsSheet(true);
      setPos({});
      return;
    }
    setIsSheet(false);
    const rect = el.getBoundingClientRect();
    const cb = containingBlock(el);
    const cbRect = cb ? cb.getBoundingClientRect() : null;
    // 包含块的"坐标原点"在视口里的位置。null（= 视口本身）时就是 (0, 0)。
    const originX = cbRect ? cbRect.left : 0;
    const originY = cbRect ? cbRect.top : 0;
    const originHeight = cbRect ? cbRect.height : window.innerHeight;

    // 目标是**视口坐标**，再折算回包含块坐标（`left: L` ⇒ 视口 x = originX + L）。
    const wantX = Math.max(8, Math.min(rect.left, window.innerWidth - width));
    const left = wantX - originX;
    const belowSpace = window.innerHeight - rect.bottom;
    // Anchor the trigger near the viewport bottom? Open UPWARD (bottom-anchored)
    // so the popover isn't pushed off-screen (e.g. the sidebar's 回收站 button).
    if (belowSpace < minSpace) {
      // 视口坐标下：浮层底边距视口底 = innerHeight - rect.top + 6。
      const wantBottomGap = window.innerHeight - rect.top + 6;
      // `bottom: B` ⇒ 视口 y = originY + originHeight - B ⇒ B = originY + originHeight - y。
      const bottom = (originY + originHeight) - (window.innerHeight - wantBottomGap);
      setPos({ left, bottom });
    } else {
      setPos({ left, top: rect.bottom + 6 - originY });
    }
  }, [width, minSpace]);

  const toggle = useCallback(() => {
    if (open) {
      setOpen(false);
    } else {
      place();
      setOpen(true);
    }
  }, [open, place]);

  const close = useCallback(() => setOpen(false), []);

  // 关闭状态下视口变了也要跟着改判定：否则"窄屏打开过、转成宽屏"之后
  // `isSheet` 会一直卡在 true，浮层再打开就没有锚点了。
  useEffect(() => {
    if (open) return;
    const onResize = () => {
      if (isNarrowViewport() !== isSheet) setIsSheet(isNarrowViewport());
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [open, isSheet]);

  // 打开期间：视口/软键盘变化就重算坐标。
  useEffect(() => {
    if (!open) return;
    const reflow = () => place();
    window.addEventListener("resize", reflow);
    window.addEventListener("orientationchange", reflow);
    const vv = window.visualViewport;
    vv?.addEventListener("resize", reflow);
    vv?.addEventListener("scroll", reflow);
    return () => {
      window.removeEventListener("resize", reflow);
      window.removeEventListener("orientationchange", reflow);
      vv?.removeEventListener("resize", reflow);
      vv?.removeEventListener("scroll", reflow);
    };
  }, [open, place]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (contentRef.current?.contains(target)) return;
      // 点击落在打开的模态层（输入弹窗 / 确认框等）时不关闭 popover——
      // 模态层优先级更高，否则「创建空间」这种从 popover 里打开输入框的操作
      // 会因点击确认按钮而被误关（确认在 capture 阶段、目标不在 popover 内）。
      if (target instanceof Element && target.closest(".confirm-overlay, .ai-settings-overlay, [data-modal-overlay]")) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [open]);

  return { open, pos, isSheet, triggerRef, contentRef, toggle, close };
}

/**
 * 最近的、建立了**包含块**的祖先（`position: fixed` 后代相对它定位）。
 * 没有则返回 null，表示包含块就是视口。
 *
 * 建立包含块的条件（CSS Positioned Layout / Transforms，取并集）：
 * `transform` / `translate` / `rotate` / `scale` / `perspective` / `filter` /
 * `backdrop-filter` 非 none，`will-change` 提到其中任一，或
 * `contain` 含 paint / layout / strict / content。
 *
 * ⚠️ 这里**不处理祖先带缩放（scale）的情况**：折算的是平移量，
 * 祖先缩放时还需要除以缩放比。本项目里没有对浮层祖先做缩放的先例，
 * 真要做的话请把 `getBoundingClientRect().width / offsetWidth` 一并算进来。
 */
function containingBlock(el: HTMLElement | null): HTMLElement | null {
  if (typeof window === "undefined") return null;
  const nonNone = (v: string | undefined) => typeof v === "string" && v !== "none" && v !== "";
  let node = el?.parentElement ?? null;
  const stop = document.body;
  while (node && node !== stop && node !== document.documentElement) {
    const cs = window.getComputedStyle(node);
    if (
      nonNone(cs.transform) ||
      nonNone(cs.perspective) ||
      nonNone(cs.filter) ||
      nonNone(cs.backdropFilter) ||
      // `translate` / `rotate` / `scale` 是独立属性（新语法）；
      // 老引擎上是 undefined，`nonNone` 会安全地判 false。
      nonNone((cs as unknown as { translate?: string }).translate) ||
      nonNone((cs as unknown as { rotate?: string }).rotate) ||
      nonNone((cs as unknown as { scale?: string }).scale) ||
      /transform|perspective|filter/.test(cs.willChange || "") ||
      /paint|layout|strict|content/.test(cs.contain || "")
    ) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}
