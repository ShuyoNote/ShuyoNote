// 判据：「侧栏折叠/展开的状态**真的**记得住」（owner 2026-10-18 提的 ✓）。
//
// 为什么要有这一条（不能只测 `lib/treeMemory.ts`）：那一层只证明"存得进去" ✓，
// 而 owner 报的是**界面行为** ——「折起来的文件夹，刷新/切空间回来又全展开了」✗。
// ⇒ 这里用**真的 PageTree 组件**（形状抄 `treeMenuSingle.test.ts`：createRoot ＋ flushSync ＋ 原生事件）
//   把两件事一次钉住：
//     ① 折叠 ⇒ 子节点**真的**从 DOM 里消失 ✓（不是只写了个键）；
//     ② **卸载再挂载**（≈ 刷新 / 切回空间）⇒ 仍然是折叠的 ✓；换一个空间 ⇒ 回到默认展开 ✓。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { PageTree } from "./PageTree";
import { useNotes } from "../store/notes";
import { useSpaceStore } from "../store/space";
import { clearTreeMemory, isNodeExpanded } from "../lib/treeMemory";
import type { PageMeta } from "../types";

const WS1 = "ws-expand-1";
const WS2 = "ws-expand-2";
const FOLDER = "folder-a";
const CHILD = "child-of-folder";
const PAGE = "page-b";

const meta = (id: string, title: string, over: Partial<PageMeta> = {}): PageMeta => ({
  id,
  workspace_id: WS1,
  parent_id: null,
  title,
  icon: "",
  kind: "page",
  sort_order: 0,
  created_at: 1_700_000_000,
  updated_at: 1_700_000_000,
  deleted_at: null,
  ...over,
});

let host: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) flushSync(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  flushSync(() => root?.render(React.createElement(PageTree)));
}

/** 卸载 + 再挂载 ≈ 刷新页面 / 切走再切回这个空间（组件树是全新的 ✓）。 */
function remount() {
  if (root) flushSync(() => root?.unmount());
  root = null;
  host?.remove();
  mount();
}

const row = (id: string): HTMLElement | null => host?.querySelector<HTMLElement>(`[data-node-id="${id}"]`) ?? null;
/** 这个节点现在**在不在屏幕上**（折叠的父节点不会渲染子节点 ✓）。 */
const visible = (id: string): boolean => Boolean(row(id));
const toggleOf = (id: string): HTMLElement | null => row(id)?.querySelector<HTMLElement>(".tree-toggle") ?? null;

function clickExpandToggle(id: string) {
  const el = toggleOf(id);
  if (!el) throw new Error(`夹具失败：找不到 ${id} 那一行的 ▾（不是判据红）`);
  flushSync(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  localStorage.clear();
  clearTreeMemory(WS1);
  clearTreeMemory(WS2);
  useSpaceStore.setState({ spaces: [], activeId: WS1 });
  useNotes.setState({
    pages: [
      meta(FOLDER, "资料", { kind: "folder", sort_order: 0 }),
      meta(CHILD, "子页", { parent_id: FOLDER, sort_order: 1 }),
      meta(PAGE, "根页", { sort_order: 2 }),
    ],
    loading: false,
    currentId: null,
  });
});

describe("PageTree · 折叠状态记得住（2026-10-18 加）", () => {
  it("① 没记忆时**默认全展开**（旧行为不变 ✓；⛔ 不因为没记录就把树折起来 ✗）", () => {
    mount();
    expect(visible(FOLDER)).toBe(true);
    expect(visible(CHILD)).toBe(true);
  });

  it("② 折叠 ⇒ 子节点从 DOM 里消失；**重挂载**（刷新/切回）⇒ 仍然折叠 ✓", () => {
    mount();
    clickExpandToggle(FOLDER);
    expect(visible(CHILD), "折叠之后子页不许还在屏幕上").toBe(false);

    remount();
    expect(visible(FOLDER)).toBe(true);
    expect(visible(CHILD), "⭐ 刷新回来还是折叠的（这就是 owner 要的「记录下来」）").toBe(false);

    // 再展开 ⇒ 也记得住（不是只会记"折叠"一种 ✓）
    clickExpandToggle(FOLDER);
    expect(visible(CHILD)).toBe(true);
    remount();
    expect(visible(CHILD), "展开也该记住 ✓").toBe(true);
  });

  it("③ 记忆**按空间分开**：WS1 折起来不影响 WS2（默认展开）✓", () => {
    mount();
    clickExpandToggle(FOLDER);
    expect(visible(CHILD)).toBe(false);

    useSpaceStore.setState({ activeId: WS2 });
    remount();
    expect(visible(CHILD), "另一个空间没折过 ⇒ 默认展开 ✓").toBe(true);

    useSpaceStore.setState({ activeId: WS1 });
    remount();
    expect(visible(CHILD), "切回 WS1 ⇒ 还是它自己那份折叠记忆 ✓").toBe(false);
  });

  it("④ 记忆落地在 `localStorage`（换一个组件实例也读得到 = 真的持久化 ✓）", () => {
    mount();
    clickExpandToggle(FOLDER);
    expect(isNodeExpanded(WS1, FOLDER), "纯存取层读出来也是折叠").toBe(false);
    expect(localStorage.getItem(`shuyonote:treeExpanded:${WS1}`), "键真的写进去了").toContain(FOLDER);
  });
});
