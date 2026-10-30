// B3（2026-10-29）**前端桥**的判据：桥这一半（Rust 那半在 `frontend_tool.rs` 的单元判据里）。
//
// 这里钉四件事：
//   ① `export.markdown`：单页 ⇒ 与界面「导出为 Markdown」**逐字节相同**的 Markdown（标题头注释 ＋ 正文）；
//   ② `export.docpackage`：算出的字节能被本仓 `openDocumentPackage` **读回**（往返）；
//   ③ `coverage.report`：桥的输出与**应用内 AI 面适配器**（同一份函数）**逐字段一致**；
//   ④ 失败面：目标给错/文件夹/超限 ⇒ 明确错误（⛔ 不静默、不空成功）。
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./api", () => ({
  api: {
    listPages: vi.fn(),
    listPageAttachments: vi.fn(),
    listStaleTextPages: vi.fn(),
    getPage: vi.fn(),
    readAttachmentBytes: vi.fn(),
    getActiveWorkspaceId: vi.fn(),
    mcpFrontendToolReady: vi.fn(),
    mcpFrontendToolRespond: vi.fn(),
  },
}));

// 桥模块 import 了 `platform`（事件总线/派生层）；判据不需要真平台。
// ⚠️ `isDesktopPlatform()` 必须 mock：桥只在**有 Rust 内核**时上报就绪
//    （Web 上调 `mcp_frontend_tool_ready` 会留下未捕获错误，CI 的 `check-web-build` 因此判红）。
vi.mock("./platform", () => ({
  isDesktopPlatform: vi.fn(() => true),
  platform: { event: { listen: vi.fn(async () => () => {}) }, derivedStores: undefined },
}));

import { api } from "./api";
import { isDesktopPlatform } from "./platform";
import { FRONTEND_ADAPTERS } from "./capabilities/frontend";
import { unzipDocument } from "./docZip";
import { openDocumentPackage } from "./docPackageOpen";
import {
  MAX_BRIDGE_FILE_BYTES,
  MAX_BRIDGE_FILES,
  bridgeLimitError,
  registerMcpFrontendTools,
  runFrontendTool,
  type FrontendToolDeps,
} from "./mcpFrontendTools";
import type { CoverageStores } from "./extract/coverageReport";

const DOC = JSON.stringify({
  root: {
    type: "root",
    children: [
      {
        type: "paragraph",
        children: [{ type: "text", text: "正文甲" }],
      },
    ],
  },
});

const PAGE = {
  id: "p1",
  title: "标题",
  kind: "page",
  content_json: DOC,
  content_text: "正文甲",
  created_at: 1,
  updated_at: 2,
};

function deps(over: Partial<FrontendToolDeps> = {}): FrontendToolDeps {
  return {
    getPage: async () => PAGE as never,
    listPageAttachments: async () => [],
    readAttachmentBytes: async () => new Uint8Array(),
    getActiveWorkspaceId: async () => "s1",
    ...over,
  };
}

const dec = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("B3 前端桥 · export.markdown", () => {
  beforeEach(() => vi.clearAllMocks());

  it("单页 ⇒ 与界面导出同一份 Markdown（标题头注释 ＋ 正文）", async () => {
    const r = await runFrontendTool("export.markdown", { pageId: "p1" }, deps());
    expect(r.name).toBe("标题.md");
    const md = dec(r.bytes);
    expect(md.startsWith("<!-- title: 标题 · id: p1 -->\n")).toBe(true);
    expect(md).toContain("正文甲");
  });

  it("目标口径：两个都给 / 文件夹 / 别的空间 ⇒ 明确 bad_args（⛔ 不猜）", async () => {
    await expect(
      runFrontendTool("export.markdown", { pageId: "p1", spaceId: "s1" }, deps()),
    ).rejects.toThrow(/bad_args/);
    await expect(
      runFrontendTool(
        "export.markdown",
        { pageId: "p1" },
        deps({ getPage: async () => ({ ...PAGE, kind: "folder" }) as never }),
      ),
    ).rejects.toThrow(/bad_args/);
    await expect(
      runFrontendTool("export.markdown", { spaceId: "s2" }, deps()),
    ).rejects.toThrow(/bad_args/);
  });

  it("整空间（当前空间）⇒ 含附件的 zip（复用界面那条收集/打包路径）", async () => {
    (api.listPages as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "p1", title: "标题", kind: "page", parent_id: null, sort_order: 0 },
    ]);
    (api.getPage as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(PAGE);
    (api.listPageAttachments as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const r = await runFrontendTool(
      "export.markdown",
      { spaceId: "s1", spaceName: "空间甲" },
      deps(),
    );
    expect(r.name).toBe("空间甲.zip");
    expect(r.bytes.byteLength).toBeGreaterThan(0);
  });
});

