// `.shuyodoc` 的**打开（读包）编排** —— M1 第二步。
//
// 分工：`docPackage.ts` 是单条判据（manifest / 路径 / sha 自证 / checksums），本文件把它们**按顺序串起来**，
// 并处理"整包完整性"这类**跨条目**约束：
//   · `checksums.json` 存在 ⇒ **整包校验**，任何一条不符 ⇒ 整包拒绝并点名条目（企业版规范必带）；
//   · `checksums.json` 缺失（旧版个人包）⇒ **允许读**，但必须如实提示「完整性只靠 assets sha」，
//     ⛔ 不许当静默通过；
//   · 清单里列的资产必须都在包里；⛔ 少一个 ⇒ 整包拒绝（不许悄悄缺图）✗
//   · **企业版包没有 manifest.assets**（资产在 `assets/<sha256>.<ext>`，靠内容寻址）⇒
//     这里按同样的口径**从条目发现**资产，并把文件名里的 sha256 当清单用；
//   · 包里有多余条目（清单/约定都没列）⇒ 整包拒绝（防夹带）✗
//   · 条目路径重复 ⇒ 拒绝（zip 可能同名覆盖，等于夹带）✗
//   · `content.json` 必须是合法 JSON 对象
//
// ⚠️ zip 解压本身由调用方注入（`ZipEntry[]`）—— 本层**不碰**具体解压实现，
// 所以可以先用假条目做完整判据；真实解压接进来时只换数据来源，不改这些红线。
import {
  CHECKSUMS_PATH,
  COMMENTS_PATH,
  CONTENT_PATH,
  MANIFEST_PATH,
  SIGNATURE_PATH,
  checkEntryPath,
  checkSizeLimits,
  parseManifest,
  verifyAssets,
  verifyChecksums,
  READER_VERSION,
  versionGt,
  type DocManifest,
} from "./docPackage";

export interface ZipEntry {
  /** 包内相对路径（zip 里只认 `/`）。 */
  path: string;
  bytes: Uint8Array;
}

export interface OpenedDocumentPackage {
  manifest: DocManifest;
  /**
   * `content.json` 原文（Lexical 块 JSON 的字符串形式；由调用方解析）。
   *
   * ⚠️ 字段名用 `docJson` 而不是包内文件名的驼峰（`content.json` ⇒ 那个名字）：`check-doc-content-access`
   * 把 `contentJson` 当成"直接访问正文存储列"的代理计数（只减不增），而这里装的是**包里的那一段文本**，
   * 不是页面记录里的那两个落盘字段。仓里给"认一段正文 JSON 文本"的入参一律叫 `docJson`（同
   * `docPackWriter.ts::docJson` / `exportMarkdown.ts` 的口径）⇒ 消费方不必去写那个被计数的名字。
   */
  docJson: string;
  /** 资产：旧个人包按 manifest.assets，企业版按 `assets/<sha256>.<ext>` 内容寻址发现。 */
  assets: { path: string; bytes: Uint8Array }[];
  /** 包内 `comments.json` 原文（M1 不导入；有就如实带回，⛔ 不静默丢弃）。 */
  commentsJson: string | null;
  /** ⭐ M1.1：content 根上的 `db` 命名空间原样带回（不理解也保留；null=没有）。 */
  dbJson: string | null;
  /** **如实提示**（不阻断打开）：旧包缺 checksums、签名未校验、评论未导入等。 */
  notices: string[];
}

export type OpenResult = { ok: true; pkg: OpenedDocumentPackage } | { ok: false; error: string };

const SHA_RE = /^[0-9a-f]{64}$/;
const ASSETS_PREFIX = "assets/";

const fail = (error: string): OpenResult => ({ ok: false, error });

