// PNG 编码器的判据。
//
// ⚠️ 这里刻意**不用 PNG 解码库**做验证（本仓没有，也不想为一条测试引一个）：
// 而是**按 PNG 规范自己把 IDAT 解出来**（`unzlibSync` + 逐 chunk 走），
// 再逐字节比对像素。这不是"自证"—— 因为解的是**规范定义的容器格式**，
// 只要我解对了，说明写出来的确实是标准 PNG；再配上结构检查（签名 / chunk CRC / IHDR），
// 就足以证明"能被别人的解码器读"。
//
// 真正端到端的验证在 Mac 侧（他们有浏览器）：`createImageBitmap`/`<img>` 一加载就知道。
// 我这边先保证**规范层面是对的**，并把这条边界写清楚，免得后面有人以为这里验过浏览器。

import { unzlibSync } from "fflate";
import { describe, expect, it } from "vitest";

import { isPng, rgbaToPng } from "./pngEncode";

/** 极简 PNG 解析：只取 IHDR 与 IDAT 的原始（已 inflate）扫描行，够验证用。 */
function parsePng(png: Uint8Array): {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  /** 逐行：去掉每行开头的 filter 字节后的像素数据。 */
  rows: Uint8Array[];
  crcOk: boolean;
} {
  expect(isPng(png)).toBe(true);
  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Uint8Array[] = [];
  let crcOk = true;

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (b: Uint8Array) => {
    let c = 0xffffffff;
    for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };

  while (off < png.length) {
    const len = (png[off] << 24) | (png[off + 1] << 16) | (png[off + 2] << 8) | png[off + 3];
    const type = String.fromCharCode(png[off + 4], png[off + 5], png[off + 6], png[off + 7]);
    const data = png.subarray(off + 8, off + 8 + len);
    const want = (png[off + 8 + len] << 24) | (png[off + 9 + len] << 16) | (png[off + 10 + len] << 8) | png[off + 11 + len];
    if (crc32(png.subarray(off + 4, off + 8 + len)) !== (want >>> 0)) crcOk = false;
    if (type === "IHDR") {
      width = (data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3];
      height = (data[4] << 24) | (data[5] << 16) | (data[6] << 8) | data[7];
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    off += 12 + len;
  }

  const merged = new Uint8Array(idat.reduce((n, d) => n + d.length, 0));
  let p = 0;
  for (const d of idat) {
    merged.set(d, p);
    p += d.length;
  }
  const raw = unzlibSync(merged);
  const stride = 1 + width * 4;
  const rows: Uint8Array[] = [];
  for (let y = 0; y < height; y++) {
    expect(raw[y * stride]).toBe(0); // filter = None（我们固定不选 filter）
    rows.push(raw.subarray(y * stride + 1, (y + 1) * stride));
  }
  return { width, height, bitDepth, colorType, rows, crcOk };
}

describe("rgbaToPng", () => {
  it("编出来的是一张**规范层面正确**的 PNG（签名 / chunk CRC / IHDR 都对）", () => {
    const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 9, 9, 9, 128]);
    const png = rgbaToPng(rgba, 2, 2);
    const p = parsePng(png);
    expect(p.crcOk).toBe(true);
    expect([p.width, p.height, p.bitDepth, p.colorType]).toEqual([2, 2, 8, 6]); // 8 位 RGBA
  });

  it("**像素逐字节往返一致**（含 alpha，证明没有偷偷预乘或换通道序）", () => {
    const rgba = new Uint8Array([
      255, 0, 0, 255,   0, 255, 0, 255,   0, 0, 255, 255,
      9, 9, 9, 128,     1, 2, 3, 0,       200, 100, 50, 200,
    ]);
    const p = parsePng(rgbaToPng(rgba, 3, 2));
    const flat = new Uint8Array(p.rows.reduce((n, r) => n + r.length, 0));
    let off = 0;
    for (const r of p.rows) {
      flat.set(r, off);
      off += r.length;
    }
    expect(Array.from(flat)).toEqual(Array.from(rgba));
  });

  it("确定性：同输入同输出（缓存与去重都依赖它）", () => {
    const rgba = new Uint8Array(4 * 4).fill(7);
    expect(Array.from(rgbaToPng(rgba, 2, 2))).toEqual(Array.from(rgbaToPng(rgba, 2, 2)));
  });

  it("**参数不合法时抛错**，而不是悄悄编一张尺寸错的图", () => {
    expect(() => rgbaToPng(new Uint8Array(16), 0, 2)).toThrow(/正整数/);
    expect(() => rgbaToPng(new Uint8Array(16), 2, 2.5)).toThrow(/正整数/);
    expect(() => rgbaToPng(new Uint8Array(8), 2, 2)).toThrow(/字节数/); // 少了一半
  });

  it("isPng 认得出真 PNG、也拒得了冒牌", () => {
    expect(isPng(rgbaToPng(new Uint8Array(4), 1, 1))).toBe(true);
    expect(isPng(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(false); // 太短
    expect(isPng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBe(false);
  });
});
