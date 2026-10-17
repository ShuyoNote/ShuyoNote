// 判据：「空间/页面导出 Markdown **带附件** ＋ 打包 zip ＋ 路径重写」（方案 V1.1）这一片。
//
// 这一组盯的是**四条硬要求**，不是 UI：
//   ① 正文里的 `attachment://<hash>` ⇒ `assets/<hash>.<ext>`（同目录相对 ✓）；
//   ② 同一个 `<hash>` 只进 zip **一份**（内容寻址 ＋ `Map`/`Set` 守住）；
//   ③ 非法 / 重名的文件名被安全化（`sanitizeName` ＋ 额外剥 `..` / 分隔符 ⇒ 防 zip-slip ✗）；
//   ④ 一页附件都没有时**不崩**（zip 里就一份 .md，没有空的 assets/ 目录）。
//
// 另外钉两条"诚实"：
//   · 附件字节取不到 ⇒ **正文保留原引用**（⛔ 不改成一个坏链接 ✗），且返回消息里说清楚；
//   · 保存对话框取消 ⇒ **一个字节都不写**、也不报成功（与 `exportMarkdown.test.ts` 同口径 ✓）。
//
// ⚠️ 这里用的附件引用**两种形状都测**：字面量 `attachment://<hash>`
//   （office 导入的图片没有指纹，正文里只剩这个）与桌面真实的
//   `attachment://localhost/C%3A/…`（URL 里**没有 hash**，只能靠节点指纹换）。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createEditor, $getRoot, $createParagraphNode, $createTextNode } from "lexical";
import { unzipSync } from "fflate";

const saveMock = vi.fn();
const writeMock = vi.fn();
const readBytesMock = vi.fn();
const listAttachmentsMock = vi.fn();
const listPagesMock = vi.fn();
const getPageMock = vi.fn();

// 只 mock"会碰外部世界"的那两头（保存对话框 ＋ 后端命令）；转换与排版走真实现 ✓
vi.mock("./platform", () => ({
  platform: { dialog: { save: (...a: unknown[]) => saveMock(...a) } },
  isDesktopPlatform: () => true,
}));
vi.mock("./api", () => ({
  api: {
    writeBinaryFile: (...a: unknown[]) => writeMock(...a),
    readAttachmentBytes: (...a: unknown[]) => readBytesMock(...a),
    listPageAttachments: (...a: unknown[]) => listAttachmentsMock(...a),
    listPages: (...a: unknown[]) => listPagesMock(...a),
    getPage: (...a: unknown[]) => getPageMock(...a),
  },
}));

// ⚠️ import 必须在 vi.mock 之后（读起来也清楚）
import { $createImageNode, ImageNode } from "../editor/nodes/ImageNode";
import {
  assetPathFor,
  attachmentHashesIn,
  exportPageBundleToZip,
  exportWorkspaceBundleToZip,
  packBundle,
  planBundle,
  preparePages,
  rewriteAttachmentRefs,
  safeEntryName,
} from "./exportMarkdownBundle";

/** 造一份**真的**编辑器状态 JSON（⛔ 不手搓形状：手搓的容易缺字段，判据就会骗人 ✗）。 */
function stateJson(build: (root: ReturnType<typeof $getRoot>) => void): string {
  const editor = createEditor({
    namespace: "export-bundle-test",
    nodes: [ImageNode],
    onError: (e) => {
      throw e;
    },
  });
  editor.update(
    () => {
      build($getRoot());
    },
    { discrete: true },
  );
  return JSON.stringify(editor.getEditorState().toJSON());
}

/** 一页只有一段文字（= 没有任何附件引用的那一档）。 */
function plainDoc(text = "正文"): string {
  return stateJson((root) => {
    const p = $createParagraphNode();
    if (text) p.append($createTextNode(text));
    root.append(p);
  });
}

/** 一页含一张图（`src` 与 `__hash` 分开给：桌面真实 URL 里没有 hash）。 */
function imageDoc(src: string, hash: string | null, mime: string | null): string {
  return stateJson((root) => {
    const p = $createParagraphNode();
    p.append($createImageNode(src, "图", false, null, null, hash, mime));
    root.append(p);
  });
}

