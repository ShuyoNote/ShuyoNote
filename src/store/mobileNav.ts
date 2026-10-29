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
 *    `07 设置`（**2026-10-14 阶段 2 接进来** ✓：手机 ⚙️ 走它 ✓）；`09 启动页` 还没接进来 ✗（⚠️ `04 阅读` 不在这条轴上 ——
 *    它由 `App.tsx` 的 `isMobile && currentId` 那一支决定 ✓，见 `MobileRead.tsx` 文件头 ✓）。
 * ⚠️ 它**只管移动端**：`App.tsx` 里是在 `isMobile` 那一支里读它的 ✓，桌面分支一个字不动 ✓。
 */
export type MobileScreen = "home" | "capture" | "search" | "pair" | "settings" | "paircode";

interface MobileNavState {
  screen: MobileScreen;
  /**
   * ⭐ **上一屏**（阶段 3 加 ✓）：供"返回"回到**来处** ✓（⛔ 不是写死的首页 ✗）。
   *
   * ⚠️ 它**不是第二份导航状态** ✗ —— 就是 `screen` 的伴生字段 ✓（同一份 state ✓、同一个 store ✓），
   *    而且**由 store 自己维护** ✓ ⇒ ⛔ 不需要每个入口各写一遍"我从哪来" ✗
   *    （`MobileSettings` 那行 ✓ 与首页「同步」胶囊 ✓ 天然各带来处 ✓）。
   * ⚠️ 兜底：`null` ⇒ 调用方回 `home` ✓（⛔ 不崩 ✗）。
   */
  cameFrom: MobileScreen | null;
  /**
   * ⭐ **带着哪一台设备进「首次配对」**（d1 ✓）—— 与桌面 `nearby-allow` **同形** ✓：
   * 只记 peer ＋ 打开「确认身份」屏 ✓，⛔ **先不发任何信任请求** ✗；⛔ 不复制面板的 `setDpPeer` 整套状态 ✗。
   */
  pairPeer: { deviceId: string; deviceName: string; shortId: string; pubkey: string } | null;
  setPairPeer: (peer: { deviceId: string; deviceName: string; shortId: string; pubkey: string } | null) => void;
  setScreen: (screen: MobileScreen) => void;
}

export const useMobileNav = create<MobileNavState>((set) => ({
  screen: "home",
  cameFrom: null,
  pairPeer: null,
  setPairPeer: (peer) => set({ pairPeer: peer }),
  // ⭐ 切到**不同**的屏时记下上一屏 ✓；重复 set 同一屏 ⇒ 不覆盖来处 ✓（免得把自己的来处冲掉 ✗）。
  setScreen: (screen) => set((s) => ({ screen, cameFrom: s.screen === screen ? s.cameFrom : s.screen })),
}));
