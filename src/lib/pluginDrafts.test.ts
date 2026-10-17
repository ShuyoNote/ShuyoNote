// `confirmAndApplyDrafts` 的判据（2026-10-18）：**确认框必须让用户看见"会变成什么"**。
//
// 挡的是哪一幕：外部 AI 的 `pages_update` 是整页替换，而确认框原来只显示一句
// 后端 summary（「更新页面 xxx（整页替换）」）⇒ 用户是在**看不见新内容**的情况下点确定。
// 这条判据钉三件事：① 覆盖式写要给出 原文→新文 的字数与开头；② 改前字数缺失时**如实说**
// （⛔ 不编一个 0）；③ 拒绝就什么都不写。

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../store/confirm", () => ({ confirmDialog: vi.fn() }));
vi.mock("./applyDraftAndRefresh", () => ({ applyDraftAndRefresh: vi.fn() }));

import { confirmDialog } from "../store/confirm";
import { applyDraftAndRefresh } from "./applyDraftAndRefresh";
import { confirmAndApplyDrafts, draftPreviewLines } from "./pluginDrafts";

const confirmMock = () => confirmDialog as unknown as ReturnType<typeof vi.fn>;
const applyMock = () => applyDraftAndRefresh as unknown as ReturnType<typeof vi.fn>;

const draft = (kind: string, payload: Record<string, unknown>) => ({
  key: `k-${kind}`,
  summary: `摘要-${kind}`,
  payload: { kind, ...payload },
});

describe("确认框：覆盖式写必须让人看见会变成什么", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    confirmMock().mockResolvedValue(true);
    applyMock().mockResolvedValue({ ok: true, message: "已保存" });
  });

  it("update_page：给出「原文 N 字 → 新正文 M 字」＋ 新正文开头", async () => {
    const lines = await draftPreviewLines([
      draft("update_page", { pageId: "p1", markdown: "# 新标题\n\n新正文更长了", beforeChars: 6 }),
    ]);
    expect(lines[0]).toContain("整页替换 p1");
    expect(lines[0]).toContain("原文 6 字");
    expect(lines[0]).toContain("新正文 13 字");
    expect(lines[1]).toContain("新正文开头：");
    expect(lines[1]).toContain("新标题");
  });

  it("后端没给改前字数 ⇒ 如实说读不到（⛔ 不编一个「原文 0 字」）", async () => {
    const lines = await draftPreviewLines([
      draft("update_page", { pageId: "p2", plain: "新内容", beforeChars: null }),
    ]);
    expect(lines[0]).toContain("读不到原文");
    expect(lines[0]).not.toContain("原文 0 字");
  });

  it("create_page / append_block 也给一行具体数量", async () => {
    const lines = await draftPreviewLines([
      draft("create_page", { title: "周报", content: "第一段" }),
      draft("append_block", { text: "追加的话" }),
    ]);
    expect(lines[0]).toBe("新建页面「周报」：正文 3 字");
    expect(lines[1]).toBe("追加一段：4 字");
  });

  it("不认识的草稿种类不产出行、也不抛", async () => {
    await expect(draftPreviewLines([draft("switch_space", { id: "s2" })])).resolves.toEqual([]);
    await expect(draftPreviewLines([{ key: "k", summary: "s", payload: null }])).resolves.toEqual([]);
  });

  it("弹框文案里带着预览（不是只给 summary）", async () => {
    await confirmAndApplyDrafts("外部 AI（external:mcp-1）", [
      draft("update_page", { pageId: "p1", markdown: "整页新正文", beforeChars: 6 }),
    ]);
    const msg = String(confirmMock().mock.calls[0][0]?.message ?? "");
    expect(msg).toContain("摘要-update_page");
    expect(msg).toContain("整页替换 p1");
    expect(msg).toContain("点「确定」才会真正写入");
  });

  it("拒绝 ⇒ 什么都不写（apply 一次都没调）", async () => {
    confirmMock().mockResolvedValue(false);
    const out = await confirmAndApplyDrafts("插件 x", [draft("update_page", { pageId: "p1", plain: "x" })]);
    expect(out).toContain("已放弃");
    expect(applyMock()).not.toHaveBeenCalled();
  });
});