function unzipBytes(bytes: number[] | Uint8Array) {
  return unzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
}

function textOf(out: Record<string, Uint8Array>, name: string): string {
  const entry = out[name];
  expect(entry, `zip 里没有 ${name}（实际有：${Object.keys(out).join(", ")}）`).toBeTruthy();
  return new TextDecoder().decode(entry);
}

beforeEach(() => {
  saveMock.mockReset();
  writeMock.mockReset();
  readBytesMock.mockReset();
  listAttachmentsMock.mockReset().mockResolvedValue([]);
  listPagesMock.mockReset().mockResolvedValue([]);
  getPageMock.mockReset();
});

describe("① 路径重写：`attachment://<hash>` ⇒ `assets/<hash>.<ext>`", () => {
  it("字面量引用（图片与附件链接）都被换成同目录相对路径", () => {
    const md = "![图](attachment://abc123)\n\n[年报](attachment://abc123)";
    const out = rewriteAttachmentRefs(md, (h) => assetPathFor(h, { mime: "image/png" }));
    expect(out).toBe("![图](assets/abc123.png)\n\n[年报](assets/abc123.png)");
    expect(out).not.toContain("attachment://");
    // 相对路径：不带 `assets` 之外的目录、也不是绝对路径
    expect(out).toContain("(assets/abc123.png)");
  });

  it("扩展名依次问 mime → 文件名 → `.bin`（⛔ 不猜 ✗）", () => {
    expect(assetPathFor("h1", { mime: "image/jpeg" })).toBe("assets/h1.jpg");
    // ⭐ 2026-10-18：有原文件名就用原名（owner 报的缺口：全叫 `<hash>.png` 认不出来 ✓）
    expect(assetPathFor("h1", { mime: "", name: "年报.PDF" })).toBe("assets/年报.pdf");
    expect(assetPathFor("h1", { mime: "", name: "没有后缀" })).toBe("assets/没有后缀.bin");
    expect(assetPathFor("h1")).toBe("assets/h1.bin");
  });

  it("控制组：桌面那种 `attachment://localhost/…`（URL 里没有 hash）不许被乱换", () => {
    const md = "![图](attachment://localhost/C%3A/x.png)";
    expect(attachmentHashesIn(md)).toEqual([]);
    expect(rewriteAttachmentRefs(md, (h) => assetPathFor(h, { mime: "image/png" }))).toBe(md);
  });

  it("真节点那条路：URL 不含 hash，也照样换成 `assets/<hash>.<ext>`（靠节点指纹）", () => {
    const prepared = preparePages([
      {
        id: "p1",
        title: "带图页",
        docJson: imageDoc("attachment://localhost/C%3A/x.png", "deadbeef", "image/png"),
      },
    ]);
    const plan = planBundle(prepared);
    expect(plan.files[0].path).toBe("带图页.md");
    expect(plan.files[0].text).toContain("![图](assets/deadbeef.png)");
    expect(plan.files[0].text).not.toContain("attachment://");
    expect(plan.assets).toEqual([{ hash: "deadbeef", path: "assets/deadbeef.png" }]);
  });
});

describe("② 去重：同一个 hash 只放一份", () => {
  it("正文里引用两次 ⇒ 只记一个 hash、只放一份", () => {
    expect(attachmentHashesIn("![a](attachment://h1)\n![b](attachment://h1)")).toEqual(["h1"]);
    const prepared = preparePages([
      {
        id: "p1",
        title: "两次引用",
        docJson: imageDoc("attachment://localhost/a.png", "h1", "image/png"),
      },
    ]);
    // 同一 hash 在正文里出现两次（第二段再引一次同一 src）
    prepared[0].markdown = `${prepared[0].markdown}\n![再引一次](attachment://localhost/a.png)`;
    const plan = planBundle(prepared);
    expect(plan.assets).toEqual([{ hash: "h1", path: "assets/h1.png" }]);
    const out = unzipBytes(packBundle(plan, new Map([["h1", new Uint8Array([9, 9])]])));
    expect(Object.keys(out).filter((k) => k.startsWith("assets/"))).toEqual(["assets/h1.png"]);
  });

  it("跨页引用同一个 hash ⇒ zip 里仍然只有一份", () => {
    const prepared = preparePages([
      { id: "p1", title: "甲", docJson: imageDoc("attachment://localhost/a.png", "h1", "image/png") },
      { id: "p2", title: "乙", docJson: imageDoc("attachment://localhost/b.png", "h1", "image/png") },
    ]);
    const plan = planBundle(prepared);
    expect(plan.files).toHaveLength(2);
    expect(plan.assets).toHaveLength(1);
    const out = unzipBytes(packBundle(plan, new Map([["h1", new Uint8Array([1, 2, 3])]])));
    expect(Object.keys(out).sort()).toEqual(["assets/h1.png", "乙.md", "甲.md"].sort());
  });
});

