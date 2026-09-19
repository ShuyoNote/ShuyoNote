// 「跨库总结」按钮那条路径的判据（store 层，不装 DOM —— happy-dom 自带 localStorage）。
//
// 守四件事：
//   1. **结果进对话 + 另给一条「插成块」草稿**（草稿走既有的确认机制，不直接写库）；
//   2. **没有当前页就不给草稿**，并说明原因（总结**不替用户挑页面**写）；
//   3. 失败（平台不支持 / 库里没内容 / 抛异常）⇒ 都是**一句能显示的话**，不是 `Error:`；
//   4. `stop()` 之后到达的结果**作废**（否则"我按了停止它还是把答案写进界面"）。

import { beforeEach, describe, expect, it, vi } from "vitest";

const runLibrarySummary = vi.fn();
vi.mock("../lib/ai/librarySummaryRun", () => ({
  runLibrarySummary: (opts: unknown) => runLibrarySummary(opts),
  // 与真实实现同形（有当前页才有草稿；`key` 与 AI 工具面的 `blocks.append` 同一套约定）
  summaryDraftEntry: (s: { markdown: string }, pageId?: string | null) => {
    const id = String(pageId ?? "").trim();
    const text = s.markdown.trim();
    if (!id || !text) return null;
    return {
      key: `append_block:${id}:${text.slice(0, 24)}`,
      summary: "把跨库总结追加到当前页",
      payload: { kind: "append_block", pageId: id, text },
    };
  },
}));

import { useAiStore } from "./ai";
import { useNotes } from "./notes";
import { useRightPanel } from "./rightPanel";

const MARKDOWN = "## 跨库总结\n- 营收 1200 万 [[季度总结]]";
const okResult = () => ({
  ok: true as const,
  summary: {
    markdown: MARKDOWN,
    refs: ["[[季度总结]]"],
    batches: [],
    droppedUnreferenced: 0,
    droppedInventedRefs: 0,
    notFound: false,
  },
  collected: { sources: [], skipped: [], chars: 20, pages: 1, attachments: 0 },
  note: "取材 1 个来源（1 页 / 0 个附件，20 字）；覆盖 1 个来源（1 批）",
});

beforeEach(() => {
  runLibrarySummary.mockReset();
  useAiStore.setState({
    running: false,
    reply: "",
    drafts: [],
    error: null,
    history: [],
    activity: [],
    currentPrompt: "",
    thinking: "",
    config: { ...useAiStore.getState().config, enabled: true },
  });
  useNotes.setState({ currentId: "p1" });
});

