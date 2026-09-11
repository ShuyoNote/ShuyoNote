import { describe, expect, it } from "vitest";
import {
  MAX_PAGE_PIXELS,
  base64ToBytes,
  describeShape,
  parseNativePageResponse,
} from "./pdfNativePage";

/** 造一页 RGBA8：每个像素 (r,g,b,a) = (i, i+1, i+2, 255)。 */
function rgba(width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    out[i * 4] = i & 0xff;
    out[i * 4 + 1] = (i + 1) & 0xff;
    out[i * 4 + 2] = (i + 2) & 0xff;
    out[i * 4 + 3] = 255;
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** 旧协议：8 字节小端头 + RGBA8。 */
function withHeader(width: number, height: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + body.length);
  new DataView(out.buffer).setUint32(0, width, true);
  new DataView(out.buffer).setUint32(4, height, true);
  out.set(body, 8);
  return out;
}

describe("parseNativePageResponse — 现在的契约（{width,height,rgba_base64}）", () => {
  it("解出宽高和 RGBA 字节", () => {
    const body = rgba(3, 2);
    const page = parseNativePageResponse({ width: 3, height: 2, rgba_base64: bytesToBase64(body) });
    expect(page.width).toBe(3);
    expect(page.height).toBe(2);
    expect(page.bytes.length).toBe(24);
    expect(Array.from(page.bytes)).toEqual(Array.from(body));
  });

  it("字节数和 width×height×4 对不上就报错，并说出两个数", () => {
    const body = rgba(3, 2);
    expect(() => parseNativePageResponse({ width: 4, height: 2, rgba_base64: bytesToBase64(body) })).toThrow(
      /字节数对不上（4×2 应为 32 字节，实际 24 字节）/,
    );
  });

  it("宽高不是整数（NaN 就是以前那个崩溃的来源）就报错，绝不往下传", () => {
    const body = rgba(2, 2);
    expect(() => parseNativePageResponse({ width: NaN, height: 2, rgba_base64: bytesToBase64(body) })).toThrow(
      /宽高不是整数/,
    );
    expect(() => parseNativePageResponse({ width: undefined, height: 2, rgba_base64: bytesToBase64(body) })).toThrow(
      /宽高不是整数/,
    );
  });

  it("尺寸非正就报错", () => {
    expect(() => parseNativePageResponse({ width: 0, height: 2, rgba_base64: "" })).toThrow(/尺寸非法/);
  });

  it("超过像素上限就报错（防 NaN/Infinity 被夹成巨幅分配）", () => {
    const huge = MAX_PAGE_PIXELS + 1;
    expect(() => parseNativePageResponse({ width: huge, height: 1, rgba_base64: "" })).toThrow(/过大/);
  });
});

describe("parseNativePageResponse — 旧协议（8 字节头）", () => {
  it("ArrayBuffer 形态", () => {
    const body = rgba(2, 3);
    const buf = withHeader(2, 3, body);
    const page = parseNativePageResponse(buf.buffer);
    expect([page.width, page.height, page.bytes.length]).toEqual([2, 3, 24]);
    expect(Array.from(page.bytes)).toEqual(Array.from(body));
  });

  it("字节视图形态（带 byteOffset 的子视图也要读对）", () => {
    const buf = withHeader(2, 3, rgba(2, 3));
    const padded = new Uint8Array(buf.length + 4);
    padded.set(buf, 4);
    const page = parseNativePageResponse(padded.subarray(4));
    expect([page.width, page.height, page.bytes.length]).toEqual([2, 3, 24]);
  });

  it("数字数组形态：macOS 上 Tauri 的原始响应就是这样（前端的 instanceof ArrayBuffer 会为假）", () => {
    const page = parseNativePageResponse(Array.from(withHeader(2, 3, rgba(2, 3))));
    expect([page.width, page.height, page.bytes.length]).toEqual([2, 3, 24]);
  });

  it("base64 字符串形态", () => {
    const page = parseNativePageResponse(bytesToBase64(withHeader(2, 3, rgba(2, 3))));
    expect([page.width, page.height]).toEqual([2, 3]);
  });

  it("连 8 字节头都不够就报错", () => {
    expect(() => parseNativePageResponse(new Uint8Array([1, 2, 3]).buffer)).toThrow(/太短/);
  });

  it("头里的宽高与字节数对不上就报错", () => {
    const buf = withHeader(9, 9, rgba(2, 2));
    expect(() => parseNativePageResponse(buf.buffer)).toThrow(/字节数对不上/);
  });

  it("兼容旧后端的 { bytes, width, height }", () => {
    const page = parseNativePageResponse({ bytes: Array.from(rgba(2, 2)), width: 2, height: 2 });
    expect([page.width, page.height, page.bytes.length]).toEqual([2, 2, 16]);
  });
});

describe("parseNativePageResponse — 认不出来就说清楚看到了什么", () => {
  it("空值 / 数字 / 陌生对象", () => {
    expect(() => parseNativePageResponse(null)).toThrow(/无法识别的原生渲染响应（null）/);
    expect(() => parseNativePageResponse(undefined)).toThrow(/undefined/);
    expect(() => parseNativePageResponse(42)).toThrow(/number\(42\)/);
    expect(() => parseNativePageResponse({ foo: 1, bar: 2 })).toThrow(/对象\{foo, bar\}/);
    expect(() => parseNativePageResponse("@@@not-base64@@@")).toThrow(/base64/);
  });

  it("describeShape 只报类型和规模", () => {
    expect(describeShape(new Uint8Array(12))).toBe("Uint8Array(12 字节)");
    expect(describeShape(new ArrayBuffer(12))).toBe("ArrayBuffer(12 字节)");
    expect(describeShape([1, 2, 3])).toBe("数组(长度 3)");
    expect(describeShape("abcd")).toBe("字符串(长度 4)");
  });

  it("base64ToBytes 忽略换行/空白", () => {
    const b64 = bytesToBase64(rgba(1, 1));
    expect(base64ToBytes(`${b64.slice(0, 4)}\n${b64.slice(4)}`).length).toBe(4);
  });
});
