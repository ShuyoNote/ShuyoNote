// Shared print/export helpers used by both page (EditorToolbar) and database
// (DatabaseView) "导出为 PDF" — render an HTML document into a hidden iframe and
// trigger the system print dialog, where the user can choose "Save as PDF".

export function printHTML(html: string) {
  const iframe = document.createElement("iframe");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument;
  if (!doc) return;
  doc.open();
  doc.write(html);
  doc.close();
  iframe.contentWindow?.focus();
  iframe.contentWindow?.print();
  setTimeout(() => iframe.remove(), 1200);
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
`;

/** Build a standalone HTML document from a body chunk. */
export function docHtml(body: string, opts: PrintOptions = {}): string {
  const title = opts.title ?? "未命名";
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
export function printDoc(body: string, opts: PrintOptions = {}) {
  printHTML(docHtml(body, opts));
}
