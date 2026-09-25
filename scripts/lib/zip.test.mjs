// `scripts/lib/zip.mjs` 的判据：**按名字取条目**这条尤其要钉 —— 两个安卓门禁都靠它，
// 而 2026-09-25 真产物上崩过一次（`check-android-crypto.mjs` 里写了个并不存在的 `readApkEntry(...)`，
// 单元判据测不到、本机没 APK 也走不到那条路 ⇒ 一直到 APK 上才以 `ReferenceError` 露头）。
// 所以这里既钉"取得到"，也钉"取不到时**返回 null**"（而不是抛，让调用方如实报"没验"）。

import { describe, expect, it } from "vitest";

import { listZipEntries, readZipEntryByName } from "./zip.mjs";

/** 造一个最小 zip（**只用 store**，够本判据用；不引外部夹具）。 */
function makeZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, "utf8");
    const data = Buffer.from(text, "utf8");
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method = store
    local.writeUInt32LE(0, 14); // crc32 (not verified for store by our reader)
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);
    locals.push(local, data);

    const cd = Buffer.alloc(46 + nameBuf.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10); // method
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42); // local header offset
    nameBuf.copy(cd, 46);
    central.push(cd);
    offset += local.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

const ZIP = makeZip({ "a.txt": "hello", "lib/arm64-v8a/x.so": "SOBYTES" });

describe("按名字取条目", () => {
  it("取得到：内容逐字节相同", () => {
    expect(readZipEntryByName(ZIP, "a.txt").toString("utf8")).toBe("hello");
    expect(readZipEntryByName(ZIP, "lib/arm64-v8a/x.so").toString("utf8")).toBe("SOBYTES");
  });

  it("★ 取不到 ⇒ **null**（不是抛异常）：调用方据此判「没验」，而不是把异常当崩溃", () => {
    expect(readZipEntryByName(ZIP, "nope.txt")).toBeNull();
  });

  it("`./<名字>` 这种写法也认（不同打包器前缀不同）", () => {
    const withDot = makeZip({ "./b.txt": "dot" });
    expect(readZipEntryByName(withDot, "b.txt").toString("utf8")).toBe("dot");
  });

  it("★ 不是 zip（被截断/错误页）⇒ null，不炸", () => {
    expect(readZipEntryByName(Buffer.from("not a zip at all"), "a.txt")).toBeNull();
    expect(readZipEntryByName(ZIP.subarray(0, 40), "a.txt")).toBeNull();
  });

  it("`listZipEntries` 认得我们造的两个条目（判据自身的自检）", () => {
    expect(listZipEntries(ZIP).map((e) => e.name).sort()).toEqual(["a.txt", "lib/arm64-v8a/x.so"]);
  });
});