describe("③ 文件名安全化：非法字符、上跳、重名", () => {
  it("`..` / 路径分隔符 / 控制字符都被剥掉（防 zip-slip ✗）", () => {
    const evil = safeEntryName("../../etc/passwd", "p1");
    expect(evil).not.toContain("..");
    expect(evil).not.toContain("/");
    expect(evil).not.toContain("\\");
    const ctrl = safeEntryName("a\\b\u0007c", "p1");
    expect(ctrl).not.toMatch(/[\\\u0000-\u001f]/);
    // 空 / null / 只有点 ⇒ 用兜底名（⛔ 不写出 `.md` 这种空基名 ✗）
    expect(safeEntryName("", "p1")).toBe("p1");
    expect(safeEntryName(null, "p1")).toBe("p1");
    expect(safeEntryName("..", "p1")).toBe("p1");
    // hash 来自正文（不可信）⇒ 也逃不出 `assets/`
    expect(assetPathFor("../../etc/passwd", { mime: "image/png" })).toBe("assets/etcpasswd.png");
    expect(assetPathFor("../../", { mime: "image/png" })).toBe("assets/attachment.png");
    // ⭐ 2026-10-18：原名也来自数据库（不可信）⇒ 同样逃不出 `assets/`（⛔ zip-slip ✗）
    expect(assetPathFor("h1", { mime: "image/png", name: "../../etc/passwd.png" })).toBe("assets/passwd.png");
    expect(assetPathFor("h1", { mime: "image/png", name: "..\\..\\win.png" })).toBe("assets/win.png");
  });

  it("重名沿用现有的 `-<id 前 6 位>` 策略", () => {
    const prepared = preparePages([
      { id: "aaaaaa1", title: "同名", docJson: plainDoc() },
      { id: "bbbbbb2", title: "同名", docJson: plainDoc() },
      { id: "cccccc3", title: "同名", docJson: plainDoc() },
    ]);
    const names = planBundle(prepared).files.map((f) => f.path);
    expect(names).toEqual(["同名.md", "同名-bbbbbb.md", "同名-cccccc.md"]);
    expect(new Set(names).size).toBe(3);
  });
});

describe("④ 空附件：不崩", () => {
  it("一页附件都没有 ⇒ zip 里只有那份 .md，没有 assets/", () => {
    const plan = planBundle(preparePages([{ id: "p1", title: "空页", docJson: plainDoc() }]));
    expect(plan.assets).toEqual([]);
    expect(plan.unresolved).toEqual([]);
    expect(plan.skipped).toBe(0);
    const out = unzipBytes(packBundle(plan, new Map()));
    expect(Object.keys(out)).toEqual(["空页.md"]);
    expect(textOf(out, "空页.md")).toContain("<!-- title: 空页 · id: p1 -->");
    expect(textOf(out, "空页.md")).not.toContain("assets/");
  });

  it("空正文（没文字也没附件）⇒ 照样出一份 .md，不抛", () => {
    const plan = planBundle(preparePages([{ id: "p2", title: "", docJson: plainDoc("") }]));
    expect(plan.files).toHaveLength(1);
    expect(plan.files[0].path).toBe("p2.md");
    expect(plan.files[0].text).toContain("<!-- title: 未命名 · id: p2 -->");
    expect(plan.assets).toEqual([]);
  });
});

