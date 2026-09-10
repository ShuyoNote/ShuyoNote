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

/** Tauri bundle 下的产物子目录（顺序即遍历顺序）。 */
export const INSTALLER_DIRS = ["nsis", "msi", "dmg", "appimage", "deb", "rpm"];

/** 安装包后缀（中间产物如 `.app`、解包目录、`.tar.gz` 一律不算）。 */
export const INSTALLER_RE = /\.(exe|msi|dmg|appimage|deb|rpm)$/i;

/** 文件名后缀 → 更新器清单里的平台键。 */
export function platformKeyFor(name) {
  if (/\.(exe|msi)$/i.test(name)) return "windows-x86_64";
  if (/\.dmg$/i.test(name)) return /aarch64|arm64/i.test(name) ? "darwin-aarch64" : "darwin-x86_64";
  if (/\.appimage$/i.test(name)) return /aarch64|arm64/i.test(name) ? "linux-aarch64" : "linux-x86_64";
  if (/\.(deb|rpm)$/i.test(name)) return "linux-x86_64";
  return null;
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

/** 扩展名（小写），用于区分同类产物。 */
export function extensionOf(name) {
  const m = /\.(exe|msi|dmg|appimage|deb|rpm)$/i.exec(name);
  return m ? m[1].toLowerCase() : "";
}

/**
 * 更新器清单在同一平台键下只能留一个 url，取哪个必须**写死且可预期**，不能靠遍历顺序。
 * 顺序：exe > msi（Windows）、deb > appimage > rpm（Linux）、dmg（macOS）。
 * 选 deb 而非 AppImage 是沿用线上既有约定（1.84.5 的 latest.json 就是 deb）——
 * 两者都会挂到 release 上，只是清单指向 deb。
 */
export const MANIFEST_PREFERENCE = ["exe", "msi", "dmg", "deb", "appimage", "rpm"];

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
      ? `${platformKeyFor(pick.name)} 的更新清单指向 ${pick.name}（同平台另有 ${sorted.slice(1).map((e) => e.name).join("、")} 也一并发布，但不进清单）`
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
    for (const e of entries) {
      if (INSTALLER_RE.test(e.name) && re.test(e.name)) picked.push(e);
    }
    if (picked.length === 0) {
      problems.push(`未找到任何属于 v${version} 的安装包（bundle 目录里可能是别的版本，或构建产物没拷进来）`);
    }
  }

  // 同平台 + 同扩展名的多个候选 = 真歧义（典型的「上次 run 的同版本残留」）。
  // 注意同平台不同扩展名（.deb 与 .AppImage）是正常的：两个都发，清单取 deb。
  const groups = new Map();
  for (const e of picked) {
    const key = platformKeyFor(e.name);
    if (!key) {
      problems.push(`无法判定平台类型：${e.name}`);
      continue;
    }
    const k = `${key}\u0000${extensionOf(e.name)}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
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
  for (const e of picked) {
    if (!e.sigPath) problems.push(`缺签名文件：${e.name}.sig（没有它就不能进更新通道）`);
    else if (!e.sigText || e.sigText.trim() === "") problems.push(`签名文件为空：${e.name}.sig`);
  }

  return { picked, problems, warnings };
}

/** 按平台键归组，给出各自的清单候选与说明（供发布时打印与写 latest.json）。 */
export function manifestPicks(picked) {
  const groups = new Map();
  for (const e of picked) {
    const key = platformKeyFor(e.name);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
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

export function fmtSize(bytes) {
  return `${(bytes / 1048576).toFixed(2)} MB`;
}

export function fmtTime(ms) {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16) + "Z";
}
