// 第三块「按需单页」的 **store 级**判据（补掉"store 动作没有自动化判据"那条缺口 ✓）。
//
// ## mock 的边界（刻意画在这里）
// 只 mock **取材**（`collectSummarySources`）与**传输**（transport.complete ⇒ 假模型回答）；
// **纯函数层走真实现**（`summarizerFromTransport` → `generateTopicDraft` → `filterClaims`）✓
// ⇒ 这条判据证明的是**整条链**，而不是"我们的假形状能被渲染"（同 `aiSettingsCoverage.test.tsx` 的口径 ✓）。
//
// ## 守的三件事
// ① **不落库**：`applyDraftAndRefresh`（唯一落库口）**一次都不许被调用** ✓ —— 草稿只进 `topicDraft` 状态；
// ② **只喂该分区声明的来源**：`collectSummarySources` 给三条，而分区只声明一条 ⇒ 提示词里只许出现那一条 ✓；
// ③ **取消＝不采用**：`stop()` 之后在飞那次的结果**不许**写进状态（仓里既有的 seq 作废语义 ✓）。

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  collect: vi.fn(),
  complete: vi.fn(),
  apply: vi.fn(),
}));

vi.mock("../lib/platform", () => ({
  platform: { derivedStores: async () => ({}), executor: { invoke: async () => undefined } },
}));

vi.mock("../lib/applyDraftAndRefresh", () => ({
  applyDraftAndRefresh: (...a: unknown[]) => mocks.apply(...a),
}));

// 只换掉"取材"这一步，其余（含 SummarySource 形状、过滤口径）走真实现 ✓
vi.mock("../lib/ai/librarySummaryRun", async () => {
  const real = await vi.importActual<typeof import("../lib/ai/librarySummaryRun")>("../lib/ai/librarySummaryRun");
  return { ...real, collectSummarySources: (...a: unknown[]) => mocks.collect(...a) };
});

// 传输：两边都换成同一个假 `complete`（jsdom 下 `IS_WEB` 为 true ⇒ 走 provider 那条 ✓）
vi.mock("../lib/ai/transport", () => ({
  createBackendStreamingTransport: () => ({ complete: (...a: unknown[]) => mocks.complete(...a) }),
  probeApi: async () => ({ ok: true }),
}));

vi.mock("../lib/ai/llm", async () => {
  const real = await vi.importActual<typeof import("../lib/ai/llm")>("../lib/ai/llm");
  return { ...real, createProviderTransport: () => ({ complete: (...a: unknown[]) => mocks.complete(...a) }) };
});

import { useAiStore } from "./ai";
import type { MapSection } from "../lib/ai/libraryMap";

const PAGE_REF = "[[页面A]]";
const BLOCK_REF = "blk-b1c2d3";
const GHOST_REF = "blk-ghost9";

/** 分区只声明 `[[页面A]]` 这一条来源 —— 取材却给了三条 ✓（正是要验的过滤） */
const section: MapSection = {
  key: "themes",
  label: "专题",
  summary: "按主题聚出来的一页",
  items: [{ key: "t1", label: "同步架构", count: 3, tone: "ok", note: "材料齐", sources: [PAGE_REF] }],
};

function collected() {
  return {
    sources: [
      { ref: PAGE_REF, kind: "page", label: "页面A", text: "同步靠变更日志……" },
      { ref: BLOCK_REF, kind: "block", text: "冲突按时间戳定序……" },
      { ref: "[[页面B]]", kind: "page", label: "页面B", text: "另一页……" },
    ],
    skipped: [],
    chars: 30,
    pages: 2,
    attachments: 0,
  };
}

/** 模型回答：一条合规矩 ＋ 一条编造回链 ＋ 一条没带回链 ✓ */
const ANSWER = [`${PAGE_REF} 同步靠变更日志。`, `${GHOST_REF} 我编的结论。`, "这是一句没有回链的结论。"].join("\n");

beforeEach(() => {
  mocks.collect.mockReset();
  mocks.complete.mockReset();
  mocks.apply.mockReset();
  useAiStore.setState({ topicDraft: null, topicRunning: false, topicError: null, config: { ...useAiStore.getState().config, enabled: true, model: "Qwen3:8B" } });
});

