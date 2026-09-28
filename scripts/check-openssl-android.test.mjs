// `scripts/check-openssl-android.mjs` 的判据 —— **属性判**（不是字节判）与三态（过 / 不符 / **没验**）。
//
// 为什么要专门钉"不按字节判"这件事：我第一版把它写成"sha256 与钉死值一致才过"，而**实测三遍**证明
// 同机同参数连编三遍就是三个不同的值 ⇒ 那条判据在真机上恒红（会把"正常"报成"坏了"）。
// 这里把新口径钉住：**属性**（静态 / 大小带 / headers / SM 符号）负全责，sha256 只当读数。

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { PINNED, countSmSymbols, envLines, verifyVendor } from "./check-openssl-android.mjs";

const dir = mkdtempSync(join(tmpdir(), "check-openssl-android-"));
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 清不掉不影响判据 */
  }
});

/**
 * 造一个"假安装前缀"。**文件系统是真的**（判据要碰真文件），但期望值全部注入
 * ⇒ 既不依赖真库存在，也不依赖某个 sha。
 */
function makePrefix(name, { libBytes = 10_000_000, soLib = false, headers = true } = {}) {
  const p = join(dir, name);
  mkdirSync(join(p, "lib"), { recursive: true });
  if (libBytes !== null) writeFileSync(join(p, "lib", "libcrypto.a"), Buffer.alloc(libBytes, 7));
  if (soLib) writeFileSync(join(p, "lib", "libcrypto.so.3"), "shared!");
  if (headers) {
    mkdirSync(join(p, "include", "openssl"), { recursive: true });
    writeFileSync(join(p, "include", "openssl", "evp.h"), "/* header */");
  }
  return p;
}

const band = [8_000_000, 16_000_000];

describe("三态：过 / 不符 / 没验", () => {
  it("★ 没编过 ⇒ status 2（**没验**）且给出「先编」的命令", () => {
    const r = verifyVendor(makePrefix("missing", { libBytes: null }), { sizeBand: band });
    expect(r.status).toBe(2);
    expect(r.lines.join("\n")).toContain("build-tongsuo-android.sh");
  });

  it("★ 大小不在合理带 ⇒ status 1（构建坏了，别当「能用」）", () => {
    const r = verifyVendor(makePrefix("tiny", { libBytes: 1024 }), { sizeBand: band });
    expect(r.status).toBe(1);
    expect(r.lines.join("\n")).toContain("不在合理带");
  });

  it("★ 居然有 libcrypto.so ⇒ status 1（「静态」那一格不成立，APK 里会变成动态依赖）", () => {
    const r = verifyVendor(makePrefix("shared", { soLib: true }), { sizeBand: band });
    expect(r.status).toBe(1);
    expect(r.lines.join("\n")).toContain("动态库");
  });

  it("★ 缺 headers ⇒ status 1（构建那条链拿不到 include）", () => {
    const r = verifyVendor(makePrefix("noheaders", { headers: false }), { sizeBand: band });
    expect(r.status).toBe(1);
    expect(r.lines.join("\n")).toContain("缺 headers");
  });

  it("★ 属性全过 ⇒ status 0；且 sha256 与记录值不同时**只提示不判红**（这正是三遍实测教出来的口径）", () => {
    const r = verifyVendor(makePrefix("good"), { sizeBand: band, recordedSha256: "0".repeat(64) });
    expect(r.status).toBe(0);
    expect(r.ok).toBe(true);
    expect(r.lines.join("\n")).toContain("属性全过");
    // 读数照打（人眼要能对），并明说"不同是正常的"
    expect(r.lines.join("\n")).toMatch(/sha256 [0-9a-f]{64}/);
    expect(r.lines.join("\n")).toContain("正常");
  });
});

describe("SM 符号那一项：拿不到工具要如实说「没验」", () => {
  it("有 llvm-nm 输出 ⇒ 数 sm3/sm4 符号", () => {
    const run = (cmd) =>
      cmd === "llvm-nm" ? "0000 T SM3_Update\n0001 T SM4_Encrypt\n0002 T AES_set_encrypt_key\n" : null;
    expect(countSmSymbols("/x/libcrypto.a", { run })).toBe(2);
  });

  it("两个工具都拿不到 ⇒ 返回 null（调用方要打「没验」，不许当成 0 个符号）", () => {
    expect(countSmSymbols("/x/libcrypto.a", { run: () => null })).toBeNull();
  });
});

describe("钉的输入与读数要自洽", () => {
  it("源码 commit / NDK 修订 / ABI / API / 固定前缀都在，且读数落在合理带内", () => {
    expect(PINNED.sourceCommit).toMatch(/^[0-9a-f]{7,40}$/);
    expect(PINNED.ndkRevision).toMatch(/^\d+\.\d+\.\d+$/);
    expect(PINNED.abi).toBe("arm64-v8a");
    expect(PINNED.api).toBeGreaterThanOrEqual(21);
    expect(PINNED.prefixFixed.startsWith("/")).toBe(true); // 必须是固定绝对路径（决定编进库的 OPENSSLDIR）
    expect(PINNED.recordedSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(PINNED.sizeBand[0]).toBeLessThan(PINNED.sizeBand[1]);
    expect(PINNED.recordedSize).toBeGreaterThanOrEqual(PINNED.sizeBand[0]);
    expect(PINNED.recordedSize).toBeLessThanOrEqual(PINNED.sizeBand[1]);
    expect(PINNED.minSmSymbols).toBeGreaterThan(0);
  });
});

describe("环境变量怎么指", () => {
  it("★ 四个键都指向同一个前缀（第四格是「链到哪一份」的核对键，别只给前三个）", () => {
    const lines = envLines(join("src-tauri", "vendor", "openssl", "android-arm64"));
    const keys = lines.map((l) => l.split("=")[0]);
    expect(keys).toEqual(["OPENSSL_DIR", "OPENSSL_LIB_DIR", "OPENSSL_INCLUDE_DIR", "SHUYONOTE_EXPECT_OPENSSL_DIR"]);
    const dirs = lines.map((l) => l.split("=")[1]);
    for (const d of dirs) expect(d.startsWith("/") || /^[A-Za-z]:[\\/]/.test(d)).toBe(true);
    expect(dirs[1]).toBe(`${dirs[0]}/lib`);
    expect(dirs[2]).toBe(`${dirs[0]}/include`);
    expect(dirs[3]).toBe(dirs[0]);
  });
});
