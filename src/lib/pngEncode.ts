// RGBA → PNG（纯 JS，无原生依赖）。
//
// ## 为什么需要它
// `deps.rasterize` 的产物要直接喂给 `deps.vision`，而视觉通道只接受**编码图**
// （`src/lib/ai/ocrVision.ts` 要的是 `data:image/...;base64,…`）。
// 契约裁定见方案 §15.8：`RasterizedPage` 直接产出编码图，而不是裸 RGBA。
//
// ## 为什么**不**放在 `platform/` 里
// 它是一次**纯数据格式变换**（和 `hash.ts` 同类），不碰任何平台 API ——
// 而它有两个消费者：① 平台适配器 `platform/extractDeps.ts`（把驱动的裸 RGBA 编码成图）；
// ② 抽取层的**共享假实现** `extract/testing/fakeDeps.ts`（`fakeRasterize` 也要产出**合法**编码图，
//    而且**必须用与生产同一份编码器**，否则"假实现"就与生产脱节了）。
// 若放在 `platform/` 下，抽取层的测试图里就会多出一条平台路径 ——
// 那正是 `isolated.test.ts` 那条隔离断言要防的形状。
//
// ## 为什么宁可在契约里定"编码图"，也不要"裸 RGBA + 再加一个 encode 能力"
// 裸 RGBA 要求**三台机器对字节序（RGBA/BGRA）、行 stride、是否预乘 alpha 达成一致** ——
// 这是一类**不会报错、只会悄悄画错**的约定，而且没有一处能把它测出来。
// PNG 没有这些自由度：要么解出一张对的图，要么解不开。
// 分家最怕的就是"三套都能跑但结果不一致"，所以这里选自由度更少的形状。
//
// ## 为什么用 fflate 而不是 canvas / image crate
// fflate 已是本仓依赖（`zlibSync` 现成），于是**Web 与桌面共用同一份编码器**，
// 不需要各写一套（那又会变成"两套编码质量"）。CRC32 PNG 没有现成的，本文件自带（12 行）。
//
// ⚠️ 固定 **8 位 RGBA（colorType 6）**：光栅化的产物本来就是 RGBA8，无损直存。

import { zlibSync } from "fflate";

const PNG_SIG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 标准 CRC-32（PNG 用的那个多项式）。 */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function be32(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

/** 组装一个 PNG chunk：长度 + 类型 + 数据 + CRC(类型+数据)。 */
function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new Uint8Array([...type].map((c) => c.charCodeAt(0)));
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);
  const out = new Uint8Array(4 + body.length + 4);
  out.set(be32(data.length), 0);
  out.set(body, 4);
  out.set(be32(crc32(body)), 4 + body.length);
  return out;
}

/**
 * 把紧凑 RGBA8 编码成 PNG。
 *
 * `rgba` 必须是 `width * height * 4` 字节（R,G,B,A 顺序、**非预乘**）—— 与平台渲染驱动
 * `PdfRenderedPage.bytes` 的约定一致（桌面 `pdfium_native::render_page` 就是紧凑 RGBA）。
 */
export function rgbaToPng(rgba: Uint8Array, width: number, height: number): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`rgbaToPng: 宽高必须是正整数（拿到 ${width}×${height}）`);
  }
  const expected = width * height * 4;
  if (rgba.length !== expected) {
    throw new Error(`rgbaToPng: 字节数应为 ${expected}（${width}×${height}×4），实得 ${rgba.length}`);
  }

  // 每个扫描行前面加一个 filter 字节（0 = None）。不做 filter 选择：
  // 我们的场景是"渲染出来立刻编码、立刻送模型"，省下的那点体积不值得引入启发式。
  const raw = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const dst = y * (1 + width * 4);
    raw[dst] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), dst + 1);
  }

  const ihdr = new Uint8Array(13);
  ihdr.set(be32(width), 0);
  ihdr.set(be32(height), 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: truecolour with alpha
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace: none

  const parts = [PNG_SIG, chunk("IHDR", ihdr), chunk("IDAT", zlibSync(raw, { level: 6 })), chunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** PNG 的魔数判断（便宜的"这是不是图"检查，vision 之前可以用）。 */
export function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIG[i]) return false;
  return true;
}
