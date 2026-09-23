// **消灭「补丁残留在全机共享的 registry 源码上」这一整类状态**（2026-09-23，owner 点名的 G 格）。
//
// ## 旧做法的问题（一句话）
// `sm-library-build.mjs` 把国密补丁**打在 cargo registry 里那份全机共享的 `sqlite3.c` 上**。
// 那份源码是**所有构建共用**的 ⇒ 跑完一次国密构建、忘了 `--revert`，这台机器后续的**默认**构建
// 编的也是打过补丁的源码：macOS 上默认（CommonCrypto）构建会红 12＋7 条，**现场像是加密库坏了**；
// Linux/Windows 上不报错，但后续默认构建被**静默**改成写 SM4 页。判据只能"发现并拦住"，救不了根。
//
// ## 新做法（根除）
// 补丁只打在**私有副本**上，再用一个**独立的 `CARGO_HOME`** 把 cargo 指过去：
//
//   <repo>/.gm-build/
//     libsqlite3-sys-<ver>/          ← registry 源码的**副本**（补丁打在这里）
//     cargo-home/
//       config.toml                  ← 真实 CARGO_HOME 的 config（镜像等）**逐字复制** ＋ `[patch.crates-io]`
//       registry -> <真实 registry>   ← 目录符号链接（Windows 用 junction，免管理员）
//
// 于是：
//   · **共享 registry 全程不被触碰** ⇒ 残留**不可能发生**（不是"被发现"，是不存在）；
//   · 国密构建的所有 cargo 调用（包括 `tauri build` 内部那条）都经 `CARGO_HOME` 自动吃到补丁 —— 不需要给每个调用点加 `--config`；
//   · `--revert` 退化成**删一个目录**；默认构建（不设这个 `CARGO_HOME`）永远走原版源码。
//
// ## 三条容易踩的点（都写死在下面）
//   1. **镜像配置必须继承**：真实 `CARGO_HOME/config.toml` 里常有 `[source.*]` 镜像（本机就是 rsproxy）
//      ⇒ 新 `CARGO_HOME` 若不带上它，cargo 会去连真正的 crates.io（很多机器上根本连不通）。
//   2. **符号链接的跨平台写法**：Windows 上目录符号链接要管理员/开发者模式，而 **junction 不需要**
//      ⇒ `fs.symlinkSync(target, path, "junction")`；其它平台用 `"dir"`。
//   3. **不嵌套**：`CARGO_HOME` 可能已经被指到我们的 `.gm-build/cargo-home`（嵌套调用）⇒ 真实 registry 的位置
//      由 `srcDir` 反推（往上数四层），**不读环境变量**，避免自己指自己。
//
// 判据：`scripts/lib/sm-library-isolate.test.mjs`（纯函数逐条钉）；真实读数见
// `docs/SM-CRYPTO-DELIVERY.md` §四（"跑了国密构建、没 revert、默认构建仍绿"）。

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** 私有构建目录（仓库根下，已进 `.gitignore`）。 */
export const GM_DIRNAME = ".gm-build";

export function gmRoot(repoRoot) {
  return join(repoRoot, GM_DIRNAME);
}

export function gmCopyDir(repoRoot, version) {
  return join(gmRoot(repoRoot), `libsqlite3-sys-${version}`);
}

export function gmCargoHome(repoRoot) {
  return join(gmRoot(repoRoot), "cargo-home");
}

/** 私有 `CARGO_HOME` 里的 config 相对路径（cargo 认 `config.toml`，老写法 `config` 也读，这里只写前者）。 */
export function gmConfigPath(repoRoot) {
  return join(gmCargoHome(repoRoot), "config.toml");
}

/**
 * 纯函数：从 registry 源码目录反推**真实 CARGO_HOME**。
 *
 * 路径形态（注意有 **5** 层）：`<cargoHome>/registry/src/<index>/<crate>/sqlcipher`
 * ⇒ 从 `srcDir` 往上数**五**层。（我第一版只数了四层，于是"继承真实 config"继承到
 * `<cargoHome>/registry/config.toml` 这个不存在的路径 ⇒ **镜像配置丢了**，构建会去连真正的 crates.io。
 * 判据在 `sm-library-isolate.test.mjs` 里用真实形态的路径钉住这一点。）
 */
export function cargoHomeOfRegistrySrc(srcDir) {
  return dirname(dirname(dirname(dirname(dirname(srcDir)))));
}

