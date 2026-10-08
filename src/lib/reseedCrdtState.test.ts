import { beforeEach, describe, expect, it, vi } from "vitest";

// ⭐ **R155 判据（第二半：接线 ✓）**：外部写落库之后，**必须**按新正文把该页的 CRDT 状态重新播种 ✓
//   否则重启按状态重建 ⇒ 旧内容赢 ✗（现场已复现三次 ✓）。
const mocks = vi.hoisted(() => ({ savePageState: vi.fn() }));
vi.mock("./api", () => ({ api: { savePageState: mocks.savePageState, mcpLogApplyResult: vi.fn() } }));

import { reseedCrdtStateFromContent } from "./reseedCrdtState";

const jsonOf = (text: string) =>
  JSON.stringify({
    root: {
      type: "root", version: 1, direction: "ltr", format: "", indent: 0,
      children: [
        {
          blockId: "b1", type: "paragraph", version: 1, direction: "ltr", format: "", indent: 0, style: "",
          children: [{ type: "text", text, format: "", style: "", mode: "normal", detail: 0, version: 1 }],
        },
      ],
    },
  });

beforeEach(() => mocks.savePageState.mockReset());

describe("R155：落库后按新正文播种 CRDT 状态", () => {
  it("★ 必须落一份**含那段文字**的状态 ✓（现场那条读数的反面 ✓）", async () => {
    mocks.savePageState.mockResolvedValue(undefined);
    await reseedCrdtStateFromContent("p1", jsonOf("R155 状态探针 XYZ"));

    expect(mocks.savePageState).toHaveBeenCalledTimes(1);
    const [id, state] = mocks.savePageState.mock.calls[0] as [string, Uint8Array];
    expect(id).toBe("p1");
    expect(state.length, "状态字节不能为空 ✗").toBeGreaterThan(0);
    expect(new TextDecoder().decode(state), "状态里必须能搜到那段文字 ✓").toContain("R155 状态探针 XYZ");
  });

  it("★ 空正文也给得出合法状态（⛔ 不抛 ✗）", async () => {
    mocks.savePageState.mockResolvedValue(undefined);
    await expect(reseedCrdtStateFromContent("p2", jsonOf(""))).resolves.toBeUndefined();
    expect(mocks.savePageState).toHaveBeenCalledTimes(1);
  });

  it("★ 播种失败**要抛出来** ✓（调用方负责留痕 —— 不许静默 ✗）", async () => {
    mocks.savePageState.mockRejectedValue(new Error("磁盘满"));
    let thrown: unknown = null;
    try {
      await reseedCrdtStateFromContent("p3", jsonOf("x"));
    } catch (e) {
      thrown = e;
    }
    expect(String(thrown), "必须把失败抛给调用方 ✓（静默吞掉就又是一条"看着成功"路径 ✗）").toContain("磁盘满");
  });
});
