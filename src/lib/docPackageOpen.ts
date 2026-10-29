// `.shuyodoc` 的**打开（读包）编排** —— M1 第二步。
//
// 分工：`docPackage.ts` 是单条判据（manifest / 路径 / sha 自证），本文件把它们**按顺序串起来**，
// 并处理"整包完整性"这类**跨条目**约束：
//   · 清单里列的资产必须都在包里；⛔ 少一个 ⇒ 整包拒绝（不许悄悄缺图）✗
//   · 包里有多余条目（清单没列的）⇒ 整包拒绝（防夹带）✗
//   · 条目路径重复 ⇒ 拒绝（zip 可能同名覆盖，等于夹带）✗
//   · `content.json` 必须是合法 JSON 对象
//
// ⚠️ zip 解压本身由调用方注入（`ZipEntry[]`）—— 本层**不碰**具体解压实现，
// 所以可以先用假条目做完整判据；真实解压接进来时只换数据来源，不改这些红线。
import {
  checkEntryPath,
  checkSizeLimits,
  parseManifest,
  verifyAssets,
  type DocManifest,
} from "./docPackage";

export interface ZipEntry {
  /** 包内相对路径（zip 里只认 `/`）。 */
  path: string;
  bytes: Uint8Array;
}

export interface OpenedDocumentPackage {
  manifest: DocManifest;
  /** `content.json` 原文（Lexical 块 JSON 的字符串形式；由调用方解析）。 */
  contentJson: string;
  assets: { path: string; bytes: Uint8Array }[];
}

export type OpenResult = { ok: true; pkg: OpenedDocumentPackage } | { ok: false; error: string };

const MANIFEST = "manifest.json";
const CONTENT = "content.json";

/** 打开一个文档包：路径 → 清单 → 完整性（缺/多/重复）→ 资产自证 → 返回可落库的结构。 */
export async function openDocumentPackage(entries: ZipEntry[]): Promise<OpenResult> {
  // ① 路径安全 + 重复（先做，后面所有查找都建立在"路径可信"上）
  const byPath = new Map<string, Uint8Array>();
  for (const e of entries) {
    const err = checkEntryPath(e.path);
    if (err) return { ok: false, error: `条目 ${e.path} ${err}` };
    if (byPath.has(e.path)) return { ok: false, error: `条目 ${e.path} 在包里出现了两次` };
    byPath.set(e.path, e.bytes);
  }

  // ② 清单
  const manifestBytes = byPath.get(MANIFEST);
  if (!manifestBytes) return { ok: false, error: `包里没有 ${MANIFEST}（不是 .shuyodoc）` };
  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch (e) {
    return { ok: false, error: `${MANIFEST} 不是合法 JSON（${e instanceof Error ? e.message : String(e)}）` };
  }
  const parsed = parseManifest(rawManifest);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const manifest = parsed.manifest;

  // ③ 大小上限（用包内真实字节，而不是清单自报的 size —— 清单可以撒谎）
  const sizeErr = checkSizeLimits(entries.map((e) => ({ path: e.path, size: e.bytes.byteLength })));
  if (sizeErr) return { ok: false, error: sizeErr };

  // ④ 正文
  const contentBytes = byPath.get(CONTENT);
  if (!contentBytes) return { ok: false, error: `包里没有 ${CONTENT}` };
  const contentJson = new TextDecoder().decode(contentBytes);
  if (contentJson.trim() === "") return { ok: false, error: `${CONTENT} 是空文件` };
  try {
    const c = JSON.parse(contentJson);
    if (typeof c !== "object" || c === null) return { ok: false, error: `${CONTENT} 不是 JSON 对象` };
  } catch (e) {
    return { ok: false, error: `${CONTENT} 不是合法 JSON（${e instanceof Error ? e.message : String(e)}）` };
  }

  // ⑤ 完整性：清单里列了、包里必须都在（⛔ 少一个就是"悄悄缺图"）
  for (const a of manifest.assets) {
    if (!byPath.has(a.path)) return { ok: false, error: `清单里有 ${a.path}，但包里没有这个文件` };
  }
  // ⑥ 完整性：包里不许有清单没列的条目（防夹带；只允许 manifest/content 两个固定名）
  const allowed = new Set<string>([MANIFEST, CONTENT, ...manifest.assets.map((a) => a.path)]);
  for (const p of byPath.keys()) {
    if (!allowed.has(p)) return { ok: false, error: `包里有清单没列的条目：${p}（拒绝夹带）` };
  }

  // ⑦ 资产自证（内容寻址）
  const assetEntries = manifest.assets.map((a) => ({ path: a.path, sha256: a.sha256, bytes: byPath.get(a.path)! }));
  const shaErr = await verifyAssets(assetEntries);
  if (shaErr) return { ok: false, error: shaErr };

  return {
    ok: true,
    pkg: {
      manifest,
      contentJson,
      assets: assetEntries.map((a) => ({ path: a.path, bytes: a.bytes })),
    },
  };
}