/**
 * 纯函数：私有 `CARGO_HOME/config.toml` 的内容 = 真实 config（可能为空）逐字保留 ＋ `[patch.crates-io]`。
 *
 * 路径用 TOML **字面字符串**（单引号）：Windows 的 `C:\a\b` 在双引号里要转义反斜杠，
 * 字面串不用 —— 少一类只在 Windows 上炸的写法。
 *
 * ⚠️ **继承时要剥掉真实 config 开头的 BOM**（2026-09-23 实测，AMD/Windows）：
 * 真实 `~/.cargo/config.toml` 完全可能**带 BOM**（本机就是：DSH 代理写的那份以 `EF BB BF` 开头，
 * cargo 自己**容忍**文件开头的 BOM）。而我们把 header 拼在它前面 ⇒ 那个 BOM 落到**第 4 行行首**
 * ⇒ 不再是"文件开头"，TOML 直接解析失败：`key with no value, expected =` ⇒ 私有 `CARGO_HOME` 下
 * **任何 cargo 调用都炸**（现场：`--prepare` exit 101）。
 * ⇒ "逐字复制"要收窄成"**逐字，除了那个编码标记**"：它只在**首位**才合法。
 */
export function gmConfigToml({ realConfigText = "", copyDir }) {
  const header = [
    "# 本文件由 scripts/sm-library-build.mjs 生成（国密构建专用，**不是**仓库文件）。",
    "# 作用：让 libsqlite3-sys 走**打过补丁的私有副本**，而不是全机共享的 registry 源码。",
    "# 删除方式：node scripts/sm-library-build.mjs --revert（就是删掉 .gm-build/）。",
    "",
  ].join("\n");
  const patch = ["[patch.crates-io]", `libsqlite3-sys = { path = '${copyDir}' }`, ""].join("\n");
  // 只剥**开头**那一个 BOM（真实文件里出现的 U+FEFF 属于内容，不动它）
  const inheritedText = realConfigText.replace(/^\uFEFF/, "");
  const inherited = inheritedText.trim() ? `${inheritedText.trimEnd()}\n\n` : "";
  return `${header}${inherited}${patch}`;
}

/** 纯函数：目录符号链接的类型（Windows 用 junction：不需要管理员/开发者模式）。 */
export function registryLinkType(platform = process.platform) {
  return platform === "win32" ? "junction" : "dir";
}

/**
 * 把"国密构建要用的那份源码与 CARGO_HOME"准备好（**每次都重做**，避免复用上次打过补丁的副本）。
 *
 * @returns {{copyDir:string, copySrc:string, cargoHome:string, configPath:string, patch:object, realCargoHome:string, linked:string[]}}
 *   `copyDir` = 副本的 **crate 根**（写进 `[patch]` 的那个路径）；`copySrc` = 副本里的 `sqlcipher/`（读标记/算哈希用）。
 */
export function isolateSqlcipherSource({ repoRoot, srcDir, version, patchFile, ensurePatch }) {
  // `srcDir` 是 **sqlcipher 子目录**（里面有 `sqlite3.c`）；`[patch]` 要的是**crate 根**（有 Cargo.toml）
  // ⇒ 拷整个 crate，补丁打在副本的 `sqlcipher/` 上，TOML 指向 crate 根。
  const crateDir = dirname(srcDir);
  const crateName = basename(crateDir);
  const expected = `libsqlite3-sys-${version}`;
  if (crateName !== expected) {
    throw new Error(`isolate: 期望 crate 目录名 ${expected}，实际 ${crateDir}`);
  }
  const realCargoHome = cargoHomeOfRegistrySrc(srcDir);
  const copyDir = gmCopyDir(repoRoot, version);
  const copySrc = join(copyDir, "sqlcipher");
  const cargoHome = gmCargoHome(repoRoot);

  // ① 每次重拷：**绝不复用**上次那份（复用就等于把"上次打过补丁的副本"变成新状态）
  rmSync(gmRoot(repoRoot), { recursive: true, force: true });
  mkdirSync(copyDir, { recursive: true });
  cpSync(crateDir, copyDir, { recursive: true });

  // ② 补丁**只打在副本上**（共享 registry 一个字节都不动）
  const patch = ensurePatch(copySrc, patchFile, { apply: true });

  // ③ 私有 CARGO_HOME：继承真实 config（镜像！）＋ 我们的 patch 段
  mkdirSync(cargoHome, { recursive: true });
  const realConfigPath = join(realCargoHome, "config.toml");
  const realConfigText = existsSync(realConfigPath) ? readFileSync(realConfigPath, "utf8") : "";
  const configPath = gmConfigPath(repoRoot);
  writeFileSync(configPath, gmConfigToml({ realConfigText, copyDir }), "utf8");

  // ④ 把真实的 registry（与 git 缓存）挂进来，免得在新 CARGO_HOME 里重新下载
  const linked = [];
  const type = registryLinkType();
  for (const sub of ["registry", "git"]) {
    const target = join(realCargoHome, sub);
    if (!existsSync(target)) continue;
    symlinkSync(target, join(cargoHome, sub), type);
    linked.push(sub);
  }

  return { copyDir, copySrc, cargoHome, configPath, patch, realCargoHome, linked };
}

/** 删掉整个私有目录（`--revert` 的新语义）。返回是否真的删了东西。 */
export function removeIsolation(repoRoot) {
  const dir = gmRoot(repoRoot);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}
