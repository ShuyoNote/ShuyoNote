// 「一次只许有一份侧栏菜单」的判据 —— 钉 owner 2026-10-12 报的症状：
// 「**多次点击右键，会出现多个右键菜单**」（截图里两份 `.tree-node-menu` 叠着 ✓，
//  下面那份压住上面那份、上面只露「重命名」「复制到其他空间」✓）。
//
// ⭐ 结论：**(乙) 真缺陷** —— 那套"广播一下、让**别行**的菜单自己关掉"的机制**根本没送到** ✗：
//   · **派发**在 `window` 上：`PageTree.tsx:19`（修前）`window.dispatchEvent(new Event(TREE_MENUS_CLOSE_EVT));`
//   · **接收**在 `document` 上：`PageTree.tsx:321`（页面行 `TreeItem`）与 `:529`（文件行 `TreeFiles`）
//   ⇒ 按 DOM 事件路径，**在 `window` 上派发的事件不经过 `document`** ⇒ 那些监听一次也不会触发。
//     本机 happy-dom 逐字实测（与本判据同一个环境）：
//       `happy-dom: document-listener hits = 0 | window-listener hits = 1`
//     真 Chromium/Edge 同样（自建探针，⛔ 非门禁）：`{"docOnWindowDispatch":0,"winOnWindowDispatch":1,"docOnDocDispatch":1}`
//   ⇒ 右键 A 行（开）→ 右键 B 行（开）⇒ A 那份**没人关** ⇒ 两份并存 ✗ ＝截图那一幕 ✓。
//   ⚠️ 为什么"右键另一行"这条路上**没有别的兜底**：那条"点别处就关"的监听（`:309-332` / `:518-526`）
//      **只认左键**（`if (e.button !== 0) return;`）⇒ 右键**不是**"点别处" ✓
//      ⇒ 该关它的**唯一**机制就是上面那条广播 ⇒ 广播一失效，两份必然并存 ✓。
//   （来由：`PageTree.tsx:11-15` 的注释写着 2026-10-08 为了治"闪一下"把"点别处就关"改成只认左键，
//     于是右键另一行不再关前一行 ⇒ 才补了这条广播 ✓ —— ⭐ 广播**加了、但派发目标与监听目标不同源** ✗。）
//
// ⭐ owner 2026-10-12 的订正："**同一行**的右键菜单会关闭前任" ✓ ⇒ **同一行只留一份**（不变量成立 ✓，
//    本文件第一条用例把它留作**反面对照** ✓，不是判据的主体）；**多份共存只发生在不同行之间** ✗
//    ⇒ 判据主体就是**跨行不互斥** ✓（第二条用例 ✓）。
//
// ⭐ 四条排查问题的逐字回答（都带出处）：
//  1. **`closeOtherTreeMenus` 怎么实现的** ⇒ ⛔ **没有注册表** ✗（无 `useRef` 表、无模块级 Map、无 context）：
//     `:17-30` 是一个**纯广播**函数 —— `document.dispatchEvent(new Event(TREE_MENUS_CLOSE_EVT))`（修后 ✓）；
//     "谁能被关"由**各行自己挂的监听**决定（`:321` 页面行、`:529` 文件行），
//     而那两个 effect 的守卫是 `:310 if (!menuOpen) return;`（文件行）／`:517 if (!menuOpen && !copyOpen) return;`（页面行）
//     ⇒ ⭐ 装进去的是"**当前开着的行**"，不是"当前渲染过的行" ✓（比担心的那种更小、更准 ✓）；
//     卸载时也对称摘掉（`:325`／`:532`）✓。
//     ⭐ 所以"注册表漏了一行"这条**已被证否**：本文件"机制取证"那条用例——把广播**真的**派到 `document`，
//     两行的菜单**都会关** ⇒ 两行的监听当时**都在** ✓ ⇒ 坏的是**投递**，不是注册 ✗。
//  2. **菜单状态在哪** ⇒ ⭐ **行内 `useState`** ✓：`:492` `const [menuOpen, setMenuOpen] = useState(false);`
//     ＋ `:493` `menuAnchor`（文件行是 `:192`／`:193`；目标行另存 `menuFile`）。⇒ 一个实例一份状态 ⇒ 跨行互斥**只能**靠广播 ✓。
//  3. **菜单是每行各渲染一个、还是全局一份** ⇒ ⭐ **每行各渲染一个** ✓：`{menuOpen && (<span className="tree-node-menu">…)}`
//     就在该行自己的 `tree-actions`（`:700` 起）里 ⇒ `:722-723`；文件行那份在 `:373`，按**文件夹**实例一份
//     ⇒ **多份天然可以并存** ✗ ⇒ 那句注释里的"一次只许一份"**完全**依赖统一入口 ✓。
//  4. **有没有第二个入口绕过 `closeOtherTreeMenus()`** ⇒ ⭐ **有**（`⋯`，原 `:697-702` ＝ 修后 `:703-717`）。
//     四个右键 handler 全都调了它：页面行 `onMouseDown`（`:622-649`，`:639`／`:641`）／页面行 `onContextMenu`（`:651-659`，`:657`）／
//     文件行 `onMouseDown`（`:346-356`，`:351`／`:354`）／文件行 `onContextMenu`（`:357-364`，`:362`）
//     ⇒ **共 6 处**；但修前它们**一个都送不到** ✗。
//
// ⭐ **2026-10-12 两处修（本判据先红后绿 ✓）**：
//  ① `closeOtherTreeMenus()` 的派发目标 `window` ⇒ **`document`**（`PageTree.tsx:28`）—— 治**右键**那条路；
//  ② `⋯` 的 `onClick` 里**只在"开"的那一支**补广播（`PageTree.tsx:716` `if (!menuOpen) closeOtherTreeMenus();`）
//     —— 治**第二条路**：`修前` 右键 A 行 ⇒ 左键点 B 行的 `⋯` ⇒ 也留两份（实测 `menuCount = 2` ✗），
//     因为 `⋯` 原先**从不**广播，而 A 行那条"点别处就关"的监听见到目标是 `.tree-more` 就 `return`（`:523`）⇒ 也不关 ✓。
//     ⛔ **别把广播塞进 `:717` 那个 toggle 本体**（`setMenuOpen((v) => !v)`）：同步广播会先把本行关掉、
//     再被 toggle **打开** ⇒ **点一下收不起来** ✗ —— 这就是"只在开的那一支"的理由 ✓。
//  修前读数：`Tests 2 failed | 3 passed (5)`（两条判据都红：`expected 2 to be less than or equal to 1`）；
//  修后读数：`Tests 5 passed (5)` ✓。
//  ⚠️ **本文件里所有 `PageTree.tsx:N` 都是"两处修之后"量的行号** ✓（修前的行号见交付报告）。
//
// 形状抄 `src/components/folderClickView.test.ts`（真组件 ＋ `createRoot` ＋ `flushSync` ＋ 原生事件；
// 本仓没有 @testing-library ⇒ 没有 `fireEvent`）。⚠️ 本文件是 `.ts` ⇒ 用 `React.createElement`
// （`.ts` 里不转 JSX；见 `vitest.config.ts:9-11`）。
import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { PageTree } from "./PageTree";
import { useNotes } from "../store/notes";
import type { PageMeta } from "../types";

