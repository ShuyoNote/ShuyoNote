// 「把用户给的标题 / 名字变成一个**三平台都能落盘的单个文件名**」—— B5 的库层
// （方案 `docs/plans/2026-10-30-note-metadata-and-title-polish.md` §B5：导出文件名 sanitize
// ＝非法字符、尾点/空格、Windows 保留名、UTF-8 字节限长；`<标题>-<id 前 8 位>` 的 id 后缀
// 由**导出侧**拼，不在本文件里 —— 见下面 `ID_SUFFIX_BYTES`）。
//
// 纯函数、**不带任何 import**：导出命名（`docPackageTransfer` 等）调用它，单测不需要浏览器 /
// Tauri 环境（与 `attachmentFetchHint` / `columnsText` 那类纯函数同一套写法）。
//
// ## 口径：按 Windows 收（它最严，收得住就三平台都过）
//
// 1. **路径分隔符先按"路径"处理，而不是当字符替换**：`a/../b` → `a_b`，`../../etc/passwd`
//    → `etc_passwd`。`.` / `..` / 空段一律丢掉 —— 这样 `../` 穿越串**根本拼不出目录**，
//    而不是靠"把 `/` 换成 `_` 后但愿没事"（后者会留下 `.._.._etc_passwd` 这种看不懂的名字）。
// 2. **其余非法字符换成 `_`**（`< > : " | ? *` + C0/C1 控制字符）：**替换**不是删掉 —— 删掉会把
//    `a/b` 与 `ab`、`a*b` 与 `ab` 变成同一个名字，撞名比多一个下划线难查得多。
// 3. **结尾的空格与点去掉**：Windows 会静默丢弃它们 ⇒ `报告.` 与 `报告` 打开的是同一个文件。
// 4. **Windows 保留名**（`CON`/`PRN`/`AUX`/`NUL`/`COM1-9`/`LPT1-9`，**带扩展名的 `CON.txt`
//    也算** —— Windows 看的是第一个点之前那段）⇒ 加 `_` 前缀：`CON.txt` → `_CON.txt`。
// 5. **UTF-8 字节限长**（默认 [`FILENAME_MAX_BYTES`]）：**保留最后一段扩展名**，从主干截；
//    截断按码点走，不切断代理对（否则名字里会出现 `�`）。
// 6. **Unicode 不转码**：中文 / emoji 原样保留 —— 它们不是非法字符，转码（拼音化 / `%E4`）
//    只会让用户认不出自己的文件。空名用 `fallback`，不是抛错。
//
// ## 与 id 后缀的关系（方案 Q4）
//
// 导出侧要拼 `-<id 前 8 位>`（`-` + 8 个十六进制 = [`ID_SUFFIX_BYTES`] 个字节）。**拼之前**
// 要把预算扣掉：`safeFilename(title, { maxBytes: FILENAME_MAX_BYTES - ID_SUFFIX_BYTES })`，
// 否则"标题占满 180 字节 + 9 字节后缀"会超方案的口径。

/** 导出文件名 UTF-8 ≤180 字节（方案 §3 的「导出文件名」那一行）。 */
export const FILENAME_MAX_BYTES = 180;

/** 空名（或全非法）时的兜底名。 */
export const DEFAULT_FILENAME_FALLBACK = "未命名";

/** `-<id 前 8 位>` 的字节数（1 个连字符 + 8 个十六进制字符）；拼后缀前先扣预算。 */
export const ID_SUFFIX_BYTES = 9;

export interface SafeFilenameOptions {
  /** 名称为空时可以接受的名字（默认 [`DEFAULT_FILENAME_FALLBACK`]）。它自己也会被 sanitize。 */
  fallback?: string;
  /** UTF-8 字节预算（默认 [`FILENAME_MAX_BYTES`]）。**要拼 id 后缀时记得先扣掉**。 */
  maxBytes?: number;
}

