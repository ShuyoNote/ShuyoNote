// AI 工具层现在只是「注册表元数据 + 前端适配表」的组合；这里钉住它没在重构中走形。
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api", () => ({
  api: {
    search: vi.fn(),
    getPage: vi.fn(),
    getPageBlocks: vi.fn(),
    getBacklinks: vi.fn(),
    listPageAttachments: vi.fn(),
    searchChunks: vi.fn(),
    readAttachmentText: vi.fn(),
    createPage: vi.fn(),
    // ⭐ B1a（2026-10-29）：5 条只读扩容工具的依赖（应用内 AI 面这一侧）
    listPages: vi.fn(),
    listWorkspacePages: vi.fn(),
    getActiveWorkspaceId: vi.fn(),
    listWorkspaces: vi.fn(),
    listTags: vi.fn(),
    listAttrDefs: vi.fn(),
    // ⭐ B1b（2026-10-29）：数据库读两条的依赖（应用内 AI 面这一侧）
    getDbColumns: vi.fn(),
    listDbViews: vi.fn(),
    queryDatabase: vi.fn(),
    // ⭐ B1c（2026-10-29）：版本/回收站/附件元数据（应用内 AI 面这一侧）
    listVersions: vi.fn(),
    listDeleted: vi.fn(),
    getAttachment: vi.fn(),
  },
}));

import { api } from "../api";
import { aiTools, aiToolSummaries, getAiTool } from "./tools";

const CTX = { currentPageId: "p1", pages: [] };

const EXPECTED = [
  "backlinks.list",
  "blocks.append",
  "blocks.list",
  "coverage.report",
  "files.list",
  "files.read",
  "files.search",
  "pages.create",
  "pages.get",
  "pages.importMarkdown",
  // 2026-10-17：`pages.list` 进 AI/MCP 面（搜索之外的发现通路）
  "pages.list",
  "pages.search",
  // 2026-10-17：这三条在注册表里早就是 ai:true（M2 的写面 + 空间切换），
  // 但这份清单没跟上 ⇒ 测试一直红着（与检索改动无关，顺手对齐现状 ✓）。
  "pages.update",
  "spaces.list",
  // ⚠️ 2026-10-18：`spaces.switch` **已从 AI 面移除**（注册表里 `ai:false`）——
  //    依据是面板「外部 AI 接入」的档位文案：「只读（全部空间）…**也不会改动你正在看的那个空间**」。
  //    ⇒ 与 `check-agent-surface` 的「`ai:true` 只许 `current-space`」同一条口径：
  //      看见有哪些空间可以（`spaces.list` 是显式例外），**替人切换不行** ✓。
  // ⭐ B1a（2026-10-29）：只读扩容 5 条进 AI/MCP 面（注册表 `ai:true`；MCP 清单由同一份注册表生成）
  "page.current",
  "pages.count",
  "pages.tree",
  "properties.list",
  "tags.list",
  // ⭐ B1b（2026-10-29）：数据库只读两条进 AI/MCP 面（注册表 `ai:true`，MCP 清单同源生成）
  "db.schema",
  "db.rows",
  // ⭐ B1c（2026-10-29）：版本/回收站/附件元数据 + 导出/下载句柄（8 条；句柄两条在应用内面如实报不可用）
  "versions.list",
  "version.get",
  "trash.list",
  "files.stat",
  "files.extract_status",
  "files.list_orphan",
  "files.download",
  "blobs.fetch",
  // ⭐ B3（2026-10-29）：前端桥三条（导出走句柄；覆盖率报告直接回 JSON）
  "export.markdown",
  "export.docpackage",
  // ⭐ B2-结构（2026-10-29）：节点/文件夹/回收站/回退/标签/属性写（全部草稿确认）
  "folders.create",
  "nodes.move",
  "nodes.rename",
  "nodes.delete",
  "trash.restore",
  "pages.revert",
  "tags.add",
  "tags.remove",
  "properties.set",
  "properties.unset",
  // ⭐ B2-块（2026-10-29）
  "blocks.patch",
  "blocks.insert",
  "blocks.delete",
  // ⭐ B2-附件与模板（2026-10-29）
  "files.move",
  "files.rename",
  "files.delete",
  "templates.apply",
];

