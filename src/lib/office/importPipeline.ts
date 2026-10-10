// **「导入为笔记」的编排层**（Office 导入第一期 · 2026-10-09）。
//
// 一条链，四步，每步都**可测**（依赖从外面注入 ⇒ 判据可以用假对象跑，不需要真 Tauri 宿主 ✓）：
//   ① `docxToNoteBlocks`   解析（纯函数，见 `src/lib/extract/ooxml.ts` ✓）
//   ② `deps.saveImage`     图片逐张落成附件（**内容寻址** ⇒ 同一张图重复引用只存一份 ✓）
//   ③ `blocksToMarkdown`   块 ⇒ Markdown（图片地址在这一步才填 ✓）
//   ④ `deps.createPage`    走**现有**的 md → Lexical → 建页那条路 ✓（⛔ 不另写一套块落库 ✗）
//
// ⛔ 失败一律**可读**（返回 `{ ok:false, code, message }`），**绝不**静默建一个空页 ✗。
// ⚠️ 图片没存进去 ⇒ 正文里有一行说明 ＋ 报告里计数（⛔ 不静默丢 ✗）。

import { docxToNoteBlocks, type DocxImage, type NoteBlockCounts } from "../extract/ooxml";
import { markdownToPageContent } from "../mdPreview";
import { blocksToMarkdown } from "./docxMarkdown";
import { CATEGORIES, type CategoryReading } from "./retention";

/** 转换结果的量纲上限：超过就**如实拒收**（半个页面比没有更糟 ✓ —— 与 R167 同口径）。 */
export const OFFICE_IMPORT_MAX_MARKDOWN_CHARS = 1024 * 1024;

/** 落库载荷：类型取自**现有**的 md 管线（本文件不出现那两个存储列名 ✓ 门禁 `check-doc-content-access`）。 */
export type OfficePagePayload = NonNullable<ReturnType<typeof markdownToPageContent>>;

export interface OfficeImportDeps {
  /** 把一张图存进附件库，返回它的 hash（内容寻址）；失败 ⇒ 抛错（本层如实记账 ✓）。 */
  saveImage?: (image: DocxImage) => Promise<string>;
  /** 建页；返回新页 id（`null` ＝ 没建成 ✓）。 */
  createPage: (args: {
    parentId: string | null;
    title: string;
    payload: OfficePagePayload;
  }) => Promise<string | null>;
}

export interface OfficeImportReport {
  title: string;
  source: NoteBlockCounts;
  converted: NoteBlockCounts;
  categories: CategoryReading[];
  markdownChars: number;
  ms: { convert: number; markdown: number; saveImages: number; total: number };
  images: { referenced: number; saved: number; failed: number };
  warnings: string[];
}

export type OfficeImportOutcome =
  | { ok: true; pageId: string | null; report: OfficeImportReport }
  | { ok: false; code: string; message: string; warnings: string[] };

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 文件名 ⇒ 页标题（去掉扩展名；空 ⇒ 给个兜底 ✓）。 */
export function officeTitleOf(filename: string): string {
  const base = filename.replace(/^.*[\\/]/, "").replace(/\.(docx|docm)$/i, "").trim();
  return base || "Office 导入";
}

/**
 * 一份 docx 字节 ⇒ 一个新笔记页。
 * `parentId` 为 `null` 时建在顶层（挂到哪个页面由调用方决定 ✓）。
 */
