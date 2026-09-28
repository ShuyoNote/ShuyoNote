// 零依赖 ZIP 读取（只读，够用即可）。
//
// 为什么自己写：APK / CI artifact 都要在**没有 unzip 的机器上**（Windows 本机）读，
// 而 `tar -xf` 能解但取不到单个条目的字节、`unzip` 是 Linux 专有、加依赖又要过供应链。
// ZIP 的中央目录结构很小（EOCD + 固定头），Node 自带 zlib 就能解 deflate ⇒ 自己读。
//
// 支持：stored(0) 与 deflate(8)；不支持 ZIP64（APK 与 CI artifact 都远小于 4GB、条目数也少；
// 真遇到就**明确报错**，不要静默给错数据）。
import { inflateRawSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** 列出中央目录里所有条目。 */
export function listZipEntries(buf) {
  let eocd = -1;
  const minPos = Math.max(0, buf.length - 66000); // 注释区最长 65535
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("不是合法的 ZIP：找不到 EOCD");
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || count === 0xffff) throw new Error("ZIP64 不受支持");
  const out = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`中央目录第 ${i} 项签名不对`);
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localHeaderOffset = buf.readUInt32LE(p + 42);
    const externalAttrs = buf.readUInt32LE(p + 38);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    out.push({
      name,
      method,
      compressedSize,
      size,
      localHeaderOffset,
      // 目录条目的判别：名字以 / 结尾，或外部属性里的 unix mode 带 IFDIR
      isDir: name.endsWith("/") || (externalAttrs >>> 16 & 0o170000) === 0o040000,
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** 取某个条目**解压后**的字节。 */
export function readZipEntry(buf, e) {
  if (buf.readUInt32LE(e.localHeaderOffset) !== 0x04034b50) throw new Error(`${e.name}：本地头签名不对`);
  const nameLen = buf.readUInt16LE(e.localHeaderOffset + 26);
  const extraLen = buf.readUInt16LE(e.localHeaderOffset + 28);
  const dataAt = e.localHeaderOffset + 30 + nameLen + extraLen;
  const raw = buf.subarray(dataAt, dataAt + e.compressedSize);
  if (e.method === 0) return raw;
  if (e.method === 8) return inflateRawSync(raw);
  throw new Error(`${e.name}：不支持的压缩方式 ${e.method}`);
}

/**
 * 按**条目名**取解压后的字节；没有这条或解不开 ⇒ `null`（调用方据此判"没验"，而不是当成"没有"）。
 *
 * 为什么收在这里（2026-09-25）：`check-android-bundle.mjs` 与 `check-android-crypto.mjs` 都要
 * "从 APK 里把某个 `.so` 抠出来"这一步 —— 一个读 `lib/<abi>/libpdfium.so`、一个读应用自己的
 * `lib<name>.so`。原来各写一份，结果后者**漏了导入**（写成 `readApkEntry(...)` 却从没定义过），
 * 而单元判据只测纯函数、本机又没有 APK ⇒ 那条路径**一直到真产物上才崩**（`ReferenceError`）。
 * 同一件事有两份实现就是这样：它们的 bug 也各不相同、且各自都不会被发现。
 */
export function readZipEntryByName(buf, name) {
  try {
    const found = listZipEntries(buf).find((e) => e.name === name || e.name === `./${name}`);
    return found ? readZipEntry(buf, found) : null;
  } catch {
    return null;
  }
}

/** 把一个 ZIP 整包解到 destDir（保持目录结构），返回写出的文件数。 */
export function extractZip(buf, destDir) {
  let n = 0;
  for (const e of listZipEntries(buf)) {
    const target = join(destDir, e.name);
    if (e.isDir) {
      mkdirSync(target, { recursive: true });
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readZipEntry(buf, e));
    n++;
  }
  return n;
}
