// 单文档包 `.shuyodoc` 的**格式层纯函数**（M1 第一步；方案见 `docs/plans/2026-10-29-shuyodoc-m1.md`）。
//
// 这一层**不碰 zip、不碰数据库、不碰 UI** —— 只做四件事，每件都能单测：
//   ① manifest 校验 / 写出（对齐企业版规范：source / source_app_version / document_id /
//      created_at / updated_at / content_type / encrypted 全部认识；⛔ 不认识的版本直接拒绝 ✗）；
//   ② `checksums.json` 的生成与校验（**结构与算法逐字照企业版**
//      `workbench/lib/package-format.mjs` 的 `checksumsFor` / `readPackage`）；
//   ③ 条目路径安全（zip-slip / 绝对路径 / 反斜杠 / Windows 保留字符）；
//   ④ 资产自证（sha256 内容寻址 ＋ 大小上限）。
//
// 跨版口径（企业版 = 只读参考 `repos/shuyonote-enterprise-client`）：
//   · manifest 企业版必填：format / format_version / source / source_app_version /
//     document_id / title / created_at / updated_at / content_type / encrypted；
//     个人版旧包只有 format / format_version / title / created / updated / assets ⇒ **缺失时给兼容默认**；
//   · 企业版 manifest **没有 assets 字段**（资产在 `assets/<sha256>.<ext>`，靠文件名内容寻址），
//     所以这里**不再强制 assets 数组**（缺省 = []）；但**给了就必须 path 与 sha 一致**（旧校验保留）；
//   · `checksums.json` 结构（企业版逐字）：
//       { "format": "shuyonote.checksums", "version": 1, "algorithm": "sha256",
//         "files": { "<包内相对路径>": "<该文件字节的 sha256 小写 hex>" } }
//     生成规则：包里**除 checksums.json 自己以外**每个条目都登记，key 按 localeCompare 排序；
//     校验规则：登记了但包里没有 / 有文件没登记 / sha 对不上 ⇒ 全部点名（整包拒绝，⛔ 不静默通过）。
//
// ⚠️ 导入侧的红线：**任何一条不过 ⇒ 整个包拒绝**，⛔ 不许"导一半"、⛔ 不许静默跳过条目 ✗。
// ⚠️ 校验失败必须能点名「哪个条目、为什么」（返回的 `error` 就是那句人话，UI 直接显示）。

export const DOC_FORMAT = "shuyonote.document";
export const DOC_FORMAT_VERSION = 1;
export const DOC_MIME = "application/vnd.shuyonote.document+zip";
export const DOC_EXTENSION = ".shuyodoc";

/** 企业版 `CHECKSUMS_FORMAT` 逐字一致（`workbench/lib/package-format.mjs`）。 */
export const CHECKSUMS_FORMAT = "shuyonote.checksums";
export const CHECKSUMS_VERSION = 1;
export const CHECKSUMS_ALGORITHM = "sha256";

/** 包内固定条目名（企业版规范 §2）。 */
export const MANIFEST_PATH = "manifest.json";
export const CONTENT_PATH = "content.json";
export const CHECKSUMS_PATH = "checksums.json";
export const SIGNATURE_PATH = "signature.json";
/** 企业版可选文件（M1 不导入评论：如实提示 + 原文带回，⛔ 不静默丢弃）。 */
export const COMMENTS_PATH = "comments.json";

/** v1 唯一的正文类型（企业版 manifest 的 `content_type` 取值）。 */
export const CONTENT_TYPE_LEXICAL = "lexical-json";

/** 本版读端支持的最高 `min_reader_version`（v1.1 裁决）。 */
export const READER_VERSION = "1.1";

