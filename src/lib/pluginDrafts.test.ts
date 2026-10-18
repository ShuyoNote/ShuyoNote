// `confirmAndApplyDrafts` 的判据（2026-10-18）：**确认框必须让用户看见"会变成什么"**。
//
// 挡的是哪一幕：外部 AI 的 `pages_update` 是整页替换，而确认框原来只显示一句
// 后端 summary（「更新页面 xxx（整页替换）」）⇒ 用户是在**看不见新内容**的情况下点确定。
// 这条判据钉五件事：① 覆盖式写要给出 原文→新文 的字数与开头；② 改前字数缺失时**如实说**
// （⛔ 不编一个 0）；③ 拒绝就什么都不写；④ **不把 UUID 和 `external:…` 这种审计 id 丢给用户**；
// ⑤ 开头预览是**纯文本**（⛔ 不是 `> **##` 的 Markdown 原文）。

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../store/confirm", () => ({ confirmDialog: vi.fn() }));
vi.mock("./applyDraftAndRefresh", () => ({ applyDraftAndRefresh: vi.fn() }));
vi.mock("./api", () => ({ api: { getPage: vi.fn() } }));

import { confirmDialog } from "../store/confirm";
import { applyDraftAndRefresh } from "./applyDraftAndRefresh";
import { api } from "./api";
import {
  confirmAndApplyDrafts,
  draftPreviewLines,
  friendlySource,
  plainPreview,
} from "./pluginDrafts";

const confirmMock = () => confirmDialog as unknown as ReturnType<typeof vi.fn>;
const applyMock = () => applyDraftAndRefresh as unknown as ReturnType<typeof vi.fn>;
const getPageMock = () => api.getPage as unknown as ReturnType<typeof vi.fn>;

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
    getPageMock().mockResolvedValue({ title: "文档标题" });
  });

  it("update_page：用**标题**、给字数与纯文本开头", async () => {
    const lines = await draftPreviewLines([
      draft("update_page", { pageId: "p1", markdown: "# 新标题\n\n新正文更长了", beforeChars: 6 }),
    ]);
    expect(lines[0]).toBe("整页替换「文档标题」：原文 6 字 → 新正文 13 字");
    expect(lines[1]).toContain("开头：新标题 新正文更长了");
    expect(lines[1]).not.toContain("#");
  });

  it("读不到页面标题 ⇒ 给短 id（⛔ 不显示整串 UUID）", async () => {
    getPageMock().mockRejectedValue(new Error("boom"));
    const lines = await draftPreviewLines([
      draft("update_page", { pageId: "91d306f7-5157-4feb-9aa7-3193a7e7878c", plain: "x" }),
    ]);
    expect(lines[0]).toContain("91d306f7");
    expect(lines[0]).not.toContain("5157-4feb");
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

  it("弹框开场说人话：`external:…` ⇒ 「外部 AI」，不出现审计 id", async () => {
    await confirmAndApplyDrafts("external:mcp-c95a6cef", [
      draft("update_page", { pageId: "p1", markdown: "整页新正文", beforeChars: 6 }),
    ]);
    const msg = String(confirmMock().mock.calls[0][0]?.message ?? "");
    expect(msg).toContain("外部 AI 想对笔记做这些改动");
    expect(msg).not.toContain("external:");
    expect(msg).toContain("摘要-update_page");
    expect(msg).toContain("整页替换「文档标题」");
    expect(msg).toContain("点「确定」才会真正写入");
  });

  it("拒绝 ⇒ 什么都不写（apply 一次都没调）", async () => {
    confirmMock().mockResolvedValue(false);
    const out = await confirmAndApplyDrafts("插件 x", [draft("update_page", { pageId: "p1", plain: "x" })]);
    expect(out).toContain("已放弃");
    expect(applyMock()).not.toHaveBeenCalled();
  });
});

describe("两个纯函数", () => {
  it("friendlySource：external 前缀 ⇒ 外部 AI；插件名原样", () => {
    expect(friendlySource("external:mcp-1")).toBe("外部 AI");
    expect(friendlySource("插件 x")).toBe("插件 x");
    expect(friendlySource("")).toBe("外部改动");
  });

  it("plainPreview：去掉标题井号/加粗/引用/列表/链接记号，只留可读的字", () => {
    const md = "> 引用\n\n# 标题\n\n**加粗** 与 `代码`\n\n- 列表项\n\n[链接文字](https://x.cn)";
    const got = plainPreview(md);
    expect(got).toBe("引用 标题 加粗 与 代码 列表项 链接文字");
  });
});
