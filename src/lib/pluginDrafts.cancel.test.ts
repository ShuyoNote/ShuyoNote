// UX-④ B：用户取消确认框 ⇒ 立刻把 draftId 回写 rejected（不是等 10 分钟变 expired）。
import { describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => ({
  mcpDraftState: vi.fn(async () => undefined),
  getPage: vi.fn(async () => null),
  mcpLogApplyResult: vi.fn(async () => undefined),
}));

vi.mock("../store/confirm", () => ({ confirmDialog: async () => false }));
vi.mock("./api", () => ({ api: apiMock }));
vi.mock("./applyDraftAndRefresh", () => ({ applyDraftAndRefresh: vi.fn() }));

import { confirmAndApplyDrafts } from "./pluginDrafts";

describe("UX-④ · 取消确认框回写 rejected", () => {
  it("用户点取消 ⇒ 每条草稿的 draftId 都立即 rejected", async () => {
    apiMock.mcpDraftState.mockClear();
    const msg = await confirmAndApplyDrafts("external:test", [
      { key: "k1", summary: "改一", payload: { kind: "blocks_patch", pageId: "p1", blockId: "b1", draftId: "d-1" } },
      { key: "k2", summary: "改二", payload: { kind: "blocks_delete", pageId: "p1", blockId: "b2", draftId: "d-2" } },
    ]);
    expect(msg).toContain("已放弃");
    expect(apiMock.mcpDraftState).toHaveBeenCalledWith("d-1", "rejected");
    expect(apiMock.mcpDraftState).toHaveBeenCalledWith("d-2", "rejected");
  });
});
