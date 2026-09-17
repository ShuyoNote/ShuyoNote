// 导出（HTML / PDF）时把**应用内才认的媒体 URL** 内联成 `data:` URL。
//
// ## 为什么要这一层
//
// 编辑器里图片能显示，靠的是渲染期的 `MediaResolver`：有 `hash` 就去 `blobStore`
// （Web）/ 磁盘（桌面）取字节、造一个 **blob: URL**（`MediaResolver.tsx:29-43`）。
// 而 Lexical 的 `$generateHtmlFromNodes` 只走节点的 `exportDOM`，那里写的是
// **插入时存下的 `src`** —— 桌面是 `attachment://localhost/…`（`tauri.ts:38`），
// Web 是裸文件路径（`web.ts:3647`）。这两者在导出件里都不是有效 URL：
//   · 另存的 `.html` 用普通浏览器打开 ⇒ 协议没人认 / 路径不存在 ⇒ **图片全空**；
//   · 打印成 PDF 时更要紧——那是一次性快照，URL 取不到就是空白。
//
// ⇒ 所以导出的正确做法不是"把 src 抄一遍"，而是**把字节读出来内联**。
//
// ## 为什么是"生成 HTML 之后再替换"，而不是在 exportDOM 里直接内联
//
// `exportDOM` 是**同步**的（Lexical 的接口约束），而读字节是**异步**的
// （`api.readAttachmentBytes` 要过 Rust / IndexedDB）。所以节点只负责**留下线索**
// （`data-export-hash`），由本模块统一在生成 HTML 之后异步替换 —— 这样
// 「导出 HTML」与「打印 PDF」两条路共用同一份逻辑，不会再各写一遍。
import { api } from "./api";

/** 节点在 `exportDOM` 里留下的"这份媒体是内容寻址的附件"线索。 */
export const EXPORT_HASH_ATTR = "data-export-hash";
export const EXPORT_MIME_ATTR = "data-export-mime";

/** 超过这个大小的附件不内联（避免导出一个几十 MB 的 HTML）。 */
export const MAX_INLINE_BYTES = 8 * 1024 * 1024;

/** 一次内联的结果，给调用方如实回报（不静默吞掉失败）。 */
export interface InlineReport {
  /** 成功内联成 data: URL 的个数。 */
  inlined: number;
  /** 读不到字节（未同步到本机 / 已删除）而保持原样的个数。 */
  missing: number;
  /** 体积超过上限而故意没内联的个数。 */
  tooLarge: number;
}

/**
 * `Uint8Array` → base64（纯函数，不依赖 DOM/btoa，便于单测与 happy-dom）。
 *
 * 分块处理：`String.fromCharCode(...bytes)` 在大图上会**爆参数个数**（V8 上限约 65535），
 * 几十 KB 的图就能触发 `RangeError`——这是内联功能最容易被忽略的坑。
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  // eslint-disable-next-line no-undef
  return btoa(binary);
}

/** 读一份附件的字节；失败返回 null（调用方决定是留原样还是报错）。 */
export type ReadAttachmentBytes = (hash: string) => Promise<ArrayBuffer | null>;

const defaultReader: ReadAttachmentBytes = async (hash) => {
  try {
    const buf = await api.readAttachmentBytes(hash);
    if (!buf || buf.byteLength === 0) return null;
    return buf;
  } catch {
    return null;
  }
};

/**
 * 把 HTML 里所有带 `data-export-hash` 的媒体替换成内联的 `data:` URL。
 *
 * **不**触碰外链图片（`http(s):` 的 `src` 本来就是可移植的），也**不**主动去服务器
 * 下载缺失的字节 —— 导出是"打包你现在有的东西"，顺手触发下载会让用户莫名其妙地
 * 等、甚至弹出提示。读不到就如实计入 `missing`，由调用方决定要不要提示。
 */
export async function inlineExportMedia(
  html: string,
  opts: { read?: ReadAttachmentBytes; maxBytes?: number } = {},
): Promise<{ html: string; report: InlineReport }> {
  const read = opts.read ?? defaultReader;
  const maxBytes = opts.maxBytes ?? MAX_INLINE_BYTES;
  const report: InlineReport = { inlined: 0, missing: 0, tooLarge: 0 };

  const doc = new DOMParser().parseFromString(html, "text/html");
  const nodes = [...doc.querySelectorAll(`[${EXPORT_HASH_ATTR}]`)];

  for (const el of nodes) {
    const hash = el.getAttribute(EXPORT_HASH_ATTR) ?? "";
    el.removeAttribute(EXPORT_HASH_ATTR);
    const mime = el.getAttribute(EXPORT_MIME_ATTR) ?? "application/octet-stream";
    el.removeAttribute(EXPORT_MIME_ATTR);
    if (!hash) continue;

    const buf = await read(hash);
    if (!buf) {
      report.missing++;
      continue;
    }
    if (buf.byteLength > maxBytes) {
      report.tooLarge++;
      continue;
    }
    const dataUrl = `data:${mime};base64,${bytesToBase64(new Uint8Array(buf))}`;
    el.setAttribute("src", dataUrl);
    // `srcset` 优先于 `src`，留着就等于白内联（img）；video 上无意义，一并清掉更省心。
    el.removeAttribute("srcset");
    report.inlined++;
  }

  return { html: doc.body.innerHTML, report };
}
