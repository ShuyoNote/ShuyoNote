// 「检查索引覆盖」那格 UI 的判据（owner 2026-09-23 拍的出口之二：**人也能看**）。
//
// 守的三件事，都是"看起来没事、实际很坏"的形状：
//   ① 点了要**真的**显示那一行摘要（含"其中 K 份没抽全"）—— 而不是显示"已索引 N/N"（§15.10 那条老坑的界面版）；
//   ② 失败要**如实报错**：平台没有派生层 / 扫描抛错 ⇒ 显示错误，**不许**显示一份空报告
//      （空报告会被读成"什么都没有"，那是完全不同的事实）；
//   ③ 缺口被截断时**要说出来**（"只列前 N 条，不是全部"）。
//
// 形状由**同一个** `coverageReportTool` 决定（组件与 AI 能力共用），所以这里 mock 的只是"取材"那一步
// （`scanLibraryCoverage`），形状仍走真实现 —— 否则这条判据证明的只是"我们的假形状能被渲染"。

import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";

const mocks = vi.hoisted(() => ({
  scan: vi.fn<() => Promise<unknown>>(),
  derivedStores: vi.fn<() => Promise<unknown>>(),
}));

vi.mock("../lib/platform", () => ({
  platform: {
    derivedStores: () => mocks.derivedStores(),
    executor: { invoke: async () => undefined },
  },
}));

vi.mock("../lib/libraryCoverage", async () => {
  const real = await vi.importActual<typeof import("../lib/libraryCoverage")>("../lib/libraryCoverage");
  return { ...real, scanLibraryCoverage: () => mocks.scan() };
});

import { AiSettingsForm } from "./AiSettingsForm";

/** 造一份"覆盖报告"（形状与 `CoverageReport` 一致；数字刻意自解释）。 */
function report(over: Record<string, unknown> = {}) {
  return {
    pages: { total: 10, indexed: 8, empty: 2 },
    attachments: { total: 4, extracted: 3, indexed: 2, partial: 1, notIndexed: 1, byReason: {} },
    derived: { extractors: 2, segments: 12, chars: 345 },
    chunks: { total: 7 },
    gaps: [
      { kind: "attachment", id: "a1", reason: "partial", detail: "混合 PDF 只抽到正文页" },
      { kind: "attachment", id: "a2", reason: "no_extractor", detail: "没人认领这种格式" },
    ],
    ...over,
  };
}

let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLDivElement | null = null;

function mount() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  flushSync(() => root!.render(<AiSettingsForm onDone={() => {}} showCancel={false} />));
  return host;
}

function clickByText(label: string) {
  const btn = [...host!.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(label));
  expect(btn, `找不到按钮：${label}；现有按钮=${[...host!.querySelectorAll("button")].map((b) => b.textContent).join(" / ")}`).toBeTruthy();
  flushSync(() => btn!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

async function settle() {
  // ⚠️ 用**宏任务**等（`setTimeout 0` + flushSync），不是只等微任务：我第一版只 `await Promise.resolve()` 若干轮，
  //    结果组件停在"检查中…"（异步链路里还有一层 `await platform.derivedStores()`），假红四条。
  await new Promise((r) => setTimeout(r, 0));
  flushSync(() => {});
}

afterEach(() => {
  if (root) flushSync(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.clearAllMocks();
});

describe("AI 设置里的「检查索引覆盖」", () => {
  it("★ 点了显示那一行摘要（含「其中 K 份没抽全」）＋ 四组计数 ＋ 缺口明细", async () => {
    mocks.derivedStores.mockResolvedValue({ ok: true });
    mocks.scan.mockResolvedValue(report());
    mount();
    clickByText("检查索引覆盖");
    await settle();
    const text = host!.textContent ?? "";
    expect(text).toContain("没抽全"); // 摘要里必须出现它（只给"已索引 N/N"会把"没抽全"读没）
    expect(text).toContain("附件：已索引 2 · 没抽全 1 · 未索引 1（共 4）");
    expect(text).toContain("块 7");
    expect(text).toContain("no_extractor"); // 明细连着分类与 detail 一起给
    expect(text).toContain("混合 PDF 只抽到正文页");
  });

  it("★ 截断必须说出来（否则人会把「列出来的几条」当成全部）", async () => {
    mocks.derivedStores.mockResolvedValue({ ok: true });
    // 25 条缺口 > 默认上限 20 ⇒ coverageReportTool 会截断
    const many = Array.from({ length: 25 }, (_, i) => ({ kind: "attachment", id: `a${i}`, reason: "partial", detail: "x" }));
    mocks.scan.mockResolvedValue(report({ gaps: many }));
    mount();
    clickByText("检查索引覆盖");
    await settle();
    const text = host!.textContent ?? "";
    expect(text).toContain("缺口 25 条");
    expect(text).toContain("只列前 20 条，不是全部");
  });

  it("★ 平台没有派生层 ⇒ **如实报错**，不许显示空报告", async () => {
    mocks.derivedStores.mockResolvedValue(undefined);
    mount();
    clickByText("检查索引覆盖");
    await settle();
    const text = host!.textContent ?? "";
    expect(text).toContain("检查失败");
    expect(text).toContain("这个平台不提供派生层");
    expect(text).not.toContain("附件：已索引"); // 不许出现"看起来正常"的空报告
  });

  it("★ 扫描抛错 ⇒ 显示原话（不吞、不假装成功）", async () => {
    mocks.derivedStores.mockResolvedValue({ ok: true });
    mocks.scan.mockRejectedValue(new Error("sqlite: database is locked"));
    mount();
    clickByText("检查索引覆盖");
    await settle();
    const text = host!.textContent ?? "";
    expect(text).toContain("检查失败");
    expect(text).toContain("database is locked");
  });
});