export async function importOfficeBytes(
  bytes: Uint8Array,
  filename: string,
  parentId: string | null,
  deps: OfficeImportDeps,
): Promise<OfficeImportOutcome> {
  const t0 = Date.now();
  const warnings: string[] = [];

  const tConvert = Date.now();
  const parsed = docxToNoteBlocks(bytes);
  const convertMs = Date.now() - tConvert;
  if (!parsed.ok) {
    // ⭐ 如实失败：把转换器给的那句人话**原样**带出去（含 code ✓）
    return { ok: false, code: parsed.code, message: parsed.message, warnings: [] };
  }
  warnings.push(...parsed.warnings);

  // ② 图片逐张落库（同一张图重复引用只处理一次 —— `parsed.images` 已按 media 去重 ✓）
  const tSave = Date.now();
  const hashByImage = new Map<DocxImage, string>();
  let imagesFailed = 0;
  for (const image of parsed.images) {
    if (!deps.saveImage) {
      imagesFailed += 1;
      continue;
    }
    try {
      hashByImage.set(image, await deps.saveImage(image));
    } catch (e) {
      imagesFailed += 1;
      warnings.push(`图片「${image.name}」没能存进附件库：${messageOf(e)}`);
    }
  }
  const saveMs = Date.now() - tSave;
  if (!deps.saveImage && parsed.images.length > 0) {
    warnings.push(
      `${parsed.images.length} 张图片没有落库（这次调用没给图片落库通道）⇒ 正文里每张只留一行说明`,
    );
  }

  // ③ 块 ⇒ Markdown（图片地址在这一步填 ✓）
  const tMd = Date.now();
  const rendered = blocksToMarkdown(parsed.blocks, {
    resolveImage: (image) => {
      const hash = hashByImage.get(image);
      return hash ? `attachment://${hash}` : null;
    },
  });
  const markdownMs = Date.now() - tMd;
  warnings.push(...rendered.warnings);

  if (rendered.markdown.trim().length === 0) {
    return {
      ok: false,
      code: "markdown_empty",
      message: "转换出来的正文是空的 ⇒ 不建页（⛔ 不生成空笔记）",
      warnings,
    };
  }
  if (rendered.markdown.length > OFFICE_IMPORT_MAX_MARKDOWN_CHARS) {
    return {
      ok: false,
      code: "too_large",
      message: `转换结果 ${Math.round(rendered.markdown.length / 1024)} KB 超过上限 ${Math.round(
        OFFICE_IMPORT_MAX_MARKDOWN_CHARS / 1024,
      )} KB ⇒ 请先拆分文档（半页比没有更糟 ✓）`,
      warnings,
    };
  }

  // ④ 走现有 md → Lexical → 建页那条路
  const payload = markdownToPageContent(rendered.markdown);
  if (!payload) {
    return {
      ok: false,
      code: "render_failed",
      message: "Markdown → 笔记块失败（内容为空或解析不了）⇒ 未建页",
      warnings,
    };
  }
  const title = officeTitleOf(filename);
  const pageId = await deps.createPage({ parentId, title, payload });
  if (!pageId) {
    return { ok: false, code: "create_page_failed", message: "建页失败（落库那一步返回了空）⇒ 未建页", warnings };
  }

  const categories: CategoryReading[] = CATEGORIES.map(({ key, label }) => {
    const source = parsed.source[key];
    const converted = parsed.converted[key];
    return { key, label, source, converted, retention: source === 0 ? null : converted / source };
  });

  return {
    ok: true,
    pageId,
    report: {
      title,
      source: parsed.source,
      converted: parsed.converted,
      categories,
      markdownChars: rendered.markdown.length,
      ms: { convert: convertMs, markdown: markdownMs, saveImages: saveMs, total: Date.now() - t0 },
      images: {
        referenced: parsed.converted.images,
        saved: rendered.imagesRendered,
        failed: imagesFailed,
      },
      warnings: [...new Set(warnings)],
    },
  };
}

/** 报告 ⇒ 一段人看的文字（面板与判据共用，⛔ 不写两份措辞 ✗）。 */
export function renderImportReport(report: OfficeImportReport): string {
  const parts: string[] = [];
  parts.push(
    `「${report.title}」已导入：` +
      report.categories
        .filter((c) => c.source > 0)
        .map((c) => `${c.label} ${c.converted}/${c.source}`)
        .join("，"),
  );
  parts.push(`耗时：转换 ${report.ms.convert} ms，图片 ${report.ms.saveImages} ms，共 ${report.ms.total} ms`);
  if (report.images.referenced > 0 && report.images.saved < report.images.referenced) {
    parts.push(`⚠️ 图片 ${report.images.referenced} 处引用，落进正文 ${report.images.saved} 张`);
  }
  for (const w of report.warnings) parts.push(`⚠️ ${w}`);
  return parts.join("\n");
}
