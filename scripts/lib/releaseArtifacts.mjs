// 发布产物收集与校验（供 scripts/release.mjs 使用）。
//
// 这里解决的是「bundle 目录里哪些文件属于本次发布」这个问题。上一版只靠
// `文件名.includes(版本号)` 猜，四个已知风险：
//   1. 子串匹配会误纳：版本 1.84.6 会匹配到 `…_1.84.60_…`、`…11.84.6…`；
//   2. 同名同版本的旧产物（上一次 run 的 1.84.6）无法与新产物区分，会被静默发出去；
//   3. 缺 `.sig` 只 warn，然后上传循环跳过整条产物 → 安装包**静默消失**，而
//      latest.json 里却留了一个签名为空的条目 → 该平台的自动更新静默失效；
//   4. 平台上少了一个键（比如本次只构建了 Linux）会让 `latest` 通道丢掉
//      windows-x86_64 → Windows 用户从此收不到更新，且毫无提示。
// 所以这里的原则是：**宁可发布前失败，也不要在用户端才暴露**。
//
// 抽成模块的另一个目的：可被单测覆盖（scripts/lib/releaseArtifacts.test.mjs）。

import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { createReadStream } from "node:fs";
import { basename } from "node:path";
import { Blake2b512 } from "./blake2b512.mjs";

/**
 * Tauri bundle 下的产物子目录（顺序即遍历顺序）。
 *
 * `macos/` 也要收：里面是 `ShuyoNote.app`（**目录**，会被下面的后缀正则挡掉）与
 * `ShuyoNote.app.tar.gz`（macOS 的**更新通道产物**，必须收，见 `isUpdaterArchive`）。
 */
export const INSTALLER_DIRS = ["nsis", "msi", "dmg", "macos", "appimage", "deb", "rpm"];

/**
 * 产物后缀。中间产物（`.app` 目录、解包目录、其它 `.tar.gz`）依旧不算，
 * **唯一例外是 `.app.tar.gz`**——理由见 `isUpdaterArchive`。
 */
export const INSTALLER_RE = /\.(exe|msi|dmg|appimage|deb|rpm|apk|app\.tar\.gz)$/i;

/**
 * macOS 的更新通道产物 `<AppName>.app.tar.gz`。
 *
 * **为什么 darwin 的清单必须指向它、而不是 dmg**（这条是发版前最容易做错的地方）：
 * `tauri-plugin-updater` 在 macOS 上只认这个格式——`src/updater.rs` 里 macOS 的
 * `install_inner()` 直接 `GzDecoder::new(cursor)` + `tar::Archive::new(decoder)`，
 * 函数 docstring 也写明期望 `[AppName]_[version]_x64.app.tar.gz` / 里面是 `[AppName].app`。
 * 给它一个 `.dmg`（连 gzip 都不是）会解包失败：**能下载、装不上**，用户端只看到一句
 * 无关的报错。dmg 照常上传（人工下载安装用），只是**不进更新清单**。
 *
 * 文件名由 `tauri-bundler` 的 `bundle::updater_bundle` 生成：
 * `format!("{}.tar.gz", <…>/ShuyoNote.app)` ⇒ **`ShuyoNote.app.tar.gz`，不带版本号、不带架构**
 * （所以版本要靠同一次构建里的 dmg 佐证，架构要从中推出来，见 `resolveUpdaterArchiveKeys`）。
 */
export function isUpdaterArchive(name) {
  return /\.app\.tar\.gz$/i.test(name);
}

/** 条目 → 平台键列表（**可能不止一个**：universal 包一物两键）。 */
function keysOf(e) {
  return e.platformKeys ?? platformKeysFor(e.name);
}

