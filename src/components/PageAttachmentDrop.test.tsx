// 判据：拖拽导入的两档语义（2026-11-09，owner 选 A+）。
//   ① 正文区：`importAttachmentFiles` **一次**把 N 个路径交给后端；成功后 bump 附件面板，
//      并把 N 个 `attachment-ref` 节点**追加进正文**；
//   ② 附件区：同样导入、同样 bump，但**一个节点都不许插正文**（正文不动）；
//   ③ 后端失败（例如文件被占用）⇒ toast 报错、不插任何节点、不吞异常。
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  importAttachmentFiles: vi.fn(),
  bump: vi.fn(),
  toast: vi.fn(),
  append: vi.fn(),
  createRef: vi.fn((...args: unknown[]) => ({ kind: "attachment-ref", args })),
  editorUpdate: vi.fn((fn: () => void) => fn()),
  editor: { update: vi.fn((fn: () => void) => fn()) } as { update: (fn: () => void) => void } | null,
}));

vi.mock("../lib/api", () => ({ api: { importAttachmentFiles: mocks.importAttachmentFiles } }));
vi.mock("../store/toast", () => ({ toast: mocks.toast }));
vi.mock("../store/attachments", () => ({
  useAttachmentsStore: { getState: () => ({ bump: mocks.bump }) },
}));
vi.mock("../store/editor", () => ({
  useEditorStore: { getState: () => ({ editor: mocks.editor }) },
}));
vi.mock("lexical", () => ({ $getRoot: () => ({ append: mocks.append }) }));
vi.mock("../editor/nodes/AttachmentRefNode", () => ({
  $createAttachmentRefNode: mocks.createRef,
}));
vi.mock("../lib/platform", () => ({
  platform: { webview: { onDragDropEvent: () => Promise.resolve(() => {}) } },
}));

import { importDroppedAttachments } from "./PageAttachmentDrop";

const METAS = [
  { id: "att-1", name: "年报.pdf", size: 1024, mime: "application/pdf", hash: "h1", path: "/p1" },
  { id: "att-2", name: "数据.zip", size: 2048, mime: "application/zip", hash: "h2", path: "/p2" },
];

beforeEach(() => {
  mocks.importAttachmentFiles.mockReset();
  mocks.bump.mockReset();
  mocks.toast.mockReset();
  mocks.append.mockReset();
  mocks.createRef.mockClear();
});

describe("importDroppedAttachments：正文区 = 挂附件 + 插正文卡片", () => {
  it("① 正文区：导入一次、bump 一次、追加 2 个节点（参数取自后端元数据）", async () => {
    mocks.importAttachmentFiles.mockResolvedValue(METAS);

    await expect(importDroppedAttachments("page-1", ["/a", "/b"], "editor")).resolves.toBe(true);

    expect(mocks.importAttachmentFiles).toHaveBeenCalledWith("page-1", ["/a", "/b"]);
    expect(mocks.bump).toHaveBeenCalledTimes(1);
    expect(mocks.append).toHaveBeenCalledTimes(2);
    expect(mocks.createRef).toHaveBeenNthCalledWith(1, "att-1", "年报.pdf", 1024, "application/pdf", "h1", "/p1");
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("插入正文"), "success");
  });

  it("② 附件区：同样导入并 bump，但**不插正文**", async () => {
    mocks.importAttachmentFiles.mockResolvedValue(METAS);

    await expect(importDroppedAttachments("page-1", ["/a"], "attachments")).resolves.toBe(true);

    expect(mocks.bump).toHaveBeenCalledTimes(1);
    expect(mocks.append).not.toHaveBeenCalled();
    expect(mocks.createRef).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("已添加"), "success");
  });

  it("③ 后端失败 ⇒ 报错、不插节点、返回 false（调用方不会误报成功）", async () => {
    mocks.importAttachmentFiles.mockRejectedValue(new Error("文件被占用"));

    await expect(importDroppedAttachments("page-1", ["/a"], "editor")).resolves.toBe(false);

    expect(mocks.append).not.toHaveBeenCalled();
    expect(mocks.bump).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("添加附件失败"), "error");
  });

  it("④ 空路径（拖了个寂寞）⇒ 直接返回 false，不打扰后端", async () => {
    await expect(importDroppedAttachments("page-1", [], "editor")).resolves.toBe(false);
    expect(mocks.importAttachmentFiles).not.toHaveBeenCalled();
  });

  it("⑤ 正文区但编辑器尚未就绪 ⇒ 只挂附件、不崩（不假装插入成功）", async () => {
    mocks.importAttachmentFiles.mockResolvedValue(METAS);
    // 用 vi.spyOn 临时换掉 getState 的返回值
    const editorMod = await import("../store/editor");
    const spy = vi.spyOn(editorMod.useEditorStore, "getState").mockReturnValue({ editor: null } as never);

    await expect(importDroppedAttachments("page-1", ["/a"], "editor")).resolves.toBe(true);
    expect(mocks.append).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
