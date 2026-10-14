// 「点侧边栏的文件夹 ⇒ 文件管理视图要切过去」的判据 —— 钉用户实测的那个症状 ✗
//（owner 的决定性读数：**「点普通文件夹，内容区完全没反应（一动都不动）」** ✓）。
//
// ⭐ 结论：**(乙)** —— 那次 click **根本没走到 `handleClick`** ✗（不是 (甲) 的"view 被改回去"）。
//    凶手＝`PageTree.tsx:126` 那个**模块级一次性标记** `dragJustFinishedRef`：
//      · 置真 `:1260`：`if (d?.armed) dragJustFinishedRef.current = true;`
//        —— `armed` 只是「按下与松开之间挪过 **5px**」（`:1188-1190`）✗，**不要求真的拖动了什么**
//        （`onMove` 只在 `id !== d.id` 时才算目标行，`:1211` ✓）；
//      · 消费 `:575-579`：`handleClick` **一进来**就清掉它并 `return` ✓。
//    ⇒ ⭐ **这个标记的寿命没有被任何东西兜住** ✗：它只在"下一次行上 click 真的跑到 handleClick"
//      时才被清掉。而**"收尾"不发生的路**至少四条（与今天刚修的 `BlockDragPlugin.tsx:296`
//      `setEditable(false)` 丢 mouseup 就永久卡住 **同族** ✓）：
//        ① ⭐ **click 落在子树里/公共祖先上** —— 拖 A 行、在 B 行松手时，按 UI Events，
//           `click` 派到按下/抬起两个 target 的**最近公共祖先**（这里是 `.sidebar-tree`，`:1575`）
//           ⇒ 行上的 `handleClick` 不跑 ⇒ 标记**永久留真** ✗（本条判据测的就是它 ✓）；
//        ② **click 落在会 `stopPropagation` 的子元素上**：`.tree-toggle`（`:642-647`）、
//           `⋯` 按钮（`:683-692`）、开着的菜单（`:705`）⇒ 同样到不了 handleClick ✗；
//        ③ **鼠标在窗外/切走时松手** ⇒ `window` 上那条 `mouseup`（`:1271`）不来 ⇒
//           这一次不置标记 ✓，但 `dragRef.current`（`:1174`）**留在那儿** ⇒ 之后**没有按键**的
//           一次普通移动（≥5px，`:1186-1190`）就会起一个幽灵拖拽、再在下一次 mouseup 置标记 ✗；
//        ④ 右键在行上按下（`:617-624`）也走不到 `onRowPointerDown` ⇒ 清不到标记 ✓。
//    ⇒ ①+② 的结果就是 owner 那句：**拖过一次之后，点文件夹"一动都不动"** ✓（标记被上一次手势
//      留下，第一次点击被 `:575-579` 整个吞掉）。
//
// ⛔ (甲) **已排除**（写在交付里，不再展开）：全仓写 `view` 的只有 `store/view.ts:56-67`（本体）／
//    `:69`（leaveTemplates ⇒ 现仅 `TemplateCenterView.tsx:249` 的关闭键）／`store/notes.ts:159/188/210`／
//    `App.tsx:717`／`:1020`／`ActivityBar.tsx:145`／`NewPageGuide.tsx:113`／`plugins/builtinCommands.ts`
//    —— 没有一条会在 `setView("files")` 之后自己触发；`App.tsx:1041-1054` 那个兜底 effect 依赖
//    `[pages, currentId, startupSettled]`（点文件夹一个都不变）、守卫还是 `view === "notes"` ✓。
//    实测也一致：**不挪手指、干净会话里点一下是好的**（见下面第一条前提断言 ✓）。
//
// 形状抄 `src/components/SyncPanel.trustDevicePanel.wiring.test.tsx`：`createRoot` ＋ `flushSync` ＋ 原生事件
// （本仓**没有 @testing-library** ⇒ 没有 `fireEvent`）。⚠️ 本文件路径固定是 `.ts`，所以照
// `vitest.config.ts:9-11` 的老写法用 `React.createElement`（`.ts` 里不转 JSX）。
import { afterEach, describe, expect, it } from "vitest";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { PageTree } from "./PageTree";
import { useNotes } from "../store/notes";
import { useViewStore } from "../store/view";
import { useFileManagerStore } from "../store/fileManager";
import type { PageMeta } from "../types";