/**
 * `.app.tar.gz` 的文件名里**既没有版本号也没有架构**，所以它的平台键只能从本次构建的
 * **dmg** 推出来。推不出来就报错，不许猜（猜错 = 把更新推给错误的架构）。
 *
 * 三种情况分别处理：
 *   ① 名字里带架构（`…aarch64.app.tar.gz`）⇒ 直接用它；
 *   ② 本次**只有一个 dmg** ⇒ 把那个 dmg 的**全部**键给它（universal dmg 是两个键，
 *      于是这一个 `.app.tar.gz` 同时占 `darwin-aarch64` 与 `darwin-x86_64`：同一个 url、同一份签名）；
 *   ③ 有多个 dmg 又没有任何架构线索 ⇒ 报错（例如分别出了 aarch64 与 x64 两个 dmg，
 *      却只有一个不带架构的 `.app.tar.gz`——无法判断它属于哪一边）。
 */
export function resolveUpdaterArchiveKeys(entries) {
  const problems = [];
  const dmgs = entries.filter((e) => /\.dmg$/i.test(e.name));
  const dmgKeys = new Set(dmgs.flatMap((e) => platformKeysFor(e.name)));
  for (const e of entries) {
    if (!isUpdaterArchive(e.name)) continue;
    const hinted = platformKeysFor(e.name);
    if (hinted.length > 0) {
      e.platformKeys = hinted;
      continue;
    }
    if (dmgs.length === 1) {
      e.platformKeys = [...dmgKeys];
      continue;
    }
    problems.push(
      dmgs.length === 0
        ? `无法判定 ${e.name} 属于哪个 macOS 架构：本次没有同版本的 dmg 可作参照（.app.tar.gz 的名字里不带架构）`
        : `无法判定 ${e.name} 属于哪个 macOS 架构：本次有 ${dmgs.length} 个 dmg（${dmgs.map((d) => d.name).join("、")}）`,
    );
  }

  // 有 dmg 却没有 `.app.tar.gz` = macOS 的自动更新必然失效（更新器只认 .app.tar.gz，
  // 见 isUpdaterArchive）。这种缺失在发布时毫无征兆、只在用户端表现为"能下载装不上"，所以硬失败。
  // 注意 universal 的 dmg 会带来**两个**键，两个键都必须被覆盖。
  const covered = new Set(entries.filter((e) => isUpdaterArchive(e.name)).flatMap((e) => keysOf(e)));
  for (const key of dmgKeys) {
    if (!covered.has(key)) {
      problems.push(
        `缺少 macOS 更新通道产物：${key} 只有 dmg 而没有 .app.tar.gz —— ` +
          `更新器（tauri-plugin-updater）在 macOS 上只解 .app.tar.gz，指向 dmg 会"能下载、装不上"。` +
          `打包时请确认 bundle.createUpdaterArtifacts 为 true 且签名私钥已配好。`,
      );
    }
  }
  return problems;
}

/**
 * Android 发版件的更新器平台键。**不要新开顶层键**：`tauri-plugin-updater` 只读
 * `platforms[<target>]`，其中 `<target>` 就是 Rust target triple（Android 上即
 * `aarch64-linux-android` 所在的 `android-aarch64` 家族命名），放进 `platforms` 里
 * 客户端才能按同一套结构取到它。
 */
export const ANDROID_PLATFORM_KEY = "android-aarch64";

/**
 * APK **没有** minisign `.sig`：它不是 `tauri` 签的，而是 `apksigner` 用 Android
 * keystore 签的（签名在 APK 内部的 META-INF 里，不是旁边的文件）。
 *
 * ⇒ 对 apk 必须开两处显式例外：① 不因缺 `.sig` 而硬失败；② 不参与「`.sig` 与字节互验」，
 *    也不上传 `.sig`。清单里该平台的 `signature` 用 **`sha256:<hex>`** 记录字节指纹
 *    （完整性由发布脚本自己算，安装时的强制签名校验由 Android 系统安装器负责）。
 */
export function isApk(name) {
  return /\.apk$/i.test(name);
}

