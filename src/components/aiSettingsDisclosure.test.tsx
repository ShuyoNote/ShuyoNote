// 第一招「渐进式披露」的判据：**关掉开关 ⇒ 配置整块收起来**（owner 2026-10-08 拍板开工 ✓）。
//
// 先写判据、看它红 ✓ —— 现在的实现是"关掉只是把整组**变灰**"（`is-off` ✓），
// 配置项**照样在 DOM 里** ✗ ⇒ 下面这两条必红 ✓（这就是"会红的判据" ✓）。
//
// ⚠️ 断言只认**结构**（组里还有没有输入控件 ✓ ＋ 有没有那个灰框 ✓），
//    ⛔ 不认文案 —— 因为灰框里**就该列出"开启后会出现什么"**（会把字段名再说一遍 ✓）。
// ⚠️ 工具面 mock 得很少：这条判据守的是渲染形状，不是取材 ✓（同 `aiSettingsCoverage.test.tsx` 的口径 ✓）。

import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";

vi.mock("../lib/platform", () => ({
  platform: {
    derivedStores: async () => [],
    executor: { invoke: async () => undefined },
    aiChat: async () => ({ ok: false, text: "" }),
    aiEmbed: async () => ({ ok: false, vectors: [] }),
  },
}));

vi.mock("../lib/api", () => ({
  api: {
    listAttrDefs: async () => [],
    getPage: async () => null,
    listPages: async () => [],
  },
}));

import { AiSettingsForm } from "./AiSettingsForm";
import { useAiStore } from "../store/ai";

let host: HTMLDivElement | null = null;

function renderForm(config: Partial<ReturnType<typeof useAiStore.getState>["config"]>) {
  useAiStore.setState({ config: { ...useAiStore.getState().config, ...config } });
  host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  flushSync(() => root.render(<AiSettingsForm onDone={() => {}} showCancel={false} />));
  return host;
}

/** 按**标题**找那一组（不改组件结构、也不靠类名巧合 ✓）。 */
function group(root: HTMLElement, title: string): HTMLElement | null {
  const all = [...root.querySelectorAll<HTMLElement>(".ai-settings-group")];
  return all.find((g) => (g.querySelector(".ai-settings-group-title")?.textContent ?? "").includes(title)) ?? null;
}

/** 组里"能被填的控件"有几个（开关本身是 button ⇒ 不算 ✓）。 */
const controls = (g: HTMLElement) => g.querySelectorAll("input, select, textarea, .ai-settings-test-btn").length;

afterEach(() => {
  host?.remove();
  host = null;
});

describe("渐进式披露：开关关着 ⇒ 配置整块收起来，只留开关 ＋ 说明 ＋ 灰框", () => {
  it("★ AI 助手关着 ⇒ 组里**没有**任何输入控件，且有灰框写着「开启后会出现什么」", () => {
    const root = renderForm({ enabled: false });
    const g = group(root, "AI 助手");
    expect(g, "没找到「AI 助手」那一组").toBeTruthy();
    expect(controls(g!), "关着却还留着输入控件 ✗（现在就是这样：只是变灰）").toBe(0);
    expect(g!.querySelector(".ai-settings-placeholder"), "关着却没有那个灰框 ✗").toBeTruthy();
    // 开关**必须**还在 —— 不然用户没法打开它 ✗
    expect(g!.querySelector('[role="switch"]'), "开关不见了 ✗").toBeTruthy();
  });

  it("★ AI 助手打开 ⇒ 控件回来，灰框撤掉", () => {
    const root = renderForm({ enabled: true });
    const g = group(root, "AI 助手")!;
    expect(controls(g)).toBeGreaterThan(0);
    expect(g.querySelector(".ai-settings-placeholder")).toBeNull();
  });

  it("★ 语义检索关着 ⇒ 同样收起（嵌入模型 / 服务 / 服务地址 都不在）", () => {
    const root = renderForm({ enableEmbedding: false });
    const g = group(root, "语义检索");
    expect(g, "没找到「语义检索」那一组").toBeTruthy();
    expect(controls(g!)).toBe(0);
    expect(g!.querySelector(".ai-settings-placeholder")).toBeTruthy();
    expect(g!.querySelector('[role="switch"]')).toBeTruthy();
  });

  it("★ 语义检索打开 ⇒ 控件回来", () => {
    const root = renderForm({ enableEmbedding: true });
    const g = group(root, "语义检索")!;
    expect(controls(g)).toBeGreaterThan(0);
    expect(g.querySelector(".ai-settings-placeholder")).toBeNull();
  });

  it("⛔ 两组的开关**互不牵连**（AI 关着不影响语义检索那一组自己的状态）", () => {
    const root = renderForm({ enabled: false, enableEmbedding: true });
    expect(controls(group(root, "AI 助手")!)).toBe(0);
    expect(controls(group(root, "语义检索")!)).toBeGreaterThan(0);
  });
});
