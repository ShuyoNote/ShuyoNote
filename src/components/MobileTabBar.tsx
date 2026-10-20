import { useNotes } from "../store/notes";
import { useMobileNav } from "../store/mobileNav";
import type { MobileScreen } from "../store/mobileNav";
import { PageIcon, PersonIcon, PlusIcon, SearchIcon } from "./icons";

/**
 * **移动端底边栏**（规格 §4 的全局导航，2026-10-19 第二刀）。
 *
 * 为什么要有它：删掉左下角那颗 ☰ 之后，**设置 / 关于 / 设备配对**在手机上就再没有入口 ✗
 * （它们原先只能"开抽屉 → ⚙️"两步才到 ✓）⇒ 底栏的「我的」就是它们**唯一的门** ✓。
 * ⚠️ 因此本文件必须与 `App.tsx` 删 ☰ 的那一刀**同一笔落地** ✓（只删 ☰ 不接底栏 ⇒ 那三屏全成死屏 ✗）。
 *
 * 规矩（照效果图逐条 ✓）：
 * - 三项：**笔记 / 搜索 / 我的** ✓；图标复用 `./icons`（⛔ 不新引图标库 ✗）。
 * - 选中态＝**实心主色**（图标背后的胶囊用 `--accent`，文字同色 ✓）。
 * - 每项触区 ≥44×44、栏高 56–64 ✓（见 `App.css` 的 `.mtab-*`）。
 * - 类名一律 `mtab-*`（⭐ 必须带连字符 —— 仓里有过 `mpaircode` 少个连字符被
 *   `check-mobile-class-namespace` 拒的先例 ✓）。
 * - 点击只走仓库现有的 `mobileNav` store ✓（⛔ 不新造导航状态 ✗）。
 */
const TABS: {
  id: Extract<MobileScreen, "home" | "search" | "settings">;
  label: string;
  Icon: typeof PageIcon;
  /** 这一项在哪些屏上显示为选中（`capture` 是首页主行动的子屏 ⇒「笔记」保持选中 ✓）。 */
  activeOn: MobileScreen[];
}[] = [
  { id: "home", label: "笔记", Icon: PageIcon, activeOn: ["home", "capture"] },
  { id: "search", label: "搜索", Icon: SearchIcon, activeOn: ["search"] },
  { id: "settings", label: "我的", Icon: PersonIcon, activeOn: ["settings"] },
];

export function MobileTabBar() {
  const screen = useMobileNav((s) => s.screen);
  const setScreen = useMobileNav((s) => s.setScreen);

  return (
    <nav className="mtab-bar" aria-label="主导航" data-testid="mobile-tabbar">
      {TABS.map(({ id, label, Icon, activeOn }) => {
        const on = activeOn.includes(screen);
        return (
          <button
            key={id}
            type="button"
            className={"mtab-item" + (on ? " is-on" : "")}
            data-tab={id}
            aria-current={on ? "page" : undefined}
            onClick={() => setScreen(id)}
          >
            <span className="mtab-ico" aria-hidden>
              <Icon width={20} height={20} />
            </span>
            <span className="mtab-label">{label}</span>
          </button>
        );
      })}
    </nav>
  );
}

/**
 * 浮「＋」：右下、**底栏上方** —— 点它＝新建笔记 ✓。
 *
 * ⚠️ 只用仓库现有的动作 `useNotes.getState().createPage(null)` ✓（默认 `select` 会打开新页 ⇒
 *    落到 `MobileRead` ✓）；⛔ 不另写一套"先建页再打开" ✗。
 * ⚠️ 先 `setScreen("home")`：`App.tsx` 里 **`settings` 支排在 `currentId` 之前** ✓ ⇒
 *    若停在「我的」上，新页建好了却被设置屏抢走 ⇒ 用户看到"点了没反应" ✗（实测 ✓）。
 *    回首页后 `currentId` 那一支自然接管 ⇒ 新页立刻出现在阅读屏 ✓。
 * ⚠️ 它挂在 `.m-tabshell` 里但 `position: fixed` ✓ —— 外壳没有 `overflow: hidden`，
 *    所以不会被 `.mshell` 的滚动裁掉 ✓（`.mshell` 自己是另一个元素 ✓）。
 */
export function MobileComposeFab() {
  return (
    <button
      type="button"
      className="mtab-fab"
      aria-label="新建笔记"
      title="新建笔记"
      onClick={() => {
        // 见上：设置屏优先级高于 currentId，先把屏栈复位再建页（否则新页被设置屏挡住）。
        useMobileNav.getState().setScreen("home");
        void useNotes.getState().createPage(null);
      }}
    >
      <PlusIcon width={24} height={24} />
    </button>
  );
}
