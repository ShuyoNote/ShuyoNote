// `.shuyodoc` 的**写侧（导出）** —— M1 写包（方案见 `docs/plans/2026-10-29-shuyodoc-m1.md`）。
//
// 分工：`docPackage.ts` 是单条判据（manifest / checksums / 路径安全 / sha 自证），本文件按**写侧顺序**
// 把它们串起来，产出一个**能被企业版 reader 直接接受**的 zip：
//   manifest.json → content.json → assets/<sha256>.<ext> → checksums.json
//
// 四条写侧红线（越界一律抛错，⛔ 绝不产出坏包）：
//   ① 正文必须是**合法 JSON 对象**（不是"先写进去、读的时候才发现坏了"）；
//   ② 资产路径先过 `checkEntryPath`（zip-slip / 绝对路径 / 盘符 / 反斜杠一律拒绝），且必须是
//      `assets/<sha256>.<ext>`（内容寻址：文件名里的 sha256 必须等于字节实际的 sha256）；
//   ③ 同名条目不许出现两次（zip 会静默覆盖 ⇒ 等于夹带）；
//   ④ manifest **只写企业版 10 个必填字段**，不写个人版扩展的 `assets` 字段 —— 这样资产只能靠
//      `assets/<sha256>.<ext>` 内容寻址发现，读回时走的正是"读企业版包"的那条路。
//
// 两个容器层口径（跨版互通的关键）：
//   · **store（不压缩）**：企业版 zip 读端只支持 store（`method !== 0` 直接报错），
//     所以这里用 `zipSync(..., { level: 0 })`；
//   · fflate 是本仓已有依赖（`docZip` / `exportMarkdownBundle` 在用），⛔ 不新增依赖。
//
// ⚠️ 正文 JSON 的入参字段叫 `docJson` 而不是正文存储列的驼峰名：本仓门禁 `check-doc-content-access`
//    把那个名字当"直接访问正文存储字段"的代理计数（只减不增）。它文件头写明的处置第 2 条
//    就是「收 JSON 文本的参数改成 `docJson`」—— 改名不是绕过，那个名字本来就不该用存储字段名。
import { zipSync } from "fflate";
import {
  CHECKSUMS_PATH,
  CONTENT_PATH,
  CONTENT_TYPE_LEXICAL,
  DOC_FORMAT,
  DOC_FORMAT_VERSION,
  MANIFEST_PATH,
  buildChecksums,
  buildManifest,
  checkEntryPath,
  checkSizeLimits,
  checkWritePaths,
  sha256Hex,
  type DocManifest,
} from "./docPackage";

/** 包内资产目录（企业版内容寻址约定：`assets/<sha256>.<ext>`）。 */
export const ASSETS_DIR = "assets/";

/** 一个要写进包的资产：`path` 是**包内相对路径**（沿用调用方给的路径，由写侧校验）。 */
export interface DocumentPackageAsset {
  path: string;
  bytes: Uint8Array;
}

export interface BuildDocumentPackageInput {
  documentId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** 正文（Lexical 块 JSON）：已序列化的字符串，或对象（写侧负责序列化）。 */
  docJson: string | Record<string, unknown>;
  /** 资产；省略 / 空数组 ⇒ 无资产的文档也能导。 */
  assets?: DocumentPackageAsset[];
  sourceAppVersion: string;
}

/**
 * 写进 zip 的固定时间戳：**本地** 1980-01-01 00:00（DOS 时间下界，编码成 0x0021）。
 *
 * ⚠️ **必须用本地时间构造，不能用 `Date.UTC(...)`**（2026-10-31 实测的真 bug）：
 * fflate 的 `zipSync` 取 mtime 后用的是 **本地** getter（`dt.getFullYear()`/`getHours()`…），
 * 所以 `new Date(Date.UTC(1980,0,1))` 在 +08:00 与 UTC 两个时区会编码出**不同的 DOS 时间字段**
 * ⇒ 同样的输入写出**不同字节**。CI 是 UTC、开发机是 +08:00 ⇒ 夹具字节稳定判据
 * （`packageFixtures.test.ts`）在 CI 上必红，而本机永远绿 ✗。
 * 用本地时间构造后，两地 getter 读到的年月日时分秒**都一样** ⇒ 逐字节相同 ✓。
 * 固定它 ⇒ **同一份输入写出逐字节相同的包**（checksums 可复现）；读端不看时间字段。
 */
const ZIP_EPOCH = new Date(1980, 0, 1, 0, 0, 0);

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** 写侧错误：消息是人话（UI 可直接显示），前缀标出是谁拒的。 */
function fail(message: string): never {
  throw new Error(`buildDocumentPackage: ${message}`);
}

const SHA_RE = /^[0-9a-f]{64}$/;
/** 资产扩展名：允许点号（如 `tar.gz`），长度设上限；路径安全已由 `checkEntryPath` 挡过一层。 */
const EXT_RE = /^[A-Za-z0-9._-]{1,16}$/;

/** 正文：字符串必须已是合法 JSON 对象（原样写进 content.json），对象则序列化。 */
function normalizeDocJson(input: BuildDocumentPackageInput["docJson"]): string {
  if (typeof input === "string") {
    if (input.trim() === "") fail("正文 JSON 不能为空（content.json 不能是空文件）");
    let parsed: unknown;
    try {
      parsed = JSON.parse(input);
    } catch (e) {
      return fail(`正文 JSON 不合法（${e instanceof Error ? e.message : String(e)}）`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      fail("正文 JSON 必须是对象（Lexical 块 JSON 的根是对象）");
    }
    return input;
  }
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    fail("正文 JSON 必须是对象或已序列化的 JSON 字符串");
  }
  try {
    return JSON.stringify(input);
  } catch (e) {
    return fail(`正文 JSON 无法序列化（${e instanceof Error ? e.message : String(e)}）`);
  }
}

