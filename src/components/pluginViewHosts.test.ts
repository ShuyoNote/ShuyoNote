// **同一个声明式视图，两种落点真的落在两个地方吗？** —— 挂起来点一遍。
//
// 为什么必须是渲染级测试：`placement` 这条链是「Rust 读 manifest → PluginMeta → 前端
// viewPlacement → 谁渲染 DOM」，中间任何一环接错（字段没序列化、判断写反、面板没挂到
// App 上、互斥漏了一处），表现都是**静默的**——不是报错，而是"作者写了 rail 却还是弹出浮层"
// 或者"右栏同时开了两个面板"。这类错只能靠真的挂组件、点一下、看 DOM 来发现。
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import "../i18n";

// 视图渲染会读设置与页面列表（IPC）。这里给空实现：本测试只关心"落点与互斥"。
vi.mock("../lib/api", () => ({
  api: new Proxy({}, { get: () => async () => [] }),
}));

import { RightRail } from "./RightRail";
import { PluginViewPanel } from "./PluginViewPanel";
import { PluginViewOverlay } from "./PluginViewOverlay";
import { usePlugins } from "../store/plugins";
import { useNotes } from "../store/notes";
import { usePluginViewStore } from "../store/pluginViews";
import { useRightPanel } from "../store/rightPanel";
import type { PageMeta, PluginMeta, PluginView } from "../types";

const NOW = Date.parse("2026-09-10T12:00:00Z");
const day = 86_400_000;

const page = (id: string, title: string, updatedDays: number): PageMeta => ({
  id,
  workspace_id: "w",
  parent_id: null,
  title,
  icon: "",
  kind: "page",
  sort_order: 0,
  created_at: NOW - 30 * day,
  updated_at: NOW - updatedDays * day,
  deleted_at: null,
});

const RAIL_VIEW: PluginView = {
  id: "board",
  title: "待整理",
  query: { sort: "updated_desc", limit: 20 },
  columns: ["title"],
  summary: true,
  placement: "rail",
};

const OVERLAY_VIEW: PluginView = {
  id: "recent",
  title: "最近更新",
  query: {},
  columns: ["title"],
  summary: false,
};

function plugin(views: PluginView[], enabled = true): PluginMeta {
  return {
    id: "pl",
    name: "清单插件",
    version: "1.0.0",
    description: "",
    enabled,
    commands: [],
    permissions: [],
    permissions_baseline: false,
    events: [],
    runtime: "declarative",
    views,
    triggers: [],
    theme: null,
    approval: { required: false, added: [] },
  } as unknown as PluginMeta;
}

function mount(node: React.ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  flushSync(() => root.render(node));
  return root;
}