describe("导出接线（保存对话框 ＋ 写二进制）", () => {
  it("取消 ⇒ ⛔ 一个字节都不写、也⛔ 不报成功", async () => {
    saveMock.mockResolvedValue(null);
    const msg = await exportPageBundleToZip({ id: "p1", title: "页", docJson: plainDoc() });
    expect(writeMock).not.toHaveBeenCalled();
    expect(msg).toContain("已取消");
    expect(msg).not.toContain("已导出");
  });

  it("成功：写到用户选的路径，zip 里 .md 指向 assets/，附件字节原样在里面", async () => {
    saveMock.mockResolvedValue("D:/out/带图页.zip");
    // 桌面读回 `ArrayBuffer`、Web 读回 `number[]` —— 两种形状都得收（见 toBytes）
    readBytesMock.mockResolvedValue(new Uint8Array([1, 2, 3, 4]).buffer);
    const msg = await exportPageBundleToZip({
      id: "p1",
      title: "带图页",
      docJson: imageDoc("attachment://localhost/C%3A/x.png", "h1", "image/png"),
    });

    expect(saveMock).toHaveBeenCalledTimes(1);
    const arg = saveMock.mock.calls[0][0] as { defaultPath: string; filters: { extensions: string[] }[] };
    expect(arg.defaultPath).toBe("带图页.zip");
    expect(arg.filters[0].extensions).toEqual(["zip"]);

    expect(writeMock).toHaveBeenCalledTimes(1);
    const [path, data] = writeMock.mock.calls[0] as [string, number[]];
    expect(path).toBe("D:/out/带图页.zip");
    expect(Array.isArray(data)).toBe(true); // CommandMap 那一格要的是 number[]

    const out = unzipBytes(data);
    expect(Object.keys(out).sort()).toEqual(["assets/h1.png", "带图页.md"]);
    expect(Array.from(out["assets/h1.png"])).toEqual([1, 2, 3, 4]);
    expect(textOf(out, "带图页.md")).toContain("![图](assets/h1.png)");
    expect(readBytesMock).toHaveBeenCalledTimes(1);
    expect(readBytesMock).toHaveBeenCalledWith("h1");
    expect(msg).toContain("已导出");
    expect(msg).toContain("1 个附件");
  });

  it("Web 那种 `number[]` 字节也收（⛔ 不赌其中一种壳 ✗）", async () => {
    saveMock.mockResolvedValue("D:/out/p.zip");
    readBytesMock.mockResolvedValue([7, 8]);
    await exportPageBundleToZip({
      id: "p1",
      title: "p",
      docJson: imageDoc("attachment://localhost/x.png", "h9", "image/png"),
    });
    const out = unzipBytes(writeMock.mock.calls[0][1] as number[]);
    expect(Array.from(out["assets/h9.png"])).toEqual([7, 8]);
  });

  it("附件字节取不到 ⇒ 正文**保留原引用**（⛔ 不留坏链接 ✗），消息里如实报", async () => {
    saveMock.mockResolvedValue("D:/out/缺件.zip");
    readBytesMock.mockRejectedValue(new Error("文件内容缺失"));
    const msg = await exportPageBundleToZip({
      id: "p1",
      title: "缺件",
      docJson: imageDoc("attachment://localhost/x.png", "h1", "image/png"),
    });
    const out = unzipBytes(writeMock.mock.calls[0][1] as number[]);
    expect(Object.keys(out)).toEqual(["缺件.md"]);
    const md = textOf(out, "缺件.md");
    expect(md).toContain("attachment://localhost/x.png");
    expect(md).not.toContain("assets/");
    expect(msg).toContain("没取到");
    expect(msg).toContain("已导出"); // 部分成功也照样落盘，但把缺的说明白
  });

  it("节点上没有 mime ⇒ 用现成的 `list_page_attachments` 问类型（⛔ 不新造后端命令 ✗）", async () => {
    saveMock.mockResolvedValue("D:/out/n.zip");
    readBytesMock.mockResolvedValue(new Uint8Array([5]));
    listAttachmentsMock.mockResolvedValue([
      { id: "a1", hash: "h2", mime: "application/pdf", name: "年报.pdf", size: 1, path: "" },
    ]);
    const doc = stateJson((root) => {
      const p = $createParagraphNode();
      // 从 Markdown 导进来的图片：只有 `src`，没有 `__hash` / `__mime`
      p.append($createImageNode("attachment://h2", "年报", false, null, null, null, null));
      root.append(p);
    });
    const msg = await exportPageBundleToZip({ id: "p1", title: "问类型", docJson: doc });
    expect(listAttachmentsMock).toHaveBeenCalledWith("p1");
    const out = unzipBytes(writeMock.mock.calls[0][1] as number[]);
    // ⭐ 2026-10-18：问到的 `name` 现在也参与条目名 ⇒ 用**原名**，扩展名仍来自 mime ✓
    expect(Object.keys(out).sort()).toEqual(["assets/年报.pdf", "问类型.md"]);
    expect(msg).toContain("1 个附件");
    expect(msg).not.toContain(".bin");
  });

  it("空间导出：读全部页、附件按 hash 去重", async () => {
    saveMock.mockResolvedValue("D:/out/空间.zip");
    readBytesMock.mockResolvedValue(new Uint8Array([1]));
    listPagesMock.mockResolvedValue([{ id: "p1" }, { id: "p2" }]);
    getPageMock.mockImplementation(async (id: string) =>
      id === "p1"
        ? { id: "p1", title: "甲", content_json: imageDoc("attachment://localhost/a.png", "h1", "image/png") }
        : { id: "p2", title: "乙", content_json: plainDoc("没有附件") },
    );
    const msg = await exportWorkspaceBundleToZip();
    expect(listPagesMock).toHaveBeenCalledTimes(1);
    const out = unzipBytes(writeMock.mock.calls[0][1] as number[]);
    // ⭐ 2026-10-18：空间导出多一页 `_attachments.md` 索引（条目数 ＝ 附件数 ✓）
    expect(Object.keys(out).sort()).toEqual(["_attachments.md", "assets/h1.png", "乙.md", "甲.md"].sort());
    expect(msg).toContain("已导出");
    expect(msg).toContain("2 页");
    expect(msg).toContain("1 个附件");
  });
});

