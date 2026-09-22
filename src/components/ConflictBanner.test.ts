// 阶段 1 · **冲突提示条 + 块级角标发布**的判据（happy-dom；数据/命令都打桩，只验"看得见 + 按得动"）。
//
// ⚠️ 本仓 vitest 的 `include` 只有 `src/**/*.test.ts` + `scripts/**/*.test.mjs`
// ⇒ 组件判据**写成 `.test.ts`**、用 `createElement`（不写 JSX，`.test.tsx` 根本不会被跑到）。
//
// 钉住六件事：
//   ① 没有冲突 ⇒ **整条不渲染**（别在每页顶部挂一个空条）；
//   ② 有冲突 ⇒ 两侧原文都显示出来 + 三个按钮（定位 / 留本地 / 用远端）都在；
//   ③ 「留本地」⇒ 调 `resolvePageConflict(id, "local")`（**不猜**：参数就是它）；
//   ④ 裁决之后重新读一次 ⇒ 未决没了就整条消失；
//   ⑤ ★ 把"哪几块有冲突"**发布给编辑器**（`useEditorStore.conflictBlockIds`）—— 块级角标靠它；
//   ⑥ 「定位」⇒ 走块引用跳转**同一条路**（`setFocusBlockId`）；离开这一页 ⇒ 把角标清空。

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// React 18 的 `act` 要这个开关：happy-dom 环境里默认没开 ⇒ 只有警告，但刷新时机就不受控了。
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const listPageConflicts = vi.fn();
const resolvePageConflict = vi.fn();

vi.mock("../lib/api", () => ({
  api: {
    listPageConflicts: (...args: unknown[]) => listPageConflicts(...args),
    resolvePageConflict: (...args: unknown[]) => resolvePageConflict(...args),
  },
}));

// i18n 在判据里不需要真的初始化：`t` 直接回键名（断言更好写，也不依赖词条）
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { ConflictBanner } from "./ConflictBanner";
import { useEditorStore } from "../store/editor";

const ROW = {
  id: "c1",
  page_id: "p1",
  block_id: "b1",
  reason: "same-rev-different-content",
  local_json: JSON.stringify({ type: "paragraph", blockId: "b1", children: [{ type: "text", text: "我改的" }] }),
  remote_json: JSON.stringify({ type: "paragraph", blockId: "b1", children: [{ type: "text", text: "他改的" }] }),
  detected_at: 1,
  resolved_at: null,
  resolved_choice: null,
};

describe("ConflictBanner（阶段 1 · 冲突提示条）", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    listPageConflicts.mockReset();
    resolvePageConflict.mockReset();
    useEditorStore.setState({ conflictBlockIds: [], focusBlockId: null });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = async () => {
    await act(async () => {
      root.render(createElement(ConflictBanner, { pageId: "p1" }));
    });
  };
  const buttons = () => Array.from(container.querySelectorAll("button"));

  it("① 没有冲突 ⇒ 什么都不渲染", async () => {
    listPageConflicts.mockResolvedValue([]);
    await render();
    expect(container.innerHTML).toBe("");
    expect(useEditorStore.getState().conflictBlockIds).toEqual([]); // 也不给编辑器发角标
  });

  it("② 有冲突 ⇒ 两侧原文都在，三个按钮都在", async () => {
    listPageConflicts.mockResolvedValue([ROW]);
    await render();

    expect(container.textContent).toContain("我改的");
    expect(container.textContent).toContain("他改的");
    expect(buttons().map((b) => b.textContent)).toEqual([
      "conflicts.locate",
      "conflicts.keepLocal",
      "conflicts.useRemote",
    ]);
  });

  it("③ 点「留本地」⇒ 调 resolvePageConflict(id, 'local')", async () => {
    listPageConflicts.mockResolvedValue([ROW]);
    resolvePageConflict.mockResolvedValue(null);
    await render();

    await act(async () => {
      buttons()[1].click();
    });
    expect(resolvePageConflict).toHaveBeenCalledWith("c1", "local");
  });

  it("④ 裁决之后重新读 ⇒ 未决没了就整条消失", async () => {
    listPageConflicts.mockResolvedValue([ROW]);
    resolvePageConflict.mockResolvedValue(null);
    await render();
    expect(container.textContent).toContain("我改的");

    // 裁决之后这一页没有未决冲突了
    listPageConflicts.mockResolvedValue([]);
    await act(async () => {
      buttons()[1].click();
    });
    expect(listPageConflicts).toHaveBeenCalledTimes(2); // 首次 + 裁决后
    expect(container.innerHTML).toBe("");
  });

  it("⑤ ★ 把冲突块 id 发布给编辑器（块级角标靠它）", async () => {
    listPageConflicts.mockResolvedValue([ROW]);
    await render();
    expect(useEditorStore.getState().conflictBlockIds).toEqual(["b1"]);
  });

  it("⑥ ★ 「定位」走块引用跳转同一条路；离开这一页 ⇒ 角标清空", async () => {
    listPageConflicts.mockResolvedValue([ROW]);
    await render();

    await act(async () => {
      buttons()[0].click();
    });
    // 跳转是"设置一个待跳的块 id"，由 Editor 那边滚动 + 闪一下（与 BacklinksPanel 同一条路）
    expect(useEditorStore.getState().focusBlockId).toBe("b1");

    act(() => root.unmount());
    expect(useEditorStore.getState().conflictBlockIds).toEqual([]); // 别把角标留在别的页上
  });
});