/** 除路径分隔符之外的 Windows 非法字符 + C0/C1 控制字符（分隔符在前一步按路径处理）。 */
const ILLEGAL_FILENAME_CHARS = /[<>:"|?*\u0000-\u001f\u007f-\u009f]/g;

/** 一个或多个 `/` `\`（`a//b` 与 `a/b` 等价）。 */
const PATH_SEPARATOR = /[\\/]+/;

/** 结尾的空格与点（Windows 静默丢弃）。 */
const TRAILING_SPACES_AND_DOTS = /[ .]+$/;

/** Windows 设备名（大小写不敏感；`CON.txt` 这种带扩展名的由调用方先切出第一段再比）。 */
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * 路径 → 平铺名：按 `/` `\` 切段，丢掉空段 / `.` / `..`，再用 `_` 拼起来。
 *
 * 这一步是"`../` 穿越必须消解"的**正解**：`../../etc/passwd` → `etc_passwd`。
 */
function stripPathTraversal(name: string): string {
  const segments = name
    .split(PATH_SEPARATOR)
    .filter((segment) => segment !== "" && segment !== "." && segment !== "..");
  return segments.join("_");
}

/** 结尾空格/点去掉（`报告...` → `报告`；`报告 . ` → `报告`）。 */
function trimTrailingSpacesAndDots(text: string): string {
  return text.replace(TRAILING_SPACES_AND_DOTS, "");
}

/** 是否为 Windows 保留名（带扩展名也算：`CON.txt` / `com3.tar.gz`；大小写不敏感）。 */
export function isWindowsReservedName(name: string): boolean {
  const trimmed = trimTrailingSpacesAndDots(name);
  if (!trimmed) return false;
  const stem = trimmed.split(".")[0] ?? "";
  return WINDOWS_RESERVED_NAME.test(stem);
}

/**
 * 按 UTF-8 字节预算截断，**保留最后一段扩展名**（`.tar.gz` 只保 `.gz`：Windows/资源管理器
 * 认的是最后一段，保两段会让"名字主干"几乎没有空间）。
 *
 * 按码点迭代 ⇒ 不会把一个代理对切成两半。
 */
function limitUtf8Bytes(text: string, maxBytes: number): string {
  if (utf8Bytes(text) <= maxBytes) return text;

  let stem = text;
  let ext = "";
  const dot = text.lastIndexOf(".");
  if (dot > 0 && dot < text.length - 1) {
    stem = text.slice(0, dot);
    ext = text.slice(dot);
  }
  let extBytes = utf8Bytes(ext);
  // 扩展名自己就吃掉整份预算（或更多）⇒ 丢掉扩展名，整串按字节截。
  if (extBytes >= maxBytes) {
    stem = text;
    ext = "";
    extBytes = 0;
  }
  const budget = maxBytes - extBytes;
  const chars = Array.from(stem);
  let used = 0;
  let kept = 0;
  for (const ch of chars) {
    const bytes = utf8Bytes(ch);
    if (used + bytes > budget) break;
    used += bytes;
    kept += 1;
  }
  return chars.slice(0, kept).join("") + ext;
}

/** 单次 sanitize（不含 fallback 递归）：返回空串表示"这个输入没有可用的名字"。 */
function sanitizeName(name: string, maxBytes: number): string {
  // ① 路径段先消解（`../` 穿越在这里就没了）
  let out = stripPathTraversal(name);
  // ② 其余非法字符 / 控制字符换成 `_`
  out = out.replace(ILLEGAL_FILENAME_CHARS, "_");
  // ③ 结尾空格/点（含"全是空格" ⇒ 空）
  out = trimTrailingSpacesAndDots(out);
  if (!out) return "";
  // ④ 保留名加前缀（放在限长**之前**，这样前缀也算进预算）
  if (isWindowsReservedName(out)) out = "_" + out;
  // ⑤ 字节限长 + 截断后再收一次尾巴（截断可能正好截到 ". " 上）
  out = limitUtf8Bytes(out, maxBytes);
  out = trimTrailingSpacesAndDots(out);
  if (!out) return "";
  // ⑥ 截断有可能把 `CONSOLE…` 截成 `CON` ⇒ 再判一次（前缀后可能又超预算，一并限长）
  if (isWindowsReservedName(out)) out = limitUtf8Bytes("_" + out, maxBytes);
  return out;
}

/**
 * 把 `name` 变成可落盘的文件名。
 *
 * - 非法字符 / 控制字符 → `_`；路径分隔符按"路径"消解（`../` 穿越不可能留下）；
 * - 结尾空格/点去掉；Windows 保留名加 `_` 前缀（含 `CON.txt` 形态）；
 * - UTF-8 ≤ `maxBytes`（默认 180，保留扩展名，按码点截断）；
 * - 中文 / emoji **不转码**；空名（或全是空白）⇒ `fallback`（默认 `未命名`）。
 *
 * ⚠️ 返回值**不含** id 后缀：要拼 `-<id 前 8 位>` 时传 `maxBytes: 171`。
 */
export function safeFilename(name: string, options: SafeFilenameOptions = {}): string {
  const maxBytes = Math.max(1, Math.floor(options.maxBytes ?? FILENAME_MAX_BYTES));
  const cleaned = sanitizeName(name, maxBytes);
  if (cleaned) return cleaned;
  const fromFallback = sanitizeName(options.fallback ?? DEFAULT_FILENAME_FALLBACK, maxBytes);
  return fromFallback || DEFAULT_FILENAME_FALLBACK;
}
