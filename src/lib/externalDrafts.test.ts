// 「外部 AI 想改你的笔记」这条事件的岔路判据（`src/lib/externalDrafts.ts` ✓）。
//
// 为什么必须钉这一条岔路：M2 的**用户侧承诺**全在这里 ——
//   · 默认 ⇒ **必须问用户**（不点确定就一个字节都不落 ✓）；
//   · 免确认 ⇒ 可以直接落 ✓，但**必须留痕**（Rust 写了审计行 ✓，用户这侧也要看得见一句 ✓）。
// 选错方向的后果都是用户数据：① 该问的时候不问 = 外部 AI 能偷偷改笔记 ✗；
// ② 不该弹框的时候弹 = 插件/AI 那条现成链路被重复打扰 ✗。
import { describe, expect, it, vi } from "vitest";
import { handleExternalDraftsEvent, parseExternalDraftsEvent, type ExternalDraftDeps } from "./externalDrafts";
import type { PluginDraft } from "../types";

const drafts: PluginDraft[] = [
  { key: "create_page:周报", summary: "新建页面「周报」", payload: { kind: "create_page", args: { title: "周报" } } },
];

/** Rust 那侧真发出来的形状：`{source, payload: "<json 文本>"}` ✓ */
function rustEvent(auto: boolean) {
  return {
    source: "external:mcp-abc",
    payload: JSON.stringify({ source: "external:mcp-abc", auto_apply: auto, drafts }),
  };
}

function deps() {
  const confirmAndApply = vi.fn<(source: string, drafts: PluginDraft[]) => Promise<string>>(
    async () => "已放弃 1 项改动（未写入）",
  );
  const applyOne = vi.fn<(payload: unknown) => Promise<{ ok: boolean; message: string }>>(async () => ({
    ok: true,
    message: "已写入",
  }));
  const notify = vi.fn<(message: string, kind: "success" | "info" | "error") => void>();
  return { deps: { confirmAndApply, applyOne, notify } as ExternalDraftDeps, confirmAndApply, applyOne, notify };
}

describe("外部草稿的分岔路", () => {
  it("★ 默认（免确认关着）必须**问用户**：走 confirmAndApply，绝不自己 apply", async () => {
    const d = deps();
    await handleExternalDraftsEvent(rustEvent(false), d.deps);
    expect(d.confirmAndApply).toHaveBeenCalledTimes(1);
    expect(d.confirmAndApply.mock.calls[0][0]).toContain("external:mcp-abc");
    expect(d.applyOne).not.toHaveBeenCalled();
  });

  it("★ 免确认开着 ⇒ 直接落库**且**留痕（逐个结果 ＋ 一句看得见的汇总）", async () => {
    const d = deps();
    await handleExternalDraftsEvent(rustEvent(true), d.deps);
    expect(d.confirmAndApply).not.toHaveBeenCalled();
    expect(d.applyOne).toHaveBeenCalledTimes(1);
    expect(d.notify).toHaveBeenCalledTimes(1);
    const [msg, kind] = d.notify.mock.calls[0];
    expect(String(msg)).toContain("直接写入");
    expect(String(msg)).toContain("周报");
    expect(kind).toBe("success");
  });

  it("★ 免确认里有一条失败 ⇒ 汇总如实说（并给出 ✗ 的那条）", async () => {
    const d = deps();
    d.applyOne.mockResolvedValueOnce({ ok: false, message: "落库失败" });
    await handleExternalDraftsEvent(rustEvent(true), d.deps);
    const [msg, kind] = d.notify.mock.calls[0];
    expect(String(msg)).toContain("0/1");
    expect(String(msg)).toContain("落库失败");
    expect(kind).toBe("error");
  });

  it("★ 看不懂的载荷 ⇒ 明说一句、不装作处理过（⛔ 不静默）", async () => {
    const d = deps();
    const out = await handleExternalDraftsEvent({ 胡说: true }, d.deps);
    expect(out).toBe("");
    expect(d.applyOne).not.toHaveBeenCalled();
    expect(d.confirmAndApply).not.toHaveBeenCalled();
    expect(d.notify).toHaveBeenCalledTimes(1);
    expect(String(d.notify.mock.calls[0][0])).toContain("看不懂");
  });

  it("解析器：两种形状都认，坏 JSON 返回 null", () => {
    expect(parseExternalDraftsEvent(rustEvent(false))?.drafts).toHaveLength(1);
    expect(parseExternalDraftsEvent({ source: "s", auto_apply: true, drafts })?.auto_apply).toBe(true);
    expect(parseExternalDraftsEvent({ payload: "{坏" })).toBeNull();
    expect(parseExternalDraftsEvent(null)).toBeNull();
  });
});
