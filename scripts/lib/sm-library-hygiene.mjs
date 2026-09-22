// 「共享 registry 上有没有留下国密补丁」—— **只读**的状态读取 ＋ 把后果变成可判定的三档。
//
// ## 为什么要有它（方案 §五：「macOS-only 风险：补丁留在共享 registry 上」，归属 AMD）
//
// 补丁打在**全机共享**的 `libsqlite3-sys-<v>/sqlcipher/sqlite3.c` 上，而 `sm-library-build.mjs`
// **刻意不自动还原**（理由见它收尾横幅：自动还原会造出"源码是 AES、产物是 SM4"的**新**静默态）。
// 于是"跑过一次国密构建、忘了 `--revert`"会把这台机器留在一个**看不见的状态**里：
//
//   · **macOS**（默认后端 CommonCrypto）：后续**默认**构建红 **12＋7** 条，而现场长得像「加密库坏了」
//     （`PRAGMA key = "x'…'"` 被拒）—— 不是一眼能认出「这是补丁残留」；
//   · **Linux / Windows**（默认后端本来就是 OpenSSL）：不红，但后续默认构建**静默**改成写 SM4 页。
//
// 原先唯一的防线是"收尾横幅 ＋ 人的纪律"。这个模块把**状态**变成可只读读出的东西，
// 把**后果**变成可判定的三档（`ok` / `notice` / `block`），再由 `scripts/check-gm-registry-clean.mjs`
// 接成常开门禁 —— 纪律变成断言。
//
// ## ⚠️ 只读是硬要求（这里踩过一次）
//
// `sm-library-build.mjs` 的 `--print-source-sha256` / `--require-static` / `--print-env` 都会
// **先幂等打补丁再干活**（2026-09-22 AMD 实测：想"核一下源码状态"，结果把源码变成了打过补丁的样子，
// 于是"我刚还原过"那句话当场变成假的）。本模块**绝不写盘** —— 判据里有一条专门钉它
// （读之前 / 读之后逐字节比对）。
import { readFileSync } from "node:fs";

import { MARKER, markerFileOf, resolveSqlcipherSource } from "./sm-library-source.mjs";

/** 补丁 v3 起写进源码的那一行：页加密由它决定（`cipher_settings` 回显里**没有** algorithm 字段）。 */
const CIPHER_DEFINE = "#define OPENSSL_CIPHER";

/**
 * 从 `sqlite3.c` 的文本里读**这份源码会编出哪种页加密**。
 *
 * 与 `sm-library-build.mjs` 收尾横幅里那段同口径（那里也读这一行）：补丁把 `OPENSSL_CIPHER`
 * 无条件改成 `EVP_sm4_cbc()` ⇒ 这行是**构建期唯一能回答**「写 SM4 页还是 AES 页」的地方。
 */
export function pageCipherOf(sqlite3cText) {
  for (const line of String(sqlite3cText ?? "").split("\n")) {
    const t = line.trim();
    if (!t.startsWith(CIPHER_DEFINE)) continue;
    if (t.includes("EVP_sm4_cbc")) return "sm4";
    if (t.includes("EVP_aes_256_cbc")) return "aes";
    return "other";
  }
  return "unknown";
}

/**
 * **只读**读一次共享 registry 的当前状态。
 *
 * 返回（**永不抛**，也**永不写盘**）：
 *   · `{ ok:true, srcDir, version, patched, pageCipher, markerFile }`
 *   · `{ ok:false, reason, message }` —— **"读不出来"不是"不干净"**：
 *     没跑过任何 cargo（registry 空的）、拿不到 `Cargo.lock` 等，都属于这一支 ⇒ 调用方据此只提示、
 *     **不判红**（与 `check-crypto-backend` 的"旧产物 ⇒ 未实查"同一条口径）。
 */
export function registryStateOf({ lockPath, cargoHome, roots } = {}) {
  let pick;
  try {
    pick = resolveSqlcipherSource({ lockPath, cargoHome, roots });
  } catch (e) {
    return { ok: false, reason: e?.code ?? "resolve-failed", message: e?.message ?? String(e) };
  }
  let sqlite3c = "";
  try {
    sqlite3c = readFileSync(`${pick.dir}/sqlite3.c`, "utf8");
  } catch {
    sqlite3c = ""; // 读不到就当"未知页加密"，不影响"补丁在不在"这个主判据
  }
  const markerFile = markerFileOf(pick.dir);
  return {
    ok: true,
    srcDir: pick.dir,
    version: pick.version,
    patched: markerFile !== null,
    markerFile,
    pageCipher: pageCipherOf(sqlite3c),
  };
}

/**
 * 纯函数：把状态 ＋ "这次要编什么"翻成三档。
 *
 * @param featureSmLibrary 这次构建**带不带** `--features sm-library`（默认语境的默认值＝不带）
 * @returns `{ level: "ok" | "notice" | "block", why: string }`
 *
 * 为什么只有 macOS 判 `block`：那 12＋7 条红是 **CommonCrypto 默认后端**的确定性后果，
 * 且**现场不像补丁问题**（像加密库坏了）⇒ 值得直接拦住并给出那一行修法。
 * Linux/Windows 上同样的状态**不会红**，只是把后续构建悄悄改成 SM4 页 ⇒ 该说、但不该假装它红。
 */
export function hygieneVerdict({
  patched,
  pageCipher = "unknown",
  platform = process.platform,
  featureSmLibrary = false,
} = {}) {
  const revert = "node scripts/sm-library-build.mjs --revert";
  if (!patched) {
    return { level: "ok", why: `共享 registry 是原版（源码里没有 \`${MARKER}\` 标记）` };
  }
  if (featureSmLibrary) {
    return { level: "ok", why: "源码带补丁，而这次就是 `sm-library` 构建 —— 这正是要的状态" };
  }
  if (platform === "darwin") {
    return {
      level: "block",
      why:
        "共享 registry 的 SQLCipher 源码**留着国密补丁**，而这次不是 `sm-library` 构建" +
        `（page_cipher=${pageCipher}）。macOS 的平台默认后端是 **CommonCrypto**，它只有 AES ⇒ ` +
        "随后任何**默认**构建会红 **12＋7** 条，而现场长得像「加密库坏了」（`PRAGMA key = \"x'…'\"` 被拒），" +
        "不是一眼能认出「这是补丁残留」。修法：" +
        `\`${revert}\``,
    };
  }
  return {
    level: "notice",
    why:
      "共享 registry 的 SQLCipher 源码**留着国密补丁**，而这次不是 `sm-library` 构建" +
      `（page_cipher=${pageCipher}）—— 本平台后端本来就是 OpenSSL，**不会红**，但后续默认构建会被` +
      `**静默**改成写 SM4 页。跑默认门禁前建议：\`${revert}\``,
  };
}
