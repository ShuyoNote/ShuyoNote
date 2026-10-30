// Rust → 前端 **请求/应答桥**的前端那一半（B3，2026-10-29）。
//
// ## 它是什么
// 有三条能力的**唯一实现只可能在前端**（TS）：
//   · `export.markdown` / `export.docpackage`：Markdown 与 `.shuyodoc` 的渲染/打包
//     （`exportMarkdown*.ts` / `docPackWriter.ts`，界面菜单走的就是它们）；
//   · `coverage.report`：覆盖率报告要读**抽取器注册表**（`extract/registry.ts`，TS 侧事实源）。
// 外部 MCP 面要交付它们，就必须「Rust 叫前端算 → 前端把结果交回去」——⛔ Rust 侧重写一遍
// 就是两套实现，而两套实现漂移**不会报错**（本仓花最多代价消灭的形状）。
//
// ## 三条纪律
// 1. **只监听、不发明**：本模块把每一个请求**转给现有函数**，⛔ 不在这里重写渲染/覆盖率逻辑；
// 2. **失败要说清**：未知方法 / 平台没有派生层 / 导出超限 ⇒ 回一条**带前缀的人话**错误
//    （`bad_args:` / `needs_confirm:`），Rust 那侧原样透传给调用方；
// 3. **就绪才报就绪**：事件监听**装好之后**才调 `mcp_frontend_tool_ready` ——
//    否则 Rust 会以为"前端在"然后空等 5 秒（`frontend_timeout` 而不是 `frontend_unavailable`）。
//
// ## 位置
// 只在**主窗口**挂（`useMcpFrontendTools`）；独立页窗口（`?page=<id>`）不参与 ——
// 与外部草稿那条同一条口径（一个应用只做一次，避免多窗口各算一遍）。
import { api } from "./api";
import { isDesktopPlatform, platform } from "./platform";
import { docJsonOfPage } from "./docContent";
import { markdownDocumentForPage, pageContentToMarkdown, sanitizeName } from "./exportMarkdown";
import { bundleTooLargeMessage, collectWorkspaceBundlePages, prepareBundle } from "./exportMarkdownBundle";
import { buildPageDocPackageBytes } from "./docPackageTransfer";
import { coverageReportTool, scanLibraryCoverage } from "./libraryCoverage";
import type { CoverageStores } from "./extract/coverageReport";
import type { AttachmentMeta, PageDetail } from "../types";

/** 事件名（与 Rust `frontend_tool::BRIDGE_EVENT` 逐字一致）。 */
export const FRONTEND_TOOL_EVENT = "mcp:frontend-tool-request";
/** 导出类工具的**单次字节上限**（矩阵 §7：>10MB 需用户确认；本批没有确认 UI ⇒ 明确报错）。 */
export const MAX_BRIDGE_FILE_BYTES = 10 * 1024 * 1024;
/** 导出类工具的**文件数上限**（矩阵 §7：>20 文件需用户确认）。 */
export const MAX_BRIDGE_FILES = 20;
/** 覆盖率报告的名称（不是文件，但回执协议统一带 name）。 */
const REPORT_NAME = "覆盖率报告";

export interface FrontendToolRequest {
  requestId: string;
  method: string;
  args: Record<string, unknown>;
}

/** 前端算好的一件东西（`name` 建议文件名；覆盖率报告把 JSON 放在 `bytes` 里）。 */
export interface FrontendToolResult {
  name: string;
  bytes: Uint8Array;
}

/** 桥要用的依赖（可注入 ⇒ 判据能测；默认走真 `api` / `platform`）。 */
export interface FrontendToolDeps {
  getPage: (id: string, spaceId?: string) => Promise<PageDetail>;
  listPageAttachments: (id: string, spaceId?: string) => Promise<AttachmentMeta[]>;
  readAttachmentBytes: (hash: string, spaceId?: string) => Promise<ArrayBuffer | Uint8Array>;
  getActiveWorkspaceId: () => Promise<string>;
  derivedStores?: () => Promise<CoverageStores | undefined>;
}

