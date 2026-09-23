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

import { parseTestResult, pickOpensslDir, prefixLooksLinkable, explainPrepareFailure, testPathFor, cargoTestArgs, windowsLoadFailure, pinnedPrefixVerdict, winRunnerPrintArgs, manifestCopyPath, winSelfRunArgs, runPowerShellSafe } from "./check-gm-wired.mjs";

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

describe("check-gm-wired：`cargo test` 参数（win32 的显式 skip 必须精确且只在 win32）", () => {
  const M = "src-tauri/Cargo.toml";

  it("★ win32 ⇒ 精确 `-- --skip plugins::`（整数组相等：谁放宽模式，这条当场红）", () => {
    expect(cargoTestArgs({ platform: "win32", manifest: M })).toEqual([
      "test",
      "--features",
      "sm-library",
      "--manifest-path",
      M,
      "--",
      "--skip",
      "plugins::",
    ]);
  });

  it("★ 非 win32 ⇒ **一个 skip 都不许有**（否则会在 Linux/macOS 上悄悄少跑一整组）", () => {
    for (const platform of ["linux", "darwin", "freebsd"]) {
      expect(cargoTestArgs({ platform, manifest: M }), platform).toEqual([
        "test",
        "--features",
        "sm-library",
        "--manifest-path",
        M,
      ]);
    }
  });

  it("★ 变异守护：跳过的**是一个具名模块**，不是「随便什么都能跳」", () => {
    // 契约（不是实现细节）：默认模式不许是空串/通配；同时参数要**可覆盖**（证明它不是写死的，
    // 否则将来要换模块名只能去改实现 —— 而那正是"判据绑在实现上"的开端）。
    const dflt = cargoTestArgs({ platform: "win32", manifest: M });
    expect(dflt).not.toContain("");
    expect(dflt).not.toContain("*");
    expect(dflt[dflt.length - 1]).toBe("plugins::");
    expect(cargoTestArgs({ platform: "win32", manifest: M, skipModules: ["foo::"] })).toContain("foo::");
  });
});

describe("check-gm-wired：win32 的**装载期**失败要能被认出来（不是接线坏了）", () => {
  it("★ 0xC0000139（缺 v6 清单）与 0xC0000135（缺 DLL）各给一句可执行的解释", () => {
    const a = windowsLoadFailure("process didn't exit successfully: … (exit code: 0xc0000139, STATUS_ENTRYPOINT_NOT_FOUND)");
    expect(a).toMatch(/v6 清单/);
    const b = windowsLoadFailure("Caused by: process didn't exit successfully (exit code: 0xC0000135, STATUS_DLL_NOT_FOUND)");
    expect(b).toMatch(/bin/);
  });

  it("★ 别的失败**不许**被认成装载期失败（否则真回归会被自报跳过吞掉）", () => {
    // 断言失败 / 编译失败 / 正常通过 —— 三种都不是装载期问题
    expect(windowsLoadFailure("test result: FAILED. 455 passed; 34 failed; 18 ignored")).toBeNull();
    expect(windowsLoadFailure("error[E0308]: mismatched types")).toBeNull();
    expect(windowsLoadFailure("test result: ok. 492 passed; 0 failed")).toBeNull();
    expect(windowsLoadFailure("")).toBeNull();
  });
});

