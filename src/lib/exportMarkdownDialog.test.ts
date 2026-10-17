// 判据：C 弹窗的**执行层**（2026-10-18）—— 「导出当前页… / 导出本空间…」＋ 三个勾选项。
//
// 这里只钉**行为**（zip ／ 纯 .md ／ 平铺 ／ YAML ／ 取消 ／ 失败），不碰 React（组件那边另有判据 ✓）。
// 外部世界只桩两头：保存对话框（`platform.dialog`）与后端命令（`api`）。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEditor, $getRoot, $createParagraphNode, $createTextNode } from "lexical";
import { unzipSync } from "fflate";

const saveMock = vi.fn();
const openMock = vi.fn();
const writeBinaryMock = vi.fn();
const writeTextMock = vi.fn();
const readBytesMock = vi.fn();
const listPagesMock = vi.fn();
const getPageMock = vi.fn();
const listAttachmentsMock = vi.fn();
const getWorkspaceNameMock = vi.fn();

vi.mock("./platform", () => ({
  platform: {
    dialog: {
      save: (...a: unknown[]) => saveMock(...a),
      open: (...a: unknown[]) => openMock(...a),
    },
  },
  isDesktopPlatform: () => true,
}));
vi.mock("./api", () => ({
  api: {
    writeBinaryFile: (...a: unknown[]) => writeBinaryMock(...a),
    writeTextFile: (...a: unknown[]) => writeTextMock(...a),
    readAttachmentBytes: (...a: unknown[]) => readBytesMock(...a),
    listPages: () => listPagesMock(),
    getPage: (...a: unknown[]) => getPageMock(...a),
    listPageAttachments: (...a: unknown[]) => listAttachmentsMock(...a),
    getWorkspaceName: () => getWorkspaceNameMock(),
  },
}));

import { ImageNode } from "../editor/nodes/ImageNode";
import { useToast } from "../store/toast";
import { ExportReportedError } from "./exportMarkdownBundle";
import { runDialogExport, type DialogExportOptions } from "./exportMarkdownDialog";

/** 一页只有一段文字的**真**编辑器状态（⛔ 不手搓 JSON 形状 ✗）。 */
function plainDoc(text = "正文"): string {
  const editor = createEditor({ namespace: "export-dialog-test", nodes: [ImageNode] });
  editor.update(
    () => {
      const p = $createParagraphNode();
      if (text) p.append($createTextNode(text));
      $getRoot().append(p);
    },
    { discrete: true },
  );
  return JSON.stringify(editor.getEditorState().toJSON());
}

const page = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  id,
  title,
  content_json: plainDoc(),
  content_text: "",
  workspace_id: "ws1",
  parent_id: null,
  kind: "page",
  ...extra,
});

const opts = (over: Partial<DialogExportOptions> = {}): DialogExportOptions => ({
  target: "page",
  pageId: "p1",
  withAttachments: true,
  yaml: false,
  flat: false,
  ...over,
});

const unzip = (bytes: number[]) => unzipSync(new Uint8Array(bytes));
const textOf = (out: Record<string, Uint8Array>, name: string) => new TextDecoder().decode(out[name]);

beforeEach(() => {
  saveMock.mockReset();
  openMock.mockReset();
  writeBinaryMock.mockReset();
  writeTextMock.mockReset();
  readBytesMock.mockReset().mockResolvedValue(new Uint8Array([1, 2, 3]));
  listPagesMock.mockReset().mockResolvedValue([]);
  getPageMock.mockReset();
  listAttachmentsMock.mockReset().mockResolvedValue([]);
  getWorkspaceNameMock.mockReset().mockResolvedValue("默认空间");
  useToast.setState({ toasts: [] });
});

