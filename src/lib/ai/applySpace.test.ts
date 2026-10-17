// spaces.switch（MCP / AI 宿主都能调）：草稿 → 落库那条路只做一件事 —— 交给空间 store 去切。
// 判据：① 命中同 id 才调 switchTo；② 缺 id 直接失败；③ store 拒绝时如实报 false（不假装成功）。
import { beforeEach, describe, expect, it, vi } from "vitest";

const switchTo = vi.fn<(id: string) => Promise<boolean>>(async () => true);

vi.mock("../../store/space", () => ({
  useSpaceStore: { getState: () => ({ switchTo }) },
}));

vi.mock("../api", () => ({
  api: {
    createPage: vi.fn(),
    getPage: vi.fn(),
    savePage: vi.fn(),
    setPageProp: vi.fn(),
    addTag: vi.fn(),
  },
}));

import { applyDraft } from "./apply";

beforeEach(() => {
  vi.resetAllMocks();
  switchTo.mockResolvedValue(true);
});

describe("applyDraft（switch_space 切空间）", () => {
  it("把 spaceId 交给空间 store（唯一实现），成功回 ok", async () => {
    const r = await applyDraft({ kind: "switch_space", spaceId: "space-ops", name: "运营" });
    expect(r.ok).toBe(true);
    expect(switchTo).toHaveBeenCalledTimes(1);
    expect(switchTo).toHaveBeenCalledWith("space-ops");
    expect(r.message).toContain("运营");
  });

  it("没有 spaceId ⇒ 明确失败，不调 store", async () => {
    const r = await applyDraft({ kind: "switch_space" });
    expect(r.ok).toBe(false);
    expect(switchTo).not.toHaveBeenCalled();
  });

  it("store 拒绝（口令/被拒）⇒ 如实报失败", async () => {
    switchTo.mockResolvedValueOnce(false);
    const r = await applyDraft({ kind: "switch_space", spaceId: "space-locked" });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("失败");
  });
});
