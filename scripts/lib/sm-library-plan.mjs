// 「库级国密构建」的**步骤计划**（纯函数，便于判据 —— CLI 本身不是模块，import 它会执行主体）。
//
// ★ 为什么要有这个文件（2026-09-22 一次真实事故）：
//   `--prepare` 里我原本只写 `cargo clean -p libsqlite3-sys`（**不带 `--release`**），
//   而发版链跑的是 `tauri build`（release）⇒ **release profile 的旧产物活了下来**。
//   又因为 `libsqlite3-sys` 的 build.rs **没有**为 `OPENSSL_DIR` 声明 `rerun-if-env-changed`
//   （docs/development.md 工具坑第 5 条），cargo 认为它"还是新鲜的" ⇒ **不重编** ⇒
//   那一份 CommonCrypto 的 SQLCipher 被原样链进 release 产物。
//   于是"按发版链构建出来的包"表面全对（补丁标记 `page_cipher=sm4` 也在），而**库级根本不是国密**。
//   ⇒ 我在本机把发版链的步骤原样跑了一遍，`check-crypto-backend` 那三条断言**当场把它抓住**。
//
//   结论写成计划：**清产物必须覆盖"这次要构建的那个 profile"**，而最省心的做法是两个都清
//   （多一次 `cargo clean -p` 而已，换来的是"永远不会因为一份陈旧产物而发出非国密包"）。

/** 需要清的 crate（两个都清：`libsqlite3-sys` 决定 SQLCipher 后端，本 crate 决定 build.rs 标记是否重跑）。 */
export const CLEAN_PACKAGES = ["libsqlite3-sys", "shuyonote"];

/**
 * 纯函数：返回**清产物**的步骤列表。每个包给 dev 与 release 各一条。
 * @returns {{cmd: string, args: string[], label: string}[]}
 */
export function cleanCommands({ manifest }) {
  const steps = [];
  for (const pkg of CLEAN_PACKAGES) {
    for (const [profileFlag, profileName] of [
      [null, "debug"],
      ["--release", "release"],
    ]) {
      steps.push({
        cmd: "cargo",
        args: ["clean", "-p", pkg, ...(profileFlag ? [profileFlag] : []), "--manifest-path", manifest],
        label:
          `清 ${pkg} 的 ${profileName} 产物` +
          (profileName === "release"
            ? "（★ 少了这一条：release 的旧 SQLCipher 会在 `tauri build` 里被**原样复用** ⇒ 发出非国密包）"
            : ""),
      });
    }
  }
  return steps;
}

/**
 * 纯函数：`--prepare` 到底做不做"构建"。
 * 准备模式的用途：CI 里只打补丁 ＋ 清产物，构建交给带 `--features sm-library` 的 `tauri build`，
 * 免得同一份代码编两遍。
 */
export function shouldBuild({ prepare = false } = {}) {
  return !prepare;
}