/** simple semver compare（a > b）。 */
export function versionGt(a: string, b: string): boolean {
  const pa = a.split(".").map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

/**
 * ⭐ M1.1 写侧硬拒（§9 S8）：非法路径/NFC 非规范化/大小写冲突/尾点尾空格/资产扩展名非小写。
 * 读侧 v1 仍只 warning（见 `openDocumentPackage` 的 notices），⛔ 不做行为变更。
 */
export function checkWritePaths(files: PackageFile[]): string | null {
  const seen = new Map<string, string>();
  for (const f of files) {
    const p = f.path;
    const bad = checkEntryPath(p);
    if (bad) return `${p} ${bad}`;
    if (p.normalize("NFC") !== p) return `${p} 不是 NFC 规范化路径（写侧硬拒）`;
    for (const seg of p.split("/")) {
      if (seg.endsWith(".") || seg.endsWith(" ")) return `${p} 的路径段以点/空格结尾（写侧硬拒）`;
    }
    const lower = p.toLowerCase();
    const prev = seen.get(lower);
    if (prev && prev !== p) return `${p} 与 ${prev} 仅大小写不同（写侧硬拒）`;
    seen.set(lower, p);
    if (p.startsWith("assets/")) {
      const base = p.slice("assets/".length);
      const dot = base.lastIndexOf(".");
      const ext = dot < 0 ? "" : base.slice(dot + 1);
      if (!ext || ext !== ext.toLowerCase()) return `${p} 的资产扩展名必须小写（写侧硬拒）`;
    }
  }
  return null;
}

/** 单文件上限 50 MB ／ 整包上限 200 MB（M1 的临时口径，方案里标了「待定」）。 */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 200 * 1024 * 1024;

export interface DocAsset {
  /** 包内相对路径，必须是 `assets/<sha256>.<ext>` 的形状（内容寻址）。 */
  path: string;
  sha256: string;
  size: number;
  mime?: string;
}

/** 包内一个条目（路径 + 字节）；`bytes` 允许字符串（按 UTF-8 计 sha，企业版同口径）。 */
export interface PackageFile {
  path: string;
  bytes: Uint8Array | string;
}

export interface DocManifest {
  format: typeof DOC_FORMAT;
  format_version: number;
  title: string;
  /** 来源（企业版规范 `personal|enterprise`）；旧个人包缺省 ⇒ `"personal"`。 */
  source: string;
  /** 来源应用版本；旧个人包没有这个字段 ⇒ 缺省（`undefined`）。 */
  source_app_version?: string;
  /** 文档 id（企业版必填）；旧个人包没有 ⇒ 缺省。 */
  document_id?: string;
  /** 企业版时间字段；旧个人包用 `created` / `updated` ⇒ 这里回填。 */
  created_at?: string;
  updated_at?: string;
  /** v1 只读 `lexical-json`。 */
  content_type: string;
  /** v1.1 可选：声明的特性（读侧只做形状校验；不认识的写进 notices）。 */
  features?: string[];
  /** v1.1 可选：> 本版（1.1）⇒ 拒收并提示升级。 */
  min_reader_version?: string;
  /** v1.1 可选：**存在也不验**（企业 v1 读端忽略未知字段；强制验属 v2）。 */
  checksums_sha256?: string;
  /** 企业版当前只写 `false`；`true` ⇒ 个人版没有解密能力，**整包拒绝**。 */
  encrypted: boolean;
  /** 旧个人包字段（仍然读；导出时不再写）。 */
  created?: string;
  updated?: string;
  /** 旧个人包显式资产清单；企业版包没有该字段 ⇒ 缺省 `[]`（资产从 `assets/` 条目发现）。 */
  assets: DocAsset[];
}

export type ManifestResult = { ok: true; manifest: DocManifest } | { ok: false; error: string };

const SHA_RE = /^[0-9a-f]{64}$/;

/** 资产条目的校验（旧个人包显式清单用）。 */
function parseAssetList(raw: unknown[]): { ok: true; assets: DocAsset[] } | { ok: false; error: string } {
  const assets: DocAsset[] = [];
  for (const [i, a] of raw.entries()) {
    if (typeof a !== "object" || a === null) return { ok: false, error: `assets[${i}] 不是对象` };
    const o = a as Record<string, unknown>;
    if (typeof o.path !== "string") return { ok: false, error: `assets[${i}].path 缺失` };
    if (typeof o.sha256 !== "string" || !SHA_RE.test(o.sha256)) {
      return { ok: false, error: `assets[${i}].sha256 不是 64 位小写十六进制（${String(o.sha256)}）` };
    }
    if (typeof o.size !== "number" || !Number.isFinite(o.size) || o.size < 0) {
      return { ok: false, error: `assets[${i}].size 不是非负数字` };
    }
    const pathErr = checkEntryPath(o.path);
    if (pathErr) return { ok: false, error: `assets[${i}].path ${pathErr}` };
    // 内容寻址：文件名必须就是那个 sha（⛔ 允许"路径和 sha 各说各话" ✗）
    const base = o.path.split("/").pop() ?? "";
    if (!base.startsWith(o.sha256)) {
      return { ok: false, error: `assets[${i}].path 与 sha256 不一致（路径 ${o.path}，sha ${o.sha256}）` };
    }
    assets.push({ path: o.path, sha256: o.sha256, size: o.size, mime: typeof o.mime === "string" ? o.mime : undefined });
  }
  return { ok: true, assets };
}

/**
 * 校验 manifest（**未知版本直接拒绝**：将来 v2 由 v2 的读取器负责，⛔ 不向下猜 ✗）。
 *
 * 兼容口径（企业版 ◀▶ 个人版）：
 *   · `source` 缺省 `"personal"`、`encrypted` 缺省 `false`、`content_type` 缺省 `"lexical-json"`；
 *   · `assets` **不再强制**（企业版包没有该字段 ⇒ 缺省 `[]`）；给了就必须是数组且逐条自证；
 *   · 企业版字段（document_id / created_at / updated_at / source_app_version）缺省 ⇒ `undefined`；
 *   · `created_at` / `updated_at` 缺失时回填旧字段 `created` / `updated`（旧个人包）。
 */
export function parseManifest(raw: unknown): ManifestResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: "manifest.json 不是对象" };
  const m = raw as Record<string, unknown>;
  if (m.format !== DOC_FORMAT) {
    return { ok: false, error: `不是文档包（manifest.format=${String(m.format)}，要求 ${DOC_FORMAT}）` };
  }
  if (m.format_version !== DOC_FORMAT_VERSION) {
    return {
      ok: false,
      error: `包版本不认识（manifest.format_version=${String(m.format_version)}，本版只读 ${DOC_FORMAT_VERSION}）`,
    };
  }
  if (typeof m.title !== "string" || m.title.trim() === "") return { ok: false, error: "manifest.title 缺失或为空" };

  // ── 企业版字段：给了就校验类型/取值；没给给兼容默认 ──
  if (m.source !== undefined && (typeof m.source !== "string" || m.source === "")) {
    return { ok: false, error: "manifest.source 必须是非空字符串（企业版规范 personal|enterprise）" };
  }
  if (m.source_app_version !== undefined && typeof m.source_app_version !== "string") {
    return { ok: false, error: "manifest.source_app_version 必须是字符串" };
  }
  if (m.document_id !== undefined && (typeof m.document_id !== "string" || m.document_id === "")) {
    return { ok: false, error: "manifest.document_id 必须是非空字符串" };
  }
  for (const key of ["created_at", "updated_at"] as const) {
    if (m[key] !== undefined && typeof m[key] !== "string") return { ok: false, error: `manifest.${key} 必须是字符串` };
  }
  if (m.content_type !== undefined && typeof m.content_type !== "string") {
    return { ok: false, error: "manifest.content_type 必须是字符串" };
  }
  if (m.features !== undefined) {
    if (!Array.isArray(m.features) || m.features.some((x) => typeof x !== "string")) {
      return { ok: false, error: "manifest.features 必须是字符串数组" };
    }
  }
  if (m.min_reader_version !== undefined && typeof m.min_reader_version !== "string") {
    return { ok: false, error: "manifest.min_reader_version 必须是字符串" };
  }
  if (m.checksums_sha256 !== undefined && typeof m.checksums_sha256 !== "string") {
    return { ok: false, error: "manifest.checksums_sha256 必须是字符串" };
  }
  const contentType = typeof m.content_type === "string" ? m.content_type : CONTENT_TYPE_LEXICAL;
  if (contentType !== CONTENT_TYPE_LEXICAL) {
    return { ok: false, error: `manifest.content_type 不认识（${contentType}，本版只读 ${CONTENT_TYPE_LEXICAL}）` };
  }
  if (m.encrypted !== undefined && typeof m.encrypted !== "boolean") {
    return { ok: false, error: "manifest.encrypted 必须是布尔" };
  }
  const encrypted = m.encrypted === true;
  if (encrypted) {
    return { ok: false, error: "加密包（manifest.encrypted=true）：本版没有解密能力，整包拒绝" };
  }

  // ── 资产清单：旧个人包有；企业版没有 ⇒ 缺省 []（资产由打开层从 assets/ 条目发现） ──
  let assets: DocAsset[] = [];
  if (m.assets !== undefined) {
    if (!Array.isArray(m.assets)) return { ok: false, error: "manifest.assets 必须是数组" };
    const parsed = parseAssetList(m.assets);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    assets = parsed.assets;
  }

  const legacyCreated = typeof m.created === "string" ? m.created : undefined;
  const legacyUpdated = typeof m.updated === "string" ? m.updated : undefined;
  return {
    ok: true,
    manifest: {
      format: DOC_FORMAT,
      format_version: DOC_FORMAT_VERSION,
      title: m.title,
      source: typeof m.source === "string" ? m.source : "personal",
      source_app_version: typeof m.source_app_version === "string" ? m.source_app_version : undefined,
    ...(Array.isArray(m.features) ? { features: m.features as string[] } : {}),
    ...(typeof m.min_reader_version === "string" ? { min_reader_version: m.min_reader_version } : {}),
    ...(typeof m.checksums_sha256 === "string" ? { checksums_sha256: m.checksums_sha256 } : {}),
      document_id: typeof m.document_id === "string" ? m.document_id : undefined,
      created_at: typeof m.created_at === "string" ? m.created_at : legacyCreated,
      updated_at: typeof m.updated_at === "string" ? m.updated_at : legacyUpdated,
      content_type: contentType,
      encrypted,
      created: legacyCreated,
      updated: legacyUpdated,
      assets,
    },
  };
}