describe("useAiStore.summarizeLibrary", () => {
  it("★ 成功：正文进对话、另给一条指向当前页的 `append_block` 草稿、活动行报清取材情况", async () => {
    runLibrarySummary.mockResolvedValue(okResult());
    await useAiStore.getState().summarizeLibrary("本季度营收多少？");

    const s = useAiStore.getState();
    expect(s.reply).toBe(MARKDOWN);
    expect(s.running).toBe(false);
    expect(s.error).toBeNull();
    expect(s.drafts).toHaveLength(1);
    // 草稿信封与 AI 工具面同形：`key` / `summary` / `payload`（payload 就是 append_block）
    expect(s.drafts[0].key).toBe(`append_block:p1:${MARKDOWN.slice(0, 24)}`);
    expect(s.drafts[0].summary).toContain("跨库总结");
    expect(s.drafts[0].payload).toEqual({ kind: "append_block", pageId: "p1", text: MARKDOWN });
    expect(s.history.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(s.history[1].content).toBe(MARKDOWN);
    expect(s.activity[0].note).toContain("取材 1 个来源");
    // 问题与"总结函数"都真传下去了（否则按钮看起来能用，其实没接模型）
    const opts = runLibrarySummary.mock.calls[0][0] as { question?: string; summarize?: unknown };
    expect(opts.question).toBe("本季度营收多少？");
    expect(typeof opts.summarize).toBe("function");
  });

  it("★ 没有打开的页面 ⇒ 不给草稿，并在活动行说清为什么（不替用户挑页面写）", async () => {
    // 库里**有**页面（否则"不给草稿"可能只是因为没得挑 —— 这条判据就成了不承重的：
    // 变异证明抓过这个漏：把落点改成 `pages[0]` 时判据照样绿）
    useNotes.setState({ currentId: null, pages: [{ id: "p9", title: "某个页面" }] as never });
    runLibrarySummary.mockResolvedValue(okResult());
    await useAiStore.getState().summarizeLibrary();
    const s = useAiStore.getState();
    expect(s.drafts).toEqual([]);
    expect(s.reply).toBe(MARKDOWN);
    expect(s.activity.some((a) => /没有打开的页面/.test(a.note))).toBe(true);
    // 没问题就不塞一条空的 user 消息
    expect(s.history.map((m) => m.role)).toEqual(["assistant"]);
  });

  it("失败（平台不支持 / 库里没内容）⇒ `error` 是一句人话，正文留空、不给草稿", async () => {
    runLibrarySummary.mockResolvedValue({ ok: false, reason: "库里还没有可总结的内容：还没有可检索文本（先点「开始索引」）" });
    await useAiStore.getState().summarizeLibrary("随便问");
    const s = useAiStore.getState();
    expect(s.error).toMatch(/先点「开始索引」/);
    expect(s.reply).toBe("");
    expect(s.drafts).toEqual([]);
    expect(s.running).toBe(false);
  });

  it("抛异常 ⇒ 也落成一句可显示的话（不是把异常丢给界面）", async () => {
    runLibrarySummary.mockRejectedValue(new Error("模型服务不可达"));
    await useAiStore.getState().summarizeLibrary("q");
    expect(useAiStore.getState().error).toBe("模型服务不可达");
    expect(useAiStore.getState().running).toBe(false);
  });

  it("分批进度进气泡（本地模型跑几分钟，没进度用户会以为卡死）", async () => {
    let release: (v: unknown) => void = () => {};
    runLibrarySummary.mockImplementation((opts: { onProgress?: (d: number, t: number) => void }) => {
      opts.onProgress?.(1, 3);
      return new Promise((r) => {
        release = r;
      });
    });
    const p = useAiStore.getState().summarizeLibrary("q");
    await Promise.resolve();
    expect(useAiStore.getState().reply).toBe("正在读第 1/3 批…");
    expect(useAiStore.getState().running).toBe(true);
    release(okResult());
    await p;
    expect(useAiStore.getState().reply).toBe(MARKDOWN);
  });

  it("★ `stop()` 之后到达的结果作废（按了停止还往界面上写，比不停止更坏）", async () => {
    let release: (v: unknown) => void = () => {};
    runLibrarySummary.mockImplementation(
      () =>
        new Promise((r) => {
          release = r;
        }),
    );
    const p = useAiStore.getState().summarizeLibrary("q");
    await Promise.resolve();
    useAiStore.getState().stop();
    release(okResult());
    await p;
    const s = useAiStore.getState();
    expect(s.reply).toBe("");
    expect(s.drafts).toEqual([]);
    expect(s.history).toEqual([]);
  });

  it("AI 未启用 ⇒ 不开跑，给提示并打开面板", async () => {
    useAiStore.setState({ config: { ...useAiStore.getState().config, enabled: false } });
    useRightPanel.setState({ ai: false });
    await useAiStore.getState().summarizeLibrary("q");
    expect(runLibrarySummary).not.toHaveBeenCalled();
    expect(useAiStore.getState().error).toMatch(/未启用/);
    expect(useRightPanel.getState().ai).toBe(true);
  });

  it("已经在跑 ⇒ 不重入（连点两次不会起两次取材）", async () => {
    useAiStore.setState({ running: true });
    await useAiStore.getState().summarizeLibrary("q");
    expect(runLibrarySummary).not.toHaveBeenCalled();
  });
});