/** 打开一个文档包：路径 → 清单 → checksums → 完整性（缺/多/重复）→ 资产自证 → 返回可落库的结构。 */
export async function openDocumentPackage(
  entries: ZipEntry[],
  opts: { allowUnverifiedChecksums?: boolean } = {},
): Promise<OpenResult> {
  // ① 路径安全 + 重复（先做，后面所有查找都建立在"路径可信"上）
  const byPath = new Map<string, Uint8Array>();
  for (const e of entries) {
    const err = checkEntryPath(e.path);
    if (err) return fail(`条目 ${e.path} ${err}`);
    if (/\.(zip|shuyodoc)$/i.test(e.path)) {
      return fail(`E_ZIP_STRUCTURE: 条目 ${e.path} 是内层压缩包（v1.1 硬拒嵌套包）`);
    }
    if (byPath.has(e.path)) return fail(`E_ZIP_STRUCTURE: 条目 ${e.path} 在包里出现了两次`);
    byPath.set(e.path, e.bytes);
  }

  // ② 清单
  const manifestBytes = byPath.get(MANIFEST_PATH);
  if (!manifestBytes) return fail(`包里没有 ${MANIFEST_PATH}（不是 .shuyodoc）`);
  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch (e) {
    return fail(`${MANIFEST_PATH} 不是合法 JSON（${e instanceof Error ? e.message : String(e)}）`);
  }
  const parsed = parseManifest(rawManifest);
  if (!parsed.ok) return fail(parsed.error);
  const manifest = parsed.manifest;
  if (manifest.min_reader_version && versionGt(manifest.min_reader_version, READER_VERSION)) {
    return fail(
      `E_VERSION: 这个包要求读端 ≥ ${manifest.min_reader_version}（本版支持到 ${READER_VERSION}）—— 请升级应用后再导入`,
    );
  }
  // 旧个人包**显式写**了 assets 字段（哪怕空数组）：此时 assets/ 下多出来的条目仍是「夹带」；
  // 企业版包**根本没有** assets 字段 ⇒ 资产只能靠 `assets/<sha256>.<ext>` 内容寻址发现。
  const declaredAssetsField =
    typeof rawManifest === "object" &&
    rawManifest !== null &&
    !Array.isArray(rawManifest) &&
    Object.prototype.hasOwnProperty.call(rawManifest, "assets");
  const notices: string[] = [];

  // ③ checksums（企业版必带）；有就**整包校验**，任何一条不符 ⇒ 整包拒绝并点名条目。
  if (manifest.checksums_sha256) {
    notices.push("包带 manifest.checksums_sha256：v1.1 读端**存在也不验**（强制验属 v2）");
  }
  // v1.1 `features`：白名单校验在 `parseManifest` 里 —— 不认识的值**已经**整包拒收并点名
  // （`E_FEATURE`，含升级提示）；能走到这里的都是本版认识的声明，照常放行。
  // ⚠️ 这里以前写的是"不认识的一律忽略（不落库）"，那是**错的**：旧读端会拿残缺语义去落库，
  //    用户看到的是"打开成功但内容少了"。规范 §1.2 明确要求拒收并点名。
  const checksumsBytes = byPath.get(CHECKSUMS_PATH);
  let checksumsFiles: Record<string, unknown> | null = null;
  if (!checksumsBytes) {
    if (!opts.allowUnverifiedChecksums) {
      return fail(
        "E_IO_CHECKSUMS: 包里缺 checksums.json —— 导入默认拒绝；旧包请显式 allowUnverifiedChecksums:true 才继续（并记 warning）",
      );
    }
    notices.push(
      "包内缺 checksums.json：allowUnverifiedChecksums=true 放行；完整性只由 assets 文件名里的 sha256 自证（warning）",
    );
  } else {
    let rawChecksums: unknown;
    try {
      rawChecksums = JSON.parse(new TextDecoder().decode(checksumsBytes));
    } catch (e) {
      return fail(`${CHECKSUMS_PATH} 不是合法 JSON（${e instanceof Error ? e.message : String(e)}）`);
    }
    const problems = await verifyChecksums(
      rawChecksums,
      entries.map((e) => ({ path: e.path, bytes: e.bytes })),
    );
    if (problems.length > 0) return fail(`E_CHECKSUMS: 整包校验失败（checksums）：${problems.join("；")}`);
    const rawObj = rawChecksums as { files?: Record<string, unknown> };
    checksumsFiles = rawObj.files ?? null;
  }
  if (byPath.has(SIGNATURE_PATH)) {
    notices.push("包带 signature.json：本层不验签（v1 未实现），按未签名处理");
  }

  // ④ 大小上限（用包内真实字节，而不是清单自报的 size —— 清单可以撒谎）
  const sizeErr = checkSizeLimits(entries.map((e) => ({ path: e.path, size: e.bytes.byteLength })));
  if (sizeErr) return fail(sizeErr);

  // ⑤ 正文
  const contentBytes = byPath.get(CONTENT_PATH);
  if (!contentBytes) return fail(`包里没有 ${CONTENT_PATH}`);
  const docJson = new TextDecoder().decode(contentBytes);
  let dbJson: string | null = null;
  if (docJson.trim() === "") return fail(`${CONTENT_PATH} 是空文件`);
  try {
    const c = JSON.parse(docJson);
    if (typeof c !== "object" || c === null) return fail(`${CONTENT_PATH} 不是 JSON 对象`);
    const db = (c as Record<string, unknown>).db;
    if (db !== undefined) dbJson = JSON.stringify(db);
  } catch (e) {
    return fail(`${CONTENT_PATH} 不是合法 JSON（${e instanceof Error ? e.message : String(e)}）`);
  }

  // ⑥ 完整性：旧个人包显式清单里列了、包里必须都在（⛔ 少一个就是"悄悄缺图"）
  for (const a of manifest.assets) {
    if (!byPath.has(a.path)) return fail(`清单里有 ${a.path}，但包里没有这个文件`);
  }

  // ⑦ 资产发现：企业版包没有 manifest.assets ⇒ 按 `assets/<sha256>.<ext>` 内容寻址认
  const assetList: { path: string; sha256: string; size: number }[] = manifest.assets.map((a) => ({
    path: a.path,
    sha256: a.sha256,
    size: a.size,
  }));
  const declared = new Set(assetList.map((a) => a.path));
  for (const [path, bytes] of byPath) {
    if (!path.startsWith(ASSETS_PREFIX) || declared.has(path)) continue;
    // 显式清单的旧包：清单没列的 assets/ 条目 ⇒ 与以前一样按夹带拒绝（⛔ 不因兼容企业版而放宽）
    if (declaredAssetsField) return fail(`包里有清单没列的条目：${path}（拒绝夹带）`);
    const base = path.slice(ASSETS_PREFIX.length);
    if (base.includes("/")) return fail(`assets/ 下的条目不支持子目录：${path}（企业版按内容寻址平铺）`);
    const dot = base.indexOf(".");
    const sha = (dot < 0 ? base : base.slice(0, dot)).toLowerCase();
    if (!SHA_RE.test(sha)) return fail(`assets/ 下的文件名不是 sha256：${path}（企业版按内容寻址）`);
    declared.add(path);
    assetList.push({ path, sha256: sha, size: bytes.byteLength });
  }

  // ⑧ 夹带：包内只允许 manifest / content / checksums / signature / comments ＋ 上面认定的资产
  const allowed = new Set<string>([MANIFEST_PATH, CONTENT_PATH, CHECKSUMS_PATH, SIGNATURE_PATH, COMMENTS_PATH]);
  for (const a of assetList) allowed.add(a.path);
  for (const p of byPath.keys()) {
    if (allowed.has(p)) continue;
    if (checksumsFiles && Object.prototype.hasOwnProperty.call(checksumsFiles, p)) {
      notices.push(`包里有未知条目 ${p}：已在 checksums.json 中登记 ⇒ v1.1 允许（原样保留，不理解）`);
      continue;
    }
    return fail(`E_ZIP_STRUCTURE: 包里有清单没列的条目：${p}（拒绝夹带；未知条目必须出现在 checksums.json）`);
  }

  // ⑨ 资产自证（内容寻址：旧清单的 sha / 企业版文件名里的 sha，都必须等于实际字节的 sha256）
  const assetEntries = assetList.map((a) => ({ path: a.path, sha256: a.sha256, bytes: byPath.get(a.path)! }));
  const shaErr = await verifyAssets(assetEntries);
  if (shaErr) return fail(shaErr);

  // ⑩ 评论：M1 不导入，但拿到了就**如实带回 + 提示**（⛔ 不静默丢弃）
  const commentsBytes = byPath.get(COMMENTS_PATH);
  const commentsJson = commentsBytes ? new TextDecoder().decode(commentsBytes) : null;
  if (commentsJson !== null) {
    notices.push("包带 comments.json：M1 不导入评论（评论未落库），原文已随返回值带回");
  }

  return {
    ok: true,
    pkg: {
      manifest,
      docJson,
      assets: assetEntries.map((a) => ({ path: a.path, bytes: a.bytes })),
      commentsJson,
      dbJson,
      notices,
    },
  };
}