export interface BuildManifestInput {
  documentId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  sourceAppVersion: string;
  /** 缺省 `"personal"`（个人版导出自己的包）。 */
  source?: string;
  content_type?: string;
  /** 只接受 `false`（个人版没有加密能力，⛔ 不写假加密包）。 */
  encrypted?: boolean;
  /** 可选：旧个人包风格的显式资产清单（企业版读端会忽略这个多余字段）。 */
  assets?: DocAsset[];
}

/**
 * **写出** manifest.json（个人版导出用；带全企业版必填字段）。
 *
 * 字段顺序与企业版 `buildDocumentPackage` 一致；`assets` 是个人版扩展字段
 * （旧个人版读端要求它在，企业版读端忽略未知字段 —— 2026-10-29 实地验过）。
 */
export function buildManifest(input: BuildManifestInput): DocManifest {
  if (typeof input?.documentId !== "string" || input.documentId === "") throw new Error("buildManifest: documentId 必须是非空字符串");
  if (typeof input.title !== "string" || input.title.trim() === "") throw new Error("buildManifest: title 必须是非空字符串");
  for (const key of ["createdAt", "updatedAt", "sourceAppVersion"] as const) {
    if (typeof input[key] !== "string" || input[key] === "") throw new Error(`buildManifest: ${key} 必须是非空字符串`);
  }
  const source = input.source ?? "personal";
  if (typeof source !== "string" || source === "") throw new Error("buildManifest: source 必须是非空字符串");
  const contentType = input.content_type ?? CONTENT_TYPE_LEXICAL;
  if (contentType !== CONTENT_TYPE_LEXICAL) throw new Error(`buildManifest: content_type 只支持 ${CONTENT_TYPE_LEXICAL}`);
  if (input.encrypted === true) throw new Error("buildManifest: 加密包未实现（encrypted:true 被拒绝，⛔ 不写\"加密\"明文）");
  const assets = input.assets ?? [];
  if (!Array.isArray(assets)) throw new Error("buildManifest: assets 必须是数组");
  return {
    format: DOC_FORMAT,
    format_version: DOC_FORMAT_VERSION,
    source,
    source_app_version: input.sourceAppVersion,
    document_id: input.documentId,
    title: input.title,
    created_at: input.createdAt,
    updated_at: input.updatedAt,
    content_type: contentType,
    encrypted: false,
    assets,
  };
}

