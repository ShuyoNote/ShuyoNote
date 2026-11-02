// 单文档包 `.shuyodoc` 的**界面接线**（M1 最后一段）—— 页面右键「导出为 .shuyodoc」＋
// 文件区「导入文档包」。方案见 `docs/plans/2026-10-29-shuyodoc-m1.md`（owner 已定：只做单篇；
// 导入**永远新建**、同名也新建；⛔ 不带评论/历史）。
//
// ## 分工：格式层不管 IO，本文件不管格式
//   · 写包：`docPackWriter.ts::buildDocumentPackage`（store zip ＋ checksums，企业版 reader 已验过）；
//   · 读包：`docZip.ts::unzipDocument` ⇒ `docPackageOpen.ts::openDocumentPackage`（整包拒绝，错误带条目名）。
//   ⇒ 本文件只做三件事：**取字节**（页面正文 / 页附件）、**走既有保存路径落盘**、**走既有附件写入路径落库**。
//
// ## ⛔ 四条"不新造"（每条都有现成的那一条路）
//   ① 保存文件：`platform.dialog.save` ＋ `api.writeBinaryFile`（与 Markdown 导出、空间导出同一条；
//      Web 侧它就是 Blob ＋ `<a download>`，见 `platform/web.ts`）—— ⛔ 不自建下载/落盘；
//   ② 读附件字节：`api.readAttachmentBytes(hash)`（内容寻址、会解密）—— ⛔ 不走 `read_text_file`（那是密文）；
//   ③ 写附件字节：`api.writeAttachmentBytes`（既有命令 `write_attachment_bytes`：内容寻址、自带去重）
//      —— ⛔ 不手写库、⛔ 不用 `save_image`（那张 mime 表只认图片/PDF 那几类）；
//   ④ 建页：`api.createPage` ＋ `pageCreationArgsFromDocJson`（正文 JSON ⇒ 落库形状那一层，
//      见 `docContent.ts` 的注释：界面自己拼那个键名会被 `check-doc-content-access` 当场判红）。
//
// ## 导入时"选来的那个文件"怎么读字节 —— 只有这一条路
// 桌面**没有**「按任意路径读二进制」的命令（`read_file_bytes` 只有 Web 实现，见 `platform/web.ts`）。
// 既有口径（`lib/office/pathImport.ts` 就是这么做的）：先把选来的文件按内容寻址**入库**，
// 再按 hash 读回**解密后**的字节。这里借道之后**删掉那一行临时附件** ——
// `remove_attachment` 只在"没有任何别的行引用这个 hash"时才释放字节（`attachments.rs` 的两条引用计数），
// 所以删它**不会**碰用户已经存在的同名附件。
//
// ## 失败姿态（与 `importPipeline.ts` / `parseManifest` 同一份口径）
// **本层不抛异常**：一律回 `{ ok, message }`，`message` 是拿来**原样**显示给用户的那句人话。
//   · `openDocumentPackage` 的拒绝语本来就点名"哪个条目、为什么" ⇒ 直接原样带回（⛔ 不翻译、不吞）；
//   · 包没问题但某一步 IO 失败 ⇒ 如实说是哪一步、什么错，⛔ 不假装成功。
import { api } from "./api";
import { platform } from "./platform";
import { docJsonOfPage, pageCreationArgsFromDocJson } from "./docContent";
import { deriveContentText } from "./contentText";
import { APP_VERSION } from "./links";
import { sanitizeName } from "./exportMarkdown";
import { extensionForMime, extensionFromName } from "./exportMarkdownBundle";
import { buildDocumentPackage, type DocumentPackageAsset } from "./docPackWriter";
import { unzipDocument } from "./docZip";
import { openDocumentPackage } from "./docPackageOpen";
import type { AttachmentMeta, PageDetail } from "../types";

/** 本格式的文件扩展名（⛔ 别在别处再写一份字面量）。 */
export const DOC_PACKAGE_EXT = "shuyodoc";
/** 包内资产目录（与 `docPackWriter.ts::ASSETS_DIR` 同口径；读回来时按它切扩展名）。 */
const ASSETS_PREFIX = "assets/";

