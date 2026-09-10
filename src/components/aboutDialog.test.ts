// 「关于」弹窗的**结构与版面**回归测试。
//
// 为什么值得钉：这个弹窗被减过两次内容（去掉中文名、去掉产品说明），而"去掉之后还协不协调"
// 是纯视觉判断——没有测试的话，下一次有人顺手加回一句说明、或者名称那行再多一个元素，
// 版面又会被撑歪，而且没人会发现。这里钉的是**结构**（剩下什么、各块的层次），不是像素。
import { describe, expect, it, vi } from "vitest";
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import "../i18n";

vi.mock("../lib/platform", () => ({
  platform: { opener: { openUrl: async () => {} } },
  isDesktopPlatform: () => false,
}));

import { AboutDialog } from "./AboutDialog";
import { useEditorStore } from "../store/editor";
import { APP_NAME } from "../lib/links";

// 注意：这个弹窗走 createPortal 渲染到 document.body，所以断言要查 document 而不是容器节点。
function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  return {
    root,
    render: () => flushSync(() => root.render(React.createElement(AboutDialog))),
  };
}

describe("「关于」弹窗的版面", () => {
  it("头部只留 logo + 名称 + 版本/许可两枚胶囊（没有中文名、没有产品说明）", () => {
    useEditorStore.setState({ aboutOpen: true });
    const { render, root } = mount();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render();

    const hero = document.querySelector(".about-hero");
    expect(hero, "头部应当在").not.toBeNull();
    expect(hero?.querySelector(".about-logo"), "logo 在").not.toBeNull();

    // 名称：只有 ShuyoNote（中文名已按要求去掉）
    const name = document.querySelector(".about-name");
    expect(name?.textContent).toBe(APP_NAME);
    expect(name?.textContent).not.toContain("数友笔记");
    // 名称行里不该再有别的元素（"再多一个 span"正是当初把它撑歪的做法）
    expect(name?.querySelectorAll("*").length).toBe(0);

    // 产品说明整行不再存在（连带 .about-desc 样式也已删除）
    expect(document.querySelector(".about-desc")).toBeNull();
    expect(document.querySelector(".about-name-en"), "只服务中文名那个 span 的样式也别再回来").toBeNull();

    // 两枚胶囊（版本 + 许可）仍在，且就在头部里
    expect(hero?.querySelectorAll(".about-pill").length).toBe(2);

    // 段落依次是：检查更新 / 开源与反馈 / 外链开关；最后是操作区
    const sections = [...document.querySelectorAll(".about-section")];
    expect(sections.length).toBe(3);
    expect(sections[0].className).toContain("about-update-row");
    expect(document.querySelector(".about-links")?.querySelectorAll("button").length).toBeGreaterThanOrEqual(3);
    expect(document.querySelector(".about-actions .about-close"), "关闭按钮在").not.toBeNull();

    flushSync(() => root.unmount());
    spy.mockRestore();
  });

  it("没打开时什么都不渲染（弹窗由 store 控制）", () => {
    useEditorStore.setState({ aboutOpen: false });
    const { render, root } = mount();
    render();
    expect(document.querySelector(".about")).toBeNull();
    flushSync(() => root.unmount());
  });
});