/** `checksums.json` 的内容（结构与企业版逐字一致）。 */
export interface DocChecksums {
  format: typeof CHECKSUMS_FORMAT;
  version: number;
  algorithm: typeof CHECKSUMS_ALGORITHM;
  /** 包内相对路径 → 该文件字节的 sha256（小写 hex）。**不含 checksums.json 自己**。 */
  files: Record<string, string>;
}

/**
 * **生成** `checksums.json`（结构与算法逐字照企业版 `checksumsFor`）：
 *   · 登记传入的**每一个条目**（`checksums.json` 自己除外 —— 企业版是先算 checksums 再加入包）；
 *   · key 按 `localeCompare` 升序（与 `JSON.stringify` 的写出顺序一致）；
 *   · 值 = 该文件字节的 sha256 小写 hex。
 *
 * 签名文件（signature.json）**照登**：企业版读端若发现它被登记就校验、没登记就跳过。
 */
export async function buildChecksums(entries: PackageFile[]): Promise<DocChecksums> {
  const files: Record<string, string> = {};
  for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    if (typeof entry?.path !== "string" || entry.path === "") throw new Error("buildChecksums: 条目 path 必须是非空字符串");
    if (entry.path === CHECKSUMS_PATH) continue; // ⛔ checksums.json 不登记自己（企业版同口径）
    if (files[entry.path] !== undefined) throw new Error(`buildChecksums: 条目重复：${entry.path}`);
    files[entry.path] = await sha256Hex(entry.bytes);
  }
  return { format: CHECKSUMS_FORMAT, version: CHECKSUMS_VERSION, algorithm: CHECKSUMS_ALGORITHM, files };
}

