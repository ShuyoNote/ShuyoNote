// 冲刺 §13.3 第 2 条 · **页级血统冲突提示条**的判据（happy-dom；api 打桩，只验"看得见 + 按得动"）。
//
// ⚠️ 与 `ConflictBanner.test.ts` 同一套手法（`.test.ts` ＋ `createElement` —— 本仓 vitest 的
// `include` 不含 `.test.tsx`）。钉住五件事：
//   ① 没有未决冲突 ⇒ **整条不渲染**（别在每页顶部挂一个空条）；
//   ② 有一条 ⇒ 两个按钮在（**只有两个**：留本机 / 另存为新页 —— 页级冲突没有"逐块选一侧"那回事）；
//   ③ ★「另存为新页」⇒ **真的建一个新页**（标题带后缀、内容是对端那一版、正文按编辑器语义派生）
//      然后把它记成 `saved-as-new`；
//   ④ 「保留本机」⇒ 记成 `local`（**不默认选边**：参数就是它）；
//   ⑤ 裁决之后重新读 ⇒ 未决没了就整条消失。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const listLineageConflicts = vi.fn();
const resolveLineageConflict = vi.fn();
const createPage = vi.fn();
const getPage = vi.fn();
const writePageProjection = vi.fn();
const savePageState = vi.fn();

vi.mock("../lib/api", () => ({
  api: {
    listLineageConflicts: (...args: unknown[]) => listLineageConflicts(...args),
    resolveLineageConflict: (...args: unknown[]) => resolveLineageConflict(...args),
    createPage: (...args: unknown[]) => createPage(...args),
    getPage: (...args: unknown[]) => getPage(...args),
    writePageProjection: (...args: unknown[]) => writePageProjection(...args),
    savePageState: (...args: unknown[]) => savePageState(...args),
  },
}));

// i18n 在判据里不需要真的初始化：`t` 直接回键名（断言更好写，也不依赖词条）
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { LineageConflictBanner } from "./LineageConflictBanner";

const PEER_JSON = JSON.stringify({
  root: { children: [{ type: "paragraph", blockId: "blk-other", children: [{ type: "text", text: "对端写的" }] }] },
});

const ROW = {
  id: "lc1",
  page_id: "p1",
  mine_fp: "7",
  remote_fp: "42",
  remote_doc: PEER_JSON,
  detected_at: 1,
  resolved_at: null,
  resolved_choice: null,
};

