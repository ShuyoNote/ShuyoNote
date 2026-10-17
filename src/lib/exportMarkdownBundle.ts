// 空间 / 单页导出 Markdown **带附件 ＋ 打包 zip ＋ 路径重写**（方案 V1.1 的 MVP 实现）。
//
// 为什么不塞进 `exportMarkdown.ts`：那条路（单页 / 空间 → **纯 .md 文件**）已经在跑、有自己的判据；
// 这一片多出来的三件事（打 zip、把附件抄进去、把引用改成相对路径）都不该影响它。
// 共用的那一步（页面 JSON → Markdown）仍然**只有** `pageContentToMarkdown` 一份 ✓（含 Route-B 列块展开）。
//
// 四条硬约束（每条都有现场）：
//  ① **zip 在前端打**（fflate）：Tauri 没有 Node 运行时 ⇒ 桌面壳与 Web 壳必须是同一份实现 ✓；
//  ② 正文里的引用是 `attachment://<hash>`（内容寻址）⇒ 出口换成 `assets/<hash>.<ext>`（**同目录相对** ✓）。
//     ⚠️ 桌面端 `ImageNode.__src` 常常是 `attachment://localhost/C%3A/…` —— 那是应用专有 URL、
//     **里面没有 hash** ⇒ 光"替换这个字符串"抓不到它。所以还有第二条路：转换时用现成的
//     `resolveImage` 回调**只记录** `src → hash`（返回空串 ⇒ Markdown 与老导出**逐字相同**），
//     再按**精确串**换成相对路径 ✓。两条路都在，是因为 office 导入的图片节点**没有指纹**
//     （正文里只剩字面量 `attachment://<hash>`），只靠节点指纹会漏。
//  ③ 同一个 `<hash>` 只放一份（`Map` / `Set` 守住 ✓ —— 内容寻址天然如此）；
//  ④ 文件名一律过 `sanitizeName`，并**额外**剥 `..` / 路径分隔符 / 控制字符（防 zip-slip ✗）；
//     附件条目名还要再剥一遍（hash 来自正文，不能信）✓。
//
// ⚠️ 落盘用**现成的** `write_binary_file`（Rust 在 `src-tauri/src/backup.rs`，Web 侧是 Blob 下载）
//    ⇒ 这一片**没有新增任何后端命令** ✓；附件字节与类型也只用现成的 `read_attachment_bytes`
//    ＋ `list_page_attachments`，⛔ 不新造附件命令 ✗。
// ⚠️ 任何一步拿不到（附件字节没同步下来 / 类型问不到）都**如实说**，⛔ 不假装成功 ✗：
//    类型问不到 ⇒ 存成 `.bin`；字节取不到 ⇒ 不装进 zip、正文里**保留原引用**，并在返回消息里报数。
import { strToU8, zipSync, type Zippable } from "fflate";
import { platform } from "./platform";
import { api } from "./api";
import { docJsonOfPage } from "./docContent";
import { pageContentToMarkdown, sanitizeName, type MarkdownPageInput } from "./exportMarkdown";
import type { AttachmentMeta } from "../types";

/** zip 里附件都放这个目录（⛔ 别改成 `./assets` / 绝对路径：正文里的引用与它必须**逐字**一致） */
export const BUNDLE_ASSET_DIR = "assets";

/**
 * mime → 扩展名。
 *
 * ⚠️ 只收"我们真的会产生"的那些，⛔ 不追求全 —— 认不出来就 `.bin`（诚实的坏文件胜过
 * 猜一个扩展名让系统用错程序打开 ✗）。表外的 `image/*` / `video/*` / `audio/*` 走子类型兜底。
 */
const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "image/svg+xml": "svg",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/ogg": "ogg",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "application/json": "json",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
};

/** 附件的元数据（`mime` 用来定扩展名，`name` 只在 mime 认不出来时兜底取后缀）。 */
export interface BundleAttachmentMeta {
  mime?: string | null;
  name?: string | null;
}