/** 一次导出/导入的结果：`message` 是**给人看的那一句**（成功也回它，界面直接 toast）。 */
export type DocPackageOutcome =
  | { ok: true; message: string; pageId?: string }
  | { ok: false; message: string; canceled?: boolean };

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** 附件的 hash 是 64 位十六进制（Rust `is_valid_hash` 同一口径）—— 不合形状的**不拿去读**。 */
const SHA_RE = /^[0-9a-f]{64}$/i;

// ─────────────────────────────────────────────────────────────────────────────
// 时间：页面记录里是**毫秒**，包里要字符串（企业版 manifest 只要求"非空字符串"）。
// ─────────────────────────────────────────────────────────────────────────────
function isoOf(ms: unknown): string {
  // 拿不到时间（老库 / 坏数据）⇒ 用现在的时刻，但**不编造一个 1970**（那会让包看起来比实际老 50 年）。
  const n = typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? ms : Date.now();
  try {
    return new Date(n).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 资产清单：页附件 ∪ 正文里引用到的 hash
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 正文 JSON 里**引用到的附件 hash**（`Map<hash, mime|null>`）。
 *
 * 两条来源都要收，因为媒体节点与"文件卡"节点的形状不同：
 *   · 节点自带的指纹字段：`{ hash, mime }`（`ImageNode` / 视频 / 文件卡导出 JSON 都有）；
 *   · 正文里的字面量 `attachment://<hash>`（office 导入的图片节点只剩这个，没有指纹）。
 * ⚠️ 只收 **64 位十六进制**：别的形状不可能是附件 hash（`readAttachmentBytes` 会拒），
 *    拿它去读只会把"正文里一句普通文字"变成一次失败。
 */
export function assetRefsInDocJson(docJson: string): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const add = (hash: string, mime: string | null) => {
    if (!SHA_RE.test(hash)) return;
    const key = hash.toLowerCase();
    if (!out.has(key) || (mime && !out.get(key))) out.set(key, mime ?? null);
  };
  let root: unknown;
  try {
    root = JSON.parse(docJson || "{}");
  } catch {
    return out; // 坏 JSON：导出侧会由 `buildDocumentPackage` 如实拒（这里不抢着报错）
  }
  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      for (const m of node.matchAll(/attachment:\/\/([0-9a-fA-F]{64})/g)) add(m[1], null);
      return;
    }
    if (Array.isArray(node)) {
      for (const v of node) walk(v);
      return;
    }
    if (!node || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    if (typeof o.hash === "string" && SHA_RE.test(o.hash)) {
      add(o.hash, typeof o.mime === "string" && o.mime ? o.mime : null);
    }
    for (const v of Object.values(o)) walk(v);
  };
  walk(root);
  return out;
}

/** 资产在包里的扩展名：**先问 mime、再问原名**，都认不出来才 `.bin`（与 `assetPathFor` 同口径）。 */
function assetExtOf(meta: { mime?: string | null; name?: string | null } | undefined): string {
  return extensionForMime(meta?.mime) || extensionFromName(meta?.name) || "bin";
}

// ─────────────────────────────────────────────────────────────────────────────
// 导入侧：包里那条 `assets/<sha256>.<ext>` ⇒ 写附件时要的 mime
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 扩展名 ⇒ mime。**镜像** Rust `attachments.rs::ext_from_mime_opt` 那张表（落地时按 mime 定扩展名）。
 *
 * ⚠️ 为什么需要它：包里只留 `assets/<sha256>.<ext>`（企业版按内容寻址，**不带原名/mime**），
 *    而写附件那条命令要 mime。优先用正文节点里声明的 mime（见 [`assetRefsInDocJson`]），
 *    这张表只兜"正文没声明"的那些。认不出来 ⇒ `application/octet-stream`（如实：不知道是什么）。
 */
const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  tiff: "image/tiff",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  html: "text/html",
  htm: "text/html",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  css: "text/css",
  json: "application/json",
  js: "application/javascript",
  zip: "application/zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
};

function mimeForExt(ext: string, declared?: string | null): string {
  if (declared && declared !== "application/octet-stream") return declared;
  return MIME_BY_EXT[ext.toLowerCase()] || "application/octet-stream";
}

