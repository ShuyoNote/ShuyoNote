// 导出内联的判据（2026-09-17）。
//
// 这一组测试针对的是那个真实现象：**导出 HTML/PDF 时图片与网址书签卡是空的**。
// 根因是导出路径只抄了节点里的 `src`（桌面是 `attachment://…` 应用专有协议、Web 是裸路径），
// 而编辑期能显示靠的是渲染时另外解析（`MediaResolver` → blob URL）。
// 所以判据不能是"导出 HTML 里有个 <img>"（那一直是有的），而必须是
// **"src 已经是自包含的 data: URL"** —— 否则把文件挪出应用就还是空的。
import { describe, expect, it } from "vitest";
import {
  bytesToBase64,
  EXPORT_HASH_ATTR,
  EXPORT_MIME_ATTR,
  inlineExportMedia,
  MAX_INLINE_BYTES,
} from "./exportInline";

const PNG_1PX = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("bytesToBase64", () => {
  it("按标准 base64 编码", () => {
    expect(bytesToBase64(PNG_1PX)).toBe("iVBORw0KGgo=");
  });

  it("大输入不炸（分块拼接：一次性展开几十万参数会 RangeError）", () => {
    const big = new Uint8Array(300_000).fill(0x41);
    expect(() => bytesToBase64(big)).not.toThrow();
    expect(bytesToBase64(big).length).toBe(Math.ceil(300_000 / 3) * 4);
  });
});

describe("inlineExportMedia —— 把应用专有 URL 换成自包含的 data: URL", () => {
  const reader = (bytes: Uint8Array) => async () => bytes.buffer.slice(0) as ArrayBuffer;

  it("带线索的图片会被内联，并抹掉线索属性", async () => {
    const html = `<p><img src="attachment://localhost/C%3A/x.png" ${EXPORT_HASH_ATTR}="h1" ${EXPORT_MIME_ATTR}="image/png"></p>`;
    const { html: out, report } = await inlineExportMedia(html, { read: reader(PNG_1PX) });
    expect(out).toContain(`src="data:image/png;base64,iVBORw0KGgo="`);
    expect(out).not.toContain("attachment://");
    expect(out).not.toContain(EXPORT_HASH_ATTR);
    expect(report).toEqual({ inlined: 1, missing: 0, tooLarge: 0 });
  });

  it("没有 mime 时退回 application/octet-stream（不能给出 `data:;base64,` 这种坏 URL）", async () => {
    const html = `<img src="x" ${EXPORT_HASH_ATTR}="h1">`;
    const { html: out } = await inlineExportMedia(html, { read: reader(PNG_1PX) });
    expect(out).toContain("data:application/octet-stream;base64,");
  });

  it("外链图片**不**动它（http(s) 本来就是可移植的）", async () => {
    const html = `<img src="https://example.com/a.png">`;
    const { html: out, report } = await inlineExportMedia(html, { read: reader(PNG_1PX) });
    expect(out).toContain('src="https://example.com/a.png"');
    expect(report.inlined).toBe(0);
  });

  it("读不到字节就如实计入 missing，且**保留原 src**（不静默变成空图）", async () => {
    const html = `<img src="attachment://localhost/x.png" ${EXPORT_HASH_ATTR}="gone">`;
    const { html: out, report } = await inlineExportMedia(html, { read: async () => null });
    expect(out).toContain('src="attachment://localhost/x.png"');
    expect(report).toEqual({ inlined: 0, missing: 1, tooLarge: 0 });
  });

  it("超上限的不内联（否则能导出一个几十 MB 的 HTML）", async () => {
    const big = new Uint8Array(MAX_INLINE_BYTES + 1);
    const html = `<img src="x" ${EXPORT_HASH_ATTR}="big">`;
    const { html: out, report } = await inlineExportMedia(html, { read: reader(big) });
    expect(out).toContain('src="x"');
    expect(report).toEqual({ inlined: 0, missing: 0, tooLarge: 1 });
  });

  it("video 同样内联；srcset 会被移除（它优先于 src，留着就白内联了）", async () => {
    const html = `<video src="attachment://localhost/v.mp4" ${EXPORT_HASH_ATTR}="v1" ${EXPORT_MIME_ATTR}="video/mp4" srcset="a 2x"></video>`;
    const { html: out, report } = await inlineExportMedia(html, { read: reader(PNG_1PX) });
    expect(out).toContain("data:video/mp4;base64,");
    expect(out).not.toContain("srcset");
    expect(report.inlined).toBe(1);
  });

  it("同一份 HTML 里多张图都处理", async () => {
    const html = `<img src="a" ${EXPORT_HASH_ATTR}="h1"><img src="b" ${EXPORT_HASH_ATTR}="h2">`;
    const { report } = await inlineExportMedia(html, { read: reader(PNG_1PX) });
    expect(report.inlined).toBe(2);
  });
});