/** mime → 扩展名（认不出来 ⇒ 空串；⛔ 不返回 `bin`，让调用方决定兜底 ✗）。 */
export function extensionForMime(mime?: string | null): string {
  const raw = String(mime ?? "").split(";")[0].trim().toLowerCase();
  if (!raw) return "";
  const hit = MIME_EXT[raw];
  if (hit) return hit;
  // 兜底：只对媒体类按子类型取（`image/x-icon` ⇒ `icon`、`image/svg+xml` ⇒ `svg`）；
  // 其它（`application/vnd…` 这种）一律认不出来 —— 猜出来也不是大家认得的扩展名。
  if (!/^(image|video|audio)\//.test(raw)) return "";
  const sub = raw.slice(raw.indexOf("/") + 1).split("+")[0].replace(/^x-/, "");
  const ext = sub.replace(/[^a-z0-9]/g, "");
  return ext.length >= 1 && ext.length <= 8 ? ext : "";
}

/** 从文件名取扩展名（`image.png` ⇒ `png`；`.hidden` / `a.` / 怪字符 ⇒ 空串）。 */
export function extensionFromName(name?: string | null): string {
  const base = String(name ?? "").replace(/^.*[\\/]/, "");
  const i = base.lastIndexOf(".");
  if (i <= 0 || i === base.length - 1) return "";
  const ext = base.slice(i + 1).toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : "";
}

/**
 * zip 条目名清洗：**先过共享的 `sanitizeName`**（⛔ 不另写一份 ✗），再额外剥
 * `..` / 路径分隔符 / 控制字符，最后限长。
 *
 * 为什么要加这一层：`sanitizeName` 保的是"这个文件名在 Windows/macOS 上合法"，
 * 而 zip 条目名多一条**安全**要求 —— `..` 不许上跳（zip-slip ✗）。
 * 实测形状：页面标题就叫 `../../etc/passwd` 时，光靠 `sanitizeName` 会留下 `..`。
 */
export function safeEntryName(raw: string | null | undefined, fallback: string): string {
  const source = String(raw ?? "").replace(/\.{2,}/g, "_");
  let s = sanitizeName(source || String(fallback ?? ""));
  // 额外再兜一遍：`sanitizeName` 将来若放宽，条目名也不能带着分隔符 / 上跳跑出目录。
  s = s.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/^[.\s]+|[.\s]+$/g, "");
  // 只剩点/下划线/连字符（例如标题就叫 `..`，清完是 `_`）⇒ 这不是个名字，用兜底名）
  if (/^[._\-\s]*$/.test(s)) s = sanitizeName(String(fallback ?? "")) || "未命名";
  return s.slice(0, 120);
}

/**
 * 一份附件在 zip 里的相对路径：`assets/<hash>.<ext>`。
 *
 * hash 来自正文（不可信）⇒ 只留 `[A-Za-z0-9_-]`（`../../x` 会退化成 `x`，剥空了就叫
 * `attachment`）；扩展名依次问 mime、文件名，都认不出来才 `.bin` ✓。
 */
export function assetPathFor(hash: string, meta?: BundleAttachmentMeta | null): string {
  const id = String(hash ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 128) || "attachment";
  const ext = extensionForMime(meta?.mime) || extensionFromName(meta?.name) || "bin";
  return `${BUNDLE_ASSET_DIR}/${id}.${ext}`;
}

/**
 * 正文里的字面量附件引用：`attachment://<hash>`（可带一个 `.png` 后缀）。
 *
 * ⚠️ 末尾那个"边界"是**故意的**：桌面的 `attachment://localhost/C%3A/x.png` 这类 URL
 * **不含 hash**，它后面跟的是 `/` ⇒ 不匹配 ⇒ 原样留着（换成相对路径只会得到一个坏链接 ✗）。
 */
