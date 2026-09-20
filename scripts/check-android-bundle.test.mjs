// `check-android-bundle` 的判据自测（纯函数那半；端到端那半需要真 APK，见门禁文件头的读数）。
//
// 这一组的价值全在"哪些条目才算**随包的库**"这一步上：
//   · 认太宽（把 `lib/<abi>/<子目录>/libpdfium.so` 也算）⇒ 门禁会给一个**加载不到**的包发绿；
//   · 认太窄（漏掉某个 ABI）⇒ 安卓真机上仍然是"找不到动态库"。
//
// 2026-09-20 补了第二组：**读 zip 的那套是纯 Node 的**（原来靠 `tar -tf`，而 CI 的 ubuntu 是
// GNU tar、读不了 zip ⇒ 那一步在 CI 上恒 exit 2"没验"）。所以这里自带一个**最小的 zip 写入器**
// 造真 zip 来验读的那一半 —— 不依赖 tar/unzip/7z，也不依赖平台。
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { deflateRawSync } from "node:zlib";

import { apkLibEntries, ABI_DIRS, check, readApkEntry, readZipEntries } from "./check-android-bundle.mjs";

const VENDOR_LIB = join("src-tauri", "vendor", "pdfium", "android-arm64", "lib", "libpdfium.so");

// ---- 最小的 zip 写入器（只为造判据的输入；`stored: true` = 不压缩的那种条目）----
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0 ^ -1;
  for (const b of buf) c = (c >>> 8) ^ CRC_TABLE[(c ^ b) & 0xff];
  return (c ^ -1) >>> 0;
}

function makeZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    const method = e.stored ? 0 : 8;
    const body = method === 0 ? raw : deflateRawSync(raw);
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += 30 + name.length + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

describe("apkLibEntries：只认 Gradle 会装进 nativeLibraryDir 的那一层", () => {
  it("`lib/<abi>/libpdfium.so` 算（三层）", () => {
    expect(apkLibEntries(["lib/arm64-v8a/libpdfium.so"])).toEqual([
      { abi: "arm64-v8a", entry: "lib/arm64-v8a/libpdfium.so" },
    ]);
  });

  it("★ 深一层**不算** —— 包里在、但 Gradle 不会把它当 native library", () => {
    expect(apkLibEntries(["lib/arm64-v8a/resources/libpdfium.so"])).toEqual([]);
  });

  it("★ 认不出的 ABI 目录**不算**（别把别的目录名当 ABI）", () => {
    expect(apkLibEntries(["lib/not-an-abi/libpdfium.so"])).toEqual([]);
  });

  it("别的 .so 不算；带 `./` 前缀的要能认出来", () => {
    expect(apkLibEntries(["lib/arm64-v8a/libc++_shared.so"])).toEqual([]);
    expect(apkLibEntries(["./lib/x86_64/libpdfium.so"]).map((e) => e.abi)).toEqual(["x86_64"]);
  });

  it("多个 ABI 时按 `ABI_DIRS` 的顺序稳定输出（报告里那行才不会抖动）", () => {
    const got = apkLibEntries([
      "lib/x86_64/libpdfium.so",
      "lib/arm64-v8a/libpdfium.so",
      "lib/armeabi-v7a/libpdfium.so",
    ]);
    expect(got.map((e) => e.abi)).toEqual(["arm64-v8a", "armeabi-v7a", "x86_64"]);
    // 顺序来自常量表，不是硬编码在这条判据里
    expect(got.map((e) => e.abi)).toEqual(ABI_DIRS.filter((a) => got.some((g) => g.abi === a)));
  });

  it("空输入 ⇒ 空结果（门禁自己不许把「没扫到」当绿）", () => {
    expect(apkLibEntries([])).toEqual([]);
  });
});

// ---- 读 zip 的那一半：纯 Node（2026-09-20 换掉 `tar -tf`，见门禁文件头）----
describe("readZipEntries / readApkEntry：纯 Node 读 zip（APK 就是 zip）", () => {
  const tmp = mkdtempSync(join(tmpdir(), "shuyo-ziptest-"));
  const withFile = (name, buf) => {
    const p = join(tmp, name);
    writeFileSync(p, buf);
    return p;
  };

  it("两种压缩方式（deflate / stored）都要认得出条目名", () => {
    const apk = withFile(
      "both.apk",
      makeZip([
        { name: "AndroidManifest.xml", data: "x".repeat(200) },
        { name: "lib/arm64-v8a/libpdfium.so", data: "y".repeat(500), stored: true },
      ]),
    );
    expect(readZipEntries(readFileSync(apk)).map((e) => e.name)).toEqual([
      "AndroidManifest.xml",
      "lib/arm64-v8a/libpdfium.so",
    ]);
  });

  it("★ 取出来的字节与写进去的**一模一样**（deflate 与 stored 各一遍）", () => {
    const payload = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7) % 251));
    const apk = withFile(
      "payload.apk",
      makeZip([
        { name: "a/libpdfium.so", data: payload },
        { name: "b/libpdfium.so", data: payload, stored: true },
      ]),
    );
    expect(readApkEntry(apk, "a/libpdfium.so").equals(payload)).toBe(true);
    expect(readApkEntry(apk, "b/libpdfium.so").equals(payload)).toBe(true);
    expect(readApkEntry(apk, "c/libpdfium.so")).toBeNull(); // 没有这条 ⇒ null，不是空 Buffer
  });

  it("★ 不是 zip（例如本机 `tar -a -cf x.apk` 造出来的那种「伪 APK」）⇒ null（如实报「没验」，不许崩、也不许当通过）", () => {
    // 这正是本机 `tar -a -cf x.apk` 造出来的东西：ustar 头 `lib/…`，根本没有中央目录
    const fake = Buffer.concat([Buffer.from("lib/"), Buffer.alloc(2048)]);
    expect(readZipEntries(fake)).toBeNull();
    const apk = withFile("fake.apk", fake);
    const errs = [];
    expect(check({ apk, log: () => {}, err: (m) => errs.push(m) })).toBe(2);
    expect(errs.join("\n")).toMatch(/读不了这个 APK 的 zip 结构/);
  });

  it("★ 包里有库、且与 vendor 逐字节相同 ⇒ 0（vendor 不在就只能是 2「没验全」，不许绿）", () => {
    const vendor = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), VENDOR_LIB);
    const hasVendor = existsSync(vendor);
    const payload = hasVendor ? readFileSync(vendor) : Buffer.from("not-the-real-lib");
    const apk = withFile("ok.apk", makeZip([{ name: "lib/arm64-v8a/libpdfium.so", data: payload }]));
    const logs = [];
    const code = check({ apk, log: (m) => logs.push(m), err: () => {} });
    if (hasVendor) {
      expect(code).toBe(0);
      expect(logs.join("\n")).toMatch(/与 vendor \*\*逐字节相同\*\*/);
    } else {
      expect(code).toBe(2);
      expect(logs.join("\n")).toMatch(/vendor 里没有 android 那份/);
    }
  });

  it("★ 库在深一层 ⇒ 1（与 `apkLibEntries` 那条口径一致：Gradle 不收子目录）", () => {
    const apk = withFile(
      "deep.apk",
      makeZip([{ name: "lib/arm64-v8a/resources/libpdfium.so", data: Buffer.from("x") }]),
    );
    const errs = [];
    expect(check({ apk, log: () => {}, err: (m) => errs.push(m) })).toBe(1);
    expect(errs.join("\n")).toMatch(/包里\*\*没有\*\* `lib\/<abi>\/libpdfium\.so`/);
  });
});
