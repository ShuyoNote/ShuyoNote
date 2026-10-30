// `docZip` 的判据：**手工构造的 store 模式 zip**（自己算 CRC，不靠打包库）能解出条目；
// 坏字节（0 字节 / 不是 zip / 截断 / 未知压缩方式）必须**明确报错**，⛔ 不许返回空数组假装成功；
// 带 `../` 的条目在这里只负责原样带回，拒绝由 `openDocumentPackage` 完成（端到端一条）。
//
// ⚠️ 覆盖边界：store 用例全部手拼字节；deflate 那一条用 fflate 的 `zipSync` 生成夹具
//    （只为覆盖压缩方式 8 的分支 —— 解压侧用的是同一个库，所以它**不独立**于实现）。
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { DOC_FORMAT, DOC_FORMAT_VERSION, MAX_FILE_BYTES } from "./docPackage";
import { openDocumentPackage } from "./docPackageOpen";
import { decodeZipEntries, unzipDocument } from "./docZip";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

const SHA_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const ASSET_PATH = `assets/${SHA_ABC}.bin`;

const manifestJson = (): string =>
  JSON.stringify({
    format: DOC_FORMAT,
    format_version: DOC_FORMAT_VERSION,
    title: "周报",
    assets: [{ path: ASSET_PATH, sha256: SHA_ABC, size: 3 }],
  });

// ---------------------------------------------------------------------------
// 手拼 zip 的夹具工具（store 方式；CRC 自己算 ⇒ 不依赖任何打包/解包库）
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32（zip 用的 IEEE 那个）。 */
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const le16 = (v: number): number[] => [v & 0xff, (v >>> 8) & 0xff];
const le32 = (v: number): number[] => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];

interface RawEntry {
  path: string;
  bytes: Uint8Array;
  /** 压缩方式：0=store（默认）；99=构造「不支持」的夹具。 */
  method?: number;
  /** 只改头部**声明**的解压后大小（构造 zip bomb 夹具用；实际字节不变）。 */
  declaredSize?: number;
}