const ATTACHMENT_REF = /attachment:\/\/([A-Za-z0-9_-]+)(?:\.[A-Za-z0-9]{1,8})?(?=[\s)"'#>\]},;|]|$)/g;

/** 正文里引用到的 `<hash>`（**按首次出现去重**，⛔ 不是"出现了几次"）。 */
export function attachmentHashesIn(markdown: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of String(markdown ?? "").matchAll(ATTACHMENT_REF)) {
    const hash = m[1];
    if (!seen.has(hash)) {
      seen.add(hash);
      out.push(hash);
    }
  }
  return out;
}

/** 把正文里的字面量 `attachment://<hash>` 换成 `pathOf(hash)`（返回 `null` ⇒ **原样留着**）。 */
export function rewriteAttachmentRefs(
  markdown: string,
  pathOf: (hash: string) => string | null,
): string {
  return String(markdown ?? "").replace(ATTACHMENT_REF, (whole, hash: string) => pathOf(hash) ?? whole);
}

/**
 * 一页"准备好的"导出材料：**Markdown 已经转好**（走的是全应用唯一那份转换 ✓），
 * 外加转换时从节点上读到的 `src → hash/mime`。
 *
 * 把"转换"与"排版（拼 zip）"拆开，是为了两件事：**只转一次**（Lexical 转换不便宜），
 * 以及让路径重写这一层是**纯函数**（好测、不碰外部世界）。
 */
