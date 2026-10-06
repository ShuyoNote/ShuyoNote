// `NewPageGuide`（新页面空态引导）的判据。
//
// 为什么要有它：owner 2026-10-06 连提两件事 —— ①「指引内容没有了」（引导整块不出现，
// 根因是"空页"口径数块 ⇒ 见 `lib/blankPage.ts`）；②「去掉新手清单」。
// 这一条把 ② 变成机器判据：**清单那套（`.first-steps` / 五个步骤）不许再回来**，
// 同时钉住**留下来的东西**（那句"点这里开始编辑" ＋ 三个起手式 ＋ 数据表格那一排）——
// 免得将来有人"清理"时把整块引导一起删掉 ✗。
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import "../i18n";

// 引导里的动作会走 IPC（建页/建库）；本测试只看**渲染出什么** ⇒ 给空实现。
vi.mock("../lib/api", () => ({
  api: new Proxy({}, { get: () => async () => [] }),
}));

import { NewPageGuide } from "./NewPageGuide";
import { useAiStore } from "../store/ai";

let root: ReturnType<typeof createRoot> | null = null;

beforeEach(() => {
  document.body.innerHTML = '<div id="host"></div>';
  useAiStore.setState((s) => ({ config: { ...s.config, enabled: false } }));
});

afterEach(() => {
  if (root) flushSync(() => root!.unmount());
  root = null;
  document.body.innerHTML = "";
});

function mount(): void {
  const host = document.getElementById("host")!;
  root = createRoot(host);
  flushSync(() => root!.render(React.createElement(NewPageGuide)));
}

describe("NewPageGuide：空页引导（2026-10-06 撤掉新手清单之后）", () => {
  it("★ 不再有「新手清单」（`.first-steps` / `.first-step` 一个都不许有）", () => {
    mount();
    expect(document.querySelectorAll(".first-steps").length).toBe(0);
    expect(document.querySelectorAll(".first-step").length).toBe(0);
    expect(document.body.textContent).not.toContain("新手清单");
  });

  it("★ 留下的东西还在：那句「点这里开始编辑」＋ 三个起手式（AI 关着时两个）＋ 数据表格一排", () => {
    mount();
    const guide = document.querySelector(".new-page-guide");
    expect(guide, "引导本体要在").not.toBeNull();
    expect(document.querySelector(".new-page-guide-desc")?.textContent).toContain("点这里开始编辑");

    const acts = Array.from(document.querySelectorAll(".npg-act")).map((x) => x.textContent || "");
    expect(acts.some((t) => t.includes("从模板中心创建"))).toBe(true);
    expect(acts.some((t) => t.includes("从导入文件创建"))).toBe(true);
    // AI 关着 ⇒ 那颗不出现（与 `aiEnabled` 一致 ✓）
    expect(acts.some((t) => t.includes("用 AI 开始创作"))).toBe(false);

    // 数据表格那一排：7 个视图入口都还在
    expect(document.querySelectorAll(".npg-db-item").length).toBe(7);
  });

  it("AI 开着时「用 AI 开始创作」才出现（原来那条行为没被这次删改带歪）", () => {
    useAiStore.setState((s) => ({ config: { ...s.config, enabled: true } }));
    mount();
    const acts = Array.from(document.querySelectorAll(".npg-act")).map((x) => x.textContent || "");
    expect(acts.some((t) => t.includes("用 AI 开始创作"))).toBe(true);
  });
});
