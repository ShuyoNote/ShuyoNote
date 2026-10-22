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
 * 浮「＋」：右下、**底栏上方** —— 点它＝**进「快速记录」屏**（马上能写字）✓。
 *
 * ⭐⭐ **2026-10-22（owner：「浮＋ 与快速记录有什么区别」）：这个按钮以前是死路** ✗ ——
 *   旧实现是 `createPage(null)` ⇒ 建一个**空页**，而手机档 `currentId` 有值就落到
 *   `MobileRead`（**只读阅读屏，没有编辑界面**）⇒ 用户看到的是"空白页、没有输入框"
 *   ＝ 跟"点了没反应"一样 ✓（真机复现过：`App.tsx` 的 `isMobile ? <MobileRead/> : <NoteEditor/>`）。
 *
 * ⇒ 现在改成与首页主卡**同一条路**：`setScreen("capture")` ⇒ 进「02 快速记录」屏
 *   （输入区 ＋ 键盘上方 6 项工具栏 ＋「存」）✓
 *   · 两个入口**形态**仍不同：首页主卡带说明（主行动）／浮「＋」是任何屏的快捷 ✓
 *   · ⛔ 不再自己 `createPage`：建页由 `MobileCapture` 在「存」时**一次写完**（含内容）✓
 *     否则又会造出"有页没内容"的空壳 ✗
 *
 * ⚠️ 它挂在 `.m-tabshell` 里但 `position: fixed` ✓ —— 外壳没有 `overflow: hidden`，
 *    所以不会被 `.mshell` 的滚动裁掉 ✓（`.mshell` 自己是另一个元素 ✓）。
 * ⚠️ 现在**只在首页渲染**（`App.tsx` 的 `showFab: mobileScreen === "home"` ✓）——
 *    02/03/07 那几屏没有它（效果图也没有），免得压住快捷工具栏/搜索结果 ✓。
 */
export function MobileComposeFab() {
  return (
    <button
      type="button"
      className="mtab-fab"
      aria-label="快速记录"
      title="快速记录"
      onClick={() => {
        // ⭐ 与首页「快速记录」主卡**同一个动作**：进 02 屏（⛔ 不在这里建页 ✗）。
        useMobileNav.getState().setScreen("capture");
      }}
    >
      <PlusIcon width={24} height={24} />
    </button>
  );
}