const FOLDER_ID = "folder-1";
const PAGE_ID = "page-1";

/** 造一份元数据（`src/types.ts:1-12` 的字段一个不少）。 */
const meta = (id: string, kind: string, title: string, sort: number): PageMeta => ({
  id,
  workspace_id: "ws-1",
  parent_id: null,
  title,
  icon: "",
  kind,
  sort_order: sort,
  created_at: 1_700_000_000 + sort,
  updated_at: 1_700_000_000 + sort,
  deleted_at: null,
});

let host: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) flushSync(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  useViewStore.setState({ view: "notes", prevView: "notes" });
  useFileManagerStore.setState({ folderId: null });
});

function setup() {
  useViewStore.setState({ view: "notes", prevView: "notes" });
  useFileManagerStore.setState({ folderId: null });
  useNotes.setState({
    pages: [meta(FOLDER_ID, "folder", "我的文件夹", 0), meta(PAGE_ID, "page", "一页笔记", 1)],
    loading: false,
    currentId: null,
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  flushSync(() => root?.render(React.createElement(PageTree)));
  const row = host.querySelector<HTMLElement>(`[data-node-id="${FOLDER_ID}"]`);
  if (!row) throw new Error("侧栏里没渲染出那个文件夹行");
  return row;
}

const at = (x: number, y: number): MouseEventInit => ({ bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });

/** 照用户手指的次序点一下那一行。`drift`＝按下与松开之间手指挪的像素（真实鼠标几乎每次都会挪）。 */
function clickRow(row: HTMLElement, drift = 0) {
  flushSync(() => row.dispatchEvent(new MouseEvent("mousedown", at(100, 100))));
  if (drift > 0) flushSync(() => window.dispatchEvent(new MouseEvent("mousemove", at(100, 100 + drift))));
  flushSync(() => window.dispatchEvent(new MouseEvent("mouseup", at(100, 100 + drift))));
  flushSync(() => row.dispatchEvent(new MouseEvent("click", at(100, 100 + drift))));
}

/**
 * 用户"把某个节点拖到另一行上"的收尾（＝常态：整理/嵌套树）。
 * ① 按下某行 → 握持期挪动 ≥5px（`:1188-1190`）→ `window` 上 mouseup（`:1270-1271`）；
 * ② ⚠️ **必须真的拖到一行上** —— 否则 `overId` 是空、修改 1 那条条件压根不成立，判据就绕过了
 *    真凶 ✗（**我第一版正是这样：happy-dom 零布局下 `document.elementFromPoint` 找不到行 ⇒
 *    那次"拖拽"没有落点 ⇒ 判据整条绿得没有意义** —— 是"只做修改 1"的 A/B 把它抓出来的 ✓）。
 *    所以这里把 `elementFromPoint` **钉到落点那一行**（与"补 happy-dom 缺的几何"同一种手法）✓。
 * ③ 随后那次 click **不会**落在行上：按 UI Events，它派到按下/抬起两个 target 的
 *    **最近公共祖先**（这里＝`.sidebar-tree`，`PageTree.tsx:1575`）⇒ 行上的 `handleClick`
 *    根本不会跑 ✓。happy-dom 不算这个祖先 ⇒ 照规范**手工派到那个容器上** ✓。
 */
function dragRowOnto(draggedRow: HTMLElement, dropRow: HTMLElement) {
  const container = document.querySelector<HTMLElement>(".sidebar-tree");
  if (!container) throw new Error("找不到 `.sidebar-tree`（PageTree.tsx:1575）");
  const realElementFromPoint = document.elementFromPoint;
  document.elementFromPoint = () => dropRow;
  try {
    flushSync(() => draggedRow.dispatchEvent(new MouseEvent("mousedown", at(100, 100))));
    flushSync(() => window.dispatchEvent(new MouseEvent("mousemove", at(100, 160))));
    flushSync(() => window.dispatchEvent(new MouseEvent("mouseup", at(100, 160))));
  } finally {
    document.elementFromPoint = realElementFromPoint;
  }
  // 尾随的 click 落在公共祖先上（到不了任何一行 ⇒ 没人消费那个一次性标记）。
  flushSync(() => container.dispatchEvent(new MouseEvent("click", at(100, 160))));
}

describe("侧栏点文件夹 ⇒ 文件管理视图", () => {
  it("⭐ 前提（干净会话）：同一次按下–抬起、没位移 ⇒ folderId 变了、view 变 files", () => {
    const row = setup();
    expect(useFileManagerStore.getState().folderId, "前提：一开始不在任何文件夹里").toBeNull();
    expect(useViewStore.getState().view, "前提：一开始在笔记视图").toBe("notes");

    clickRow(row);

    expect(
      useFileManagerStore.getState().folderId,
      "干净会话里点一下文件夹：`PageTree.tsx:592` 的 setFolderId 应当被调到",
    ).toBe(FOLDER_ID);
    expect(
      useViewStore.getState().view,
      "干净会话里点一下文件夹：`PageTree.tsx:593` 应当把 view 设成 files",
    ).toBe("files");
  });

  it("⭐ 拖过一次树节点之后，**第一次**点文件夹（同样没位移）也必须是好的 —— 那个一次性标记不许被留下", () => {
    const row = setup();
    const pageRow = host?.querySelector<HTMLElement>(`[data-node-id="${PAGE_ID}"]`);
    if (!pageRow) throw new Error("没渲染出那一行页面");

    // 场景＝常态：用户先把「一页笔记」拖到「我的文件夹」上（**真的落了**，`:1261` 成立 ⇒
    // 修改 1 之后标记会被置真 ✓）。它那次尾随 click 落在公共祖先上 ⇒ 没人消费那个标记 ✗。
    dragRowOnto(pageRow, row);
    expect(useViewStore.getState().view, "前提：拖动本身不该改视图").toBe("notes");
    expect(useFileManagerStore.getState().folderId, "前提：拖动本身不该进任何文件夹").toBeNull();

    // ⭐ 判据：**同一次按下–抬起、零位移**的一击。
    clickRow(row);
    const first = { folderId: useFileManagerStore.getState().folderId, view: useViewStore.getState().view };
    // 再来一次（此时残留标记已被上一击消费掉）—— **因果证明**：
    // 第二次好使 ⇒ 第一次不是死在 `handleClick` 里，而是**没送达** ✓。
    clickRow(row);
    const second = useFileManagerStore.getState().folderId;

    expect(
      second,
      "因果证明：第二次点击应当正常打开文件夹（残留标记已被上一击 `:576` 消费掉）——" +
        "这条绿 ⇒ 真凶是那个**一次性标记**，不是 `handleClick` 自己坏了",
    ).toBe(FOLDER_ID);
    expect(
      first.folderId,
      "拖过一次之后第一次点文件夹：`setFolderId` 必须被调到 —— " +
        "这条红而上面那条绿 ⇒ `PageTree.tsx:126` 的 `dragJustFinishedRef` 被上一次手势留成了真，" +
        "`:575-579` 把这一击整个吞掉（既没拖动、也没打开）＝「一动都不动」",
    ).toBe(FOLDER_ID);
    expect(first.view, "同上：view 必须变 files（`PageTree.tsx:593`）").toBe("files");
  });

  it("补充读数：握持期挪了 6px、松手仍在同一行（什么都没拖到）⇒ 同样不许吞这一击", () => {
    const row = setup();
    // `onMove` 只在 `id !== d.id` 时才算拖到了东西（`:1211`）⇒ 这一下手势**什么也没做**。
    clickRow(row, 6);
    expect(
      useFileManagerStore.getState().folderId,
      "`:1260` 只看 `d?.armed`（＝挪过 5px，`:1188-1190`）就置标记 ⇒ 一次**没有落点的**微动" +
        "也把点击吞掉 ⇒ 同一族的另一半",
    ).toBe(FOLDER_ID);
  });
});
