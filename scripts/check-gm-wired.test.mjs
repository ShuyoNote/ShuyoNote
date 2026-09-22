// `scripts/check-gm-wired.mjs` 的判据（纯函数那两半）。
//
// 为什么值得判：这一格决定"要不要真跑库级国密那套"——
//   · 前缀挑错（例如 macOS 上误以为有系统 OpenSSL）⇒ 门禁**假绿**（跳过被读成通过）；
//   · `test result` 解析漏了 FAILED 或多块相加错 ⇒ 门禁把"34 条红"读成"全过"。
// 两条都发生在这门禁的第一版身上（前者靠下限定为 380 兜住，后者靠这条判据）。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseTestResult, pickOpensslDir, prefixLooksLinkable, explainPrepareFailure, testPathFor } from "./check-gm-wired.mjs";

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

describe("check-gm-wired：解析 cargo 的 test result", () => {  it("单块", () => {
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

// ⚠️ **假 FS 的匹配必须与生产代码同口径**：生产用 `node:path.join`（Windows 上是 `\`），
//   而这里第一版按**字面 `/lib`、`/lib64`** 匹配 ⇒ 在 Windows 上一条都匹配不上 ⇒ 这两条**假红**。
//   实测（2026-09-22，Windows）：`join('/usr','lib')` = `"\\usr\\lib"`，`endsWith('/lib')` = false；
//   把假实现改成分隔符无关 ⇒ 立刻 true。⇒ 一律按**最后一段路径**（`basename`）匹配，天然跨平台；
//   另加一条**真磁盘**判据（不喂任何假 FS）兜住这一类。
describe("check-gm-wired：前缀能不能真的链接（Linux 的 `/usr` 要看开发文件）", () => {
  it("★ ubuntu 多架构布局（`lib/x86_64-linux-gnu/libcrypto.so`）⇒ 可链接", () => {
    const exists = () => true;
    const readdir = (p) =>
      ["lib", "lib64"].includes(basename(p))
        ? ["x86_64-linux-gnu"]
        : basename(p) === "x86_64-linux-gnu"
          ? ["libcrypto.so", "libcrypto.so.3"]
          : [];
    expect(prefixLooksLinkable("/usr", { exists, readdir })).toBe(true);
  });

  it("★ 只有运行时库（`libcrypto.so.3`，没有 `.so` 开发符号链接）⇒ **不可链接**（该跳过）", () => {
    const exists = () => true;
    const readdir = (p) => (basename(p) === "lib" ? ["libcrypto.so.3"] : []);
    expect(prefixLooksLinkable("/opt/rt-only", { exists, readdir })).toBe(false);
  });

  it("Windows 的 vcpkg 前缀（`lib/libcrypto.lib`）⇒ 可链接", () => {
    const exists = (p) => basename(p) === "lib";
    const readdir = () => ["libcrypto.lib", "libssl.lib"];
    expect(prefixLooksLinkable("/vcpkg/installed/x64-windows-static-md", { exists, readdir })).toBe(true);
  });

  it("空目录 / 没给前缀 ⇒ 不可链接", () => {
    expect(prefixLooksLinkable("/nope", { exists: () => false, readdir: () => [] })).toBe(false);
    expect(prefixLooksLinkable("")).toBe(false);
  });

  it("★ 真磁盘（**不喂假 FS**）：用 `join` 建出来的前缀目录能认出开发文件（这一类假红的兜底判据）", () => {
    const dir = mkdtempSync(join(tmpdir(), "gm-wired-"));
    try {
      mkdirSync(join(dir, "lib"), { recursive: true });
      writeFileSync(join(dir, "lib", "libcrypto.so"), "");
      expect(prefixLooksLinkable(dir)).toBe(true);
      // 反向：只剩运行时的 `.so.3`（没有开发符号链接）⇒ 不可链接（门禁该自报跳过，而不是假绿）
      rmSync(join(dir, "lib", "libcrypto.so"));
      writeFileSync(join(dir, "lib", "libcrypto.so.3"), "");
      expect(prefixLooksLinkable(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ★ 这一组是**真踩出来的**（2026-09-22，AMD 的 Windows）：`--prepare` 失败时门禁原先只印
//   「最常见：`cargo` 不在 PATH」，而那次真因是 `cargo clean` 碰上**正在跑的 `shuyonote.exe`**
//   （`os error 5 拒绝访问`）⇒ 提示把人引去查 PATH，方向完全错了、白跑一轮。
//   两类原因的可操作修法完全不同 ⇒ 必须按证据分开，且**不许互相冒充**。
describe("check-gm-wired：准备失败的提示要分清「target 被占」与「cargo 不在 PATH」", () => {
  const LOCKED = [
    "sm-library-build: ① 清 shuyonote 的 debug 产物",
    "error: failed to remove file `C:\\...\\target\\debug\\deps\\shuyonote.exe`",
    "Caused by:",
    "    拒绝访问。 (os error 5)",
  ].join("\n");

  it("★ target 被占（os error 5 / 拒绝访问）⇒ 提示指向「先停掉 dev 实例」，且**不许**提 PATH", () => {
    const hints = explainPrepareFailure(LOCKED).join("\n");
    expect(hints).toMatch(/占着/);
    expect(hints).toMatch(/shuyonote/);
    expect(hints).not.toMatch(/PATH/);
  });

  it("cargo 不在 PATH ⇒ 提示指向 PATH", () => {
    const hints = explainPrepareFailure("'cargo' is not recognized as an internal or external command").join("\n");
    expect(hints).toMatch(/PATH/);
  });

  it("两类证据都没有 ⇒ 如实说「看原始输出」，不瞎猜一个方向", () => {
    const hints = explainPrepareFailure("some unexpected failure").join("\n");
    expect(hints).toMatch(/原始输出/);
  });
});

// ★ 同样是**真踩出来的**（2026-09-22 AMD 的 Windows）：测试 exe 编出来了却在**加载时**死掉，
//   cargo 只报一句 `test failed`，真因是 `0xC0000135 STATUS_DLL_NOT_FOUND` —— 本机全局前缀是
//   **动态**的，运行时要 `libcrypto-3-x64.dll`，而门禁没把 `<前缀>\bin` 放进 PATH（dev 脚本放了）。
describe("check-gm-wired：Windows 上测试 exe 要能找到 OpenSSL 的 DLL", () => {
  it("★ win32 + 动态前缀 ⇒ 把 `<前缀>\\bin` 并到 PATH 最前（否则 0xC0000135 直接退出）", () => {
    const p = testPathFor("C:\\Windows;C:\\other", "C:\\OpenSSL", "win32");
    expect(p.split(";")[0]).toBe(join("C:\\OpenSSL", "bin"));
    expect(p).toContain("C:\\other");
  });

  it("幂等：已经在 PATH 里就不重复插（比大小写无关）", () => {
    const once = testPathFor("C:\\x", "C:\\OpenSSL", "win32");
    expect(testPathFor(once, "C:\\OpenSSL", "win32")).toBe(once);
    expect(testPathFor(once.toLowerCase(), "C:\\OpenSSL", "win32")).toBe(once.toLowerCase());
  });

  it("POSIX 不动它（那边靠 rpath / install_name，不需要 PATH）", () => {
    expect(testPathFor("/usr/bin:/bin", "/opt/tongsuo", "linux")).toBe("/usr/bin:/bin");
    expect(testPathFor("/usr/bin", "/opt/tongsuo", "darwin")).toBe("/usr/bin");
  });
});
