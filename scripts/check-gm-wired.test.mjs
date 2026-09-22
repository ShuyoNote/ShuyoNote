// `scripts/check-gm-wired.mjs` 的判据（纯函数那两半）。
//
// 为什么值得判：这一格决定"要不要真跑库级国密那套"——
//   · 前缀挑错（例如 macOS 上误以为有系统 OpenSSL）⇒ 门禁**假绿**（跳过被读成通过）；
//   · `test result` 解析漏了 FAILED 或多块相加错 ⇒ 门禁把"34 条红"读成"全过"。
// 两条都发生在这门禁的第一版身上（前者靠下限定为 380 兜住，后者靠这条判据）。
import { describe, expect, it } from "vitest";

import { parseTestResult, pickOpensslDir, prefixLooksLinkable } from "./check-gm-wired.mjs";

describe("check-gm-wired：挑 OpenSSL 前缀", () => {
  it("给了 OPENSSL_DIR 且目录在 ⇒ 用它", () => {
    expect(pickOpensslDir({ env: { OPENSSL_DIR: "/opt/tongsuo" }, platform: "darwin", exists: () => true })).toBe("/opt/tongsuo");
  });

  it("★ 给了但目录不在 ⇒ null（宁可跳过，也别拿一个不存在的路径去编）", () => {
    expect(pickOpensslDir({ env: { OPENSSL_DIR: "/nope" }, platform: "linux", exists: (p) => p !== "/nope" })).toBe(null);
  });

  it("Linux 没给 ⇒ 用系统 /usr（OpenSSL 3 自带 SM3/SM4）", () => {
    expect(pickOpensslDir({ env: {}, platform: "linux", exists: () => true })).toBe("/usr");
  });

  it("★ macOS 没给 ⇒ null（**没有系统 OpenSSL**；不能因为 /usr 存在就假装能跑）", () => {
    expect(pickOpensslDir({ env: {}, platform: "darwin", exists: () => true })).toBe(null);
  });
});

describe("check-gm-wired：解析 cargo 的 test result", () => {
  it("单块", () => {
    expect(parseTestResult("test result: ok. 428 passed; 0 failed; 18 ignored; 0 measured")).toEqual({ passed: 428, failed: 0 });
  });

  it("★ 多块（lib ＋ 集成测试）要**相加**，别只取第一块", () => {
    const out = [
      "test result: ok. 12 passed; 0 failed; 0 ignored",
      "test result: FAILED. 3 passed; 2 failed; 0 ignored",
    ].join("\n其他输出\n");
    expect(parseTestResult(out)).toEqual({ passed: 15, failed: 2 });
  });

  it("没有 `test result:` ⇒ null（＝这一格没跑，门禁据此判红：空跑即红）", () => {
    expect(parseTestResult("error: could not compile `shuyonote`")).toBe(null);
  });
});

describe("check-gm-wired：前缀能不能真的链接（Linux 的 `/usr` 要看开发文件）", () => {
  it("★ ubuntu 多架构布局（`lib/x86_64-linux-gnu/libcrypto.so`）⇒ 可链接", () => {
    const exists = () => true;
    const readdir = (p) =>
      p.endsWith("/lib") ? ["x86_64-linux-gnu"] : p.endsWith("x86_64-linux-gnu") ? ["libcrypto.so", "libcrypto.so.3"] : [];
    expect(prefixLooksLinkable("/usr", { exists, readdir })).toBe(true);
  });

  it("★ 只有运行时库（`libcrypto.so.3`，没有 `.so` 开发符号链接）⇒ **不可链接**（该跳过）", () => {
    const exists = () => true;
    const readdir = (p) => (p.endsWith("/lib") ? ["libcrypto.so.3"] : []);
    expect(prefixLooksLinkable("/opt/rt-only", { exists, readdir })).toBe(false);
  });

  it("Windows 的 vcpkg 前缀（`lib/libcrypto.lib`）⇒ 可链接", () => {
    const exists = (p) => p.endsWith("/lib");
    const readdir = () => ["libcrypto.lib", "libssl.lib"];
    expect(prefixLooksLinkable("/vcpkg/installed/x64-windows-static-md", { exists, readdir })).toBe(true);
  });

  it("空目录 / 没给前缀 ⇒ 不可链接", () => {
    expect(prefixLooksLinkable("/nope", { exists: () => false, readdir: () => [] })).toBe(false);
    expect(prefixLooksLinkable("")).toBe(false);
  });
});