export interface PreparedPage {
  id: string;
  title: string;
  markdown: string;
  /** 节点里带指纹的图片/视频：`__src` → `__hash` ＋ `__mime`（`resolveImage` 只记录、不改写）。 */
  srcToHash: Map<string, { hash: string; mime: string }>;
  /** ⭐ 2026-10-17：页面树里的父页 id（`null`／缺省 ⇒ 顶层）；只用于 zip 内的**目录** ✓。 */
  parentId?: string | null;
  /** 转换失败的原因（有值 ⇒ 这一页不进 zip，但**要在返回消息里如实说**）。 */
  error?: string;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 把页面转成 Markdown，并记下节点上的附件指纹。
 *
 * ⚠️ `resolveImage` 一律返回空串 ⇒ exporter 保留 `__src` ⇒ **Markdown 与老导出逐字相同** ✓
 * （这一步只"看"，不改写；真正的换路径在 [`planBundle`] 里，那时才知道字节取不取得到）。
 */
export function preparePages(pages: readonly MarkdownPageInput[]): PreparedPage[] {
  return pages.map((page) => {
    const srcToHash = new Map<string, { hash: string; mime: string }>();
    try {
      const markdown = pageContentToMarkdown(page.docJson, (hash, mime, src) => {
        if (hash && src) srcToHash.set(src, { hash, mime: mime || "" });
        return ""; // 空串 ＝ 保持 `__src`（见 `exportMarkdown.ts::transformersWithImageResolver`）
      });
      return { id: page.id, title: page.title || "", markdown, srcToHash, parentId: page.parentId ?? null };
    } catch (e) {
      // 这一页转换不了（正文 JSON 坏了）⇒ 跳过它，但账要留着（返回消息里报数）
      return { id: page.id, title: page.title || "", markdown: "", srcToHash, parentId: page.parentId ?? null, error: messageOf(e) };
    }
  });
}

/**
 * 这些页**真的**引用到了哪些 `<hash>`（去重、按首次出现排序）。
 *
 * ⚠️ 只算"Markdown 里看得见"的：段落里嵌着的图片本来就整块不进 Markdown
 * （见 `exportMarkdown.ts::pageImageRefs` 那条"多收"的注释）⇒ 给它复制一份附件是白费。
 */
export function referencedHashes(prepared: readonly PreparedPage[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (hash: string) => {
    if (!hash || seen.has(hash)) return;
    seen.add(hash);
    out.push(hash);
  };
  for (const p of prepared) {
    if (p.error) continue;
    for (const [src, ref] of p.srcToHash) if (p.markdown.includes(src)) push(ref.hash);
    for (const hash of attachmentHashesIn(p.markdown)) push(hash);
  }
  return out;
}

/**
 * ⭐ **2026-10-17**：算出**每个页面在 zip 里的路径**（目录树 ✓，纯函数 ✓）。
 *
 * 口径（与 `wikiExport.ts::findChildren` 同一套惯例 ✓）：
 * · 兄弟顺序＝标题（`localeCompare("zh")`）再按 `id` ⇒ **稳定** ✓
 *   （这一层没有 `sort_order` ✗ —— ⛔ 不为排序再去多读一列 ✗）；
 * · 同名兄弟 ⇒ **后出现的**那份加 `-<id 前 6 位>` ✓（与文件重名同一策略 ✓）；
 * · 父**不在这一轮清单里**、或父链**成环** ⇒ 当**顶层** ✓（⛔ 不猜、不造空目录 ✗）；
 * · 子页放进**与父页同名的目录**（Obsidian folder-note 惯例 ✓：`父.md` ＋ `父/子.md`）；
 * · 名字仍走 `safeEntryName` ✓（清理 ＋ 防 `..` ✓）。
 */
export function treePaths(prepared: readonly PreparedPage[]): Map<string, string> {
  const usable = prepared.filter((p) => !p.error);
  const byId = new Map(usable.map((p) => [p.id, p] as const));

  // 父指针归一：父必须在清单里、不是自己、且父链**不成环** ⇒ 否则当顶层 ✓
  const parentOf = new Map<string, string | null>();
  for (const p of usable) {
    let parent = p.parentId && byId.has(p.parentId) && p.parentId !== p.id ? p.parentId : null;
    if (parent) {
      const seen = new Set<string>([p.id]);
      let walk: string | null = parent;
      while (walk) {
        if (seen.has(walk)) {
          parent = null; // 成环 ⇒ 这一页当顶层 ✓（⛔ 死循环 ✗）
          break;
        }
        seen.add(walk);
        const next: string | null = byId.get(walk)?.parentId ?? null;
        if (!next || !byId.has(next) || next === walk) break;
        walk = next;
      }
    }
    parentOf.set(p.id, parent);
  }

  const children = new Map<string | null, PreparedPage[]>();
  for (const p of usable) {
    const key = parentOf.get(p.id) ?? null;
    const list = children.get(key) ?? [];
    list.push(p);
    children.set(key, list);
  }
  const byTitle = (a: PreparedPage, b: PreparedPage) =>
    (a.title || "").localeCompare(b.title || "", "zh") || a.id.localeCompare(b.id);

  const paths = new Map<string, string>();
  const nameMaps = new Map<string, Set<string>>(); // 目录 → 该目录里已用掉的名字（去重 ✓）
  const walk = (parent: string | null, dir: string) => {
    for (const p of (children.get(parent) ?? []).slice().sort(byTitle)) {
      const base = safeEntryName(p.title || p.id, p.id);
      const used = nameMaps.get(dir) ?? new Set<string>();
      nameMaps.set(dir, used);
      let name = base;
      if (used.has(name)) name = safeEntryName(`${base}-${p.id.slice(0, 6)}`, p.id);
      used.add(name);
      paths.set(p.id, dir ? `${dir}/${name}.md` : `${name}.md`);
      walk(p.id, dir ? `${dir}/${name}` : name); // 子页进同名目录 ✓
    }
  };
  walk(null, "");
  return paths;
}

export interface BundleFile {
  /** zip 内的相对路径（已清洗）。 */
  path: string;
  text: string;
}

export interface BundleAsset {
  hash: string;
  /** zip 内的相对路径：`assets/<hash>.<ext>`。 */
  path: string;
}

export interface BundlePlan {
  files: BundleFile[];
  /** 要装进 zip 的附件（**已按 hash 去重**）。 */
  assets: BundleAsset[];
  /** 正文引用了、但这一轮**装不进去**的 hash（字节没取到 ⇒ 正文里保留原引用）。 */
  unresolved: string[];
  /** 转换失败被跳过的页数。 */
  skipped: number;
}

/**
 * 排版：算出 zip 里放哪些文件、每个引用换成什么路径。**纯函数**（不读字节、不碰文件）。
 *
 * @param prepared  [`preparePages`] 的产物
 * @param metaOf    按 hash 补元数据（mime/name）—— 节点上没带 mime 的那些靠它
 * @param available 给了就只装**这些** hash（字节没取到的那批 ⇒ 正文保留原引用，⛔ 不留坏链接 ✗）
 */
export function planBundle(
  prepared: readonly PreparedPage[],
  metaOf: (hash: string) => BundleAttachmentMeta | undefined = () => undefined,
  available?: ReadonlySet<string>,
): BundlePlan {
  // 节点上读到的 mime 优先（那是"这个文件本来是什么"的第一手读数）
  const nodeMime = new Map<string, string>();
  for (const p of prepared) {
    for (const [, ref] of p.srcToHash) if (ref.mime) nodeMime.set(ref.hash, ref.mime);
  }
  const metaFor = (hash: string): BundleAttachmentMeta => {
    const m = metaOf(hash);
    return { mime: nodeMime.get(hash) || m?.mime || "", name: m?.name ?? null };
  };
  const canUse = (hash: string) => !available || available.has(hash);

  const files: BundleFile[] = [];
  const treePathsById = treePaths(prepared);
  const assets = new Map<string, BundleAsset>();
  const unresolved = new Set<string>();
  let skipped = 0;

  for (const p of prepared) {
    if (p.error) {
      skipped += 1;
      continue;
    }
    let md = p.markdown;

    // ① 这一页真正引用到的 hash（节点指纹 ＋ 字面量，去重）
    const refs: string[] = [];
    const seenRef = new Set<string>();
    for (const [src, ref] of p.srcToHash) {
      if (!md.includes(src) || seenRef.has(ref.hash)) continue;
      seenRef.add(ref.hash);
      refs.push(ref.hash);
    }
    for (const hash of attachmentHashesIn(md)) {
      if (seenRef.has(hash)) continue;
      seenRef.add(hash);
      refs.push(hash);
    }

    // ② 每个 hash 分到一条 `assets/<hash>.<ext>`（同一 hash 全篇只一条 ⇒ 天然去重 ✓）
    const pathByHash = new Map<string, string>();
    for (const hash of refs) {
      if (!canUse(hash)) {
        unresolved.add(hash);
        continue;
      }
      const path = assetPathFor(hash, metaFor(hash));
      pathByHash.set(hash, path);
      if (!assets.has(hash)) assets.set(hash, { hash, path });
    }

    // ③ 节点指纹那条路：**精确串**替换（`attachment://localhost/…` 只能这么换）
    for (const [src, ref] of p.srcToHash) {
      const path = pathByHash.get(ref.hash);
      if (path && md.includes(src)) md = md.split(src).join(path);
    }
    // ④ 字面量那条路（office 导入的图片没有指纹，正文里只剩 `attachment://<hash>`）
    md = rewriteAttachmentRefs(md, (hash) => pathByHash.get(hash) ?? null);

    // ⑤ 路径：**目录树** ✓（同目录重名去重已在 `treePaths` 里做完 ✓）
    const name = treePathsById.get(p.id) ?? `${safeEntryName(p.title || p.id, p.id)}.md`;
    // 文件头与单页 / 空间导出**同一个形状**（`<!-- title: … · id: … -->`）
    files.push({ path: name, text: `<!-- title: ${p.title || "未命名"} · id: ${p.id} -->\n${md}` });
  }

  return { files, assets: [...assets.values()], unresolved: [...unresolved], skipped };
}

/**
 * 打成 zip（fflate，**在前端**打 ⇒ 桌面壳与 Web 壳同源 ✓）。
 *
 * 附件用 `level: 0`（**存**）：png/jpg/mp4 本来就已经压缩过，再压一遍只烧 CPU 和内存。
 * 正文用默认压缩（Markdown 压得动，且它小）。
 */
export function packBundle(
  plan: BundlePlan,
  bytesOf: ReadonlyMap<string, Uint8Array>,
): Uint8Array {
  const entries: Zippable = {};
  for (const f of plan.files) entries[f.path] = strToU8(f.text);
  for (const a of plan.assets) {
    const bytes = bytesOf.get(a.hash);
    if (!bytes) continue; // 取不到字节的已经记进 `unresolved`，不会出现在 assets 里
    entries[a.path] = [bytes, { level: 0 }];
  }
  return zipSync(entries);
}

/**
 * 附件字节的形状归一：桌面是 `ArrayBuffer`（`tauri::ipc::Response`），Web 是 `number[]`
 * （见 `web.ts` 的 `read_attachment_bytes`）—— 两边都收，⛔ 别赌其中一种 ✗。
 */
function toBytes(raw: unknown): Uint8Array {
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (ArrayBuffer.isView(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  if (Array.isArray(raw)) return Uint8Array.from(raw as number[]);
  throw new Error("附件字节的形状不认识");
}

/**
 * 问附件类型（只问**节点上没带 mime** 的那些，且同一页只问一次）。
 *
 * 用的是现成命令 `list_page_attachments`（页面自己的附件表 ⇒ hash → mime/name），
 * ⛔ 不新造后端命令 ✗。列不出来就按 `.bin` 兜底 —— 返回消息里会如实说有几个 `.bin`。
 */
async function attachmentMetaMap(
  pages: readonly MarkdownPageInput[],
  prepared: readonly PreparedPage[],
): Promise<Map<string, BundleAttachmentMeta>> {
  const meta = new Map<string, BundleAttachmentMeta>();
  const known = new Set<string>();
  for (const p of prepared) {
    for (const [, ref] of p.srcToHash) if (ref.mime) known.add(ref.hash);
  }
  const want = new Set(referencedHashes(prepared).filter((h) => !known.has(h)));
  if (want.size === 0) return meta;

  for (const page of pages) {
    if (want.size === 0) break;
    let rows: AttachmentMeta[] = [];
    try {
      rows = await api.listPageAttachments(page.id);
    } catch {
      continue; // 列不出来 ⇒ 这一页的问不到，继续下一页；最终按 .bin 兜底
    }
    for (const row of rows ?? []) {
      if (!row?.hash || !want.has(row.hash)) continue;
      meta.set(row.hash, { mime: row.mime || "", name: row.name || null });
      want.delete(row.hash);
    }
  }
  return meta;
}

interface BundleResult {
  bytes: Uint8Array;
  pages: number;
  assets: number;
  unresolved: number;
  bins: number;
  skipped: number;
}

/** 导出核心：转换 → 问类型 → 取字节（同 hash 只取一次）→ 排版 → 打包。 */
async function bundleFor(pages: readonly MarkdownPageInput[]): Promise<BundleResult> {
  const prepared = preparePages(pages);
  const meta = await attachmentMetaMap(pages, prepared);
  const metaOf = (hash: string) => meta.get(hash);

  // 先按"全都取得到"排一次版（拿到完整附件清单），再去取字节。
  const planned = planBundle(prepared, metaOf);
  const bytesOf = new Map<string, Uint8Array>();
  const failed = new Set<string>();
  for (const asset of planned.assets) {
    try {
      bytesOf.set(asset.hash, toBytes(await api.readAttachmentBytes(asset.hash)));
    } catch {
      // 没同步到本机 / 盘上没有 ⇒ **不装进 zip**；正文里的引用会在下面第二趟里**原样留着**
      // （⛔ 不改成 `assets/…` 留一个坏链接 ✗，也⛔ 不静默删掉那行 ✗）
      failed.add(asset.hash);
    }
  }

  const final =
    failed.size === 0
      ? planned
      : planBundle(
          prepared,
          metaOf,
          new Set(planned.assets.filter((a) => !failed.has(a.hash)).map((a) => a.hash)),
        );

  return {
    bytes: packBundle(final, bytesOf),
    pages: final.files.length,
    assets: final.assets.length,
    unresolved: final.unresolved.length,
    bins: final.assets.filter((a) => a.path.endsWith(".bin")).length,
    skipped: final.skipped,
  };
}

/** 一句给用户的话：成功的部分说清，**没装进去的那几件也如实说** ✓。 */
function bundleMessage(title: string, path: string, r: BundleResult): string {
  const bits = [`${r.pages} 页`, `${r.assets} 个附件`];
  if (r.bins) bits.push(`其中 ${r.bins} 个拿不到类型 ⇒ 存成 .bin`);
  if (r.unresolved) {
    bits.push(`${r.unresolved} 个附件字节没取到 ⇒ 正文里保留 attachment:// 原引用（没静默删）`);
  }
  if (r.skipped) bits.push(`${r.skipped} 页转换失败已跳过`);
  return `已导出「${title}」到 ${path}（${bits.join(" · ")}）`;
}

/**
 * ⭐ **把当前这一页存成一个 zip**：`<标题>.md` ＋ `assets/<hash>.<ext>`。
 *
 * 与 [`exportPageToMarkdown`]（纯 .md）**并存**：那一个不碰附件、也不改引用，判据在那儿钉着。
 * 这一页的正文经 `docJsonOfPage` 那层取（⛔ 不在这里提存储列名 ✗）。
 *
 * @returns 一句给用户的话（取消 ⇒ 明确说"已取消"，⛔ 不假装成功 ✗）
 */
export async function exportPageBundleToZip(page: MarkdownPageInput): Promise<string> {
  const title = page.title || "未命名";
  const path = await platform.dialog.save({
    title: "导出 Markdown ＋ 附件（zip）",
    defaultPath: `${sanitizeName(page.title || page.id)}.zip`,
    filters: [{ name: "Zip", extensions: ["zip"] }],
  });
  if (!path) return "已取消导出"; // 取消 ⇒ 一个字节都不写 ✓
  const result = await bundleFor([page]);
  // Web 侧 `write_binary_file` 是 Blob ＋ `<a download>`（见 `web.ts`）；桌面是真实落盘 ✓
  await api.writeBinaryFile(path, Array.from(result.bytes));
  return bundleMessage(title, path, result);
}

/** 把**本空间所有页面**＋它们引用的附件打成一个 zip（同一 hash 只出现一次 ✓）。 */
export async function exportWorkspaceBundleToZip(): Promise<string> {
  const path = await platform.dialog.save({
    title: "导出本空间为 Markdown ＋ 附件（zip）",
    defaultPath: "空间导出.zip",
    filters: [{ name: "Zip", extensions: ["zip"] }],
  });
  if (!path) return "已取消导出";

  const metas = await api.listPages();
  const pages: MarkdownPageInput[] = [];
  let unreadable = 0;
  for (const m of metas) {
    try {
      const page = await api.getPage(m.id);
      // 正文经 `docContent.ts` 那一层取 ✓（⛔ 不在这里写存储列名 ✗ —— 门禁只减不增）
      // ⭐ 2026-10-17：带上 `parent_id` ⇒ zip 内按页面树建目录 ✓（`PageMeta.parent_id` ✓）
      pages.push({ id: page.id, title: page.title, docJson: docJsonOfPage(page), parentId: m.parent_id ?? null });
    } catch {
      unreadable += 1; // 单页读不出来 ⇒ 跳过，但**不假装它不存在**（下面报数）
    }
  }

  const result = await bundleFor(pages);
  await api.writeBinaryFile(path, Array.from(result.bytes));
  const msg = bundleMessage("本空间", path, result);
  return unreadable ? `${msg}；另有 ${unreadable} 页读不出来已跳过` : msg;
}