/** 文件名后缀 → 更新器清单里的平台键（**可能不止一个**：universal 包一物两键）。 */
export function platformKeysFor(name) {
  if (/\.(exe|msi)$/i.test(name)) return ["windows-x86_64"];
  // `.app.tar.gz` 要在 dmg 之前判（两者都是 darwin）。名字里带架构就用，不带返回空数组，
  // 由 `resolveUpdaterArchiveKeys` 从同批次的 dmg 推。
  if (isUpdaterArchive(name)) {
    if (/x86_64|x64|amd64/i.test(name)) return ["darwin-x86_64"];
    if (/aarch64|arm64/i.test(name)) return ["darwin-aarch64"];
    if (/universal/i.test(name)) return ["darwin-aarch64", "darwin-x86_64"];
    return [];
  }
  if (/\.dmg$/i.test(name)) {
    // universal 的 dmg（`tauri build --target universal-apple-darwin` 产出 `…_universal.dmg`）
    // 在 Intel 与 Apple Silicon 上都能跑 ⇒ **两个键都要占**。只归一个键的后果是：
    // 另一架构的用户"检查更新什么都不发生"，且不报任何错（更新器按平台键找条目）。
    if (/universal/i.test(name)) return ["darwin-aarch64", "darwin-x86_64"];
    return [/aarch64|arm64/i.test(name) ? "darwin-aarch64" : "darwin-x86_64"];
  }
  if (/\.appimage$/i.test(name)) return [/aarch64|arm64/i.test(name) ? "linux-aarch64" : "linux-x86_64"];
  if (/\.(deb|rpm)$/i.test(name)) return ["linux-x86_64"];
  // 目前只出 arm64-v8a（见 docs/RELEASING.md §9.5），arm32/其它 ABI 的包不进这个通道。
  if (isApk(name)) return /arm64|aarch64/i.test(name) ? [ANDROID_PLATFORM_KEY] : [];
  return [];
}

