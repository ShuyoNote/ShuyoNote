// 第 3 招「AI 面板三块并列 → Tab」的判据（owner 拍板开工 ✓，方案第 3 招 ✓）。
//
// 先写判据、看它红 ✓ —— 现在三块**同时**渲染（`ai-settings-cols` 三列 ✓）⇒
// 下面"默认只该看到 AI 助手那一块"的断言必红 ✓（这就是"密度降 2/3"那条承诺的入口 ✓）。
//
// ⚠️ 断言只认**结构**：靠 `.ai-index`（第三块自己的类 ✓）与 `.ai-settings-placeholder`（第一块关着时的灰框 ✓）
//    来判"哪一块在 DOM 里"，⛔ 不靠文案（文案会随 i18n/措辞变 ✗）。
// ⚠️ 工具面 mock 得很少：判据守的是渲染形状，不是取材 ✓（同 `aiSettingsCoverage.test.tsx` 的口径 ✓）。

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
  // ⚠️ 2026-10-08：`AiSettingsForm` 现在还问一句 `isDesktopPlatform()`（桌面专属命令不许在 Web 上调，
  //    见那个 effect 的注释）⇒ 桩必须一起给（否则 vitest 报 No "isDesktopPlatform" export ✓）。
  isDesktopPlatform: () => true,
}));

vi.mock("../lib/api", () => ({
  api: { listAttrDefs: async () => [], getPage: async () => null, listPages: async () => [] },
}));

import { AiSettingsForm } from "./AiSettingsForm";
import { useAiStore } from "../store/ai";

let host: HTMLDivElement | null = null;

function renderForm(config: Partial<ReturnType<typeof useAiStore.getState>["config"]> = {}) {
  useAiStore.setState({ config: { ...useAiStore.getState().config, ...config } });
  host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  flushSync(() => root.render(<AiSettingsForm onDone={() => {}} showCancel={false} />));
  return { root, host };
}

/** 点某个 Tab（按 Tab 条里的文字找 ✓）。 */
function clickTab(text: string) {
  const tab = [...document.querySelectorAll<HTMLElement>(".ai-settings-tabs button, .ai-settings-tabs [role='tab']")].find(
    (b) => (b.textContent ?? "").trim().includes(text),
  );
  if (!tab) return false;
  flushSync(() => tab.click());
  return true;
}

const hasIndex = () => !!document.querySelector(".ai-index");
const hasPlaceholder = (title: string) => {
  const g = [...document.querySelectorAll<HTMLElement>(".ai-settings-group")].find((x) =>
    (x.querySelector(".ai-settings-group-title")?.textContent ?? "").includes(title),
  );
  return !!g?.querySelector(".ai-settings-placeholder");
};

afterEach(() => {
  host?.remove();
  host = null;
});

describe("AI 面板：三块并列 → Tab（默认停在 AI 助手）", () => {
  it("★ 有 Tab 条，且默认停在「AI 助手」——另外两块**不在 DOM 里**", () => {
    renderForm({ enabled: false, enableEmbedding: false });
    expect(document.querySelectorAll(".ai-settings-tabs button, .ai-settings-tabs [role='tab']").length, "没有 Tab 条 ✗").toBe(3);
    expect(hasPlaceholder("AI 助手"), "默认那块（AI 助手）没渲染 ✗").toBe(true);
    expect(hasIndex(), "「全库索引」那一块默认也在 DOM 里 ✗（这就是「密度没降」✗）").toBe(false);
    expect(hasPlaceholder("语义检索"), "「语义检索」那一块默认也在 DOM 里 ✗").toBe(false);
  });

  it("★ 点「全库索引」⇒ 那一块出现，其它两块让位", () => {
    renderForm();
    expect(clickTab("全库索引"), "没找到「全库索引」这颗 Tab ✗").toBe(true);
    expect(hasIndex(), "切过去却没渲染「全库索引」✗").toBe(true);
    expect(hasPlaceholder("AI 助手"), "切走之后「AI 助手」那块还留着 ✗").toBe(false);
  });

  it("★ 点「语义检索」⇒ 换到它那一块（开关关着 ⇒ 是灰框 ✓）", () => {
    renderForm({ enableEmbedding: false });
    expect(clickTab("语义检索")).toBe(true);
    expect(hasPlaceholder("语义检索"), "切过去却没渲染「语义检索」✗").toBe(true);
    expect(hasIndex()).toBe(false);
  });

  it("★ 切回「AI 助手」⇒ 又回到第一块（来回切不丢表 ✓）", () => {
    renderForm();
    expect(clickTab("语义检索")).toBe(true);
    expect(clickTab("AI 助手")).toBe(true);
    expect(hasPlaceholder("AI 助手")).toBe(true);
    expect(hasIndex()).toBe(false);
  });
});