describe("声明式视图的两种落点", () => {
  let root: ReturnType<typeof createRoot> | null = null;
  const realOpenPage = useNotes.getState().openPage;
  const realLoadPages = useNotes.getState().loadPages;
  let openPage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    openPage = vi.fn(async () => {});
    useNotes.setState({
      pages: [page("p1", "第一篇", 1), page("p2", "第二篇", 2)],
      openPage: openPage as never,
      loadPages: vi.fn(async () => {}) as never,
    });
    usePlugins.setState({ plugins: [plugin([RAIL_VIEW, OVERLAY_VIEW])] });
    usePluginViewStore.setState({ pluginId: null, pluginName: "", view: null });
    useRightPanel.setState({ ai: false, toc: false, comments: false, plugin: null });
  });

  afterEach(() => {
    if (root) flushSync(() => root!.unmount());
    root = null;
    useNotes.setState({ openPage: realOpenPage, loadPages: realLoadPages });
    useRightPanel.setState({ ai: false, toc: false, comments: false, plugin: null });
    usePluginViewStore.setState({ pluginId: null, pluginName: "", view: null });
    document.body.classList.remove("is-plugin-panel-open");
    document.body.innerHTML = "";
  });

  it("rail 视图在右栏占一个按钮；overlay 视图不占", () => {
    root = mount(
      React.createElement(React.Fragment, null, React.createElement(RightRail), React.createElement(PluginViewPanel)),
    );
    const railBtns = Array.from(document.querySelectorAll(".right-rail .rail-btn"));
    const labels = railBtns.map((b) => b.getAttribute("aria-label"));
    expect(labels).toContain("插件面板：待整理");
    expect(labels.some((l) => l?.includes("最近更新")), "overlay 落点的视图不该出现在右栏").toBe(false);
    // 三个内置抽屉还在（不要因为加了插件按钮就把它们顶掉）
    expect(labels).toEqual(expect.arrayContaining(["AI 助手", "评论 / 通知", "目录"]));
  });

  it("点右栏按钮 → 面板打开、画出表、主区让位；再点一次收起", () => {
    root = mount(
      React.createElement(React.Fragment, null, React.createElement(RightRail), React.createElement(PluginViewPanel)),
    );
    const btn = document.querySelector('[aria-label="插件面板：待整理"]') as HTMLElement;
    flushSync(() => btn.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(document.querySelector(".plugin-panel"), "面板应当出现").not.toBeNull();
    expect(document.body.classList.contains("is-plugin-panel-open"), "桌面让位靠这个 class").toBe(true);
    const rows = Array.from(document.querySelectorAll(".plugin-panel .plugin-view-table tbody tr"));
    expect(rows.map((r) => r.textContent)).toEqual(["第一篇", "第二篇"]);
    expect(document.querySelector(".plugin-panel .plugin-view-summary")?.textContent).toContain("2 篇");
    expect(document.querySelector(".plugin-view-overlay"), "rail 落点不该同时开浮层").toBeNull();

    // 再点一次收起，并且把 body class 摘掉（否则主区会一直空着一条）
    flushSync(() => btn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(document.querySelector(".plugin-panel")).toBeNull();
    expect(document.body.classList.contains("is-plugin-panel-open")).toBe(false);
  });

  it("常驻面板点行**不关面板**（这正是它和浮层的区别）", () => {
    root = mount(
      React.createElement(React.Fragment, null, React.createElement(RightRail), React.createElement(PluginViewPanel)),
    );
    const btn = document.querySelector('[aria-label="插件面板：待整理"]') as HTMLElement;
    flushSync(() => btn.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    const firstRow = document.querySelector(".plugin-panel .plugin-view-table tbody tr") as HTMLElement;
    flushSync(() => firstRow.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(openPage).toHaveBeenCalledWith("p1");
    expect(document.querySelector(".plugin-panel"), "点开一页之后面板还要在（要继续看下一行）").not.toBeNull();
  });

  it("右栏互斥：开插件面板会收起 AI；开 AI 会收起插件面板", () => {
    root = mount(
      React.createElement(React.Fragment, null, React.createElement(RightRail), React.createElement(PluginViewPanel)),
    );
    // 先开 AI
    flushSync(() => useRightPanel.getState().openAi(true));
    expect(useRightPanel.getState().ai).toBe(true);

    // 再点插件面板按钮 → AI 关掉
    const btn = document.querySelector('[aria-label="插件面板：待整理"]') as HTMLElement;
    flushSync(() => btn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(useRightPanel.getState().ai, "右栏一次只能开一个抽屉").toBe(false);
    expect(document.querySelector(".plugin-panel")).not.toBeNull();

    // 反过来：开 AI → 插件面板收起（视图数据还在，只是不再占右栏）
    flushSync(() => useRightPanel.getState().openAi(true));
    expect(document.querySelector(".plugin-panel")).toBeNull();
    expect(usePluginViewStore.getState().view?.id, "收起不等于丢掉视图数据").toBe("board");
  });

  it("overlay 视图仍然走浮层，且面板不会跟着开", () => {
    root = mount(
      React.createElement(React.Fragment, null,
        React.createElement(PluginViewOverlay),
        React.createElement(PluginViewPanel),
      ),
    );
    flushSync(() => usePluginViewStore.getState().open("pl", "清单插件", OVERLAY_VIEW));
    expect(document.querySelector(".plugin-view-overlay"), "默认落点是浮层").not.toBeNull();
    expect(document.querySelector(".plugin-panel"), "浮层不该同时开面板").toBeNull();
    expect(useRightPanel.getState().plugin, "浮层不占右栏").toBeNull();

    // 浮层里点行：打开页面并**关掉浮层**（与面板的契约相反，两边都钉住）
    const firstRow = document.querySelector(".plugin-view-overlay tbody tr") as HTMLElement;
    flushSync(() => firstRow.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(openPage).toHaveBeenCalledWith("p1");
    expect(document.querySelector(".plugin-view-overlay")).toBeNull();
  });

  it("停用的插件不再占右栏位置", () => {
    usePlugins.setState({ plugins: [plugin([RAIL_VIEW], false)] });
    root = mount(React.createElement(RightRail));
    const labels = Array.from(document.querySelectorAll(".right-rail .rail-btn")).map((b) => b.getAttribute("aria-label"));
    expect(labels.some((l) => l?.includes("待整理")), "停用的插件不该留入口").toBe(false);
  });
});