export function defaultFrontendToolDeps(): FrontendToolDeps {
  return {
    getPage: (id, spaceId) => api.getPage(id, spaceId) as unknown as Promise<PageDetail>,
    listPageAttachments: (id, spaceId) => api.listPageAttachments(id, spaceId),
    readAttachmentBytes: (hash, spaceId) => api.readAttachmentBytes(hash, spaceId),
    getActiveWorkspaceId: () => api.getActiveWorkspaceId(),
    ...(platform.derivedStores
      ? {
          derivedStores: async (): Promise<CoverageStores | undefined> =>
            (await platform.derivedStores!()) as unknown as CoverageStores,
        }
      : {}),
  };
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * 矩阵 §7 的"需要用户确认"两档（本批**没有**确认 UI）⇒ 明确报错（⛔ 不静默导出）。
 * 返回 `null` 表示这两档都不触发。
 */
export function bridgeLimitError(fileCount: number, byteLength: number): string | null {
  if (byteLength > MAX_BRIDGE_FILE_BYTES) {
    return `needs_confirm: 导出 ${byteLength} 字节，超过 10MB 上限 —— 本批未接用户确认 UI，不能静默导出`;
  }
  if (fileCount > MAX_BRIDGE_FILES) {
    return `needs_confirm: 导出包含 ${fileCount} 个文件，超过 20 个上限 —— 本批未接用户确认 UI，不能静默导出`;
  }
  return null;
}

/** 一次工具请求 → 结果（`method` 白名单由 Rust 那侧先筛，这里仍按"不认识就报错"处理）。 */
export async function runFrontendTool(
  method: string,
  args: Record<string, unknown>,
  deps: FrontendToolDeps = defaultFrontendToolDeps(),
): Promise<FrontendToolResult> {
  switch (method) {
    case "export.markdown":
      return exportMarkdown(args, deps);
    case "export.docpackage":
      return exportDocPackage(args, deps);
    case "coverage.report":
      return coverageReport(deps);
    case "markdown.render":
      return renderMarkdownWithAnchors(args, deps);
    default:
      throw new Error(`bad_args: 不支持的前端工具 ${method}`);
  }
}

/** `export.markdown`：单页 ⇒ `.md`；整空间 ⇒ 含附件的 `.zip`（与界面两条导出同口径）。 */
async function exportMarkdown(
  args: Record<string, unknown>,
  deps: FrontendToolDeps,
): Promise<FrontendToolResult> {
  const pageId = String(args.pageId ?? "").trim();
  const spaceId = String(args.spaceId ?? "").trim();
  if (pageId) {
    const page = await deps.getPage(pageId, spaceId || undefined);
    if (!page) throw new Error(`not_found: 页面 ${pageId} 不存在或已读取失败`);
    if (page.kind === "folder") {
      throw new Error(`bad_args: 「${page.title || pageId}」是文件夹，没有正文可导出`);
    }
    const md = markdownDocumentForPage({
      id: page.id,
      title: page.title,
      docJson: docJsonOfPage(page),
      kind: page.kind,
    });
    const bytes = new TextEncoder().encode(md);
    const limit = bridgeLimitError(1, bytes.length);
    if (limit) throw new Error(limit);
    return { name: `${sanitizeName(String(page.title || pageId))}.md`, bytes };
  }
  if (!spaceId) throw new Error("bad_args: 需要 pageId 或 spaceId（单页导出 vs 整空间导出）");
  // 整空间导出：页面正文/附件都经**当前空间连接**读 ⇒ 跨空间暂不支持（如实拒，⛔ 不静默导错空间）
  const active = await deps.getActiveWorkspaceId();
  if (spaceId !== active) {
    throw new Error(
      "bad_args: 整空间导出目前只支持当前空间（跨空间读取没有命令面入口）—— 请在应用里切到那个空间再导出",
    );
  }
  // 与界面「导出本空间为 Markdown ＋ 附件」同一条收集/打包路径（含文件夹节点与全部附件）
  const { pages } = await collectWorkspaceBundlePages();
  const result = await prepareBundle(pages, { allAttachments: true });
  if (result.tooLarge) {
    throw new Error(
      bundleTooLargeMessage(result.tooLarge) ?? "bad_args: 导出体积超过上限（接口无法交付这么大的文件）",
    );
  }
  const fileCount = result.pages + result.assets;
  const limit = bridgeLimitError(fileCount, result.bytes.length);
  if (limit) throw new Error(limit);
  const spaceName = String(args.spaceName ?? "").trim() || "空间导出";
  return { name: `${sanitizeName(spaceName)}.zip`, bytes: result.bytes };
}

/** `export.docpackage`：单页 `.shuyodoc`（格式实现只有 `docPackWriter.ts` 那一份）。 */
async function exportDocPackage(
  args: Record<string, unknown>,
  deps: FrontendToolDeps,
): Promise<FrontendToolResult> {
  const pageId = String(args.pageId ?? "").trim();
  const spaceId = String(args.spaceId ?? "").trim();
  if (!pageId) throw new Error("bad_args: export.docpackage 需要 pageId");
  // 先读一次页面：文件夹没有正文（与单页 Markdown 同一条拒绝口径）
  const page = await deps.getPage(pageId, spaceId || undefined);
  if (!page) throw new Error(`not_found: 页面 ${pageId} 不存在或已读取失败`);
  if (page.kind === "folder") {
    throw new Error(`bad_args: 「${page.title || pageId}」是文件夹，没有正文可导出`);
  }
  const built = await buildPageDocPackageBytes(pageId, spaceId ? { ...deps, listPageAttachments: (id) => deps.listPageAttachments(id, spaceId), readAttachmentBytes: (h) => deps.readAttachmentBytes(h, spaceId) } : deps);
  const limit = bridgeLimitError(built.assetCount, built.bytes.length);
  if (limit) throw new Error(limit);
  return { name: `${sanitizeName(built.title)}.shuyodoc`, bytes: built.bytes };
}

/**
 * `coverage.report`：**直接回 JSON**（不写盘、不进句柄表）。
 *
 * ⚠️ 与界面「检查索引覆盖」、应用内 AI 面用的是**同一份函数**（`scanLibraryCoverage` →
 * `coverageReportTool`）⇒ 三处读数不会漂（判据逐字段比对）。
 */
async function coverageReport(deps: FrontendToolDeps): Promise<FrontendToolResult> {
  const getStores = deps.derivedStores;
  if (!getStores) {
    throw new Error("bad_args: 这个平台没有派生层存储，索引覆盖报告不可用（桌面版/已启用本地库才有）");
  }
  const stores = await getStores();
  if (!stores) throw new Error("bad_args: 这个平台没有派生层存储，索引覆盖报告不可用");
  const report = coverageReportTool(await scanLibraryCoverage(stores));
  return { name: REPORT_NAME, bytes: new TextEncoder().encode(JSON.stringify(report)) };
}

/**
 * 挂上桥：监听请求 → 调现有实现 → 回执；**监听成功后**才报"就绪"。
 *
 * 返回反注册函数（卸载时把监听一起摘掉；`ready` 标记是进程级的，不回收 —— 窗口重载会再报一次）。
 */
/** 渲染一页的当前 markdown（每个顶层块后带 `<!-- b:<blockId> -->` 锚点）。 */
async function renderMarkdownWithAnchors(
  args: Record<string, unknown>,
  deps: FrontendToolDeps,
): Promise<FrontendToolResult> {
  const pageId = String(args.pageId ?? "").trim();
  if (!pageId) throw new Error("bad_args: markdown.render 需要 pageId");
  const page = await deps.getPage(pageId);
  if (!page) throw new Error(`not_found: 页面 ${pageId} 不存在`);
  const doc = JSON.parse(docJsonOfPage(page)) as {
    root?: { children?: Array<Record<string, unknown>> };
  };
  const children = Array.isArray(doc?.root?.children) ? doc.root!.children! : [];
  const parts = children.map((c) => {
    const id = String((c as { blockId?: unknown }).blockId ?? "");
    const md = pageContentToMarkdown(JSON.stringify({ root: { type: "root", children: [c] } }));
    return id ? `${md}\n<!-- b:${id} -->` : md;
  });
  return {
    name: "markdown.json",
    bytes: new TextEncoder().encode(JSON.stringify({ markdown: parts.join("\n\n") })),
  };
}

export function registerMcpFrontendTools(): () => void {
  let unlisten: (() => void) | undefined;
  let alive = true;
  void platform.event
    .listen<FrontendToolRequest>(FRONTEND_TOOL_EVENT, (e) => {
      const req = e?.payload;
      const requestId = String(req?.requestId ?? "");
      if (!requestId) return;
      void (async () => {
        try {
          const result = await runFrontendTool(String(req?.method ?? ""), (req?.args ?? {}) as Record<string, unknown>);
          await api.mcpFrontendToolRespond({
            requestId,
            name: result.name,
            data: Array.from(result.bytes),
          });
        } catch (err) {
          // 失败也要**回执**（⛔ 不回执 ⇒ Rust 只能等满超时，且调用方看不到原因）
          try {
            await api.mcpFrontendToolRespond({
              requestId,
              name: "",
              data: [],
              error: messageOf(err),
            });
          } catch {
            /* 回执都发不出去 ⇒ Rust 侧会走超时；这里没法再做什么（不假装成功） */
          }
        }
      })();
    })
    .then((un) => {
      if (alive) unlisten = un;
      else un();
      // 只在**监听真的装上了**之后报就绪（否则 Rust 会以为前端在、然后空等 5 秒）。
      // ⚠️ 2026-10-30（CI 实测）：`mcp_frontend_tool_ready` 是**桌面专属**命令；Web 平台没有
      //   Rust 内核，调它会走 `[web] invoke error … 未实现该命令` 并在控制台留下**未捕获错误**，
      //   于是 `check-web-build` 的「没有未捕获错误」判红。⇒ 先判有没有 Rust 内核；
      //   Web 上**不报就绪正是想要的**（这条桥本来也不会被调用）。
      if (isDesktopPlatform()) {
        void api.mcpFrontendToolReady().catch(() => {
          /* 极简 Web 壳/冒烟形态：拿不到通道就不报就绪，不假装成功 */
        });
      }
    })
    .catch(() => {
      // 没有事件总线的形态（Node 冒烟 / 极简 Web 壳）⇒ 这条桥本来也不会来请求
    });
  return () => {
    alive = false;
    unlisten?.();
  };
}