describe("AI 工具层 = 能力注册表（元数据）+ 前端适配表（实现）", () => {
  beforeEach(() => vi.resetAllMocks());

  it("工具清单与注册表一致：id 齐全、读写标记正确、描述非空", () => {
    expect(aiTools.map((t) => t.id).sort()).toEqual([...EXPECTED].sort());
    const byId = Object.fromEntries(aiTools.map((t) => [t.id, t]));
    expect(byId["pages.create"].isWrite).toBe(true);
    expect(byId["blocks.append"].isWrite).toBe(true);
    expect(byId["pages.search"].isWrite).toBe(false);
    // 系统提示就是靠这些描述让模型选工具的
    const summaries = aiToolSummaries();
    for (const id of EXPECTED) expect(summaries).toContain(id);
  });

  it("读取类：参数按注册表命名映射到既有 api，返回形状保持不变", async () => {
    vi.mocked(api.search).mockResolvedValue([{ id: "p1", title: "T", snippet: "S" }] as never);

    const r = (await getAiTool("pages.search")!.run({ q: "关键词", limit: 3 }, CTX)) as Record<string, any>;

    expect(api.search).toHaveBeenCalledWith("关键词", 3, false);
    expect(r.ok).toBe(true);
    expect(r.pages[0]).toEqual({ id: "p1", title: "T", snippet: "S" });
  });

  it("files.search：块级命中**原样透出**（pageId/attId/loc 是回链三件套，这一层不加工）", async () => {
    vi.mocked(api.searchChunks).mockResolvedValue([
      { chunkId: "att:a1#0", pageId: null, attId: "a1", ord: 0, loc: "p.3", snippet: "…本周进展…", score: 2.5 },
    ] as never);

    const r = (await getAiTool("files.search")!.run({ query: "进展" }, CTX)) as Record<string, any>;

    expect(api.searchChunks).toHaveBeenCalledWith("进展", 10);
    expect(r.ok).toBe(true);
    expect(r.hits[0].loc).toBe("p.3");
    expect(r.hits[0].attId).toBe("a1");
  });

  it("files.search：空查询 ⇒ 明确报错且不触碰 api（绝不允许「返回全库」）", async () => {
    const r = (await getAiTool("files.search")!.run({ query: "   " }, CTX)) as Record<string, any>;

    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("files.search");
    expect(api.searchChunks).not.toHaveBeenCalled();
  });

  it("files.read：派生文本原样透出 + **必须回报 total/truncated**（AI 才知道自己只看到一部分）", async () => {
    vi.mocked(api.readAttachmentText).mockResolvedValue({
      segments: [{ extractor: "pdf.text@1", kind: "text", text: "第一段", loc: "p.1" }],
      total: 7,
      truncated: true,
    } as never);

    const r = (await getAiTool("files.read")!.run({ id: "a1" }, CTX)) as Record<string, any>;

    expect(api.readAttachmentText).toHaveBeenCalledWith("a1", 0, 200);
    expect(r.ok).toBe(true);
    expect(r.file.segments[0].loc).toBe("p.1");
    expect(r.file.segments[0].extractor).toBe("pdf.text@1");
    expect(r.file.total).toBe(7);
    expect(r.file.truncated).toBe(true);
  });

  it("files.read：**「还没抽过」与「不存在」分开回话**（否则 AI 会把没索引读成「文件里没有」）", async () => {
    // 还没抽过：空段 + total 0 + note
    vi.mocked(api.readAttachmentText).mockResolvedValue({ segments: [], total: 0, truncated: false } as never);
    const empty = (await getAiTool("files.read")!.run({ id: "a1" }, CTX)) as Record<string, any>;
    expect(empty.ok).toBe(true);
    expect(empty.file.segments).toEqual([]);
    expect(String(empty.file.note)).toContain("不要");

    // 不存在：file: null
    vi.mocked(api.readAttachmentText).mockResolvedValue(null as never);
    const missing = (await getAiTool("files.read")!.run({ id: "nope" }, CTX)) as Record<string, any>;
    expect(missing.ok).toBe(true);
    expect(missing.file).toBeNull();

    // 空 id：明确报错且不触碰 api
    vi.mocked(api.readAttachmentText).mockClear();
    const bad = (await getAiTool("files.read")!.run({}, CTX)) as Record<string, any>;
    expect(bad.ok).toBe(false);
    expect(api.readAttachmentText).not.toHaveBeenCalled();
  });

  it("写入类：只产出草稿，绝不直接落库", async () => {
    const r = (await getAiTool("pages.create")!.run({ title: "周报", content: "正文" }, CTX)) as Record<string, any>;

    expect(r.draft).toBe(true);
    expect(r.summary).toContain("周报");
    expect(r.payload.kind).toBe("create_page");
    expect(api.createPage).not.toHaveBeenCalled();
  });

  it("缺必填参数时明确报错，且不触碰 api", async () => {
    const r = (await getAiTool("pages.search")!.run({}, CTX)) as Record<string, any>;

    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("pages.search");
    expect(api.search).not.toHaveBeenCalled();
  });

  // ⭐ B1a（2026-10-29）：5 条只读扩容工具在**应用内 AI 面**的这一侧（MCP 侧在 Rust 判据里）
  it("B1a·page.current：没有当前页 ⇒ 如实 opened:false（⛔ 不编一页、不碰 api）", async () => {
    const r = (await getAiTool("page.current")!.run({}, { currentPageId: null, pages: [] })) as Record<string, any>;
    expect(r.ok).toBe(true);
    expect(r.opened).toBe(false);
    expect(r.page).toBeUndefined();
    expect(api.getPage).not.toHaveBeenCalled();
  });

  it("B1a·pages.count / pages.tree：与 listPages 同一集合（count==length、父子与 kind 一致）", async () => {
    vi.mocked(api.listPages).mockResolvedValue([
      { id: "f1", title: "资料", kind: "folder", parent_id: null, sort_order: 0 },
      { id: "p1", title: "第一页", kind: "page", parent_id: "f1", sort_order: 1 },
    ] as never);
    const count = (await getAiTool("pages.count")!.run({}, CTX)) as Record<string, any>;
    expect(count).toEqual({ ok: true, count: 2 });

    const tree = (await getAiTool("pages.tree")!.run({}, CTX)) as Record<string, any>;
    expect(tree.ok).toBe(true);
    expect(tree.nodes.map((n: any) => n.id)).toEqual(["f1", "p1"]);
    expect(tree.nodes[0].kind).toBe("folder");
    expect(tree.nodes[1].parentId).toBe("f1");
    expect(tree.total).toBe(2);
    expect(tree.truncated).toBe(false);
  });

  it("B1a·tags.list / properties.list：字段与注册表一致（type 来自 attr_type）", async () => {
    vi.mocked(api.listTags).mockResolvedValue([{ id: "t1", name: "待办", page_count: 3 }] as never);
    vi.mocked(api.listAttrDefs).mockResolvedValue([
      { id: "a1", name: "状态", attr_type: "select", options: [] },
    ] as never);

    const tags = (await getAiTool("tags.list")!.run({}, CTX)) as Record<string, any>;
    expect(tags.tags[0]).toEqual({ id: "t1", name: "待办", page_count: 3 });

    const props = (await getAiTool("properties.list")!.run({}, CTX)) as Record<string, any>;
    expect(props.properties[0]).toEqual({ id: "a1", name: "状态", type: "select" });
  });

  // ⭐ B1b（2026-10-29）：数据库只读两条在**应用内 AI 面**这一侧（MCP 侧的权威实现在 Rust）
  const DB_COLUMNS = [
    { id: "a1", name: "状态", attr_type: "select", options: [] },
    { id: "a2", name: "分数", attr_type: "number", options: [] },
    { id: "a5", name: "公式", attr_type: "formula", options: [] },
    { id: "a6", name: "关联", attr_type: "ref", options: [] },
  ];
  const DB_ROWS = [
    { page_id: "r1", title: "甲", values: { a1: "进行中", a2: "10", a5: "a1+a2", a6: "p:r2" } },
    { page_id: "r2", title: "乙", values: { a1: "完成", a2: "20" } },
    { page_id: "r3", title: "丙", values: { a1: "进行中", a2: "30" } },
  ];
  const mockDb = () => {
    vi.mocked(api.listPages).mockResolvedValue([
      { id: "db1", title: "任务库", kind: "database", parent_id: null, sort_order: 0 },
    ] as never);
    vi.mocked(api.getDbColumns).mockResolvedValue(DB_COLUMNS as never);
    vi.mocked(api.listDbViews).mockResolvedValue([
      { id: "v1", db_page_id: "db1", name: "表格", view_type: "table", config: "{}", sort_order: 0, created_at: 1 },
    ] as never);
    vi.mocked(api.queryDatabase).mockResolvedValue({ columns: DB_COLUMNS, rows: DB_ROWS } as never);
  };

  it("B1b·db.schema：列/视图与 UI 同源；公式列只标 isFormula（⛔ 不计算）", async () => {
    mockDb();
    const r = (await getAiTool("db.schema")!.run({ pageId: "db1" }, CTX)) as Record<string, any>;
    expect(r.ok).toBe(true);
    expect(r.views).toEqual([{ id: "v1", name: "表格", type: "table" }]);
    expect(r.columns.map((c: any) => c.id)).toEqual(["a1", "a2", "a5", "a6"]);
    expect(r.columns[2].isFormula).toBe(true);
    expect(r.columns[2].value).toBeUndefined();
    expect(r.relations).toEqual([{ id: "a6", name: "关联", type: "ref" }]);
  });

  it("B1b·db.rows：只给原始值（公式列不算）＋ where/分页在宿主侧生效", async () => {
    mockDb();
    const all = (await getAiTool("db.rows")!.run({ pageId: "db1" }, CTX)) as Record<string, any>;
    expect(all.ok).toBe(true);
    expect(all.total).toBe(3);
    expect(all.rows[0].values.a5).toBe("a1+a2");
    expect(String(all.note)).toContain("原始值");

    // 单条件（列名）＋ AND（列 id，数值列按数值比）
    const one = (await getAiTool("db.rows")!.run(
      { pageId: "db1", where: [{ field: "a1", op: "=", value: "进行中" }, { field: "a2", op: ">", value: 15 }] },
      CTX,
    )) as Record<string, any>;
    expect(one.total).toBe(1);
    expect(one.rows[0].id).toBe("r3");

    // 分页：limit/offset 在宿主侧切片，total 不变
    const page = (await getAiTool("db.rows")!.run({ pageId: "db1", limit: 2, offset: 1 }, CTX)) as Record<string, any>;
    expect(page.total).toBe(3);
    expect(page.rows.map((r: any) => r.id)).toEqual(["r2", "r3"]);
    expect(page.truncated).toBe(false);
  });

  it("B1b·db.rows：坏 where 逐条 invalid_args 并点名（⛔ 不许静默返回空）", async () => {
    mockDb();
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ pageId: "db1", where: [{ field: "不存在的列", op: "=", value: 1 }] }, "不存在的列"],
      [{ pageId: "db1", where: [{ field: "a1", op: "like", value: "x" }] }, "like"],
      [{ pageId: "db1", where: [{ field: "a1", op: "in", value: "进行中" }] }, "数组"],
    ];
    for (const [args, needle] of cases) {
      const r = (await getAiTool("db.rows")!.run(args, CTX)) as Record<string, any>;
      expect(r.ok).toBe(false);
      expect(String(r.error)).toContain("invalid_args");
      expect(String(r.error)).toContain(needle);
      expect(String(r.error)).toContain("where[0]");
    }
  });

  // ⭐ B1c（2026-10-29）：版本 / 回收站 / 附件元数据（应用内面这一侧）
  it("B1c·versions.list / version.get：清单倒序、正文窗口与 pages.get 同口径；查不到 ⇒ not_found", async () => {
    vi.mocked(api.listVersions).mockResolvedValue([
      { id: "v2", page_id: "p1", title: "第二版", content_text: "乙".repeat(30), created_at: 200 },
      { id: "v1", page_id: "p1", title: "第一版", content_text: "甲".repeat(30), created_at: 100 },
    ] as never);
    const list = (await getAiTool("versions.list")!.run({ pageId: "p1", limit: 10 }, CTX)) as Record<string, any>;
    expect(list.versions.map((v: any) => v.versionId)).toEqual(["v2", "v1"]);
    expect(list.versions[0].at).toBe(200);

    const one = (await getAiTool("version.get")!.run({ pageId: "p1", versionId: "v1", offset: 0, limit: 5 }, CTX)) as Record<string, any>;
    expect(one.ok).toBe(true);
    expect(one.version.content_text).toHaveLength(5);
    expect(one.version.chars_total).toBe(30);
    expect(one.version.title).toBe("第一版");
    expect(String(one.version.note)).toContain("锚点");

    const missing = (await getAiTool("version.get")!.run({ pageId: "p1", versionId: "nope" }, CTX)) as Record<string, any>;
    expect(missing.ok).toBe(false);
    expect(String(missing.error)).toContain("not_found");
  });

  it("B1c·trash.list / files.stat / files.extract_status / files.list_orphan：形状与字段", async () => {
    vi.mocked(api.listDeleted).mockResolvedValue([
      { id: "p9", title: "删掉的页", deleted_at: 123 } as never,
    ] as never);
    vi.mocked(api.getAttachment).mockResolvedValue({
      id: "a1",
      name: "扫描件.pdf",
      hash: "sha-abc",
      mime: "application/pdf",
      size: 42,
      path: "",
    } as never);
    vi.mocked(api.readAttachmentText).mockResolvedValue({
      segments: [{ extractor: "pdf.text@1", kind: "text", text: "甲", loc: "p.1" }],
      total: 3,
      truncated: true,
      coverage: [{ extractor: "pdf.text@1", coverage: '{"complete":false}' }],
    } as never);
    vi.mocked(api.listPageAttachments).mockResolvedValue([
      { id: "a1", name: "扫描件.pdf", hash: "h1", mime: "application/pdf", size: 42, path: "", created_at: 7 },
      { id: "a2", name: "孤儿.zip", hash: "h2", mime: "application/zip", size: 8, path: "", created_at: 6 },
    ] as never);

    const trash = (await getAiTool("trash.list")!.run({ limit: 10 }, CTX)) as Record<string, any>;
    expect(trash.pages[0]).toEqual({ pageId: "p9", title: "删掉的页", deletedAt: 123 });

    const stat = (await getAiTool("files.stat")!.run({ attId: "a1" }, CTX)) as Record<string, any>;
    expect(stat.file.sha256).toBe("sha-abc");
    expect(stat.file.mime).toBe("application/pdf");

    const ex = (await getAiTool("files.extract_status")!.run({ attId: "a1" }, CTX)) as Record<string, any>;
    expect(ex.status.extracted).toBe(true);
    expect(ex.status.segments).toBe(3);
    expect(ex.status.extractors).toEqual([{ extractor: "pdf.text@1", coverage: '{"complete":false}' }]);

    const orphan = (await getAiTool("files.list_orphan")!.run({ limit: 1, offset: 1 }, CTX)) as Record<string, any>;
    expect(orphan.total).toBe(2);
    expect(orphan.files.map((f: any) => f.attId)).toEqual(["a2"]);
    expect(orphan.files[0].sha256).toBe("h2");
  });

  it("B1c·files.download / blobs.fetch：应用内面没有句柄通道 ⇒ 如实说（⛔ 不发明前端句柄）", async () => {
    const dl = (await getAiTool("files.download")!.run({ attId: "a1" }, CTX)) as Record<string, any>;
    expect(dl.ok).toBe(false);
    expect(String(dl.error)).toContain("句柄");
    const fetch = (await getAiTool("blobs.fetch")!.run({ handle: "abc" }, CTX)) as Record<string, any>;
    expect(fetch.ok).toBe(false);
    expect(String(fetch.error)).toContain("句柄");
  });
});

describe("省略 pageId 时用宿主的当前页（与插件侧同一语义）", () => {
  beforeEach(() => vi.resetAllMocks());

  it("backlinks.list 不传 pageId → 用 ctx.currentPageId", async () => {
    vi.mocked(api.getBacklinks).mockResolvedValue([{ id: "p2", title: "来源" }] as never);

    const r = (await getAiTool("backlinks.list")!.run({}, { currentPageId: "p9", pages: [] })) as Record<string, any>;

    expect(api.getBacklinks).toHaveBeenCalledWith("p9");
    expect(r.backlinks[0]).toEqual({ id: "p2", title: "来源" });
  });
});
