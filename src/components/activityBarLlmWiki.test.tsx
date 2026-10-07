// 判据：**侧边工具栏**里、紧挨着「知识地图」**下面**，要有一颗 **LLM Wiki 的图标按钮**
//（owner 2026-10-08 的原话：「在侧边工具栏的『知识地图』按钮入口下面添加 LLM Wiki 的图标按钮」✓）。
//
// 三条都要机器可判：
//   ① **位置**：它就在「知识地图」那颗的**正下面** —— 按竖条里 `.activity-btn` 的 **DOM 次序**量 ✓
//      （「下面」是可核的顺序，不是印象 ✓；顺带也证明它没被放到模板中心/设置那一组去 ✗）；
//   ② **动作**：点它就是 `useEditorStore.openSettings("ai")` —— 与命令面板那条 `ai.libraryMap`
//      **同一个动作** ✓（⛔ 不另造一条"打开库地图"的路 ✗）；
//   ③ **它不是"活动"**：不参与高亮、**不许 `setView` / `setActivity`** —— 它是"去开一个面板"，
//      不是"切到某个视图" ✓（形态与竖条底部那颗「设置」一致 ✓）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import "../i18n";

const mocks = vi.hoisted(() => ({
  setActivity: vi.fn(),
  toggleSidebar: vi.fn(),
  setSidebarOpen: vi.fn(),
  setRailOpen: vi.fn(),
  setView: vi.fn(),
  openSettings: vi.fn<(tab?: string) => void>(),
  closePreview: vi.fn(),
}));

vi.mock("../store/activity", () => {
  const state = {
    activity: "map",
    sidebarOpen: true,
    railOpen: false,
    setActivity: mocks.setActivity,
    toggleSidebar: mocks.toggleSidebar,
    setSidebarOpen: mocks.setSidebarOpen,
    setRailOpen: mocks.setRailOpen,
  };
  const isActivity = (v: unknown) =>
    ["notes", "files", "board", "graph", "timeline", "map", "templates"].includes(String(v));
  const hook = (sel?: (s: typeof state) => unknown) => (sel ? sel(state) : state);
  return { useActivity: Object.assign(hook, { getState: () => state }), isActivity };
});
vi.mock("../store/view", () => {
  const state = { view: "map", setView: mocks.setView };
  const hook = (sel?: (s: typeof state) => unknown) => (sel ? sel(state) : state);
  return { useViewStore: Object.assign(hook, { getState: () => state }) };
});
vi.mock("../store/editor", () => ({
  useEditorStore: { getState: () => ({ openSettings: mocks.openSettings }) },
}));
vi.mock("../store/filePreview", () => ({
  useFilePreview: { getState: () => ({ close: mocks.closePreview }) },
}));
vi.mock("../hooks/useMobile", () => ({ isMobileViewport: () => false }));
// 竖条里这两颗自带弹层（各要一串 store）⇒ 桩掉，判据只关心竖条本身 ✓
vi.mock("./TrashPanel", () => ({ TrashPanel: () => null }));
vi.mock("./SearchPanel", () => ({ SearchPanel: () => null }));

import { ActivityBar } from "./ActivityBar";

let root: Root | null = null;

const btns = () => Array.from(document.querySelectorAll<HTMLButtonElement>(".activity-group .activity-btn"));
/** LLM Wiki 那颗：**按 aria-label 里的 "LLM Wiki"** 找 —— 中英两语的文案里都有这四个词 ✓（不依赖当前语言） */
const wikiBtn = () => btns().find((b) => /LLM Wiki/i.test(b.getAttribute("aria-label") ?? "")) ?? null;
const mapBtn = () => btns().find((b) => /知识地图|Knowledge map/i.test(b.getAttribute("title") ?? "")) ?? null;

beforeEach(() => {
  for (const f of Object.values(mocks)) f.mockClear();
  flushSync(() => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    root = createRoot(el);
    root.render(<ActivityBar />);
  });
});

afterEach(() => {
  if (root) flushSync(() => root!.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("侧边工具栏：知识地图下面的 LLM Wiki 图标按钮", () => {
  it("★ 它就在「知识地图」那颗的**正下面**（按 DOM 次序量）", () => {
    const map = mapBtn();
    const wiki = wikiBtn();
    expect(map, "找不到「知识地图」那颗（标题应当是 知识地图 / Knowledge map）").not.toBeNull();
    expect(wiki, "找不到 LLM Wiki 那颗（aria-label 里应当有 LLM Wiki）").not.toBeNull();
    const all = btns();
    expect(all.indexOf(wiki!)).toBe(all.indexOf(map!) + 1); // 紧挨着的下一颗 ✓
  });

  it("★ 点它 ⇒ openSettings(\"ai\")，且**不切视图、不换活动**（它是动作，不是活动）", () => {
    flushSync(() => wikiBtn()!.click());
    expect(mocks.openSettings).toHaveBeenCalledTimes(1);
    expect(mocks.openSettings).toHaveBeenCalledWith("ai");
    expect(mocks.setView).not.toHaveBeenCalled();
    expect(mocks.setActivity).not.toHaveBeenCalled();
  });

  it("★ 它**不参与高亮**（当前活动是 map：地图那颗亮着，LLM Wiki 那颗不亮）", () => {
    expect(mapBtn()!.className).toContain("is-on");
    expect(wikiBtn()!.className).not.toContain("is-on");
    expect(wikiBtn()!.getAttribute("aria-current")).not.toBe("true");
  });

  it("它有图标（不是空按钮 —— 竖条是图标条，空按钮等于看不见）", () => {
    expect(wikiBtn()!.querySelector("svg")).not.toBeNull();
  });

  it("★ 图标与竖条其它图标**同一套风格**：单色描边 ＋ 同一 viewBox/线宽，⛔ 不许自带彩色渐变", () => {
    const wikiSvg = wikiBtn()!.querySelector("svg")!;
    const mapSvg = mapBtn()!.querySelector("svg")!; // 「知识地图」那颗：它就是本竖条的样板
    // ① 单色、跟主题走（竖条里所有图标都这样：`Icon` 外壳写死 fill=none + stroke=currentColor ✓）
    expect(wikiSvg.getAttribute("stroke")).toBe("currentColor");
    expect(wikiSvg.getAttribute("fill")).toBe("none");
    // ② 几何口径与邻居逐字一致（换 viewBox/线宽 ⇒ 与旁边几颗"不是一套"✓）
    expect(wikiSvg.getAttribute("viewBox")).toBe(mapSvg.getAttribute("viewBox"));
    expect(wikiSvg.getAttribute("stroke-width")).toBe(mapSvg.getAttribute("stroke-width"));
    // ③ ⛔ 不许自带渐变：`AiSparkIcon` 就是被这条挡下的（它 `stroke="url(#aiAssistGrad)"` ＋ 内联 `<linearGradient>`）
    expect(wikiSvg.querySelector("linearGradient")).toBeNull();
    expect(wikiSvg.innerHTML).not.toContain("url(#");
    // ④ 也不许写死颜色（写死就变成"深色主题下还是那个色" ✗）
    expect(/stroke="#|fill="#/.test(wikiSvg.innerHTML)).toBe(false);
  });
});
