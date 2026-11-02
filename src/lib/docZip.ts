// `.shuyodoc` 的 zip 解包层 —— M1 第三步（**只读**：字节进、条目出；⛔ 不落盘、不写库、不碰 UI）。
//
// 为什么用 fflate：它已经是本仓依赖（`exportMarkdownBundle` 打 zip 就靠它），方案也要求
// 「复用现有 zip 能力，避免第二套」⇒ **本层不新增任何依赖** ✓。
//
// 职责只有两件：
//   ① 把 zip 字节读成 `{ path, bytes }`。路径**原样带回**、不在这里判安全 —— 路径闸只有一处
//      （`openDocumentPackage` → `checkEntryPath`），这样 zip-slip 的拒绝理由不会变成两份 ✓。
//   ② 解不开就**如实报错**，⛔ 不返回空数组假装成功 ✗（调用方据此整包拒绝）。
//
// 三处补强（fflate 本身不做、但导入侧红线需要的）：
//   · `unzipSync` 用对象收集条目 ⇒ **同名条目会被后者静默覆盖** ✗；本层拿 EOCD 声明的条目数
//     与实际解出的条目数对账，对不上就拒绝（与 `openDocumentPackage` 的「重复 ⇒ 拒绝」一致 ✓）；
//   · 先按**中央目录声明的解压后大小**做上限预检（`MAX_FILE_BYTES` / `MAX_TOTAL_BYTES`）——
//     ⛔ 不先解压再判：zip bomb 会在判上限之前就把内存吃掉 ✗；
//   · 不支持的压缩方式（非 store / deflate）点名报错，⛔ 不猜、不静默跳过条目 ✗。
//
// ⚠️ 已知边界（本层**不**负责，交给上层兜底）：加密条目（fflate 不认加密标志，解出来是密文
//    ⇒ 由 manifest / content 的 JSON 判据与资产 sha 兜底拒绝）；CRC 校验（fflate 不做，
//    资产完整性由 `verifyAssets` 的 sha256 内容寻址负责）。
import { unzipSync, type UnzipFileInfo } from "fflate";
import { MAX_FILE_BYTES, MAX_TOTAL_BYTES } from "./docPackage";
import type { ZipEntry } from "./docPackageOpen";

/** 解包结果：纯函数形态的错误（**不抛异常**），便于单测与上层统一处理。 */
export type UnzipResult = { ok: true; entries: ZipEntry[] } | { ok: false; error: string };

const EOCD_SIG = 0x06054b50;
const EOCD_MIN_BYTES = 22;
const EOCD_MAX_COMMENT = 65535;

/** 小端读 u16 / u32（zip 的字节序）。 */
function u16le(b: Uint8Array, i: number): number {
  return b[i] | (b[i + 1] << 8);
}

function u32le(b: Uint8Array, i: number): number {
  return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
}

/**
 * EOCD（目录结尾记录）里声明的「本盘条目数」。
 * 读不到 / 是 zip64 占位符（0xFFFF）⇒ `null`：**判不了就不猜** ✓（zip64 由 fflate 自己处理）。
 */
function declaredEntryCount(bytes: Uint8Array): number | null {
  if (bytes.length < EOCD_MIN_BYTES) return null;
  const lowest = Math.max(0, bytes.length - EOCD_MIN_BYTES - EOCD_MAX_COMMENT);
  for (let i = bytes.length - EOCD_MIN_BYTES; i >= lowest; i--) {
    if (u32le(bytes, i) === EOCD_SIG) {
      const n = u16le(bytes, i + 8); // EOCD+8 = 本盘条目数
      return n === 0xffff ? null : n;
    }
  }
  return null;
}

/** fflate 的英文报错 → 能被 UI 直接显示的人话；未知压缩方式单独点名。 */
function humanError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const unknownMethod = /unknown compression type (\d+)/.exec(msg);
  if (unknownMethod) return `条目用了不支持的压缩方式 ${unknownMethod[1]}（本版只支持 store / deflate）`;
  return `不是合法的 zip（数据被截断或不是 zip）：${msg}`;
}

/**
 * zip 字节 ⇒ 条目（**纯函数**：不抛异常，解不开就返回人话原因）。
 *
 * 路径原样带回（连 `../` 也不在这里拦）—— 安全闸只在 `openDocumentPackage` 一处。
 */
export function decodeZipEntries(bytes: Uint8Array): UnzipResult {
  if (bytes.length === 0) return { ok: false, error: "不是合法的 zip（0 字节）" };

  // 上限预检：只看中央目录**声明**的大小，⛔ 不先解压再判（zip bomb 会在判之前吃光内存 ✗）。
  let declaredTotal = 0;
  let tooBig: string | null = null;
  const filter = (f: UnzipFileInfo): boolean => {
    if (tooBig) return false; // 已经判超限 ⇒ 后面的一律不解压
    if (f.originalSize > MAX_FILE_BYTES) {
      tooBig = `${f.name} 声明的解压后大小超过单文件上限 ${MAX_FILE_BYTES / 1024 / 1024} MB`;
      return false;
    }
    declaredTotal += f.originalSize;
    if (declaredTotal > MAX_TOTAL_BYTES) {
      tooBig = `整包声明的解压后总大小超过上限 ${MAX_TOTAL_BYTES / 1024 / 1024} MB`;
      return false;
    }
    return true;
  };

  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, { filter });
  } catch (e) {
    return { ok: false, error: humanError(e) };
  }
  if (tooBig) return { ok: false, error: tooBig };

  const paths = Object.keys(files);
  // 同名条目会被 unzipSync 静默覆盖 ⇒ 拿 EOCD 声明的条目数对账，对不上就整包拒绝。
  const declared = declaredEntryCount(bytes);
  if (declared !== null && declared !== paths.length) {
    return {
      ok: false,
      error: `zip 目录声明 ${declared} 个条目，实际解出 ${paths.length} 个（同名条目被覆盖或目录损坏）`,
    };
  }
  return { ok: true, entries: paths.map((path) => ({ path, bytes: files[path] })) };
}

/**
 * 解一个 `.shuyodoc` 的 zip 字节（调用方拿到的是**原始条目**，还没过任何红线）。
 * 解不开 ⇒ **抛错**，错误信息可直接显示给用户。
 */
export async function unzipDocument(bytes: Uint8Array): Promise<ZipEntry[]> {
  const r = decodeZipEntries(bytes);
  if (!r.ok) throw new Error(r.error);
  return r.entries;
}
