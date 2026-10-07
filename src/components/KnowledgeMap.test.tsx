// 判据：知识地图**下面**要有一个 LLM Wiki 的入口按钮
//（owner 2026-10-08：「在知识地图下面添加 LLM Wiki 入口按钮」✓）。
//
// 两条都要机器可判，别靠"看着在那儿"：
//   ① 点它 **就是** `useEditorStore.openSettings("ai")` —— 与命令面板那条 `ai.libraryMap` **同一个动作** ✓
//      （⛔ 不许另造一条"打开库地图"的路：那会变成第二份真相源 ✓）；
//   ② 它在**聚类列表之后** ——「下面」是可核的 **DOM 顺序**（`compareDocumentPosition`），不是印象 ✓。
// 另外钉一条：**空库也要留着入口** —— 一个还没索引过的空间里，这一页恰恰是"该去 LLM Wiki 看看"的地方；
// 若把入口只挂在有聚类的分支上，新空间里它反而消失 ✗。
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import "../i18n";

const mocks = vi.hoisted(() => ({
  getGraph: vi.fn<() => Promise<unknown>>(),
  openSettings: vi.fn<(tab?: string) => void>(),
  openPage: vi.fn<(id: string) => Promise<void>>(),
}));

vi.mock("../lib/api", () => ({ api: { getGraph: () => mocks.getGraph() } }));
vi.mock("../store/editor", () => ({
  useEditorStore: { getState: () => ({ openSettings: mocks.openSettings }) },
}));
// 组件用选择器形态 `useNotes((s) => s.openPage)` ⇒ 桩要按选择器调用 ✓
vi.mock("../store/notes", () => {
  const state = { openPage: mocks.openPage };
  const hook = (sel?: (s: typeof state) => unknown) => (sel ? sel(state) : state);
  return { useNotes: Object.assign(hook, { getState: () => state }) };
});

import { KnowledgeMap } from "./KnowledgeMap";

let root: Root | null = null;

const page = (id: string, title: string, tags: string[] = []) => ({ id, title, tags, props: [], kind: "page" });
const graph = (pages: unknown[], edges: unknown[] = []) => ({
  pages,
  edges,
  blocks: [],
  block_edges: [],
  blocks_supported: true,
});

const mount = () => {
  flushSync(() => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    root = createRoot(el);
    root.render(<KnowledgeMap />);
  });
};

/** 找到那个入口按钮（按文案找，别按 class 找 —— 那才是"用户看得见的东西"）。 */
const wikiBtn = () =>
  Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
    /LLM Wiki/i.test(b.textContent ?? ""),
  ) ?? null;

afterEach(() => {
  if (root) flushSync(() => root!.unmount());
  root = null;
  document.body.innerHTML = "";
  mocks.getGraph.mockReset();
  mocks.openSettings.mockReset();
  mocks.openPage.mockReset();
});

describe("知识地图：下面的 LLM Wiki 入口", () => {
  it("★ 点它 ⇒ openSettings(\"ai\")（与命令面板 `ai.libraryMap` 同一个动作）", async () => {
    mocks.getGraph.mockResolvedValue(graph([page("a", "甲", ["research"])]));
    mount();
    await vi.waitFor(() => expect(wikiBtn()).not.toBeNull());
    flushSync(() => wikiBtn()!.click());
    expect(mocks.openSettings).toHaveBeenCalledTimes(1);
    expect(mocks.openSettings).toHaveBeenCalledWith("ai");
    // ⛔ 顺带钉住"它不是导航到某个页面"：入口只负责打开面板，不碰当前页 ✓
    expect(mocks.openPage).not.toHaveBeenCalled();
  });

  it("★ 入口在**聚类列表之后**（「下面」是 DOM 顺序，不是印象）", async () => {
    mocks.getGraph.mockResolvedValue(
      graph([page("a", "甲", ["research"]), page("b", "乙", ["research"]), page("c", "丙")]),
    );
    mount();
    await vi.waitFor(() => expect(wikiBtn()).not.toBeNull());
    const clusters = document.querySelector(".kb-map-clusters");
    expect(clusters).not.toBeNull();
    // clusters 在按钮**之前** ⇒ 按钮确实在下面 ✓
    const rel = clusters!.compareDocumentPosition(wikiBtn()!);
    expect(rel & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("空库（一个可画的页面都没有）也留着入口 —— 这种空间恰恰最该去 LLM Wiki 看一眼", async () => {
    mocks.getGraph.mockResolvedValue(graph([]));
    mount();
    await vi.waitFor(() => expect(wikiBtn()).not.toBeNull());
    expect(document.querySelector(".kb-map-clusters")).toBeNull(); // 空库不画列表 ✓
    flushSync(() => wikiBtn()!.click());
    expect(mocks.openSettings).toHaveBeenCalledWith("ai");
  });
});