const ROW_A = "menu-row-a";
const ROW_B = "menu-row-b";
/** `PageTree.tsx:16` 的那条广播名（判据直接派它 ⇔ 不改源码）。 */
const CLOSE_EVT = "shuyo:close-tree-menus";

/** 造一份元数据（`src/types.ts` 的字段一个不少；与 `folderClickView.test.ts:49-60` 同形）。 */
const meta = (id: string, title: string, sort: number): PageMeta => ({
  id,
  workspace_id: "ws-1",
  parent_id: null,
  title,
  icon: "",
  kind: "page",
  sort_order: sort,
  created_at: 1_700_000_000 + sort,
  updated_at: 1_700_000_000 + sort,
  deleted_at: null,
});

let host: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  // ⚠️ 闭包里要用 `root?.unmount()` ✗ 不能写 `root.unmount()` —— `root` 是可变的模块级 `let`，
  //    TS 的窄化**进不了闭包** ⇒ `error TS18047: 'root' is possibly 'null'`（与 `folderClickView.test.ts:66` 同形 ✓）。
  if (root) flushSync(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function setup() {
  useNotes.setState({
    pages: [meta(ROW_A, "第一页", 0), meta(ROW_B, "第二页", 1)],
    loading: false,
    currentId: null,
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  flushSync(() => root?.render(React.createElement(PageTree)));
  const a = host.querySelector<HTMLElement>(`[data-node-id="${ROW_A}"]`);
  const b = host.querySelector<HTMLElement>(`[data-node-id="${ROW_B}"]`);
  if (!a || !b) throw new Error("侧栏里没渲染出那两行（夹具失败，不是判据红）");
  return { a, b };
}

/**
 * 「开着的菜单有几份」的第一份读数：`.tree-node-menu` 是 `menuOpen` 的**条件渲染**
 * （`PageTree.tsx:722` `{menuOpen && (<span className="tree-node-menu" …>`）⇒ 数节点＝数状态实例。
 */
const menuCount = (): number => host!.querySelectorAll(".tree-node-menu").length;
/**
 * 第二份读数，**更贴近状态本身**：`PageTree.tsx:705` `aria-expanded={menuOpen}` ✓
 * ⇒ 数 `aria-expanded="true"` 的 `⋯` 按钮 ＝ 数"这一行的 `menuOpen` 为真"。
 * ⚠️ `menuOpen` 是**组件内部** state（`:492`），外面取不到 ⇒ 这两种投影是唯一可核的读数 ✓。
 */
const openFlags = (): number =>
  [...host!.querySelectorAll(".tree-more")].filter((b) => b.getAttribute("aria-expanded") === "true").length;

/**
 * 用户的一次右键：按下（右键）→ 抬起 → `contextmenu`。
 * ⚠️ **两条路都要派**，因为源码里两条都留了、而且**两边都会开菜单**：
 *   · `onMouseDown` 的右键分支（`PageTree.tsx:636-644`，2026-10-08 为"窗口未激活时要点两下"加的 ✓）
 *   · `onContextMenu`（`PageTree.tsx:651`）
 * ⇒ 只派一条会漏测另一条（真实浏览器两条都发 ✓）。
 */
function rightClick(row: HTMLElement, x = 120, y = 100) {
  const init: MouseEventInit = { bubbles: true, cancelable: true, button: 2, clientX: x, clientY: y };
  flushSync(() => row.dispatchEvent(new MouseEvent("mousedown", init)));
  flushSync(() => row.dispatchEvent(new MouseEvent("mouseup", init)));
  flushSync(() => row.dispatchEvent(new MouseEvent("contextmenu", init)));
}

describe("侧栏菜单：一次只许有一份（owner 2026-10-12「多个右键菜单」）", () => {
  it("【反面对照·owner 已验正常】同一行**连按两次右键**（中间不点背景）⇒ 只许一份", () => {
    const { a } = setup();
    expect(menuCount(), "前提：右键前一份菜单都不该有").toBe(0);

    rightClick(a, 120, 100);
    // ⭐ 夹具前提**必须断言**（否则"一份都没有"会让下面那条空转 ⇒ 没牙的判据 ✓）
    expect(menuCount(), "夹具前提：第一次右键要真的把菜单画出来（`:722`）").toBe(1);
    expect(openFlags(), "夹具前提：那一行的 `aria-expanded` 要变真（`:705`）").toBe(1);

    // 第二次右键落在**同一行**：状态是**布尔**（`menuOpen`，`:492`）⇒ 只能仍是一份 ✓。
    rightClick(a, 140, 140);
    expect(menuCount(), "同一行连按两次右键：菜单仍然只许一份").toBeLessThanOrEqual(1);
    expect(openFlags(), "同一行连按两次右键：`menuOpen` 为真的行仍然只许一行").toBeLessThanOrEqual(1);
  });

  it("⭐ 判据①：不点背景，右键落到**另一行** ⇒ 仍然只许一份（修前红：两份并存）", () => {
    const { a, b } = setup();

    rightClick(a, 120, 100);
    expect(menuCount(), "夹具前提：A 行那份先开出来").toBe(1);

    rightClick(b, 120, 180);

    expect(
      openFlags(),
      "⭐ 右键另一行：A 行那份必须被关掉 —— 判据是 `PageTree.tsx:17-30` 的广播要送到 " +
        "`:321`/`:529` 的 `document` 监听（修前派在 `window` 上 ⇒ 永远送不到 ✗）",
    ).toBeLessThanOrEqual(1);
    expect(
      menuCount(),
      "⭐ 同一屏里不许有第二份 `.tree-node-menu` —— 两份并存就是 owner 截图那一幕 " +
        "（下面那份把上面那份的「复制为副本/新建子页面/删除」压住，只露出「重命名」「复制到其他空间」）",
    ).toBeLessThanOrEqual(1);
  });

  it("⭐ 判据②：右键 A 行 ⇒ 左键点 **B 行的 `⋯`** ⇒ 菜单数 ≤ 1（修前红：`⋯` 那条路从不广播）", () => {
    const { a, b } = setup();

    rightClick(a, 120, 100);
    expect(menuCount(), "夹具前提：A 行那份先开出来").toBe(1);

    // ⭐ A 行那个"点别处就关"的监听**对 `.tree-more` 放行**（`PageTree.tsx:523` 的
    //    `t.closest(".tree-node-menu, .tree-copy-panel, .tree-more")` ⇒ `return`）
    //    ⇒ 这一击**不会**顺手关掉 A ✓ ⇒ 只有 `⋯` 自己广播才救得回来 ✓。
    const more = b.querySelector<HTMLElement>(".tree-more");
    if (!more) throw new Error("B 行没有 `⋯` 按钮（夹具失败，不是判据红）");
    const init: MouseEventInit = { bubbles: true, cancelable: true, button: 0, clientX: 120, clientY: 180 };
    flushSync(() => more.dispatchEvent(new MouseEvent("mousedown", init)));
    flushSync(() => more.dispatchEvent(new MouseEvent("mouseup", init)));
    flushSync(() => more.dispatchEvent(new MouseEvent("click", init)));

    expect(
      openFlags(),
      "⭐ 点另一行的 `⋯` 开菜单：A 行那份必须被关掉 —— `⋯`（`PageTree.tsx:703-717`）修前" +
        "**不调** `closeOtherTreeMenus()` ⇒ A 的 `menuOpen` 一直为真 ✗（修法是 `:716` 只在「开」那一支广播）",
    ).toBeLessThanOrEqual(1);
    expect(
      menuCount(),
      "⭐ 同一屏里不许有第二份 `.tree-node-menu`（本格与右键那条是两个**独立**入口 ⇒ 两条都要广播 ✓）",
    ).toBeLessThanOrEqual(1);
  });

  it("拟修法验证：让广播**也派到 `document`**（＝ 修①的等价物）⇒ 判据① 的条件在测试里也成立", () => {
    const { a, b } = setup();
    // ⭐ 修① 之后这条**已是真代码的行为**；保留下它是为了把"一行修法就够治右键那条路"留在账上
    //    （若哪天有人把 `:28` 改回 `window`，判据① 会红 ✓ ⇒ 这条不会替它遮丑 ✓）。
    const real = window.dispatchEvent.bind(window);
    const spy = vi.spyOn(window, "dispatchEvent").mockImplementation((e: Event) => {
      const r = real(e);
      document.dispatchEvent(e); // ← 修法：与 `:321`/`:529` 的监听同源
      return r;
    });
    try {
      rightClick(a, 120, 100);
      rightClick(b, 120, 180);
      expect(menuCount(), "广播真的送达之后：右键另一行 ⇒ 只剩一份").toBeLessThanOrEqual(1);
      expect(openFlags(), "同上：`menuOpen` 为真的行只剩一行").toBeLessThanOrEqual(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("机制取证：那条广播只要**真的送到**，别行的菜单就会自己关（⇒ 坏在投递，不在接收）", () => {
    const { a, b } = setup();
    rightClick(a, 120, 100);
    rightClick(b, 120, 180);

    // ⭐ 两个目标都派一遍（⛔ 不预设修法是"改派发"还是"改监听"✓）：只要送到，接收侧就生效 ✓。
    flushSync(() => {
      document.dispatchEvent(new Event(CLOSE_EVT));
      window.dispatchEvent(new Event(CLOSE_EVT));
    });

    expect(
      menuCount(),
      "广播送达之后应当没有任何菜单留着 ⇒ 接收侧（`:321`/`:529` 的 onCloseAll）是好的，" +
        "修前坏的是 `:19` 把它派到了 `window` 上",
    ).toBeLessThanOrEqual(1);
    expect(openFlags(), "同上：送达后 `aria-expanded` 应当全回落").toBeLessThanOrEqual(1);
  });
});