describe("runDialogExport · ☑附件 ⇒ zip", () => {
  it("当前页：写出 zip（.md ＋ assets/），默认名带空间名 ✓", async () => {
    getPageMock.mockResolvedValue(page("p1", "我的页"));
    saveMock.mockResolvedValue("D:/out/我的页.zip");
    listAttachmentsMock.mockResolvedValue([
      { id: "a1", hash: "h1", mime: "image/png", name: "图.png", size: 3, path: "" },
    ]);
    // 正文里有一条字面量引用 ⇒ 走附件那条路
    getPageMock.mockResolvedValue({ ...page("p1", "我的页"), content_json: plainDoc("见 attachment://h1") });

    const msg = await runDialogExport(opts());

    const saveArg = saveMock.mock.calls[0][0] as { defaultPath: string };
    expect(saveArg.defaultPath).toBe("默认空间-我的页.zip");
    const out = unzip(writeBinaryMock.mock.calls[0][1] as number[]);
    expect(Object.keys(out).sort()).toEqual(["assets/图.png", "我的页.md"].sort());
    expect(textOf(out, "我的页.md")).toContain("assets/图.png");
    expect(msg).toContain("已导出");
  });

  it("勾「纯 .md 平铺」⇒ zip 内不再有 `父/子.md` 这种目录 ✓", async () => {
    listPagesMock.mockResolvedValue([{ id: "a", parent_id: null, kind: "page" }]);
    getPageMock.mockResolvedValue(page("a", "父"));
    saveMock.mockResolvedValue("D:/out/平铺.zip");

    await runDialogExport(opts({ target: "space", withAttachments: true, flat: true }));

    const out = unzip(writeBinaryMock.mock.calls[0][1] as number[]);
    expect(out["父.md"]).toBeTruthy();
    expect(Object.keys(out).some((k) => k.includes("/") && !k.startsWith("assets/"))).toBe(false);
  });

  it("勾「元数据 YAML」⇒ 每份 .md 顶部是 front matter（不是 HTML 注释）✓", async () => {
    getPageMock.mockResolvedValue(page("p1", "我的页"));
    saveMock.mockResolvedValue("D:/out/y.zip");

    await runDialogExport(opts({ yaml: true }));

    const out = unzip(writeBinaryMock.mock.calls[0][1] as number[]);
    const md = textOf(out, "我的页.md");
    expect(md.startsWith('---\ntitle: "我的页"\nid: "p1"\nkind: "page"\n---\n')).toBe(true);
    expect(md).not.toContain("<!-- title:");
  });

  it("取消保存对话框 ⇒ 一个字节都不写、也不报成功 ✓", async () => {
    getPageMock.mockResolvedValue(page("p1", "我的页"));
    saveMock.mockResolvedValue(null);

    const msg = await runDialogExport(opts());

    expect(writeBinaryMock).not.toHaveBeenCalled();
    expect(msg).toContain("已取消");
    expect(msg).not.toContain("已导出");
  });

  it("写盘失败 ⇒ 抛 `ExportReportedError`（进度 toast 已如实变红，调用方别重复弹 ✗）", async () => {
    getPageMock.mockResolvedValue(page("p1", "我的页"));
    saveMock.mockResolvedValue("D:/out/f.zip");
    writeBinaryMock.mockRejectedValue(new Error("盘满了"));
    await expect(runDialogExport(opts())).rejects.toBeInstanceOf(ExportReportedError);
    const { toasts } = useToast.getState();
    expect(toasts[toasts.length - 1]?.kind).toBe("error");
    expect(toasts[toasts.length - 1]?.message).toContain("盘满了");
  });
});

describe("runDialogExport · ☐附件 ⇒ 纯 .md", () => {
  it("当前页 ⇒ 单个 .md；正文里的 attachment:// 引用**原样留着**并如实报数 ✓", async () => {
    getPageMock.mockResolvedValue({ ...page("p1", "我的页"), content_json: plainDoc("见 attachment://h1") });
    saveMock.mockResolvedValue("D:/out/我的页.md");

    const msg = await runDialogExport(opts({ withAttachments: false }));

    expect(readBytesMock, "不带附件 ⇒ ⛔ 不许偷偷读附件字节 ✗").not.toHaveBeenCalled();
    expect(saveMock.mock.calls[0][0]).toMatchObject({ defaultPath: "我的页.md" });
    const text = writeTextMock.mock.calls[0][1] as string;
    expect(text).toContain("attachment://h1");
    expect(text).not.toContain("assets/");
    expect(msg).toContain("保留 attachment:// 原样");
  });

  it("本空间 ⇒ 选目录后**平铺**写多份 .md（不建子目录）✓", async () => {
    listPagesMock.mockResolvedValue([{ id: "a", parent_id: null, kind: "page" }]);
    getPageMock.mockResolvedValue(page("a", "父"));
    openMock.mockResolvedValue("D:/out/md");

    const msg = await runDialogExport(opts({ target: "space", withAttachments: false }));

    expect(openMock.mock.calls[0][0]).toMatchObject({ directory: true });
    expect(writeTextMock).toHaveBeenCalledTimes(1);
    expect(writeTextMock.mock.calls[0][0]).toBe("D:/out/md/父.md");
    expect(msg).toContain("已导出 1 个页面");
    expect(msg).toContain("纯 .md 平铺");
  });

  it("取消目录选择 ⇒ 什么都不写 ✓", async () => {
    listPagesMock.mockResolvedValue([{ id: "a", parent_id: null, kind: "page" }]);
    getPageMock.mockResolvedValue(page("a", "父"));
    openMock.mockResolvedValue(null);

    const msg = await runDialogExport(opts({ target: "space", withAttachments: false }));

    expect(writeTextMock).not.toHaveBeenCalled();
    expect(msg).toContain("已取消");
  });

  it("勾「元数据 YAML」⇒ 纯 .md 也有 front matter ✓", async () => {
    getPageMock.mockResolvedValue(page("p1", "我的页"));
    saveMock.mockResolvedValue("D:/out/我的页.md");

    await runDialogExport(opts({ withAttachments: false, yaml: true }));

    expect(writeTextMock.mock.calls[0][1] as string).toContain('title: "我的页"');
  });
});