describe("check-gm-wired：③ 钉的前缀 vs 产物 link-search（第五格的同 job 版）", () => {
  const P = "/Users/shuyo/tongsuo-macos/install";

  it("有一个候选对得上（含**子目录**形态）⇒ true", () => {
    expect(pinnedPrefixVerdict({ expected: P, candidates: [`${P}/lib`] }).verdict).toBe(true);
    expect(pinnedPrefixVerdict({ expected: "/usr", candidates: ["/usr/lib/x86_64-linux-gnu"] }).verdict).toBe(true);
  });

  it("★ 一个都对不上（真实外部目录）⇒ false，且理由点到 `OPENSSL_LIB_DIR` 覆盖", () => {
    const v = pinnedPrefixVerdict({ expected: P, candidates: ["/opt/homebrew/opt/openssl@3/lib"] });
    expect(v.verdict).toBe(false);
    expect(v.reason).toMatch(/OPENSSL_LIB_DIR/);
  });

  it("★ 候选全是 cargo 产物目录 ⇒ false，但理由是**第二种形态**（没走发现路径），不是「链了别的」", () => {
    const v = pinnedPrefixVerdict({
      expected: "/usr",
      candidates: ["/repo/src-tauri/target/debug/build/libsqlite3-sys-abc/out"],
    });
    expect(v.verdict).toBe(false);
    expect(v.reason).toMatch(/没走 OPENSSL_DIR 发现路径/);
    expect(v.reason).not.toMatch(/OPENSSL_LIB_DIR/);
  });

  it("★ 没解析出候选 ⇒ null（**未实查**，不判红 —— 与「旧产物⇒未实查」同纪律）", () => {
    expect(pinnedPrefixVerdict({ expected: P, candidates: [] }).verdict).toBe(null);
    expect(pinnedPrefixVerdict({ expected: P, candidates: [""] }).verdict).toBe(null);
  });

  it("win32 折叠大小写（Windows 路径本就不区分）", () => {
    expect(
      pinnedPrefixVerdict({ expected: "C:\\Vcpkg\\prefix", candidates: ["c:/vcpkg/prefix/lib"], platform: "win32" })
        .verdict,
    ).toBe(true);
  });
});

describe("check-gm-wired：win32 **自产读数**那条路（跑器 -PrintExePath ＋ 自跑副本）", () => {
  it("跑器参数：只构建＋注入＋打印路径（不能顺手跑测试）", () => {
    const a = winRunnerPrintArgs();
    expect(a).toContain("-PrintExePath");
    expect(a).toContain("scripts/win-cargo-test.ps1");
    expect(a.join(" ")).not.toContain("cargo test");
  });

  it("★ 从跑器输出里取副本路径：取**最后**一条（子进程的 Write-Host 进度行也会落到 stdout）", () => {
    const out = [
      "win-cargo-test: building the test binary",
      "WIN_CARGO_TEST_EXE=C:\\tmp\\a\\shuyonote-abc.exe",
      "win-cargo-test: manifest present in the copy (verified by byte scan)",
      "WIN_CARGO_TEST_EXE=C:\\tmp\\b\\shuyonote-def.exe",
      "win-cargo-test: done",
    ].join("\n");
    expect(manifestCopyPath(out)).toBe("C:\\tmp\\b\\shuyonote-def.exe");
  });

  it("取不到就返回空串（调用方据此**退回未实查**，不判红也不装绿）", () => {
    expect(manifestCopyPath("win-cargo-test: manifest present\n")).toBe("");
    expect(manifestCopyPath("")).toBe("");
    expect(manifestCopyPath(null)).toBe("");
    // 只认整行前缀：夹在别的话里的路径不算（避免把日志里随便一个路径当副本）
    expect(manifestCopyPath("see WIN_CARGO_TEST_EXE=C:\\x.exe for details")).toBe("");
  });

  it("★ 自跑副本的参数必须**显式 skip** 那一组要真宿主二进制的用例，且与 cargoTestArgs 同口径", () => {
    expect(winSelfRunArgs()).toEqual(["--skip", "plugins::"]);
    // 与 win32 的 cargo 参数用同一份 skipModules ⇒ 两处不会各写各的
    const viaCargo = cargoTestArgs({ platform: "win32", manifest: "M" });
    expect(viaCargo.slice(-2)).toEqual(winSelfRunArgs());
    expect(winSelfRunArgs(["a::", "b::"])).toEqual(["--skip", "a::", "--skip", "b::"]);
  });

  it("runPowerShellSafe：成功时 why 为空；失败时**不抛**且把原话留下来（退回未实查要能说清原因）", () => {
    const okRun = () => "WIN_CARGO_TEST_EXE=C:\\x.exe\n";
    expect(runPowerShellSafe(okRun, ["-File", "s.ps1"], {})).toEqual({ output: "WIN_CARGO_TEST_EXE=C:\\x.exe\n", why: "" });

    const boom = Object.assign(new Error("exit 1"), { stdout: "line-a\n", stderr: "details-here\n" });
    const bad = runPowerShellSafe(() => {
      throw boom;
    }, ["-File", "s.ps1"], {});
    expect(bad.why).toContain("details-here");
    expect(bad.output).toContain("line-a");
  });
});
