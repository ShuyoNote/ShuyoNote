// 阶段 1 · **正文索引补算器**（B1）的判据（happy-dom；api / toast / i18n 都打桩）。
//
// ⚠️ 本仓 vitest 的 `include` 只有 `src/**/*.test.ts` + `scripts/**/*.test.mjs`
// ⇒ 组件判据写成 `.test.ts`、用 `createElement`（`.test.tsx` 不会被跑到）；React 18 的 `act` 要手动开开关。
//
// 钉住五件事：
//   ① 队列为空 ⇒ **一次 `refreshPageText` 都不调**（没事别写库）；
//   ② 一页 ⇒ 用**唯一派生实现**算出来的那串喂给 `refreshPageText`（本文件不重写派生）；
//   ③ **有预算**：队列一直有货时也只补 `budget` 页（后台动作不许把整库拖进来）；
//   ④ 补不完 ⇒ 返回的 `remaining` > 0（界面据此说"还有 N 页"—— B1 的价值就是它**可观测**）；
//   ⑤ 组件时机：正在同步时**不跑**；同步结束（`syncing` 变 false）跑一趟。

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const listStaleTextPages = vi.fn();
const refreshPageText = vi.fn();
const toastSpy = vi.fn();

vi.mock("../lib/api", () => ({
  api: {
    listStaleTextPages: (...args: unknown[]) => listStaleTextPages(...args),
    refreshPageText: (...args: unknown[]) => refreshPageText(...args),
  },
}));

vi.mock("../store/toast", () => ({ toast: (...args: unknown[]) => toastSpy(...args) }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { TextRepairRunner, runTextRepairPass } from "./TextRepairRunner";
import { deriveContentText } from "../lib/contentText";
import { useSyncStatus } from "../store/syncStatus";

/** 两个段落的一页（**well-formed**：缺 Lexical 的字段会掉进"老算法"兜底，那测的就不是真派生了）。 */
const textNode = (t: string) => ({ detail: 0, format: 0, mode: "normal", style: "", text: t, type: "text", version: 1 });
const para = (t: string) => ({ children: [textNode(t)], direction: "ltr", format: "", indent: 0, type: "paragraph", version: 1 });
const DOC = JSON.stringify({
  root: { children: [para("甲"), para("乙")], direction: "ltr", format: "", indent: 0, type: "root", version: 1 },
});

const queue = (pages: number, total = pages) => ({
  total,
  pages: Array.from({ length: pages }, (_, i) => ({
    page_id: `p${i + 1}`,
    title: `第 ${i + 1} 页`,
    doc_json: DOC,
  })),
});

describe("runTextRepairPass（B1 · 补算一趟）", () => {
  beforeEach(() => {
    listStaleTextPages.mockReset();
    refreshPageText.mockReset();
    toastSpy.mockReset();
  });

  it("① 队列为空 ⇒ 一次 refreshPageText 都不调", async () => {
    listStaleTextPages.mockResolvedValue(queue(0, 0));
    const out = await runTextRepairPass();
    expect(refreshPageText).not.toHaveBeenCalled();
    expect(out).toEqual({ repaired: 0, remaining: 0 });
  });

  it("② 一页 ⇒ 喂的是**唯一派生实现**算出来的那串，并报「修了」", async () => {
    listStaleTextPages.mockResolvedValue(queue(1));
    refreshPageText.mockResolvedValue(true);
    const out = await runTextRepairPass();
    expect(refreshPageText).toHaveBeenCalledTimes(1);
    const [pageId, derived] = refreshPageText.mock.calls[0];
    expect(pageId).toBe("p1");
    // 派生语义这一层**不重写**：期望值就是那份唯一实现的输出（`contentText.test.ts` 钉它与编辑器逐字相同）
    expect(derived).toBe(deriveContentText(DOC));
    // 反向确认这一条测的是**真派生**、不是"老算法"兜底（兜底是空格拼接 —— 见 contentText.ts）
    expect(derived).not.toBe("甲 乙");
    expect(out).toEqual({ repaired: 1, remaining: 0 });
  });

  it("③④ 队列一直有货 ⇒ 只补 budget 页，并回报**还有剩**（界面据此说实话）", async () => {
    // 队列要**照着 limit 给货**（否则测的就不是预算，而是打桩的脾气）
    listStaleTextPages.mockImplementation((limit?: number) =>
      Promise.resolve(queue(Math.min(5, limit ?? 5), 100)),
    );
    refreshPageText.mockResolvedValue(true);
    const out = await runTextRepairPass(7);
    expect(refreshPageText).toHaveBeenCalledTimes(7); // 预算 7：5 + 2
    expect(out.repaired).toBe(7);
    expect(out.remaining).toBeGreaterThan(0);
    // 预算被**真的**尊重：第二批只问 2 页（不是又抓 5 页回来）
    const asked = listStaleTextPages.mock.calls.map((c) => c[0]);
    expect(asked.slice(0, 2)).toEqual([5, 2]);
  });

  it("②' 一页都不需要真改（派生与库里相同）⇒ repaired 记为 0（别说自己修了）", async () => {
    listStaleTextPages.mockResolvedValue(queue(1));
    refreshPageText.mockResolvedValue(false);
    const out = await runTextRepairPass();
    expect(out.repaired).toBe(0);
    expect(out.remaining).toBe(0);
  });
});

describe("TextRepairRunner（挂载时机）", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    listStaleTextPages.mockReset();
    refreshPageText.mockReset();
    toastSpy.mockReset();
    listStaleTextPages.mockResolvedValue(queue(1));
    refreshPageText.mockResolvedValue(true);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useSyncStatus.setState({ syncing: false });
  });

  it("⑤ 正在同步时**不跑**；同步结束跑一趟（补不完 ⇒ 弹「还有 N 页」）", async () => {
    useSyncStatus.setState({ syncing: true });
    act(() => {
      root.render(createElement(TextRepairRunner));
    });
    await act(async () => {});
    expect(listStaleTextPages).not.toHaveBeenCalled();

    // 同步结束 ⇒ 跑一趟；让这一趟补不完（队列每批都满 + 总数 100）
    listStaleTextPages.mockResolvedValue(queue(5, 100));
    await act(async () => {
      useSyncStatus.setState({ syncing: false });
    });
    await act(async () => {});
    expect(listStaleTextPages).toHaveBeenCalled();
    expect(refreshPageText).toHaveBeenCalled();
    expect(toastSpy).toHaveBeenCalled();
  });
});
