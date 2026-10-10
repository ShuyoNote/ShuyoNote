import { create } from "zustand";

/**
 * **移动端自己的屏栈**（就一档，够用为止 ✓）。
 *
 * 为什么要有它：手机档的"屏"与桌面的 `view`（`useViewStore`）**不是一回事** ✗ ——
 * 桌面那套 `view` 是"主区显示哪个大视图（笔记/看板/关系图…）"，而移动端这几屏
 * （首页 → 快速记录 → …，见 `docs/plans/mobile/2026-10-08-mobile-spec.md` §4）
 * 是**整屏**的 ✓。把它们塞进 `view` 会让桌面也认识这些值 ✗ ⇒ 单独一个小 store ✓。
 *
 * ⚠️ 现状（不许把没做的写成做了 ✗）：`home`（首页）／`capture`（快速记录）／
 *    `search`（**03 搜索**，2026-10-10 接进来 ✓）三档 ✓；
 *    `07 设置` / `09 启动页` 还没接进来 ✗（⚠️ `04 阅读` 不在这条轴上 ——
 *    它由 `App.tsx` 的 `isMobile && currentId` 那一支决定 ✓，见 `MobileRead.tsx` 文件头 ✓）。
 * ⚠️ 它**只管移动端**：`App.tsx` 里是在 `isMobile` 那一支里读它的 ✓，桌面分支一个字不动 ✓。
 */
export type MobileScreen = "home" | "capture" | "search" | "pair";

interface MobileNavState {
  screen: MobileScreen;
  setScreen: (screen: MobileScreen) => void;
}

export const useMobileNav = create<MobileNavState>((set) => ({
  screen: "home",
  setScreen: (screen) => set({ screen }),
}));
