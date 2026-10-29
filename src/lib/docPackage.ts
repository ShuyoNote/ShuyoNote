// 单文档包 `.shuyodoc` 的**格式层纯函数**（M1 第一步；方案见 `docs/plans/2026-10-29-shuyodoc-m1.md`）。
//
// 这一层**不碰 zip、不碰数据库、不碰 UI** —— 只做三件事，每件都能单测：
//   ① manifest 校验（format/版本/资产清单；未知版本**拒绝**，⛔ 不猜 ✗）；
//   ② 条目路径安全（zip-slip / 绝对路径 / 反斜杠 / Windows 保留字符）；
//   ③ 资产自证（sha256 内容寻址 ＋ 大小上限）。
//
// ⚠️ 导入侧的红线：**任何一条不过 ⇒ 整个包拒绝**，⛔ 不许"导一半"、⛔ 不许静默跳过条目 ✗。
// ⚠️ 校验失败必须能点名「哪个条目、为什么」（返回的 `error` 就是那句人话，UI 直接显示）。

export const DOC_FORMAT = "shuyonote.document";
export const DOC_FORMAT_VERSION = 1;
export const DOC_MIME = "application/vnd.shuyonote.document+zip";
export const DOC_EXTENSION = ".shuyodoc";

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

export interface DocManifest {
  format: typeof DOC_FORMAT;
  format_version: number;
  title: string;
  created?: string;
  updated?: string;
  assets: DocAsset[];
}

export type ManifestResult = { ok: true; manifest: DocManifest } | { ok: false; error: string };

const SHA_RE = /^[0-9a-f]{64}$/;

/** 校验 manfiest（**未知版本直接拒绝**：将来 v2 由 v2 的读取器负责，⛔ 不向下猜 ✗）。 */
export function parseManifest(raw: unknown): ManifestResult {
  if (typeof raw !== "object" || raw === null) return { ok: false, error: "manifest.json 不是对象" };
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
  if (!Array.isArray(m.assets)) return { ok: false, error: "manifest.assets 必须是数组" };
  const assets: DocAsset[] = [];
  for (const [i, a] of m.assets.entries()) {
    if (typeof a !== "object" || a === null) return { ok: false, error: `assets[${i}] 不是对象` };
    const o = a as Record<string, unknown>;
    if (typeof o.path !== "string") return { ok: false, error: `assets[${i}].path 缺失` };
    if (typeof o.sha256 !== "string" || !SHA_RE.test(o.sha256)) {
      return { ok: false, error: `assets[${i}].sha256 不是 64 位十六进制（${String(o.sha256)}）` };
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
  return {
    ok: true,
    manifest: {
      format: DOC_FORMAT,
      format_version: DOC_FORMAT_VERSION,
      title: m.title,
      created: typeof m.created === "string" ? m.created : undefined,
      updated: typeof m.updated === "string" ? m.updated : undefined,
      assets,
    },
  };
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

/** sha256（WebCrypto；浏览器与 Node 都有 `crypto.subtle`）。 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
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
      return `${e.path} 的内容与 sha256 不符（清单 ${e.sha256}，实际 ${got}）`;
    }
  }
  return null;
}
