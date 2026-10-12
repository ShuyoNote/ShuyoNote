// **给导出的 PDF 盖页码**（task-30 的 TS 那半步）。
//
// ## 为什么需要这一步（真因，量过 ✓）
// 页面导出走的原是 `src/lib/print.ts:51-78`：隐藏 iframe ＋ **`win?.print()`** ⇒ 系统打印对话框里
// 那些**页头页脚（日期／标题／URL／页码）是打印引擎自己加的** ✗ —— `print.ts` 里
// `@page|displayHeaderFooter|headerTemplate|footerTemplate|页眉|页脚` **零命中** ✓，
// 也就是说**我们编不了它**（那个开关是整体的：关掉 ⇒ 页码一起没 ✓）。
// ⇒ Windows 上改走「引擎出 PDF 时**关掉**页头页脚 ＋ **我们自己盖页码**」：Rust 那半步出 PDF（⛔ 不在本文件），
//    **本文件负责后半**：拿到 PDF 字节 ⇒ 每页底部盖一个页码 ⇒ 交回字节 ✓。
//
// ## 只有这一个纯函数（⭐ 判据因此不依赖 Rust 那半步 ✓）
// `stampPageNumbers(pdf: Uint8Array) => Promise<Uint8Array>`：**进字节、出字节** ✓，不起宿主、不碰 DOM ✓。
//
// ## ⚠️ 一条**如实**的取舍：默认用 ASCII 页码（`1 / 3`），**不是**「第 N 页 / 共 M 页」
// 中文要**嵌 CJK 字体** ⇒ pdf-lib 需要 `@pdf-lib/fontkit`（⭐ 实测**未安装** ✗）＋ 一份 CJK 字体
// （仓里有 `src-tauri/assets/fonts/NotoSansSC-Regular.ttf` ✓ 0.07 MB ✓，但那条路径是 Rust 侧的 ✗）。
// ⇒ 所以默认格式写成 ASCII ✓（⛔ 不为了一个格式去引依赖 ✗）；要中文，先批"加 `@pdf-lib/fontkit` ＋ 把字体
//    搬进前端能引的位置"这两件 ✓ —— 见 `report` 里那一栏"没量到的"。
//
// ## 懒加载（照 `pdfAnnotExport.ts:5-6` 的房规）
// 本模块**静态**引 `pdf-lib` ✓ ⇒ 调用方请用 `await import("./pdfPageNumbers")`（别进主 chunk ✓）。

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

/** 页码那点样式（都有默认值 ⇒ 调用方通常不用给 ✓）。 */
export interface PageNumberOptions {
  /** 每页画什么。默认 `${页} / ${总页}`（ASCII ⇒ ⛔ 不用嵌字体 ✓）。 */
  format?: (page: number, total: number) => string;
  /** 距页面**底边**多少 pt（默认 18 ⇒ 在打印页边距里 ✓）。 */
  marginBottom?: number;
  /** 字号（pt，默认 9 ✓）。 */
  size?: number;
}

/** 默认格式：`1 / 3`（⭐ ASCII ⇒ 零字体依赖 ✓）。 */
export function defaultPageNumberText(page: number, total: number): string {
  return `${page} / ${total}`;
}

/**
 * ⭐ **纯函数**：把 `pdf` 每页底部盖上页码，返回**新的**字节（⛔ 不改入参 ✓）。
 *
 * · 页数**不变** ✓（只在已有页上画字 ✓，⛔ 不加页不减页 ✗）
 * · 页序**不变** ✓（按 `getPages()` 的顺序 ✓）
 * · ⚠️ 加密 PDF：**不**加 `ignoreEncryption` ⇒ 解不开就抛 ✓（⛔ 不静默产出一个坏件 ✗）
 */
export async function stampPageNumbers(
  pdf: Uint8Array,
  opts: PageNumberOptions = {},
): Promise<Uint8Array> {
  const format = opts.format ?? defaultPageNumberText;
  const marginBottom = opts.marginBottom ?? 18;
  const size = opts.size ?? 9;

  const doc = await PDFDocument.load(pdf);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  const total = pages.length;

  pages.forEach((page, i) => {
    const text = format(i + 1, total);
    const { width } = page.getSize();
    const w = font.widthOfTextAtSize(text, size);
    page.drawText(text, {
      x: Math.max(0, (width - w) / 2), // 居中（页太窄时别画到左边外面 ✓）
      y: marginBottom,
      size,
      font,
      color: rgb(0.35, 0.35, 0.35),
    });
  });

  // ⚠️ 与 `pdfAnnotExport.ts:234` 同一个写法（`Uint8Array<ArrayBuffer>` ✓）
  return (await doc.save()) as Uint8Array<ArrayBuffer>;
}

/**
 * ⭐ **判据用的启发式**：抽出来的文本里有没有"**打印引擎加的页头页脚**"的味道。
 *
 * 认三样（就是引擎默认那三样 ✓）：**URL** ／ **日期** ／ **我们自己设的 `<title>`**（`print.ts:130` ✓）。
 * ⚠️ ⭐ 它是**启发式，不是证明** ✗：正文里本来就可能出现 URL 或日期 ⇒
 *    **判据必须喂一份"正文里不含 URL／日期"的测试页** ✓，否则会**假红** ✓。
 * ⚠️ ⭐ 它**认不出**我们自己的页码（`1 / 3` 不匹配任何一条 ✓）⇒ 反过来说：
 *    它**红了**就说明引擎那三样回来了 ⇒ 这正是"把 `ShouldPrintHeaderAndFooter=false` 改回 true 就会红"的判据 ✓。
 */
export function looksLikeEngineHeaderFooter(text: string, opts: { title?: string } = {}): boolean {
  // ⚠️ ⭐ 两条正则**故意不带 `\b`**：`pdfjs` 抽出来的文本是**拼起来**的（没有空格 ⇒
  //    `2026-10-10https://example.com/…` 会连成一串 ✗），而 `\b` 在"前一个字符也是词字符"时**不成立** ⇒
  //    ✅ 带 `\b` 的版本**认不出**夹在中间的 URL ⇒ 判据 2 会变成"永远绿"的假判据 ✗。
  //    （这个坑是**正向对照那条**当场抓出来的 ✓ —— 见测试文件第 3 条 ✓）
  if (/https?:\/\/\S+/i.test(text)) return true; // 引擎页脚默认带 URL ✓
  if (/\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/.test(text)) return true; // 引擎页眉默认带日期 ✓
  const title = (opts.title ?? "").trim();
  if (title.length > 0 && text.includes(title)) return true; // 引擎页眉默认带标题 ✓
  return false;
}