/** `assets/<sha256>.<ext>` ⇒ `{ hash, ext }`（`openDocumentPackage` 已判过形状，这里只拆）。 */
function splitAssetPath(path: string): { hash: string; ext: string } {
  const base = path.startsWith(ASSETS_PREFIX) ? path.slice(ASSETS_PREFIX.length) : path;
  const dot = base.indexOf(".");
  const hash = (dot < 0 ? base : base.slice(0, dot)).toLowerCase();
  const ext = dot < 0 ? "bin" : base.slice(dot + 1).toLowerCase();
  return { hash, ext };
}

// ─────────────────────────────────────────────────────────────────────────────
// 导出
// ─────────────────────────────────────────────────────────────────────────────

/** 打包 `.shuyodoc` 时能注入的读依赖（B3 的前端桥用；不注入就全走既有 `api`）。 */
export interface DocPackageBuildDeps {
  getPage?: (id: string) => Promise<PageDetail>;
  listPageAttachments?: (id: string) => Promise<AttachmentMeta[]>;
  readAttachmentBytes?: (hash: string) => Promise<ArrayBuffer | Uint8Array>;
}

/** 只**算出来**的一只 `.shuyodoc`（不弹框、不落盘）。 */
export interface BuiltDocPackage {
  bytes: Uint8Array;
  title: string;
  assetCount: number;
  unreadable: number;
  notices: string[];
}

/**
 * 只**算字节**：读页 → 收集附件（页附件 ∪ 正文引用）→ `buildDocumentPackage`。
 *
 * 为什么单独抽出来（B3，2026-10-29）：界面「导出为 .shuyodoc」与外部 MCP 的
 * `export.docpackage`（经 Rust→前端桥）必须走**同一份**收集/打包逻辑；各写一遍就会出现
 * "界面带走 3 个附件、MCP 只带走 2 个"这种没人会发现的漂移。⛔ 不在这里判格式（格式归
 * `docPackWriter.ts`）。
 */
export async function buildPageDocPackageBytes(
  pageId: string,
  deps: DocPackageBuildDeps = {},
): Promise<BuiltDocPackage> {
  const getPage = deps.getPage ?? ((id: string) => api.getPage(id) as unknown as Promise<PageDetail>);
  const listAttachments = deps.listPageAttachments ?? ((id: string) => api.listPageAttachments(id));
  const readBytes = deps.readAttachmentBytes ?? ((hash: string) => api.readAttachmentBytes(hash));
  const page = await getPage(pageId);
  if (!page || typeof page.id !== "string") {
    throw new Error(`not_found: 页面 ${pageId} 不存在或已被删`);
  }
  const title = String(page.title ?? "").trim() || "未命名";
  // 正文经 `docContent.ts` 那一层取（⛔ 不在这里提存储列名 —— `check-doc-content-access` 只减不增）。
  const docJson = docJsonOfPage(page);

  // 资产 = 页附件（显式挂在这页上的）∪ 正文引用（可能挂在别的页/未整理，但正文要用）
  const notices: string[] = [];
  let attached: AttachmentMeta[] = [];
  try {
    attached = await listAttachments(pageId);
  } catch (e) {
    notices.push(`页附件清单没列出来（${messageOf(e)}）⇒ 只带正文引用到的附件`);
  }
  const refs = assetRefsInDocJson(docJson);
  const wanted = new Map<string, { mime?: string | null; name?: string | null }>();
  for (const a of attached) {
    if (!a || typeof a.hash !== "string" || !SHA_RE.test(a.hash)) continue;
    wanted.set(a.hash.toLowerCase(), { mime: a.mime, name: a.name });
  }
  for (const [hash, mime] of refs) {
    if (!wanted.has(hash)) wanted.set(hash, { mime });
  }

  const assets: DocumentPackageAsset[] = [];
  const unreadable: string[] = [];
  for (const [hash, meta] of wanted) {
    try {
      const raw = await readBytes(hash);
      const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      if (bytes.byteLength === 0) {
        unreadable.push(hash);
        continue;
      }
      // 路径形状由写侧校验（`assets/<sha256>.<ext>`）；hash 来自数据库/正文，这里已限成 64 hex。
      assets.push({ path: `${ASSETS_PREFIX}${hash}.${assetExtOf(meta)}`, bytes });
    } catch {
      // 拿不到字节（没同步到本机 / 盘上被删）⇒ **不装进包**，但如实报数（⛔ 不假装带走）
      unreadable.push(hash);
    }
  }

  const zip = await buildDocumentPackage({
    documentId: page.id,
    title,
    createdAt: isoOf(page.created_at),
    updatedAt: isoOf(page.updated_at),
    docJson,
    assets,
    sourceAppVersion: APP_VERSION,
  });
  return { bytes: zip, title, assetCount: assets.length, unreadable: unreadable.length, notices };
}