/** 主键（既有调用点、说明文字用）：取平台键列表的第一个。 */
export function platformKeyFor(name) {
  return platformKeysFor(name)[0] ?? null;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 版本号作为**完整词元**匹配，而不是子串。
 *
 * 边界只排除「数字和点」——因为真实产物名用 `_` 和 `-` 分隔
 * （`ShuyoNote_1.84.6_x64-setup.exe`），若按 `\w` 排除会把 `_` 也算成词内字符，
 * 反而一个都匹配不上（这个坑当场踩过）。于是：
 * `ShuyoNote_1.84.6_x64-setup.exe` ✓、`1.84.6-beta` ✓，
 * 而 `…_1.84.60_…`、`…11.84.6…`、`…_1.84.61_…` 都不算。
 */
export function versionMatcher(version) {
  const v = escapeRe(version);
  return new RegExp(`(?<![\\d.])${v}(?![\\d.])`, "i");
}

/** 扩展名（小写），用于区分同类产物。`.app.tar.gz` 单独返回（它含两个点）。 */
export function extensionOf(name) {
  if (isUpdaterArchive(name)) return "app.tar.gz";
  const m = /\.(exe|msi|dmg|appimage|deb|rpm|apk)$/i.exec(name);
  return m ? m[1].toLowerCase() : "";
}

/**
 * 更新器清单在同一平台键下只能留一个 url，取哪个必须**写死且可预期**，不能靠遍历顺序。
 * 顺序：exe > msi（Windows）、**app.tar.gz > dmg（macOS）**、deb > appimage > rpm（Linux）、apk（Android）。
 * 选 deb 而非 AppImage 是沿用线上既有约定（1.84.5 的 latest.json 就是 deb）——
 * 两者都会挂到 release 上，只是清单指向 deb。
 *
 * ⚠️ macOS 取 `app.tar.gz` 而不是 dmg：更新器在 macOS 上只会解 `.app.tar.gz`
 * （证据见 `isUpdaterArchive` 的注释）。dmg 仍然发布，但只用于人工下载安装。
 */
export const MANIFEST_PREFERENCE = ["exe", "msi", "app.tar.gz", "dmg", "deb", "appimage", "rpm", "apk"];

/**
 * 从同一平台键的多个产物里挑出进清单的那一个，并说明为什么。
 * @returns { pick, note } pick 为 null 表示该键下没有可用产物
 */
export function pickForManifest(list) {
  if (list.length === 0) return { pick: null, note: null };
  const rank = (e) => {
    const i = MANIFEST_PREFERENCE.indexOf(extensionOf(e.name));
    return i < 0 ? MANIFEST_PREFERENCE.length : i;
  };
  const sorted = [...list].sort((a, b) => rank(a) - rank(b));
  const pick = sorted[0];
  const note =
    sorted.length > 1
      ? `${keysOf(pick).join("、")} 的更新清单指向 ${pick.name}（同平台另有 ${sorted.slice(1).map((e) => e.name).join("、")} 也一并发布，但不进清单）`
      : null;
  return { pick, note };
}

/**
 * 从候选里挑出本次要发布的产物。
 *
 * @param entries [{ dir, name, size, mtimeMs, sigPath, sigText }]（sigPath 为 null 表示缺 .sig）
 * @param version 当前版本号
 * @param explicit 显式指定的文件名列表（给定时不再依赖版本号启发式）
 * @returns { picked, problems, warnings } problems 非空即应中止发布
 */
export function selectArtifacts({ entries, version, explicit = [] }) {
  const picked = [];
  const problems = [];
  const warnings = [];
  const byName = new Map(entries.map((e) => [e.name, e]));

  if (explicit.length > 0) {
    for (const want of explicit) {
      const e = byName.get(basename(want));
      if (!e) {
        problems.push(`显式指定的产物不存在：${want}`);
        continue;
      }
      if (!INSTALLER_RE.test(e.name)) problems.push(`显式指定的产物不是安装包：${e.name}`);
      if (!versionMatcher(version).test(e.name)) warnings.push(`显式指定的产物文件名不含版本号 ${version}：${e.name}`);
      picked.push(e);
    }
  } else {
    const re = versionMatcher(version);
    const versioned = entries.filter((e) => INSTALLER_RE.test(e.name) && re.test(e.name));
    for (const e of versioned) picked.push(e);
    // `.app.tar.gz` 的名字里**没有版本号**（见 isUpdaterArchive），所以它不能靠文件名判版本；
    // 判据换成"本次构建里有一个带版本号的 macOS dmg"——那是同一次 `tauri build` 的另一半产物。
    const darwinWitness = versioned.some((e) => /\.dmg$/i.test(e.name));
    if (darwinWitness) {
      for (const e of entries) if (isUpdaterArchive(e.name) && !picked.includes(e)) picked.push(e);
    } else {
      const skipped = entries.filter((e) => isUpdaterArchive(e.name));
      if (skipped.length > 0) {
        warnings.push(
          `跳过了 ${skipped.map((e) => e.name).join("、")}：它是 macOS 的更新通道产物，文件名**不带版本号**，` +
            `而本次没有同版本的 dmg 可佐证它属于 v${version}。若本次确实要发 macOS，请确认 dmg 也构建出来了。`,
        );
      }
    }
    if (picked.length === 0) {
      problems.push(`未找到任何属于 v${version} 的安装包（bundle 目录里可能是别的版本，或构建产物没拷进来）`);
    }
  }

  // `.app.tar.gz` 的架构只能从 dmg 推（名字里没有），推不出来就报错。
  problems.push(...resolveUpdaterArchiveKeys(picked));

  // 同平台 + 同扩展名的多个候选 = 真歧义（典型的「上次 run 的同版本残留」）。
  // 注意同平台不同扩展名（.deb 与 .AppImage / .app.tar.gz 与 .dmg）是正常的：都发，清单取偏好靠前那个。
  const groups = new Map();
  for (const e of picked) {
    const keys = keysOf(e);
    if (keys.length === 0) {
      problems.push(`无法判定平台类型：${e.name}`);
      continue;
    }
    // 一个产物可能占**多个**平台键（universal 的 dmg / .app.tar.gz）⇒ 每个键下都要归一次。
    for (const key of keys) {
      const k = `${key}\u0000${extensionOf(e.name)}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(e);
    }
  }
  for (const [k, list] of groups) {
    if (list.length > 1) {
      problems.push(
        `平台 ${k.split("\u0000")[0]} 下有 ${list.length} 个同类候选，无法确定发哪个（同版本残留时请用 --artifacts 显式指定）：` +
          list.map((e) => `${e.name}(${fmtSize(e.size)}, ${fmtTime(e.mtimeMs)})`).join("、"),
      );
    }
  }

  // 缺 .sig 是硬错误：发布出去会让该平台的自动更新静默失效。
  // **例外：apk**——它的签名在包内（apksigner），本来就没有旁边的 `.sig`；
  // 清单里用 sha256 记录字节，见 isApk 的注释。
  for (const e of picked) {
    if (isApk(e.name)) continue;
    if (!e.sigPath) problems.push(`缺签名文件：${e.name}.sig（没有它就不能进更新通道）`);
    else if (!e.sigText || e.sigText.trim() === "") problems.push(`签名文件为空：${e.name}.sig`);
  }

  return { picked, problems, warnings };
}

/** 按平台键归组，给出各自的清单候选与说明（供发布时打印与写 latest.json）。 */
export function manifestPicks(picked) {
  const groups = new Map();
  for (const e of picked) {
    // 一个产物可能占**多个**平台键：universal 的 dmg / `.app.tar.gz` ⇒ 两个 darwin 键
    // 都指向同一个文件（同一 url、同一签名）——这正是 universal 该有的样子。
    for (const key of keysOf(e)) {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    }
  }
  const out = new Map();
  const notes = [];
  for (const [key, list] of groups) {
    const { pick, note } = pickForManifest(list);
    if (pick) out.set(key, pick);
    if (note) notes.push(note);
  }
  return { picks: out, notes };
}

/** 与上一次已发布的清单比较，避免悄悄砍掉某个平台的更新通道。 */
export function coverageProblems({ previousKeys, nextKeys }) {
  const next = new Set(nextKeys);
  return (previousKeys ?? []).filter((k) => !next.has(k)).map((k) => `本次清单里没有 ${k}，但线上已经有它——发布会让该平台收不到更新`);
}

/**
 * `--android-apk <路径>` 的检查（apk 不在 bundle 目录里，走独立入口，因此单独校验）。
 *
 * Android 包只能由 CI 产出（本机 Windows 出不了，见 docs/RELEASING.md §9 开头），
 * 所以发版时必须显式把它拿过来；缺了就**硬失败**——否则 Android 的更新通道会静默消失，
 * 而这种缺失在发布时毫无征兆。要明确跳过只能写 `--no-android`（与 `--allow-platform-drop`
 * 同一套哲学：逃生口必须显式、且能被事后审计）。
 */
export function androidApkProblems({ name, version, exists, statIsFile }) {
  const problems = [];
  const warnings = [];
  if (!name) return { problems: [`未提供 Android 发版件（--android-apk <路径>）。` + ANDROID_APK_HOWTO], warnings };
  if (!exists || statIsFile === false) {
    return { problems: [`Android 发版件不存在或不是普通文件：${name}。` + ANDROID_APK_HOWTO], warnings };
  }
  if (!isApk(name)) problems.push(`--android-apk 给的不是 .apk：${name}`);
  if (!versionMatcher(version).test(name)) {
    // 只警告不硬失败：CI 的 artifact 名字里带版本，但手工拿的包未必。
    warnings.push(`Android 发版件文件名不含本次版本号 ${version}：${name}（确认拿的是这次的包，别发上次的）`);
  }
  return { problems, warnings };
}

/** 缺 APK 时的可操作提示（贴在错误信息后面，别让人去猜怎么拿包）。 */
export const ANDROID_APK_HOWTO =
  `拿包方式（本机 Windows 出不了 Android 包，一律从 CI 取）：` +
  `① GitHub Actions 里该 tag 的 run → artifact android-release-apk（含 ShuyoNote_<版本>_android-arm64-release.apk 与同名 .sha256，保留 14 天）；` +
  `② 或从 GitHub Release 的资产里下同名 apk（见 docs/RELEASING.md ⑤ 的下载说明）；` +
  `③ 确实要这次不带 Android：加 --no-android（Android 用户本轮收不到新版本，会被记录在案）。`;

/** 解析 minisign 公钥（tauri.conf.json 的 `plugins.updater.pubkey`，整份公钥文件的 base64）。 */
export function parseMinisignPublicKey(pubkeyB64) {
  const text = Buffer.from(pubkeyB64, "base64").toString("utf8").trim();
  const b64 = text.split("\n").find((l) => l && !l.startsWith("untrusted comment"));
  if (!b64) throw new Error("公钥内容里找不到 base64 主体");
  const blob = Buffer.from(b64, "base64");
  if (blob.length !== 42) throw new Error(`公钥长度异常：${blob.length}（应为 42）`);
  return { alg: blob.subarray(0, 2).toString(), keyId: blob.subarray(2, 10).toString("hex"), raw: blob.subarray(10, 42) };
}

/**
 * 解析 Tauri 写出的 `.sig`。
 * 注意它有**两层** base64：外层是 minisign 文本的 base64，内层是签名 blob。
 */
export function parseMinisignSignature(sigText) {
  const outer = sigText.trim();
  const text = outer.startsWith("untrusted comment") ? outer : Buffer.from(outer, "base64").toString("utf8");
  const lines = text.trim().split("\n");
  const blob = Buffer.from(lines[1] ?? "", "base64");
  if (blob.length !== 74) throw new Error(`签名 blob 长度异常：${blob.length}（应为 74）`);
  const trustedComment = lines[2] ?? "";
  const m = /(?:^|\t)file:(.+)$/.exec(trustedComment);
  return {
    alg: blob.subarray(0, 2).toString(),
    keyId: blob.subarray(2, 10).toString("hex"),
    signature: blob.subarray(10, 74),
    trustedComment,
    signedFileName: m ? basename(m[1].trim()) : null,
  };
}

function ed25519PublicKey(raw32) {
  // 裸 32 字节 ed25519 公钥包一层 SPKI DER 头，Node 才认
  return createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw32]),
    format: "der",
    type: "spki",
  });
}

export async function sha256File(filePath) {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(filePath, { highWaterMark: 1 << 20 })) h.update(chunk);
  return h.digest("hex");
}

/**
 * 校验 `.sig` 确实是**这几个字节**的签名（Tauri 更新器做的就是这件事）。
 *
 * 返回值 status：
 *   `ok`          通过
 *   `mismatch`    明确不匹配（该中止发布）
 *   `unsupported` 签名/公钥格式不认识（只警告，不阻断——避免将来格式变化卡死发布）
 */
export async function verifyArtifactSignature({ filePath, sigText, publicKey }) {
  let sig, key;
  try {
    sig = parseMinisignSignature(sigText);
    key = typeof publicKey === "string" ? parseMinisignPublicKey(publicKey) : publicKey;
  } catch (e) {
    return { status: "unsupported", detail: `无法解析：${e.message}` };
  }
  const name = basename(filePath);
  if (sig.keyId !== key.keyId) {
    return { status: "mismatch", detail: `签名 keyId ${sig.keyId} 与配置公钥 ${key.keyId} 不一致（不是这把密钥签的）` };
  }
  if (sig.signedFileName && sig.signedFileName !== name) {
    return { status: "mismatch", detail: `签名是为 ${sig.signedFileName} 做的，却拿来配 ${name}` };
  }
  if (sig.alg === "ED") {
    const h = new Blake2b512();
    for await (const chunk of createReadStream(filePath, { highWaterMark: 1 << 20 })) h.update(chunk);
    if (cryptoVerify(null, h.digest(), ed25519PublicKey(key.raw), sig.signature)) return { status: "ok" };
    return { status: "mismatch", detail: "文件摘要的 ed25519 签名校验失败（安装包与 .sig 很可能不是同一次构建的产物）" };
  }
  if (sig.alg === "Ed") {
    const chunks = [];
    for await (const chunk of createReadStream(filePath, { highWaterMark: 1 << 20 })) chunks.push(chunk);
    if (cryptoVerify(null, Buffer.concat(chunks), ed25519PublicKey(key.raw), sig.signature)) return { status: "ok" };
    return { status: "mismatch", detail: "原始字节的 ed25519 签名校验失败（安装包与 .sig 很可能不是同一次构建的产物）" };
  }
  return { status: "unsupported", detail: `未知的签名算法标识 ${JSON.stringify(sig.alg)}` };
}

/**
 * 写盘前的清单门禁：**每个平台条目必须同时有 `url` 与 `signature`**。
 *
 * 为什么这条非有不可（不是"更保险一点"，是防一个会连坐的地雷）：
 * `tauri-plugin-updater` 反序列化 `latest.json` 时把 `platforms` 的值解析成一个
 * **每个字段都必需**的结构（`url: Url` + `signature: String`）。只要**任何一个**平台键
 * 少了 `signature`（或写成空串导致解析失败），**整份 latest.json 解析就失败**——
 * 于是不光是新加的那个平台，**桌面的自动更新也一起挂**，而症状是"检查更新什么都不发生"。
 *
 * 这正是本轮 Android 条目最容易踩的地方：APK 没有 minisign `.sig`，最省事的做法是
 * 干脆不写 `signature` 字段——那一下就把桌面更新通道一起带走了。所以这里写死：
 * 缺字段 = 发布中止。apk 的 `signature` 用 `sha256:<hex>` 顶上（多出来的字段无害）。
 *
 * @param manifest 即将写盘的 latest.json 对象
 * @returns { problems, warnings } problems 非空即应中止发布
 */
export function validateManifest(manifest) {
  const problems = [];
  const warnings = [];
  if (!manifest || typeof manifest !== "object") return { problems: ["清单不是对象"], warnings };
  if (typeof manifest.version !== "string" || manifest.version.trim() === "") {
    problems.push("清单缺 version（客户端拿不到版本号，等于没有更新通道）");
  }
  const platforms = manifest.platforms;
  if (!platforms || typeof platforms !== "object" || Array.isArray(platforms)) {
    return { problems: [...problems, "清单缺 platforms 对象"], warnings };
  }
  const keys = Object.keys(platforms);
  if (keys.length === 0) problems.push("platforms 为空（任何平台都收不到更新）");
  for (const key of keys) {
    const e = platforms[key];
    const at = `platforms["${key}"]`;
    if (!e || typeof e !== "object") {
      problems.push(`${at} 不是对象`);
      continue;
    }
    // url：必须是非空字符串，且必须是**绝对 https**。相对地址在客户端解析失败；
    // http 会被 updater 拒绝（且属于明文传输安装包）。
    if (typeof e.url !== "string" || e.url.trim() === "") problems.push(`${at}.url 缺失或为空`);
    else if (!/^https:\/\/[^\s]+$/i.test(e.url.trim())) problems.push(`${at}.url 必须是绝对 https 地址：${e.url}`);
    if (typeof e.signature !== "string" || e.signature.trim() === "") {
      // 这条就是那个连坐地雷：缺它 ⇒ 整个 latest.json 反序列化失败 ⇒ 桌面更新通道一起挂。
      problems.push(`${at}.signature 缺失或为空（tauri-plugin-updater 会把每个平台条目解析成 url+signature 必需的结构；缺一个就会让**整份清单**解析失败，桌面更新通道一起挂）`);
    } else if (key === ANDROID_PLATFORM_KEY && !/^sha256:[0-9a-f]{64}$/.test(e.signature.trim())) {
      // Android 不是 minisign 签名（apk 的签名在包内、由系统安装器强制），清单里记字节指纹。
      problems.push(`${at}.signature 应为 sha256:<64 位 hex>（apk 没有 minisign 签名，用字节指纹顶替）：${e.signature}`);
    }
  }
  return { problems, warnings };
}

export function fmtSize(bytes) {
  return `${(bytes / 1048576).toFixed(2)} MB`;
}

export function fmtTime(ms) {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16) + "Z";
}