interface NormalizedAsset {
  path: string;
  bytes: Uint8Array;
  sha256: string;
}

/** 资产：路径安全 + `assets/<sha256>.<ext>` 形状 + 文件名里的 sha256 与字节一致。 */
async function normalizeAsset(input: DocumentPackageAsset, index: number): Promise<NormalizedAsset> {
  const label = `资产 #${index}`;
  if (typeof input !== "object" || input === null) return fail(`${label} 不是对象`);
  if (!(input.bytes instanceof Uint8Array)) return fail(`${label} 的 bytes 必须是 Uint8Array`);
  if (typeof input.path !== "string" || input.path === "") return fail(`${label} 的 path 必须是非空字符串`);
  const pathErr = checkEntryPath(input.path);
  if (pathErr) return fail(`路径不安全：${input.path} ${pathErr}`);
  if (!input.path.startsWith(ASSETS_DIR)) {
    return fail(`${label} 的路径必须以 ${ASSETS_DIR} 开头（${input.path}）`);
  }
  const base = input.path.slice(ASSETS_DIR.length);
  if (base.includes("/")) return fail(`资产路径不支持子目录：${input.path}（企业版按内容寻址平铺）`);
  const dot = base.indexOf(".");
  const sha = dot < 0 ? base : base.slice(0, dot);
  if (!SHA_RE.test(sha)) return fail(`资产文件名不是 sha256：${input.path}`);
  if (dot >= 0 && !EXT_RE.test(base.slice(dot + 1))) return fail(`资产扩展名不合法：${input.path}`);
  const actual = await sha256Hex(input.bytes);
  if (actual !== sha) return fail(`资产 sha256 与内容不符（路径写 ${sha}，字节实际 ${actual}）：${input.path}`);
  return { path: input.path, bytes: input.bytes, sha256: sha };
}

/**
 * 组装一个 `.shuyodoc` 的 zip 字节。
 *
 * 顺序固定、store 模式、时间戳固定 ⇒ 同一份输入得到**逐字节相同**的包。
 * 入参不合法 / 资产自证不过 / 重名 / 超上限 ⇒ **抛错**（调用方拿到的是"没产出"，不是一个坏包）。
 */
export async function buildDocumentPackage(input: BuildDocumentPackageInput): Promise<Uint8Array> {
  if (typeof input !== "object" || input === null) fail("入参必须是对象");

  // ① manifest：复用格式层的入参校验（id / 标题 / 时间 / 版本号必须非空），
  //    但**只写企业版 10 个必填字段**（字段顺序同企业版 `buildDocumentPackage`）。
  const built = buildManifest({
    documentId: input.documentId,
    title: input.title,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    sourceAppVersion: input.sourceAppVersion,
  });
  const manifest: Omit<DocManifest, "assets"> = {
    format: DOC_FORMAT,
    format_version: DOC_FORMAT_VERSION,
    source: built.source,
    source_app_version: built.source_app_version,
    document_id: built.document_id,
    title: built.title,
    created_at: built.created_at,
    updated_at: built.updated_at,
    content_type: CONTENT_TYPE_LEXICAL,
    encrypted: false,
  };

  // ② 正文（不合法就现在拒，⛔ 不写"自己的读端读不回来"的包）
  const docJson = normalizeDocJson(input.docJson);

  // ③ 资产：逐个校验（路径安全 / 内容寻址 / sha 与字节一致 / 不重名）
  const rawAssets = input.assets ?? [];
  if (!Array.isArray(rawAssets)) fail("assets 必须是数组");
  const assets: NormalizedAsset[] = [];
  const seen = new Set<string>();
  for (const [i, a] of rawAssets.entries()) {
    const normalized = await normalizeAsset(a, i);
    if (seen.has(normalized.path)) fail(`资产路径重复：${normalized.path}（同名条目会被 zip 静默覆盖）`);
    seen.add(normalized.path);
    assets.push(normalized);
  }

  // ④ 条目（顺序固定：清单 → 正文 → 资产 → 校验和）
  const entries: { path: string; bytes: Uint8Array }[] = [
    { path: MANIFEST_PATH, bytes: utf8(`${JSON.stringify(manifest, null, 2)}\n`) },
    { path: CONTENT_PATH, bytes: utf8(docJson) },
    ...assets.map((a) => ({ path: a.path, bytes: a.bytes })),
  ];
  // checksums 登记除自身以外的每个条目（v1 不写签名 ⇒「除自身/签名」等于「除自身」）。
  const checksums = await buildChecksums(entries);
  entries.push({ path: CHECKSUMS_PATH, bytes: utf8(`${JSON.stringify(checksums, null, 2)}\n`) });

  // ⑤ 大小上限：与本仓读端同一口径（⛔ 不导出自己都读不回来的包）
  const sizeErr = checkSizeLimits(entries.map((e) => ({ path: e.path, size: e.bytes.byteLength })));
  if (sizeErr) fail(sizeErr);

  // ⑥ store（level 0）⇒ zip。企业版读端只认 store，容器层口径必须一致。
  const zippable: Record<string, Uint8Array> = {};
  for (const e of entries) zippable[e.path] = e.bytes;
  const pathErr = checkWritePaths(entries);
  if (pathErr) throw new Error(`buildDocumentPackage: ${pathErr}`);
  return zipSync(zippable, { level: 0, mtime: ZIP_EPOCH });
}