/**
 * **校验** `checksums.json`（读端）。返回空数组 ＝ 全部通过；否则**逐条点名**：
 *   · 结构不认识（format / algorithm / files 形态）；
 *   · 登记了但包里没有这个文件；
 *   · sha256 对不上；
 *   · 包里有文件却没登记（`checksums.json` / `signature.json` 除外 —— 企业版读端同口径）。
 *
 * ⚠️ 调用方必须把非空结果当**整包拒绝**（⛔ 不静默通过）。
 */
export async function verifyChecksums(raw: unknown, entries: PackageFile[]): Promise<string[]> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return ["checksums.json 不是对象"];
  const c = raw as Record<string, unknown>;
  if (c.format !== CHECKSUMS_FORMAT) {
    return [`checksums.json 的 format 不认识（${String(c.format)}，要求 ${CHECKSUMS_FORMAT}）`];
  }
  if (c.algorithm !== CHECKSUMS_ALGORITHM) {
    return [`checksums.json 的 algorithm 不认识（${String(c.algorithm)}，要求 ${CHECKSUMS_ALGORITHM}）`];
  }
  if (typeof c.files !== "object" || c.files === null || Array.isArray(c.files)) {
    return ["checksums.json 的 files 不是对象"];
  }
  const registered = c.files as Record<string, unknown>;
  const byPath = new Map(entries.map((e) => [e.path, e.bytes]));
  const problems: string[] = [];
  for (const [path, want] of Object.entries(registered)) {
    if (typeof want !== "string" || !SHA_RE.test(want)) {
      problems.push(`checksums 里 ${path} 的 sha256 形状不对（${String(want)}）`);
      continue;
    }
    const bytes = byPath.get(path);
    if (bytes === undefined) {
      problems.push(`缺文件：${path}`);
      continue;
    }
    const got = await sha256Hex(bytes);
    if (got !== want) problems.push(`校验失败：${path}（登记 ${want}，实际 ${got}）`);
  }
  for (const path of byPath.keys()) {
    if (path === CHECKSUMS_PATH || path === SIGNATURE_PATH) continue;
    if (!Object.prototype.hasOwnProperty.call(registered, path)) problems.push(`checksums 没登记：${path}`);
  }
  return problems;
}

/**
 * 条目路径安全（导入侧第一道闸）。返回 `null` ＝ 合法；返回字符串 ＝ 那句人话原因。
 * 挡：空路径 / 绝对路径 / 盘符 / 反斜杠（zip 里只认 `/`）/ `..` 段 / NUL / 过长 / 以 `/` 结尾。
 */
export function checkEntryPath(p: string): string | null {
  if (!p) return "为空";
  if (p.includes("\u0000")) return "含 NUL 字节";
  if (p.includes("\\")) return "含反斜杠（zip 里只认 /）";
  if (p.startsWith("/")) return "是绝对路径";
  if (/^[A-Za-z]:/.test(p)) return "含 Windows 盘符";
  if (p.endsWith("/")) return "以 / 结尾（这是目录条目）";
  if (p.length > 200) return "过长（>200 字符）";
  const segs = p.split("/");
  if (segs.some((s) => s === "..")) return "含 ..（zip-slip）";
  if (segs.some((s) => s === "." || s === "")) return "含空段或 . 段";
  return null;
}

/** 大小上限（单个 + 整包）。返回 `null` ＝ 合法。 */
export function checkSizeLimits(files: { path: string; size: number }[]): string | null {
  let total = 0;
  for (const f of files) {
    if (f.size > MAX_FILE_BYTES) {
      return `${f.path} 超过单文件上限 ${MAX_FILE_BYTES / 1024 / 1024} MB`;
    }
    total += f.size;
  }
  if (total > MAX_TOTAL_BYTES) return `整包超过上限 ${MAX_TOTAL_BYTES / 1024 / 1024} MB`;
  return null;
}

/** sha256（WebCrypto；浏览器与 Node 都有 `crypto.subtle`）。字符串按 UTF-8 计（企业版同口径）。 */
export async function sha256Hex(bytes: Uint8Array | string): Promise<string> {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  const buf = await crypto.subtle.digest("SHA-256", data as unknown as BufferSource);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 资产自证：每个条目解出来的字节的 sha256 必须等于清单里写的（内容寻址）。
 * 返回 `null` ＝ 全部通过；否则点名第一个不对劲的条目。
 */
export async function verifyAssets(
  entries: { path: string; sha256: string; bytes: Uint8Array }[],
): Promise<string | null> {
  for (const e of entries) {
    const got = await sha256Hex(e.bytes);
    if (got !== e.sha256) {
      return `${e.path} 的内容与 sha256 不符（期望 ${e.sha256}，实际 ${got}）`;
    }
  }
  return null;
}