describe("store.generateTopic —— 按需单页", () => {
  it("★ 成功 ⇒ 草稿进 `topicDraft`，而**唯一的落库口一次都没被调用**", async () => {
    mocks.collect.mockResolvedValue(collected());
    mocks.complete.mockResolvedValue({ content: ANSWER });

    await useAiStore.getState().generateTopic(section, { indexed: 3, total: 9 });

    const s = useAiStore.getState();
    expect(mocks.apply).toHaveBeenCalledTimes(0); // ⭐ 不落库：这条是这一块的全部意义 ✓
    expect(s.topicError).toBeNull();
    expect(s.topicDraft).toBeTruthy();
    expect(s.topicDraft!.refs).toEqual([PAGE_REF]); // 回链只来自输入（且只来自本分区声明的那些 ✓）
    expect(s.topicDraft!.body).toContain("同步靠变更日志");
    expect(s.topicDraft!.body).not.toContain("我编的结论");
    expect(s.topicDraft!.body).not.toContain("没有回链的结论");
    expect(s.topicDraft!.footer).toContain("派生，非出处");
    expect(s.topicDraft!.coverage).toBe("覆盖度：3/9");
  });

  it("★ 只喂该分区声明的来源：提示词里**不许**出现另外两条材料", async () => {
    mocks.collect.mockResolvedValue(collected());
    mocks.complete.mockResolvedValue({ content: `${PAGE_REF} 甲。` });

    await useAiStore.getState().generateTopic(section, null);

    const call = mocks.complete.mock.calls[0] as unknown[];
    const messages = call[0] as Array<{ role: string; content: string }>;
    const prompt = messages.map((m) => m.content).join("\n");
    expect(prompt).toContain(PAGE_REF);
    expect(prompt).not.toContain(BLOCK_REF);
    expect(prompt).not.toContain("[[页面B]]");
    expect(useAiStore.getState().topicDraft!.coverage).toBe("覆盖度：未知"); // 没给读数 ⇒ 未知 ✓
  });

  it("取材被平台挡住 ⇒ 如实报错，且**不留一份空草稿**（空报告会被读成「什么都没有」✗）", async () => {
    mocks.collect.mockResolvedValue({ sources: [], skipped: [], chars: 0, pages: 0, attachments: 0, blocked: "这个平台不提供派生层" });

    await useAiStore.getState().generateTopic(section, null);

    const s = useAiStore.getState();
    expect(s.topicDraft).toBeNull();
    expect(s.topicError).toContain("不提供派生层");
    expect(mocks.apply).toHaveBeenCalledTimes(0);
  });

  it("★ 取消（`stop()`）⇒ 在飞那次的结果**不采用**", async () => {
    mocks.collect.mockResolvedValue(collected());
    let release: (v: { content: string }) => void = () => {};
    mocks.complete.mockImplementation(() => new Promise((res) => (release = res)));

    const inflight = useAiStore.getState().generateTopic(section, null);
    useAiStore.getState().stop(); // 取消＝让 seq 作废（**不是**中断网络请求——LlmOptions 里没有 signal ✗）
    release({ content: `${PAGE_REF} 迟到的结论。` });
    await inflight;

    const s = useAiStore.getState();
    expect(s.topicDraft).toBeNull(); // 结果不采用 ✓
    expect(s.topicRunning).toBe(false);
    expect(mocks.apply).toHaveBeenCalledTimes(0);
  });

  it("`clearTopicDraft`（「不采用」）⇒ 清掉草稿，**什么都不写**", async () => {
    mocks.collect.mockResolvedValue(collected());
    mocks.complete.mockResolvedValue({ content: `${PAGE_REF} 甲。` });
    await useAiStore.getState().generateTopic(section, null);
    expect(useAiStore.getState().topicDraft).toBeTruthy();

    useAiStore.getState().clearTopicDraft();
    expect(useAiStore.getState().topicDraft).toBeNull();
    expect(mocks.apply).toHaveBeenCalledTimes(0);
  });
});
