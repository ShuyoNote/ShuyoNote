// 原生（MuPDF）页面渲染结果的解析 + 校验。
//
// 为什么单独抽出来：这一步以前是"想当然"的——前端写死 `buf instanceof ArrayBuffer`，
// 然后从 8 字节头里读宽高。但 Tauri 的原始响应**不是所有平台都给 ArrayBuffer**：
// 在 macOS / iOS 上 `InvokeResponseBody::Raw` 走的是 `format_result(Ok(Vec<u8>))`，
// 也就是把字节 JSON 编码成**数字数组**（`[12,240,…]`）。于是：
//   instanceof 为假 → 落到兜底分支 → `width` 是 `undefined`
//   → `canvas.width`/`createImageData(undefined, undefined)` 收到 NaN
//   → WKWebView 抛 `Value NaN is outside the range [-2147483648, 2147483647]`
//     （Chrome/WebView2 不抛，只是静默画出 0×0 —— 也就是用户看到的"一片空白"）。
//
// 教训：**渲染之前先把形状校验掉**，任何非有限/对不上的数值都变成一句说得清的错误，
// 而不是一路 NaN 冲到画布 API 上。这个模块就是那道闸门。

/** 一页光栅化结果：RGBA8（长度 = width × height × 4）+ 显式宽高。 */
export interface NativePage {
  bytes: Uint8Array;
  width: number;
  height: number;
}

/**
 * 单页像素上限（40MP ≈ 8000×5000）。
 *
 * 不是性能偏好，是防御：缩放倍率或页面尺寸一旦算错（NaN/Infinity 被夹到极大值），
 * `createImageData` 会尝试分配几百 MB~几 GB 的内存，直接把 WebView 打崩。
 * 超限时报错，让人看到原因。
 */
export const MAX_PAGE_PIXELS = 40_000_000;

/** 旧协议：8 字节小端头 [width u32][height u32] + RGBA8。 */
const HEADER_BYTES = 8;

function isByteView(v: unknown): v is ArrayBufferView {
  return typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(v as ArrayBufferView);
}

/** 把字节视图拷成独立的 Uint8Array（不共享原 buffer，避免被后续复用改掉）。 */
function copyView(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
}

/** base64 → 字节。解不开时抛出说得清的错误。 */
export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/\s+/g, "");
  try {
    const bin = atob(clean);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch (e) {
    throw new Error(`原生渲染结果不是有效的 base64（${e instanceof Error ? e.message : String(e)}）`);
  }
}

/** 给"形状不认识"准备的错误上下文：只说类型和规模，不 dump 内容。 */
export function describeShape(raw: unknown): string {
  if (raw === null) return "null";
  if (raw === undefined) return "undefined";
  if (typeof raw === "string") return `字符串(长度 ${raw.length})`;
  if (typeof raw === "number" || typeof raw === "boolean") return `${typeof raw}(${String(raw)})`;
  if (typeof ArrayBuffer !== "undefined" && raw instanceof ArrayBuffer) return `ArrayBuffer(${raw.byteLength} 字节)`;
  if (isByteView(raw)) return `${raw.constructor?.name ?? "字节视图"}(${raw.byteLength} 字节)`;
  if (Array.isArray(raw)) return `数组(长度 ${raw.length})`;
  if (typeof raw === "object") {
    const keys = Object.keys(raw as object).slice(0, 6);
    return `对象{${keys.join(", ")}}`;
  }
  return typeof raw;
}

/** 宽高 + 字节数的唯一校验收口：所有形状都要过这一关。 */
function validatePage(width: unknown, height: unknown, byteLength: number): { width: number; height: number } {
  if (typeof width !== "number" || typeof height !== "number" || !Number.isInteger(width) || !Number.isInteger(height)) {
    throw new Error(`原生渲染结果的宽高不是整数（width=${String(width)}, height=${String(height)}）`);
  }
  if (width <= 0 || height <= 0) {
    throw new Error(`原生渲染结果尺寸非法（${width}×${height}）`);
  }
  if (width * height > MAX_PAGE_PIXELS) {
    throw new Error(`原生渲染结果过大（${width}×${height}，超过 ${MAX_PAGE_PIXELS} 像素上限）`);
  }
  const want = width * height * 4;
  if (byteLength !== want) {
    throw new Error(`原生渲染结果字节数对不上（${width}×${height} 应为 ${want} 字节，实际 ${byteLength} 字节）`);
  }
  return { width, height };
}

/** 旧协议（带 8 字节头）的解析：ArrayBuffer / 字节视图 / 数字数组都走这里。 */
function parseHeaderBytes(buf: Uint8Array): NativePage {
  if (buf.byteLength < HEADER_BYTES) {
    throw new Error(`原生渲染结果太短（${buf.byteLength} 字节，连 8 字节头都不够）`);
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const width = view.getUint32(0, true);
  const height = view.getUint32(4, true);
  const bytes = buf.subarray(HEADER_BYTES);
  validatePage(width, height, bytes.byteLength);
  return { bytes, width, height };
}

/**
 * 解析 `render_pdf_page` 的返回值。
 *
 * 支持三种形状，都是真实平台上会出现的：
 *  1. `{ width, height, rgba_base64 }` —— 现在的契约（所有平台一致，见 commands.rs 的注释）；
 *  2. `ArrayBuffer` / `Uint8Array` —— Windows/Linux 上原始响应的形态，或旧版后端；
 *  3. 数字数组 —— macOS 上原始响应被 JSON 编码后的形态（旧版后端）。
 * 认不出来的形状直接报错并说明看到了什么，绝不返回半成品。
 */
export function parseNativePageResponse(raw: unknown): NativePage {
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw) && !isByteView(raw) && !(raw instanceof ArrayBuffer)) {
    const o = raw as { width?: unknown; height?: unknown; rgba_base64?: unknown; bytes?: unknown };
    if (typeof o.rgba_base64 === "string") {
      const bytes = base64ToBytes(o.rgba_base64);
      const { width, height } = validatePage(o.width, o.height, bytes.byteLength);
      return { bytes, width, height };
    }
    // 兼容旧后端：{ bytes: number[], width, height }（无头部）。
    if (Array.isArray(o.bytes)) {
      const bytes = Uint8Array.from(o.bytes as number[]);
      const { width, height } = validatePage(o.width, o.height, bytes.byteLength);
      return { bytes, width, height };
    }
    throw new Error(`无法识别的原生渲染响应（${describeShape(raw)}）——前后端版本可能不一致，请重启应用`);
  }
  if (typeof ArrayBuffer !== "undefined" && raw instanceof ArrayBuffer) return parseHeaderBytes(new Uint8Array(raw));
  if (isByteView(raw)) return parseHeaderBytes(copyView(raw));
  if (Array.isArray(raw)) {
    const bytes = Uint8Array.from(raw as number[]);
    return parseHeaderBytes(bytes);
  }
  if (typeof raw === "string") return parseHeaderBytes(base64ToBytes(raw));
  throw new Error(`无法识别的原生渲染响应（${describeShape(raw)}）——前后端版本可能不一致，请重启应用`);
}