describe("LineageConflictBanner（页级血统冲突）", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    listLineageConflicts.mockReset();
    resolveLineageConflict.mockReset();
    createPage.mockReset();
    getPage.mockReset();
    writePageProjection.mockReset();
    savePageState.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = async () => {
    await act(async () => {
      root.render(createElement(LineageConflictBanner, { pageId: "p1" }));
    });
  };
  const buttons = () => Array.from(container.querySelectorAll("button"));

  it("① 没有未决 ⇒ 什么都不渲染", async () => {
    listLineageConflicts.mockResolvedValue(null);
    await render();
    expect(container.innerHTML).toBe("");
  });

  it("② 有一条 ⇒ **三个**按钮（留本机 / 采用对端 / 另存为新页），并说清「合不了」这件事", async () => {
    listLineageConflicts.mockResolvedValue(ROW);
    await render();
    expect(buttons().map((b) => b.textContent)).toEqual(["lineage.keepLocal", "lineage.adoptRemote", "lineage.savedAsNew"]);
    expect(container.textContent).toContain("lineage.title");
    expect(container.textContent).toContain("lineage.hint");
  });

  it("⑥ ★「采用对端那一版」⇒ 写回对端正文（经文档层）＋ 清本机 CRDT 状态 ＋ 裁决记 remote", async () => {
    listLineageConflicts.mockResolvedValue(ROW);
    getPage.mockResolvedValue({ title: "本页" });
    await render();
    await act(async () => {});
    const btn = buttons().find((b) => b.textContent === "lineage.adoptRemote") as HTMLButtonElement;
    await act(async () => { btn.click(); });
    expect(writePageProjection).toHaveBeenCalledTimes(1);
    expect(writePageProjection).toHaveBeenCalledWith("p1", PEER_JSON);   // ① 写回**对端那版** ✓
    expect(savePageState).toHaveBeenCalledWith("p1", expect.any(Uint8Array));  // ② 清本机状态 ✓
    expect(resolveLineageConflict).toHaveBeenCalledWith("lc1", "remote");       // ③ 裁决记 remote ✓
  });

  it("⑦ 采用对端时「清本机状态」必须发生在「记裁决」之前（顺序错了＝选择会被静默撤销 ✗）", async () => {
    const order: string[] = [];
    listLineageConflicts.mockResolvedValue(ROW);
    getPage.mockResolvedValue({ title: "本页" });
    writePageProjection.mockImplementation(async () => { order.push("save"); });
    savePageState.mockImplementation(async () => { order.push("clear"); });
    resolveLineageConflict.mockImplementation(async () => { order.push("resolve"); });
    await render();
    await act(async () => {});
    const btn = buttons().find((b) => b.textContent === "lineage.adoptRemote") as HTMLButtonElement;
    await act(async () => { btn.click(); });
    expect(order).toEqual(["save", "clear", "resolve"]);
  });
it("③ ★「另存为新页」⇒ 建一个新页（标题带后缀、内容是对端那版）＋ 记成 saved-as-new", async () => {
    listLineageConflicts.mockResolvedValue(ROW);
    getPage.mockResolvedValue({ id: "p1", title: "会议纪要", content_json: "{}", content_text: "" });
    createPage.mockResolvedValue("new-page-id");
    resolveLineageConflict.mockResolvedValue(null);
    await render();

    await act(async () => {
      buttons().find((b) => b.textContent === "lineage.savedAsNew")!.click();
    });

    expect(createPage).toHaveBeenCalledTimes(1);
    const arg = createPage.mock.calls[0][0] as {
      parent_id: string | null;
      title: string;
      content_json: string;
      content_text: string;
    };
    expect(arg.parent_id, "救回来的页放顶层（不猜父页面）").toBeNull();
    expect(arg.title, "标题要能看出它是另一条编辑历史那份").toContain("会议纪要");
    expect(arg.title).toContain("另一条编辑历史");
    expect(arg.content_json, "内容必须是**对端那一版**").toBe(PEER_JSON);
    expect(arg.content_text, "正文要按编辑器语义派生（新页一建出来就能被搜到）").toContain("对端写的");
    expect(resolveLineageConflict).toHaveBeenCalledWith("lc1", "saved-as-new");
  });

  it("④ 「保留本机」⇒ 记成 local（不默认选边：参数就是它）", async () => {
    listLineageConflicts.mockResolvedValue(ROW);
    resolveLineageConflict.mockResolvedValue(null);
    await render();

    await act(async () => {
      buttons().find((b) => b.textContent === "lineage.keepLocal")!.click();
    });
    expect(resolveLineageConflict).toHaveBeenCalledWith("lc1", "local");
    expect(createPage, "只是「我知道了」 ⇒ 不许建页").not.toHaveBeenCalled();
  });

  it("⑤ 裁决之后重新读 ⇒ 未决没了就整条消失", async () => {
    listLineageConflicts.mockResolvedValue(ROW);
    resolveLineageConflict.mockResolvedValue(null);
    await render();
    expect(container.textContent).toContain("lineage.title");

    listLineageConflicts.mockResolvedValue(null);
    await act(async () => {
      buttons().find((b) => b.textContent === "lineage.keepLocal")!.click();
    });
    expect(listLineageConflicts).toHaveBeenCalledTimes(2); // 首次 + 裁决后
    expect(container.innerHTML).toBe("");
  });
});
