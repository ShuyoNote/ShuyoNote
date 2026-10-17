// R155 第二半（外部写后播种 CRDT 状态）的判据 —— 钉的是 `crdt/seedExternalWrite.ts` 这个纯函数。
//
// 为什么值得单独钉：它是"免确认写入能不能算落定"的唯一开关（现场：外部写落库后 `page_crdt`
// 里搜不到那段文字 ⇒ 重启时旧内容赢 ✗）。这里用注入的假实现，确认三件事：
//   ① 成功路径：状态字节被写到**这一页**上；
//   ② 失败路径：**不抛**（落库已经发生，不能让刷新流程炸掉），但返回 false 留痕；
//   ③ 播种用的就是 `stateFor(page)` 给的字节（不许换成空状态）。
import { describe, expect, it, vi } from "vitest";
import { seedExternalWriteState } from "./seedExternalWrite";

const page = { id: "p-r155" };

describe("R155 第二半：外部写后播种 CRDT 状态", () => {
  it("成功：把 stateFor 产出的字节写到这一页上", async () => {
    const state = new Uint8Array([1, 2, 3]);
    const saveState = vi.fn(async () => undefined);
    const ok = await seedExternalWriteState(page, {
      stateFor: (p) => {
        expect(p).toBe(page);
        return state;
      },
      saveState,
    });
    expect(ok).toBe(true);
    expect(saveState).toHaveBeenCalledTimes(1);
    expect(saveState).toHaveBeenCalledWith("p-r155", state);
  });

  it("失败：不抛异常、返回 false（落库已发生，不能把刷新流程带崩）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const ok = await seedExternalWriteState(page, {
      stateFor: () => new Uint8Array([9]),
      saveState: async () => {
        throw new Error("save_page_state 失败");
      },
    });
    expect(ok).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("stateFor 抛错也走同一条失败路径（不静默、不抛）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const ok = await seedExternalWriteState(page, {
      stateFor: () => {
        throw new Error("正文不合法");
      },
      saveState: async () => undefined,
    });
    expect(ok).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