/**
 * 把一页导出成 `<标题>.shuyodoc`（选路径 ⇒ 读正文/附件 ⇒ 写包 ⇒ 落盘）。
 *
 * @returns 成功 ⇒ `{ ok:true, message }`（`message` 里带落盘路径与附件数，以及**没带进去的那几件**）；
 *          取消 ⇒ `{ ok:false, canceled:true }`；失败 ⇒ `{ ok:false, message }`（`Error.message` **原样**）。
 */
export async function exportPageAsDocPackage(pageId: string): Promise<DocPackageOutcome> {
  try {
    const page = (await api.getPage(pageId)) as PageDetail;
    if (!page || typeof page.id !== "string") return { ok: false, message: "导出失败：读不到这一页（页面不存在或已被删）" };

    // 保存路径：走**现有**那条（桌面 dialog ＋ write_binary_file；Web 是下载）。
    // ⚠️ **先弹框、再读附件**：用户取消时一个字节都不读（大文档的附件读取很贵，
    //    而"先读 200 MB 再问用户要不要"是白付）。默认文件名用标题（`sanitizeName` 清非法字符）。
    const path = await platform.dialog.save({
      title: "导出为 .shuyodoc",
      defaultPath: `${sanitizeName(String(page.title || pageId))}.${DOC_PACKAGE_EXT}`,
      filters: [{ name: "ShuyoDoc 文档包", extensions: [DOC_PACKAGE_EXT] }],
    });
    if (!path) return { ok: false, canceled: true, message: "已取消导出" };

    // 保存路径已经问过（见上）⇒ 这里直接打包（`buildDocumentPackage` 会自证资产 sha）。
    const built = await buildPageDocPackageBytes(pageId, { getPage: async () => page });
    await api.writeBinaryFile(path as string, Array.from(built.bytes));

    const bits = [`${built.assetCount} 个附件`];
    if (built.unreadable) bits.push(`${built.unreadable} 个附件字节取不到 ⇒ 没装进包（正文里仍引用它们，没静默删）`);
    bits.push(...built.notices);
    return { ok: true, message: `已导出「${built.title}」到 ${path}（${bits.join("；")}）` };
  } catch (e) {
    // 「原样」：`buildDocumentPackage` 的拒绝语自带来源前缀（`buildDocumentPackage: …`），
    // 磁盘/IPC 的错误也自带原因 ⇒ 不再包一层"导出失败：…"把它盖掉。
    return { ok: false, message: messageOf(e) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 导入
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 把用户选来的那个文件读成字节 —— 走**现有**那条"路径 ⇒ 内容寻址入库 ⇒ 按 hash 读回"的路。
 *
 * @param parentId 临时那一行挂在谁名下（传当前页/文件夹；马上就会删，所以几乎看不到它）。
 * @returns 文件的明文字节。
 */
async function readPickedFileBytes(path: string, parentId: string | null): Promise<Uint8Array> {
  const metas = await api.importAttachmentFiles(parentId, [path as string]);
  const meta = Array.isArray(metas) ? metas[0] : undefined;
  if (!meta?.hash) throw new Error("这个文件没能读入（拿不到内容指纹）—— 换个位置再试，或用桌面版");
  try {
    return new Uint8Array(await api.readAttachmentBytes(meta.hash));
  } finally {
    // 只是借道读字节：删掉这一行。`remove_attachment` 只在**没有任何别的行**引用这个 hash 时才释放
    // 字节（跨空间也算）⇒ 用户库里已有的同名附件不受影响；删不掉也只是多一行未整理文件，不影响导入。
    try {
      await api.removeAttachment(meta.id);
    } catch {
      /* 清不掉不影响导入（如实不做承诺） */
    }
  }
}

/**
 * 导入一个 `.shuyodoc`：选文件 ⇒ 解 zip ⇒ 整包校验 ⇒ 资产入库 ⇒ **新建一页**。
 *
 * 三条红线：
 *   · ⛔ **永不覆盖**：只调 `api.createPage`（新建），不调任何 update/覆盖接口；
 *   · ⛔ **不手写库**：资产走既有命令 `write_attachment_bytes`（内容寻址去重）；
 *   · ⛔ **失败不吞**：`openDocumentPackage` 的拒绝语原样回给界面（它已经点名条目与原因）。
 *
 * @param parentId 新页挂哪（当前选中的页/文件夹；`null` ⇒ 空间根）。**同名也新建**。
 */
export async function importDocumentPackage(parentId: string | null): Promise<DocPackageOutcome> {
  try {
    const path = await platform.dialog.open({
      title: "导入文档包",
      filters: [{ name: "ShuyoDoc 文档包", extensions: [DOC_PACKAGE_EXT] }],
      multiple: false,
    });
    if (!path) return { ok: false, canceled: true, message: "已取消导入" };
    const picked = Array.isArray(path) ? path[0] : path;
    if (!picked) return { ok: false, canceled: true, message: "已取消导入" };

    // ① 字节 ⇒ 条目（zip 层只负责解，安全闸在 `openDocumentPackage` 一处）
    const bytes = await readPickedFileBytes(picked, null);
    const entries = await unzipDocument(bytes);
    // ② 整包校验（manifest / checksums / 缺 · 多 · 重复 · 夹带 / sha 自证）
    const opened = await openDocumentPackage(entries);
    if (!opened.ok) {
      // ⛔ 原样：这句话已经点名"哪个条目、为什么"（`docPackageOpen.ts` 的每条拒绝语都是给用户看的）
      return { ok: false, message: opened.error };
    }
    const pkg = opened.pkg;
    const title = String(pkg.manifest.title ?? "").trim() || "导入的文档";

    // ③ 资产：按**包里文件名里的 sha256** 写回内容寻址附件库（去重由那条命令负责）
    const declaredMime = assetRefsInDocJson(pkg.docJson);
    let writtenCount = 0;
    const failed: string[] = [];
    for (const a of pkg.assets) {
      const { hash, ext } = splitAssetPath(a.path);
      try {
        await api.writeAttachmentBytes({
          hash,
          mime: mimeForExt(ext, declaredMime.get(hash) ?? null),
          // 包里**没有原名**（企业版只存内容地址）⇒ 名字只能给内容地址的前 8 位；如实不用假名。
          name: `${hash.slice(0, 8)}.${ext}`,
          data: Array.from(a.bytes),
        });
        writtenCount += 1;
      } catch (e) {
        failed.push(`${a.path}（${messageOf(e)}）`);
      }
    }

    // ④ 新建一页（父级＝调用方给的当前页/文件夹；⛔ 不覆盖任何已有页面）
    const args = pageCreationArgsFromDocJson(title, pkg.docJson, deriveContentText(pkg.docJson));
    const created = await api.createPage({ ...args, parent_id: parentId });
    if (!created || typeof created.id !== "string") {
      return { ok: false, message: `页面没能建出来（正文与 ${writtenCount} 个附件已入库，但没有落到任何页面上）` };
    }

    // ⑤ 刷新页面树并打开新页（⛔ 不让用户"导入了却看不到"）
    // ⚠️ 懒引用 store（与 `lib/office/pathImport.ts` 同一手法：顶层引会把 store ⇄ lib 的依赖图绕成环）
    try {
      const { useNotes } = await import("../store/notes");
      await useNotes.getState().loadPages();
      await useNotes.getState().openPage(created.id);
    } catch {
      /* 已建页就算成功：刷新/打开失败只影响"看不看得见"，不影响数据（不从成功降级成失败） */
    }

    const bits = [`${writtenCount} 个附件`];
    if (failed.length) bits.push(`${failed.length} 个附件没写进去：${failed.join("；")}`);
    bits.push(...pkg.notices);
    return {
      ok: true,
      pageId: created.id,
      message: `已导入「${title}」为新页面（${bits.join("；")}；同名也新建，未覆盖任何已有页面）`,
    };
  } catch (e) {
    return { ok: false, message: messageOf(e) };
  }
}
