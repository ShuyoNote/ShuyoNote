// 把 `.note-scroll` 那个滚动容器的位置**按页面**记下来，并在回到这一页时恢复。
//
// 来由（owner 2026-10-06）：「刷新页面，当前页面位置丢失了」。
//
// 五条口径（前三条是设计，后两条是**实测踩出来的**）：
//  ① **存 `localStorage`、按 key 一页一条**（存取那一半在 `lib/scrollMemory.ts` ✓，带上限剪枝）；
//  ② **恢复要重试**：正文/题头图是异步来的 —— 刚刷新那一刻 `scrollHeight` 还装不下目标值，
//     一次 `scrollTop = y` 会被夹成当时的最大值 ✗；
//  ③ **没有记录的页面要显式回顶部**（容器换页不重建 ⇒ 否则会"继承"上一页的位置 ✗）；
//  ④ ⚠️ **等"内容就绪"再恢复**（`ready`）：只靠"重试若干帧"不够 —— 整页刷新后，页面 JSON 要
//     走完 `loadPages`＋`openPage` 才到，那时早过了几十帧 ⇒ 重试窗口早放弃、位置还是 0 ✗
//     （本机实测：修前刷新后读到的就是 0 ✓）。所以调用方把"这一页的详情到位了没"传进来 ✓，
//     而且重试窗口放宽到 ~3s（图片/题头图还会再撑高一点 ✓）；
//  ⑤ ⚠️ **恢复完成前不许写盘**：内容还没到的时候 `scrollTop` 是 0，那时若把 0 存进去，
//     就把之前记的位置**擦掉了** ✗ ⇒ 用 `restoredRef` 把"保存"挡在恢复之后 ✓；
//     另外**用户一动（滚轮/触摸/按键）就立刻停手**，别跟人抢滚动条 ✓。
import { useEffect, useRef, type RefObject } from "react";
import { readScroll, writeScroll } from "../lib/scrollMemory";

/** 节流窗口：滚动停下约 200ms 后落盘（够快，又不会每帧写 localStorage）。 */
const SAVE_DEBOUNCE_MS = 200;
/**
 * 恢复的**轮询**间隔与总期限（不是"重试若干帧"）。
 *
 * ⚠️ 为什么不用 rAF 数帧：整页刷新后高度是**分几段**长起来的（壳 → 页面 JSON → 题头图/图片），
 *    固定帧数（哪怕 180 帧 ≈3s）会在半路放弃，于是位置停在**当时的** `max`（本机实测：600 被夹成 523 ✗）。
 *    ⇒ 改成"每 100ms 探一次，直到装得下；最多等 6s"，期间**用户一动就停手** ✓。
 */
const RESTORE_POLL_MS = 100;
const RESTORE_DEADLINE_MS = 6000;
/**
 * 落位之后再"守"一会儿（约 1.2s）。
 *
 * ⚠️ 为什么需要：本机实测（Edge + 整页刷新）—— 我们刚把 `scrollTop` 设成 600 ✓，
 *    紧接着**别人又把它改回 524** ✗：编辑器挂载后把光标/首块滚进视口、以及浏览器自己的
 *    历史滚动恢复，都会在这之后动同一个容器。⇒ 落位后在这个窗口里**继续守着**：
 *    位置被人挪走（且**不是用户操作**）就再放回去 ✓（浏览器那一半由 ⓪ 直接关掉 ✓）。
 * ⚠️ 守的边界：① 用户一动（滚轮/触摸/指针/按键）立即停手 ✓；② 窗口过了就彻底放手 ✓。
 */
const SETTLE_WINDOW_MS = 1200;

export function useScrollMemory(
  ref: RefObject<HTMLElement | null>,
  key: string | null,
  ready = true,
): void {
  const restoredRef = useRef(false);

  // ⓪ 关掉**浏览器自己的**历史滚动恢复：页面本身不滚（滚的是 `.note-scroll`），而 Chromium 仍可能
  //    把内层滚动器的位置在刷新后恢复一次 ⇒ 与我们抢同一个容器（实测：它把 600 顶回 524 ✗）。
  //    本 hook 在时接管这件事：设 `manual` ✓，卸载时还回去 ✓。
  useEffect(() => {
    if (typeof history === "undefined" || !("scrollRestoration" in history)) return;
    const prev = history.scrollRestoration;
    history.scrollRestoration = "manual";
    return () => {
      history.scrollRestoration = prev;
    };
  }, []);
  // ① 保存：key 定了就挂滚动监听（但**恢复完成前不写盘**，见口径 ⑤）
  useEffect(() => {
    const el = ref.current;
    if (!el || !key) return;
    restoredRef.current = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onScroll = () => {
      if (!restoredRef.current) return; // 加载期的 0 不许落盘 ✗
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        writeScroll(key, el.scrollTop);
      }, SAVE_DEBOUNCE_MS);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (timer) clearTimeout(timer);
      if (restoredRef.current) writeScroll(key, el.scrollTop); // 切页/卸载前补最后一笔 ✓
    };
    // ⚠️ 依赖只有 `key`：`ref.current` 在同一容器里是同一个元素（换页不重建容器 ✓）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // ② 恢复：等 `ready`（这一页的详情到位）再恢复；带重试；用户一动就停手（口径 ②③④⑤）
  useEffect(() => {
    const el = ref.current;
    if (!el || !key || !ready) return;

    const target = readScroll(key);
    if (target <= 0) {
      el.scrollTop = 0; // 口径 ③
      restoredRef.current = true;
      return;
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    let waited = 0;
    let settledAt = -1; // ≥0 ⇒ 已经落位过，进入"守着"窗口
    let stopped = false;
    const stop = () => {
      stopped = true;
    };
    const stopEvents = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
    stopEvents.forEach((e) => el.addEventListener(e, stop, { passive: true }));

    const tick = () => {
      if (stopped) return;
      const max = Math.max(0, el.scrollHeight - el.clientHeight);
      const want = Math.min(target, max);
      // ① 还没落位：装得下就落位 ✓；等到期限还装不下 ⇒ 落到当时的最大值（内容可能变短了）
      // ② 已落位：在"守着"窗口里发现位置被别人挪走（编辑器把光标滚进视口 / 浏览器历史恢复）⇒ 再放回去 ✓
      if (settledAt < 0) {
        if (max >= target || waited >= RESTORE_DEADLINE_MS) {
          el.scrollTop = want;
          restoredRef.current = true; // 从这一刻起，"保存"才生效 ✓
          settledAt = waited;
        }
      } else if (waited - settledAt < SETTLE_WINDOW_MS && Math.abs(el.scrollTop - want) > 2) {
        el.scrollTop = want;
      }
      // 窗口过了（且不再需要重试）⇒ 彻底放手
      if (settledAt >= 0 && waited - settledAt >= SETTLE_WINDOW_MS) return;
      waited += RESTORE_POLL_MS;
      timer = setTimeout(tick, RESTORE_POLL_MS);
    };
    tick(); // 立即试一次（多数情况这时就已经装得下了 ✓）

    return () => {
      if (timer) clearTimeout(timer);
      stopEvents.forEach((e) => el.removeEventListener(e, stop));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ready]);
}
