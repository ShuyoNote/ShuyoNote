// Shared print/export helpers used by both page (EditorToolbar) and database
// (DatabaseView) "导出为 PDF" — render an HTML document into a hidden iframe and
// trigger the system print dialog, where the user can choose "Save as PDF".
//
// ⚠️ 2026-09-17 修：**打印前必须等资源就绪**。原来这里是
// `doc.write(html) → print()` 一路同步，图片（尤其 `attachment://` 这种要过一趟异步协议
// 取字节再解码的）**还没画出来就打了快照** ⇒ 导出的 PDF 里图片是空白。
// 另外原来 `setTimeout(remove, 1200)` 也太早：WebView 里的打印对话框是异步的，
// 太早把 iframe 拿掉会把还没渲染完的内容一起带走。

/**
 * 等文档里的图片解码完成（含 `fonts.ready`），带超时兜底。
 *
 * 三条判据都不能少：
 * - 已 `complete` 的**直接放行**（包括加载失败的：`naturalWidth === 0` 时如果不放行，
 *   一个坏图会把整个导出卡到超时）；
 * - `load` / `error` 都算"结束"，否则永远不 resolve；
 * - 每个图各自带超时兜底 —— 网络慢时宁可导出得快一点，也不要卡死。
 *
 * 抽成独立导出的函数是为了**可测**：不依赖打印对话框就能验"它确实会等"。
 */
export function waitForPrintAssets(doc: Document, timeoutMs = 5000): Promise<void> {
  const imgs = [...doc.querySelectorAll("img")];
  const waits = imgs.map(
    (img) =>
      new Promise<void>((resolve) => {
        if (img.complete) return resolve();
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        img.addEventListener("load", finish, { once: true });
        img.addEventListener("error", finish, { once: true });
        setTimeout(finish, timeoutMs);
      }),
  );
  const fonts = (doc as Document & { fonts?: { ready?: Promise<unknown> } }).fonts;
  const fontWait = fonts?.ready
    ? Promise.race([fonts.ready, new Promise((r) => setTimeout(r, 1500))])
    : Promise.resolve();
  return Promise.all([...waits, fontWait]).then(() => undefined);
}

export interface PrintHTMLOptions {
  /** 每张图片最多等多久（毫秒）。 */
  timeoutMs?: number;
}

export async function printHTML(html: string, opts: PrintHTMLOptions = {}): Promise<void> {
  const iframe = document.createElement("iframe");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument;
  if (!doc) {
    iframe.remove();
    return;
  }
  doc.open();
  doc.write(html);
  doc.close();

  await waitForPrintAssets(doc, opts.timeoutMs ?? 5000);

  const win = iframe.contentWindow;
  win?.focus();
  win?.print();

  // 打印对话框关闭后（`afterprint`）再收走 iframe；同时留一个长兜底，
  // 免得某些 WebView 不派发 afterprint 时 iframe 永久留在 DOM 里。
  win?.addEventListener("afterprint", () => setTimeout(() => iframe.remove(), 1000), { once: true });
  setTimeout(() => iframe.remove(), 120_000);
}

export interface PrintOptions {
  title?: string;
  /** Extra CSS appended after the base styles. */
  extraCss?: string;
}

const BASE_CSS = `
  body { max-width: 720px; margin: 40px auto; padding: 0 24px; font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; line-height: 1.7; color: #1f2329; }
  h1 { font-size: 1.8em; margin: 0.6em 0 0.3em; }
  h2 { font-size: 1.4em; margin: 0.5em 0 0.25em; }
  h3 { font-size: 1.15em; margin: 0.4em 0 0.2em; }
  blockquote { border-left: 3px solid #d4d8df; padding-left: 12px; color: #646a73; margin: 0.5em 0; }
  code { background: #f2f3f5; border-radius: 4px; padding: 1px 4px; font-family: Consolas, monospace; font-size: 0.9em; }
  pre { background: #f7f8fa; border: 1px solid #e5e8ee; border-radius: 6px; padding: 12px; overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; margin: 0.5em 0; font-size: 13px; }
  th, td { border: 1px solid #e5e8ee; padding: 6px 10px; text-align: left; vertical-align: top; }
  th { background: #f7f8fa; font-weight: 600; }
  img { max-width: 100%; border-radius: 6px; }
  hr { border: none; border-top: 1px solid #e5e8ee; margin: 1em 0; }
  .db-count { color: #646a73; font-size: 13px; margin-bottom: 12px; }
  /* 网址书签卡：导出件是独立文档，拿不到应用 CSS，所以这里必须自带一套。
     样式与编辑器里的 .editor-webbookmark 保持同一观感（浅底卡片 + 缩略图在左）。 */
  .webbookmark-card { display: flex; gap: 12px; border: 1px solid #e5e8ee; border-radius: 8px; overflow: hidden; margin: 0.6em 0; background: #fbfcfe; }
  .webbookmark-thumb { flex: none; width: 140px; background: #f2f3f5; }
  .webbookmark-thumb img { display: block; width: 100%; height: 100%; object-fit: cover; border-radius: 0; }
  .webbookmark-body { padding: 10px 12px; min-width: 0; }
  .webbookmark-title { font-weight: 600; margin-bottom: 4px; }
  .webbookmark-title a { color: #1f2329; text-decoration: none; }
  .webbookmark-desc { color: #646a73; font-size: 13px; margin-bottom: 6px; }
  .webbookmark-site { color: #8a9099; font-size: 12px; word-break: break-all; }
`;

/** 导出文档的 `<title>` 来自页面标题（用户输入），必须转义——否则 `a<b` 会把文档写坏。 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Build a standalone HTML document from a body chunk. */
export function docHtml(body: string, opts: PrintOptions = {}): string {
  const title = escapeHtml(opts.title ?? "未命名");
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${title}</title>
<style>${BASE_CSS}${opts.extraCss ?? ""}</style>
</head>
<body>
${body}
</body>
</html>`;
}

/** Wrap a document body in a standalone HTML doc and trigger the print dialog. */
export async function printDoc(body: string, opts: PrintOptions = {}): Promise<void> {
  await printHTML(docHtml(body, opts));
}