describe("B3 前端桥 · export.docpackage（句柄字节可被 openDocumentPackage 读回）", () => {
  beforeEach(() => vi.clearAllMocks());

  it("往返：桥算出的 .shuyodoc ⇒ 解 zip ⇒ openDocumentPackage 接受", async () => {
    const r = await runFrontendTool("export.docpackage", { pageId: "p1" }, deps());
    expect(r.name).toBe("标题.shuyodoc");
    const entries = await unzipDocument(r.bytes);
    const opened = await openDocumentPackage(entries);
    expect(opened.ok, `包读不回来：${JSON.stringify(opened)}`).toBe(true);
  });

  it("页不存在 / 文件夹 ⇒ not_found / bad_args", async () => {
    await expect(
      runFrontendTool("export.docpackage", { pageId: "nope" }, deps({ getPage: async () => null as never })),
    ).rejects.toThrow(/not_found/);
    await expect(
      runFrontendTool(
        "export.docpackage",
        { pageId: "p1" },
        deps({ getPage: async () => ({ ...PAGE, kind: "folder" }) as never }),
      ),
    ).rejects.toThrow(/bad_args/);
  });
});

describe("B3 前端桥 · coverage.report（与前端适配器逐字段一致）", () => {
  beforeEach(() => vi.clearAllMocks());

  function fakeStores(): CoverageStores {
    return {
      text: {
        segmentsOf: async () => [],
        coverageOf: async () => [],
        // `stats()` 是**按抽取器一行**（`{extractor, rows, chars}`）—— 报告里的 derived 三格靠它
        stats: async () => [],
      },
      chunks: {
        chunksOf: async () => [],
        stats: async () => ({ chunks: 0 }),
      },
    } as unknown as CoverageStores;
  }

  it("桥输出 = 应用内 AI 面适配器的输出（同一函数据同一夹具）", async () => {
    (api.listPages as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "p1", title: "标题", kind: "page", parent_id: null, sort_order: 0 },
    ]);
    (api.listPageAttachments as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "a1", name: "扫描件.pdf", mime: "application/pdf", hash: "h", size: 1 },
    ]);
    (api.listStaleTextPages as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      total: 0,
      pages: [],
    });
    const stores = fakeStores();
    const viaBridge = await runFrontendTool("coverage.report", {}, deps({ derivedStores: async () => stores }));
    const bridgeJson = JSON.parse(dec(viaBridge.bytes));
    const viaAdapter = await FRONTEND_ADAPTERS["coverage.report"]({}, { derivedStores: async () => stores });
    expect(bridgeJson).toEqual(viaAdapter);
  });

  it("没有派生层存储 ⇒ 明确 bad_args（⛔ 不假装有报告）", async () => {
    await expect(
      runFrontendTool("coverage.report", {}, deps({ derivedStores: undefined })),
    ).rejects.toThrow(/bad_args/);
  });
});

describe("B3 前端桥 · 失败面与就绪信号", () => {
  it("矩阵 §7 两档超限 ⇒ needs_confirm（本批没有确认 UI）", () => {
    expect(bridgeLimitError(1, MAX_BRIDGE_FILE_BYTES + 1)).toMatch(/^needs_confirm: .*10MB/);
    expect(bridgeLimitError(MAX_BRIDGE_FILES + 1, 1)).toMatch(/^needs_confirm: .*20 个/);
    expect(bridgeLimitError(1, 1)).toBeNull();
  });

  it("未知方法 ⇒ bad_args（白名单之外不执行）", async () => {
    await expect(runFrontendTool("fs.read", {}, deps())).rejects.toThrow(/bad_args/);
  });

  it("监听**装好之后**才报就绪（否则 Rust 会空等 5 秒）", async () => {
    registerMcpFrontendTools();
    await vi.waitFor(() => {
      expect(api.mcpFrontendToolReady).toHaveBeenCalled();
    });
  });

  it("Web（没有 Rust 内核）⇒ **不报就绪**（否则控制台留未捕获错误 ⇒ check-web-build 判红）", async () => {
    vi.clearAllMocks();
    vi.mocked(isDesktopPlatform).mockReturnValue(false);
    const unregister = registerMcpFrontendTools();
    await new Promise((r) => setTimeout(r, 30));
    expect(api.mcpFrontendToolReady).not.toHaveBeenCalled();
    unregister();
    vi.mocked(isDesktopPlatform).mockReturnValue(true);
  });
});