/** 最小可用的 store 模式 zip：本地头 ＋ 中央目录 ＋ EOCD（手拼，不调 `zipSync`）。 */
function buildZip(entries: RawEntry[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc(e.path);
    const method = e.method ?? 0;
    const compSize = e.bytes.length;
    const uncompSize = e.declaredSize ?? e.bytes.length;
    const crc = crc32(e.bytes);
    const local = Uint8Array.from([
      ...le32(0x04034b50),
      ...le16(20),
      ...le16(0x0800), // UTF-8 名字
      ...le16(method),
      ...le16(0),
      ...le16(0),
      ...le32(crc),
      ...le32(compSize),
      ...le32(uncompSize),
      ...le16(name.length),
      ...le16(0),
      ...name,
      ...e.bytes,
    ]);
    const central = Uint8Array.from([
      ...le32(0x02014b50),
      ...le16(20),
      ...le16(20),
      ...le16(0x0800),
      ...le16(method),
      ...le16(0),
      ...le16(0),
      ...le32(crc),
      ...le32(compSize),
      ...le32(uncompSize),
      ...le16(name.length),
      ...le16(0),
      ...le16(0),
      ...le16(0),
      ...le16(0),
      ...le32(0),
      ...le32(offset),
      ...name,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const cd = Uint8Array.from(centrals.flatMap((c) => [...c]));
  const eocd = Uint8Array.from([
    ...le32(0x06054b50),
    ...le16(0),
    ...le16(0),
    ...le16(entries.length),
    ...le16(entries.length),
    ...le32(cd.length),
    ...le32(offset),
    ...le16(0),
  ]);
  const out = new Uint8Array(offset + cd.length + eocd.length);
  let p = 0;
  for (const l of locals) {
    out.set(l, p);
    p += l.length;
  }
  out.set(cd, p);
  out.set(eocd, p + cd.length);
  return out;
}

// ---------------------------------------------------------------------------

describe("docZip：读 .shuyodoc 的 zip 字节", () => {
  it("① 单条目（store）：路径与字节原样读回", async () => {
    const entries = await unzipDocument(buildZip([{ path: "content.json", bytes: enc("你好，shuyodoc") }]));
    expect(entries).toHaveLength(1);
    expect(entries[0].path).toBe("content.json");
    expect(dec(entries[0].bytes)).toBe("你好，shuyodoc");
  });

  it("② 多条目（store）：真 zip 一路过 openDocumentPackage（不是假条目）", async () => {
    const sumEntries = await (async () => {
      const { buildChecksums } = await import("./docPackage");
      const base = [
        { path: "manifest.json", bytes: enc(manifestJson()) },
        { path: "content.json", bytes: enc(JSON.stringify({ root: { children: [] } })) },
        { path: ASSET_PATH, bytes: enc("abc") },
      ];
      const sums = await buildChecksums(base.map((e) => ({ path: e.path, bytes: new TextDecoder().decode(e.bytes) })));
      return [...base, { path: "checksums.json", bytes: enc(JSON.stringify(sums)) }];
    })();
    const zip = buildZip(sumEntries);
    const opened = await openDocumentPackage(await unzipDocument(zip));
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      expect(opened.pkg.manifest.title).toBe("周报");
      expect(opened.pkg.assets).toHaveLength(1);
      expect(dec(opened.pkg.assets[0].bytes)).toBe("abc");
    }
  });

  it("③ 坏字节：0 字节 / 不是 zip / 截断 / 未知压缩方式 ⇒ 明确报错（⛔ 不返回空数组）", async () => {
    await expect(unzipDocument(new Uint8Array(0))).rejects.toThrow(/不是合法的 zip（0 字节）/);
    await expect(unzipDocument(enc("这不是 zip，只是一段文本"))).rejects.toThrow(/不是合法的 zip/);

    const good = buildZip([{ path: "a.txt", bytes: enc("abc") }]);
    await expect(unzipDocument(good.subarray(0, good.length - 4))).rejects.toThrow(/不是合法的 zip（数据被截断/);

    await expect(unzipDocument(buildZip([{ path: "a.txt", bytes: enc("abc"), method: 99 }]))).rejects.toThrow(
      /不支持的压缩方式 99/,
    );

    // 纯函数形态：解不开返回 {ok:false}（不抛），错误可单测
    const pure = decodeZipEntries(enc("这不是 zip"));
    expect(pure.ok).toBe(false);
    if (!pure.ok) expect(pure.error).toContain("不是合法的 zip");
  });

  it("④ 条目名带 ../ ⇒ 原样带回，openDocumentPackage 判 zip-slip 并点名条目（端到端）", async () => {
    const entries = await unzipDocument(buildZip([{ path: "../evil.txt", bytes: enc("x") }]));
    expect(entries.map((e) => e.path)).toEqual(["../evil.txt"]);

    const r = await openDocumentPackage(entries);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("zip-slip");
      expect(r.error).toContain("../evil.txt");
    }
  });

  it("⑤ 同名条目 ⇒ 拒绝（fflate 会静默覆盖，靠 EOCD 条目数对账挡住）", async () => {
    const zip = buildZip([
      { path: "manifest.json", bytes: enc("first") },
      { path: "manifest.json", bytes: enc("second") },
    ]);
    const pure = decodeZipEntries(zip);
    expect(pure.ok).toBe(false);
    if (!pure.ok) expect(pure.error).toContain("同名条目被覆盖");
    await expect(unzipDocument(zip)).rejects.toThrow(/同名条目被覆盖/);
  });

  it("⑥ 声明的解压后大小超上限 ⇒ 不解压就拒绝（zip bomb 预检）", async () => {
    const zip = buildZip([{ path: "assets/bomb.bin", bytes: enc("x"), declaredSize: MAX_FILE_BYTES + 1 }]);
    const pure = decodeZipEntries(zip);
    expect(pure.ok).toBe(false);
    if (!pure.ok) expect(pure.error).toContain("超过单文件上限");
  });

  it("⑦ deflate 条目也能读（用 fflate 打包生成，覆盖压缩方式 8 的分支）", async () => {
    const zip = zipSync({ "manifest.json": strToU8("{}"), "content.json": strToU8("{}") });
    expect(zip[8]).toBe(8); // 本地头偏移 8 = 压缩方式 ⇒ 确认真的是 deflate 夹具
    const entries = await unzipDocument(zip);
    expect(entries.map((e) => e.path).sort()).toEqual(["content.json", "manifest.json"]);
    expect(entries.every((e) => dec(e.bytes) === "{}")).toBe(true);
  });

  it("⑧ 目录条目：原样带回，由 openDocumentPackage 明确拒绝（⛔ 不静默跳过）", async () => {
    const zip = buildZip([
      { path: "assets/", bytes: new Uint8Array(0) },
      { path: "content.json", bytes: enc("{}") },
    ]);
    const r = await openDocumentPackage(await unzipDocument(zip));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("目录条目");
  });
});