// ⭐ 2026-10-18（owner 报的缺口：空间导出只带"正文引用的"附件 ⇒ 塞进空间的 PDF/Word/素材丢了 ✗）：
//   口径改成**完整备份** —— 全部附件都进 zip ＋ `_attachments.md` 索引（原名 → 路径 ✓）。
describe("⑤ 空间导出带上**全部附件**（2026-10-18 加）", () => {
  /** 一个只有 `p1` 一页、正文没有任何附件引用的空间。 */
  function singlePageSpace(rows: unknown[]) {
    saveMock.mockResolvedValue("D:/out/完整.zip");
    readBytesMock.mockResolvedValue(new Uint8Array([1, 2]));
    listPagesMock.mockResolvedValue([{ id: "p1", parent_id: null, kind: "page" }]);
    getPageMock.mockResolvedValue({ id: "p1", title: "页", content_json: plainDoc("没有引用附件") });
    listAttachmentsMock.mockResolvedValue(rows);
  }
  const indexRows = (text: string) =>
    text.split("\n").filter((line) => /^\| .* \| assets\//.test(line)).length;

  it("未引用附件也在包里 ＋ 索引条目数＝附件数 ✓", async () => {
    singlePageSpace([
      { id: "a1", hash: "z9", mime: "application/pdf", name: "手册.pdf", size: 1, path: "" },
      {
        id: "a2",
        hash: "z8",
        mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        name: "需求.docx",
        size: 2,
        path: "",
      },
    ]);
    const msg = await exportWorkspaceBundleToZip();
    const out = unzipBytes(writeMock.mock.calls[0][1] as number[]);
    expect(Object.keys(out).sort()).toEqual(["_attachments.md", "assets/手册.pdf", "assets/需求.docx", "页.md"].sort());
    const index = textOf(out, "_attachments.md");
    expect(indexRows(index)).toBe(2);
    expect(index).toContain("| 手册.pdf | assets/手册.pdf |");
    expect(index).toContain("| 需求.docx | assets/需求.docx |");
    expect(msg).toContain("2 个附件");
    expect(msg).toContain("未被正文引用");
    // 附件字节原样进包（不是空壳 ✓）
    expect(Array.from(out["assets/手册.pdf"])).toEqual([1, 2]);
  });

  it("同名附件互不覆盖（后到的退 `-<hash 前 6 位>` ✓）", async () => {
    singlePageSpace([
      { id: "a1", hash: "aaaaaa11", mime: "application/pdf", name: "报告.pdf", size: 1, path: "" },
      { id: "a2", hash: "bbbbbb22", mime: "application/pdf", name: "报告.pdf", size: 1, path: "" },
    ]);
    await exportWorkspaceBundleToZip();
    const out = unzipBytes(writeMock.mock.calls[0][1] as number[]);
    expect(Object.keys(out).filter((k) => k.startsWith("assets/")).sort()).toEqual([
      "assets/报告-bbbbbb.pdf",
      "assets/报告.pdf",
    ]);
    expect(indexRows(textOf(out, "_attachments.md"))).toBe(2);
  });

  it("附件原名里的 `..` / 分隔符逃不出 `assets/`（zip-slip ✗）", async () => {
    singlePageSpace([
      { id: "a1", hash: "evil01", mime: "image/png", name: "../../etc/passwd.png", size: 1, path: "" },
    ]);
    await exportWorkspaceBundleToZip();
    const out = unzipBytes(writeMock.mock.calls[0][1] as number[]);
    const assetKeys = Object.keys(out).filter((k) => k.startsWith("assets/"));
    expect(assetKeys).toEqual(["assets/passwd.png"]);
    expect(assetKeys.every((k) => !k.includes(".."))).toBe(true);
  });

  it("正文引用的附件也用原名进 zip，正文里的引用跟着换成新路径 ✓", async () => {
    saveMock.mockResolvedValue("D:/out/引用.zip");
    readBytesMock.mockResolvedValue(new Uint8Array([7]));
    listPagesMock.mockResolvedValue([{ id: "p1", parent_id: null, kind: "page" }]);
    getPageMock.mockResolvedValue({
      id: "p1",
      title: "带图",
      content_json: imageDoc("attachment://localhost/C%3A/a.png", "h1", "image/png"),
    });
    listAttachmentsMock.mockResolvedValue([
      { id: "a1", hash: "h1", mime: "image/png", name: "封面.png", size: 1, path: "" },
    ]);
    await exportWorkspaceBundleToZip();
    const out = unzipBytes(writeMock.mock.calls[0][1] as number[]);
    expect(Object.keys(out).sort()).toEqual(["_attachments.md", "assets/封面.png", "带图.md"].sort());
    expect(textOf(out, "带图.md")).toContain("![图](assets/封面.png)");
    expect(textOf(out, "带图.md")).not.toContain("attachment://");
  });

  it("附件清单列不出来 ⇒ 如实说「可能漏带」，⛔ 不假装完整 ✗", async () => {
    saveMock.mockResolvedValue("D:/out/x.zip");
    readBytesMock.mockResolvedValue(new Uint8Array([1]));
    listPagesMock.mockResolvedValue([{ id: "p1", parent_id: null, kind: "page" }]);
    getPageMock.mockResolvedValue({ id: "p1", title: "页", content_json: plainDoc() });
    listAttachmentsMock.mockRejectedValue(new Error("列不出来"));
    const msg = await exportWorkspaceBundleToZip();
    expect(msg).toContain("附件清单没列出来");
    expect(msg).toContain("可能漏带");
  });

  it("单页导出仍只带正文引用的附件（完整备份口径只属于空间导出 ✓）", async () => {
    saveMock.mockResolvedValue("D:/out/单页.zip");
    readBytesMock.mockResolvedValue(new Uint8Array([1]));
    listAttachmentsMock.mockResolvedValue([
      { id: "a1", hash: "z9", mime: "application/pdf", name: "手册.pdf", size: 1, path: "" },
    ]);
    const msg = await exportPageBundleToZip({ id: "p1", title: "页", docJson: plainDoc() });
    const out = unzipBytes(writeMock.mock.calls[0][1] as number[]);
    expect(Object.keys(out)).toEqual(["页.md"]);
    expect(msg).toContain("0 个附件");
  });
});
