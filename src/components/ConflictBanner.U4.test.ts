// U4 片 3 组件判据（happy-dom；数据/命令/确认框都打桩）—— 补两条：
//   ① **批量确认路径**：点「本页全部留本地」⇒ 先 confirmDialog（带影响块数）⇒ 逐块调 resolvePageConflict
//   ② **推荐高亮**：一侧是另一侧前缀时，推荐按钮带 `conflict-btn-primary`；真两难时**两个都不高亮**
//
// ⚠️ 本仓 vitest include 只有 `src/**/*.test.ts`（无 tsx）⇒ 用 createElement（与 ConflictBanner.test.ts 同形）。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const listPageConflicts = vi.fn();
const resolvePageConflict = vi.fn();
const confirmDialog = vi.fn();

vi.mock("../lib/api", () => ({
  api: {
    listPageConflicts: (...args: unknown[]) => listPageConflicts(...args),
    resolvePageConflict: (...args: unknown[]) => resolvePageConflict(...args),
  },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("../store/confirm", () => ({
  confirmDialog: (...args: unknown[]) => confirmDialog(...args),
}));

import { ConflictBanner } from "./ConflictBanner";
import { useEditorStore } from "../store/editor";

const para = (text: string) =>
  JSON.stringify({ type: "paragraph", blockId: "b1", content: [{ type: "text", text }] });

const row = (id: string, block: string, local: string, remote: string) => ({
  id,
  page_id: "p1",
  block_id: block,
  reason: "same-rev-different-content",
  local_json: para(local),
  remote_json: para(remote),
  detected_at: 1,
  resolved_at: null,
  resolved_choice: null,
});

describe("ConflictBanner · U4 批量与推荐", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    listPageConflicts.mockReset();
    resolvePageConflict.mockReset();
    confirmDialog.mockReset();
    confirmDialog.mockResolvedValue(true);
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

  it("① 批量：先二次确认（带块数），再逐块调既有命令", async () => {
    const rows = [row("c1", "b1", "我改的", "他改的"), row("c2", "b2", "甲乙", "丙丁")];
    listPageConflicts.mockResolvedValue(rows);
    resolvePageConflict.mockResolvedValue(null);
    await render();

    const batch = container.querySelector('[data-testid="conflict-batch-local"]') as HTMLButtonElement;
    expect(batch).toBeTruthy();
    await act(async () => {
      batch.click();
    });

    // ① 二次确认：必须带「影响 N 块」（i18n 打桩 ⇒ 断的是 key 与 count）
    expect(confirmDialog).toHaveBeenCalledTimes(1);
    const arg = confirmDialog.mock.calls[0][0] as { message: string; title: string };
    expect(arg.message).toBe("conflicts.batchMessage");
    // ② 逐块调既有命令（⛔ 不新造命令）
    expect(resolvePageConflict.mock.calls).toEqual([
      ["c1", "local"],
      ["c2", "local"],
    ]);
  });

  it("② 推荐高亮：一侧前缀 ⇒ 高亮更全那侧；真两难 ⇒ 两个都不高亮", async () => {
    // 本地是远端前缀（本地更全）⇒ 推荐「留本地」
    listPageConflicts.mockResolvedValue([row("c1", "b1", "更长的一版", "更长的")]);
    await render();
    const primary = () => Array.from(container.querySelectorAll("button.conflict-btn-primary"));
    expect(primary().length).toBe(1);
    expect(primary()[0].textContent).toBe("conflicts.keepLocal");

    // 真两难 ⇒ 无主按钮
    act(() => root.unmount());
    root = createRoot(container);
    listPageConflicts.mockResolvedValue([row("c9", "b9", "我改的", "他改的")]);
    await render();
    expect(container.querySelectorAll("button.conflict-btn-primary").length).toBe(0);
  });
});
