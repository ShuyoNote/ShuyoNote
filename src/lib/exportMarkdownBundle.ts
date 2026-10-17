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
import { useToast, type ToastKind } from "../store/toast";
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
 * 一份附件在 zip 里的**条目基名**：优先用它**原来的文件名**（去掉目录与扩展名后过 `safeEntryName` ✓），
 * 认不出来才退回 hash（清洗后）。
 *
 * ⭐ 2026-10-18（owner 报的缺口：导出的附件全叫 `assets/<hash>.png`，等于一堆乱码文件名 ✗）：
 * 原名是**用户认得出的唯一线索** ⇒ 有就用它 ✓。冲突由 `planBundle` 统一退化成
 * `-<hash 前 6 位>`（同名附件互不覆盖 ✓）。
 * ⚠️ 原名来自数据库、不可信 ⇒ 仍要过 `safeEntryName`（剥 `..` / 分隔符 / 控制字符 ✓）。
 */
function assetBaseFor(hash: string, name?: string | null): string {
  const id = String(hash ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 128) || "attachment";
  const base = String(name ?? "").replace(/^.*[\\/]/, ""); // 只留文件名部分（剥目录）
  const ext = extensionFromName(base);
  const stem = ext ? base.slice(0, base.length - ext.length - 1) : base;
  return safeEntryName(stem, id);
}

/**
 * 一份附件在 zip 里的相对路径：`assets/<原名或 hash>.<ext>`。
 *
 * 原名可用 ⇒ 用原名 ✓（见 [`assetBaseFor`]）；扩展名依次问 mime、文件名，都认不出来才 `.bin` ✓。
 * hash 来自正文（不可信）⇒ 只留 `[A-Za-z0-9_-]`（`../../x` 会退化成 `x`，剥空了就叫
 * `attachment`）；扩展名依次问 mime、文件名，都认不出来才 `.bin` ✓。
 *
 * ⚠️ 这里**不处理重名** —— 重名要在一整份 bundle 里判（同一个 hash 只算一次、不同 hash 撞名才退
 * `-<hash 前 6 位>`），那是 [`planBundle`] 的活 ✓。
 */
export function assetPathFor(hash: string, meta?: BundleAttachmentMeta | null): string {
  const id = String(hash ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 128) || "attachment";
  const ext = extensionForMime(meta?.mime) || extensionFromName(meta?.name) || "bin";
  const base = assetBaseFor(hash, meta?.name) || id;
  return `${BUNDLE_ASSET_DIR}/${base}.${ext}`;
}

/**
 * 附件条目名撞车时的退化路径：`…/名录-<hash 前 6 位>.<ext>`（再撞就继续加 `-1`/`-2`…）。
 *
 * 为什么留 hash 前 6 位而不是 `-1`/`-2`：出口件里能拿这段反查到"这是哪一个附件" ✓，
 * 纯序号丢掉这条线索。与页面重名的既有策略（`-<id 前 6 位>`）同一手法 ✓。
 */
function dedupeAssetPath(path: string, hash: string, used: ReadonlySet<string>): string {
  const dot = path.lastIndexOf(".");
  const stem = dot > 0 ? path.slice(0, dot) : path;
  const ext = dot > 0 ? path.slice(dot) : "";
  const tag = String(hash ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 6) || "dup";
  let candidate = `${stem}-${tag}${ext}`;
  let n = 1;
  while (used.has(candidate)) candidate = `${stem}-${tag}-${n++}${ext}`;
  return candidate;
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
  /**
   * ⭐ 2026-10-18：页面类型，**只认 `"folder"`** ✓ —— 文件夹节点不产出自己的 `.md`，
   * 但仍是子页的目录层级（见 [`treePaths`]）。
   */
  kind?: string | null;
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
    // ⭐ 2026-10-18：`kind` 原样带过来（只有 `treePaths` / `planBundle` 认 `"folder"` ✓）
    const carry = { parentId: page.parentId ?? null, kind: page.kind ?? null };
    try {
      const markdown = pageContentToMarkdown(page.docJson, (hash, mime, src) => {
        if (hash && src) srcToHash.set(src, { hash, mime: mime || "" });
        return ""; // 空串 ＝ 保持 `__src`（见 `exportMarkdown.ts::transformersWithImageResolver`）
      });
      return { id: page.id, title: page.title || "", markdown, srcToHash, ...carry };
    } catch (e) {
      // 这一页转换不了（正文 JSON 坏了）⇒ 跳过它，但账要留着（返回消息里报数）
      return { id: page.id, title: page.title || "", markdown: "", srcToHash, ...carry, error: messageOf(e) };
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
 *   ⭐ 2026-10-18：**文件夹节点（`kind === "folder"`）自己不产出 `.md`** ✓ —— 它只是一层目录，
 *   子页落在 `文件夹/子.md`（owner 报的缺口：空间里的目录与子页原来一起被摊成平铺 ✗）。
 *   文件夹下属的空目录**不写 zip 条目**（zip 里造空目录对"带走内容"没有意义 ✓）；
 *   数据库节点（`kind === "database"`）**照旧出 `.md`** ✓（它有正文）。
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
      // ⭐ 2026-10-18：文件夹节点**不产出自己的 `.md`** ✓ —— 只把它当一层目录往下走
      //   （`paths` 里没有它的条目；`planBundle` 也据此不再给它兜底造一个文件 ✓）。
      if (p.kind !== "folder") paths.set(p.id, dir ? `${dir}/${name}.md` : `${name}.md`);
      walk(p.id, dir ? `${dir}/${name}` : name); // 子页进同名目录 ✓（文件夹也一样）
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

/**
 * ⭐ 2026-10-18（C 弹窗的「☐纯 .md 平铺」）：**不按页面树建目录**的路径表 —— 所有页都放根 ✓。
 *
 * 口径与 [`treePaths`] 一致的地方（同名去重、folder 不出文件、转换失败的页不占路径）刻意复用同一份规则；
 * 不同的只有一处：**不再建目录**（子页也平铺在根）✓。
 * ⚠️ 平铺时"同名"是按**根目录整张表**去重的 ⇒ 两棵子树里的同名页也会被区分开（`-<id 前 6 位>` ✓）。
 */
export function flatPaths(prepared: readonly PreparedPage[]): Map<string, string> {
  const usable = prepared.filter((p) => !p.error && p.kind !== "folder");
  const byTitle = (a: PreparedPage, b: PreparedPage) =>
    (a.title || "").localeCompare(b.title || "", "zh") || a.id.localeCompare(b.id);
  const paths = new Map<string, string>();
  const used = new Set<string>();
  for (const p of usable.slice().sort(byTitle)) {
    const base = safeEntryName(p.title || p.id, p.id);
    let name = base;
    if (used.has(name)) name = safeEntryName(`${base}-${p.id.slice(0, 6)}`, p.id);
    used.add(name);
    paths.set(p.id, `${name}.md`);
  }
  return paths;
}

/** YAML front matter 里的一格：用 JSON 字符串写法转义引号/反斜杠/换行/控制字符 ✓。 */
function yamlValue(text: string): string {
  return JSON.stringify(String(text ?? ""));
}

/**
 * ⭐ 2026-10-18（C 弹窗的「☐元数据 YAML」）：每份 `.md` 顶部的 YAML front matter —— **纯函数**，好测 ✓。
 *
 * 为什么要有它：`.md` 被别的工具（Obsidian / 静态站 / 脚本）拿去时，`title` / `id` / `kind`
 * 是**可机读**的元数据 ✓；现在那行 HTML 注释只能给人看。
 * ⚠️ 字段只放**确定有**的三个（`title` / `id` / `kind`）—— ⛔ 不猜时间戳/标签 ✗
 *   （`updated_at` 我们这一层拿不到，写了就是假读数 ✓）。
 */
export function yamlFrontMatter(page: { id: string; title?: string | null; kind?: string | null }): string {
  const lines = [
    "---",
    `title: ${yamlValue(page.title || "未命名")}`,
    `id: ${yamlValue(page.id)}`,
    `kind: ${yamlValue(page.kind || "page")}`,
    "---",
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * 一份 `.md` 的文件头 —— 两种口径（**同一份实现**，⛔ 别在别处再拼一遍 ✗）：
 * · `yaml: true` ⇒ YAML front matter（机读 ✓）
 * · `yaml: false` ⇒ 与老导出**逐字相同**的 HTML 注释（向后兼容 ✓）
 */
export function pageFileHeader(
  page: { id: string; title?: string | null; kind?: string | null },
  yaml: boolean,
): string {
  if (yaml) return yamlFrontMatter(page);
  return `<!-- title: ${page.title || "未命名"} · id: ${page.id} -->\n`;
}

export interface BundleAsset {
  hash: string;
  /** zip 内的相对路径：`assets/<hash>.<ext>`。 */
  path: string;
}

export interface BundlePlan {
  files: BundleFile[];
  /** 要装进 zip 的附件（**已按 hash 去重**；空间导出时**含未被正文引用的那些** ✓）。 */
  assets: BundleAsset[];
  /** 正文引用了、但这一轮**装不进去**的 hash（字节没取到 ⇒ 正文里保留原引用）。 */
  unresolved: string[];
  /** 转换失败被跳过的页数。 */
  skipped: number;
  /** ⭐ 2026-10-18：`_attachments.md` 索引在 zip 里的路径（没有生成 ⇒ 缺省）。 */
  indexPath?: string;
}

/** [`planBundle`] 的排版选项（都是后加的，缺省 ⇒ 行为与加之前一致 ✓）。 */
export interface BundlePlanOptions {
  /**
   * ⭐ 2026-10-18：**额外**要装进 zip 的附件 hash（空间导出传"这个空间的全部附件"）。
   *
   * 未被正文引用的那些也进 `assets/` ✓ —— 口径是**完整备份**，不是"渲染得出来的那部分" ✓。
   * 按 hash 去重 ✓；`available` 里没有的不装（⛔ 不假装装进去了 ✗）。
   */
  extraHashes?: readonly string[];
  /** ⭐ 2026-10-18：生成 `_attachments.md` 索引（**条目数 ＝ 附件数** ✓）。 */
  attachmentIndex?: boolean;
  /**
   * ⭐ 2026-10-18（C 弹窗的「☐纯 .md 平铺」）：**不按页面树建目录**（所有 `.md` 放根 ✓）。
   * 缺省 `false` ⇒ 仍是 `父.md` ＋ `父/子.md`（与加之前逐字相同 ✓）。
   */
  flat?: boolean;
  /**
   * ⭐ 2026-10-18（C 弹窗的「☐元数据 YAML」）：每份 `.md` 顶部写 YAML front matter（见 [`pageFileHeader`]）。
   * 缺省 `false` ⇒ 仍是老的 HTML 注释头（向后兼容 ✓）。
   */
  yaml?: boolean;
}

/** 索引表格里的一格：竖线 / 换行会把表格拆坏 ⇒ 转义 ✓。 */
function indexCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/**
 * ⭐ 2026-10-18：附件索引（`原名 → assets/…`）那一页的正文 —— **纯函数**，好测 ✓。
 *
 * 为什么需要它：附件改用原名之后，只有**正文引用到的**那些能在 `.md` 里看到；
 * 其余"完整备份"带进来的附件得有个地方交代自己是哪个、在哪 ✓。
 * ⚠️ 条目数必须**等于附件数**（一条一行 —— 漏一条就是索引在骗人 ✓）。
 */
export function attachmentIndexText(
  assets: readonly BundleAsset[],
  nameOf: (hash: string) => string | null | undefined,
): string {
  const rows = assets.map((a) => {
    const name = nameOf(a.hash);
    // 原名问不到（附件表里没有 / 没法列）⇒ 如实写 hash，⛔ 不留空 ✗
    return `| ${indexCell(name || `（原名未知）${a.hash}`)} | ${a.path} |`;
  });
  return [
    `<!-- 附件索引 · 共 ${assets.length} 个 · 条目数 = zip 里的附件数 -->`,
    "# 附件索引",
    "",
    "| 原名 | zip 内路径 |",
    "|---|---|",
    ...rows,
    "",
  ].join("\n");
}

/**
 * 排版：算出 zip 里放哪些文件、每个引用换成什么路径。**纯函数**（不读字节、不碰文件）。
 *
 * @param prepared  [`preparePages`] 的产物
 * @param metaOf    按 hash 补元数据（mime/name）—— 节点上没带 mime 的那些靠它，
 *                  原名（`name`）也靠它 ✓
 * @param available 给了就只装**这些** hash（字节没取到的那批 ⇒ 正文保留原引用，⛔ 不留坏链接 ✗）
 * @param opts      见 [`BundlePlanOptions`]（后加的；缺省 ⇒ 与加之前逐字相同 ✓）
 */
export function planBundle(
  prepared: readonly PreparedPage[],
  metaOf: (hash: string) => BundleAttachmentMeta | undefined = () => undefined,
  available?: ReadonlySet<string>,
  opts: BundlePlanOptions = {},
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
  // ⭐ 2026-10-18：两种路径口径（C 弹窗的「纯 .md 平铺」）—— 缺省仍是目录树 ✓
  const treePathsById = opts.flat ? flatPaths(prepared) : treePaths(prepared);
  const assets = new Map<string, BundleAsset>();
  const unresolved = new Set<string>();
  let skipped = 0;

  // ⭐ 2026-10-18：同一个 hash 只分一条路径（跨页/跨引用 ✓）；**不同 hash 撞名**时后到的
  //   退 `-<hash 前 6 位>` ✓（原名可能重名 —— 两份都叫「报告.pdf」也是真实场景 ✓）。
  const usedAssetPaths = new Set<string>();
  const pathByHash = new Map<string, string>();
  const allocAssetPath = (hash: string): string => {
    const hit = pathByHash.get(hash);
    if (hit) return hit;
    const base = assetPathFor(hash, metaFor(hash));
    // 第一条用原名；只有**真的撞了**才退 `-<hash 前 6 位>` ✓
    const path = usedAssetPaths.has(base) ? dedupeAssetPath(base, hash, usedAssetPaths) : base;
    usedAssetPaths.add(path);
    pathByHash.set(hash, path);
    return path;
  };

  for (const p of prepared) {
    if (p.error) {
      skipped += 1;
      continue;
    }
    // ⭐ 2026-10-18：文件夹节点**没有正文可导** ⇒ 不产出 `.md`（它在 `treePaths` 里只是目录层 ✓）。
    //   ⛔ 不算 `skipped`（那不是"转换失败"，别在返回消息里报成失败 ✗）。
    if (p.kind === "folder") continue;
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

    // ② 每个 hash 分到一条 `assets/<原名或 hash>.<ext>`（同一 hash 全篇只一条 ⇒ 天然去重 ✓）
    const refPath = new Map<string, string>();
    for (const hash of refs) {
      if (!canUse(hash)) {
        unresolved.add(hash);
        continue;
      }
      const path = allocAssetPath(hash);
      refPath.set(hash, path);
      if (!assets.has(hash)) assets.set(hash, { hash, path });
    }

    // ③ 节点指纹那条路：**精确串**替换（`attachment://localhost/…` 只能这么换）
    for (const [src, ref] of p.srcToHash) {
      const path = refPath.get(ref.hash);
      if (path && md.includes(src)) md = md.split(src).join(path);
    }
    // ④ 字面量那条路（office 导入的图片没有指纹，正文里只剩 `attachment://<hash>`）
    md = rewriteAttachmentRefs(md, (hash) => refPath.get(hash) ?? null);

    // ⑤ 路径：**目录树** ✓（同目录重名去重已在 `treePaths` / `flatPaths` 里做完 ✓）
    const name = treePathsById.get(p.id) ?? `${safeEntryName(p.title || p.id, p.id)}.md`;
    // 文件头：缺省与单页 / 空间导出**同一个形状**（`<!-- title: … · id: … -->`）；
    // ⭐ 勾了「元数据 YAML」⇒ 换成机读的 front matter ✓
    files.push({
      path: name,
      text: pageFileHeader({ id: p.id, title: p.title, kind: p.kind }, Boolean(opts.yaml)) + md,
    });
  }

  // ⭐ 2026-10-18：空间导出的"完整备份"口径 —— **没被正文引用的附件也装进来** ✓
  //   （`available` 里没有的不装：字节取不到已经没东西可装，且返回消息会另报数 ✓）
  for (const hash of opts.extraHashes ?? []) {
    if (assets.has(hash) || !canUse(hash)) continue;
    assets.set(hash, { hash, path: allocAssetPath(hash) });
  }

  // ⭐ 2026-10-18：附件索引（条目数 ＝ 附件数 ✓）。文件名若被某页占用 ⇒ 前面补 `_` 让开 ✓
  let indexPath: string | undefined;
  if (opts.attachmentIndex && assets.size > 0) {
    indexPath = "_attachments.md";
    while (files.some((f) => f.path === indexPath)) indexPath = `_${indexPath}`;
    files.push({
      path: indexPath,
      text: attachmentIndexText([...assets.values()], (hash) => metaFor(hash).name),
    });
  }

  return { files, assets: [...assets.values()], unresolved: [...unresolved], skipped, indexPath };
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

/**
 * ⭐ 2026-10-18：把**这个空间的全部附件**列出来（逐页求并集，按 hash 去重 ✓）。
 *
 * 口径是**完整备份**：没被正文引用的附件也要带走 ✓ —— 否则导出件只是"渲染得出来的那部分"，
 * 用户塞进来的 PDF / Word / 原始图片就丢了 ✗（owner 真机报的缺口）。
 * ⚠️ 用的是现成命令 `list_page_attachments`（⛔ 不新造后端命令 ✗）。
 * ⚠️ 还列 **空间根**（`pageId = null` 的「未整理」附件）—— 它们同样属于这个空间 ✓。
 * ⚠️ 某一处列不出来 ⇒ 记进 `unreadable` 并在返回消息里如实说（⛔ 当成"这里没有附件" ✗）。
 */
async function allAttachmentMeta(
  pages: readonly MarkdownPageInput[],
): Promise<{ meta: Map<string, BundleAttachmentMeta>; unreadable: number }> {
  const meta = new Map<string, BundleAttachmentMeta>();
  let unreadable = 0;
  for (const pageId of [...pages.map((p) => p.id), null]) {
    let rows: AttachmentMeta[] = [];
    try {
      rows = await api.listPageAttachments(pageId);
    } catch {
      unreadable += 1;
      continue; // 列不出来 ⇒ 这一处的附件可能漏带，但不把它当成"没有" ✓
    }
    for (const row of rows ?? []) {
      if (!row?.hash || meta.has(row.hash)) continue;
      meta.set(row.hash, { mime: row.mime || "", name: row.name || null });
    }
  }
  return { meta, unreadable };
}

interface BundleResult {
  bytes: Uint8Array;
  /** ⭐ 2026-10-18：最终排版出来的文件（`.md` 正文，含索引页）—— C 弹窗的「纯 .md」那条路直接用它 ✓。 */
  files: BundleFile[];
  pages: number;
  assets: number;
  unresolved: number;
  bins: number;
  skipped: number;
  /** ⭐ 2026-10-18：其中**没被正文引用**、只因"完整备份"口径装进来的附件数 ✓。 */
  extras: number;
  /** ⭐ 2026-10-18：未被正文引用、但字节没取到的附件数（如实说，⛔ 不静默漏 ✗）。 */
  extraMissing: number;
  /** ⭐ 2026-10-18：附件清单没列出来的地方数（可能漏带 ⇒ 如实说 ✓）。 */
  unlisted: number;
  /** ⭐ 2026-10-17：这次要打的字节数 —— **超过 [`BUNDLE_BYTE_CAP`] 时才有值** ⇒ 没有产出 zip ✓。 */
  tooLarge?: number;
}

/**
 * 导出进度回调（⭐ 2026-10-18：owner 报"导出没有任何进度反馈"✗）。
 *
 * 契约（判据在 `exportMarkdownBundle.test.ts` 里钉着）：
 * · `done` 从 1 **单调递增**到 `total` ✓；
 * · **总调用次数 ＝ 附件数**（每取一个附件报一次，成功/失败都算走了一件 ✓）；
 * · `phase` 是给用户看的阶段名（当前只有取附件这一段）✓。
 */
export type BundleProgress = (done: number, total: number, phase: string) => void;

/** 两个导出入口共用的选项（都可缺省 ⇒ 与加之前行为一致 ✓）。 */
export interface BundleExportOptions {
  /**
   * 进度回调。不传 ⇒ 入口自己弹**持久 toast**（「正在导出…（取附件 3/32）」⇒ 结束替换成结果 ✓）。
   * 传了 ⇒ 用你的（测试/别的壳用得到 ✓）。
   */
  onProgress?: BundleProgress;
}

/** [`bundleFor`] 的选项（⭐ 2026-10-18：C 弹窗要的 `flat` / `yaml` 也走这里 ✓）。 */
export interface BundleForOptions {
  onProgress?: BundleProgress;
  /**
   * ⭐ 2026-10-18：空间导出用 —— 把**全部**附件（含未被正文引用的）装进 zip ＋ 生成
   * `_attachments.md` 索引 ✓。单页导出不开它（只看这一页正文引用的那些 ✓）。
   */
  allAttachments?: boolean;
  /** ⭐ 2026-10-18（C 弹窗）：不按页面树建目录（全部 `.md` 放根 ✓）。 */
  flat?: boolean;
  /** ⭐ 2026-10-18（C 弹窗）：每份 `.md` 顶部写 YAML front matter ✓。 */
  yaml?: boolean;
}

/**
 * ⭐ 2026-10-18（owner：「压缩包名加上空间名称」）：zip 的默认文件名 = `<空间名>-<原名>` ✓。
 *
 * 为什么两个导出入口都要：多空间各导一份时，文件不再全叫「空间导出.zip」/ 同名页的 zip 也分得清 ✓
 * （浏览器对重名只会加 `(1)`/`(2)` ✗）。空间名仍过 `sanitizeName`（Windows/macOS 非法字符 +
 * 首尾点空格 ＋ 限长 ✓）。
 * ⚠️ 名字读不到（命令失败 / 为空）⇒ **原样退回 `fallback`**（⛔ 不因为一个文件名把导出弄失败 ✗）。
 */
export async function defaultBundleZipName(fallback: string): Promise<string> {
  const spaceName = await api.getWorkspaceName().catch(() => "");
  const named = spaceName ? sanitizeName(spaceName) : "";
  return named ? `${named}-${fallback}` : fallback;
}

/**
 * ⭐ 2026-10-18：**进度/结果已经如实报过**的那条错误。
 *
 * 有什么用：导出入口自己弹一条**持久 toast**，失败时把它替换成「导出失败：…」✓。
 * 调用方（工具栏等）的 `catch` 就**不该再弹一遍**同一句（⛔ 一次失败弹两条 ✗）——
 * 用这个类型分得清"已经报过"与"还没走到导出就失败了"（例如取页面就失败 ⇒ 还没报过 ⇒ 调用方补报 ✓）。
 */
export class ExportReportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportReportedError";
  }
}

interface ExportProgressHandle {
  onProgress: BundleProgress;
  /** 结束：把**同一条** toast 替换成结果（成功/取消/失败都如实说 ✓；⛔ 不假装成功 ✗）。 */
  finish: (message: string, kind: ToastKind) => void;
}

/**
 * ⭐ 2026-10-18（owner 报"导出没有任何进度反馈"✗）：导出用的**持久 toast**。
 *
 * 形状：开始「正在导出…」→ 每取一个附件就**就地更新**成「正在导出…（取附件 3/32）」→
 * 结束**同一条** toast 替换成结果（3 秒后自己消失 ✓；⛔ 不另弹一条重复的 ✗）。
 * 传了 `provided`（测试 / 别的壳）⇒ **一个 toast 都不弹**，结果由调用方自己展示 ✓。
 */
export function startExportProgress(label: string, provided?: BundleProgress): ExportProgressHandle {
  if (provided) return { onProgress: provided, finish: () => {} };
  // 0 ⇒ 持久：不自动消失 ✓（拿到 id 才能**就地**改成进度/结果 ✓）
  const id = useToast.getState().show(`${label}…`, "info", { duration: 0 });
  const update = (message: string, kind: ToastKind, duration?: number) =>
    useToast.getState().update(id, message, kind, duration === undefined ? undefined : { duration });
  return {
    onProgress: (done, total, phase) => update(`${label}…（${phase} ${done}/${total}）`, "info", 0),
    finish: (message, kind) => update(message, kind),
  };
}

/**
 * 导出前的**预估**那句话说成什么（2026-10-17，C 弹窗的前置 ✓）。纯函数 ⇒ 好测 ✓。
 *
 * ⚠️ 口径（⛔ 不许把"不知道"说成 0 ✗）：
 * · 字节数**只算已知的**（`knownBytes` ✓）；
 * · 读不到大小的附件**照样计数** ✓，并且**另说一句**"另有 N 个大小未知" ✓
 *   —— 界面不能给出一个看起来精确、其实少算了的体积 ✗（那正是 owner 最讨厌的"假读数"✓）。
 */
export function estimateBundleText(
  pageCount: number,
  assetCount: number,
  knownBytes: number,
  unknownSize: number,
): string {
  const mb = knownBytes > 0 ? Math.max(1, Math.round(knownBytes / (1024 * 1024))) : 0;
  const bits = [`${pageCount} 篇`, `${assetCount} 个附件`];
  if (mb > 0) bits.push(`已知约 ${mb} MB`);
  if (unknownSize > 0) bits.push(`另有 ${unknownSize} 个大小未知`);
  return bits.join(" · ");
}

/**
 * ⭐ 2026-10-18（C 弹窗的**预估行**）：一个导出范围大概有多少东西 —— **不读附件字节**（只问列表 ✓，
 * 弹窗一打开就要出数 ✓）。
 *
 * 口径与真正导出的口径**对齐**（否则预估就是在骗人 ✓）：
 * · `page` ⇒ 这一页（1 篇）＋ 这一页自己的附件；
 * · `space` ⇒ 全部页面（**folder 不算"篇"** ✓）＋ 该空间**全部**附件（逐页并集 ＋ 空间根的「未整理」，
 *   按 hash 去重 —— 与 [`prepareBundle`] 的 `allAttachments` 同一口径 ✓）。
 * ⚠️ 大小只算附件表里 `size > 0` 的那些；其余进 `unknownSize`（⛔ 不当 0 ✗，见 [`estimateBundleText`]）。
 */
export interface ExportEstimate {
  pageCount: number;
  assetCount: number;
  knownBytes: number;
  unknownSize: number;
  /** 附件清单没列出来的地方数（预估可能偏低 ⇒ 界面要如实说 ✓）。 */
  unreadable: number;
}

export async function estimateExportScope(
  target: { kind: "page"; pageId: string } | { kind: "space" },
): Promise<ExportEstimate> {
  let scopes: (string | null)[];
  let pageCount: number;
  if (target.kind === "page") {
    scopes = [target.pageId];
    pageCount = 1;
  } else {
    const metas = await api.listPages();
    pageCount = metas.filter((m) => m.kind !== "folder").length;
    // 逐页 ＋ 空间根（null）—— 与空间导出的"完整备份"口径一致 ✓
    scopes = [...metas.map((m) => m.id), null];
  }
  const seen = new Set<string>();
  let assetCount = 0;
  let knownBytes = 0;
  let unknownSize = 0;
  let unreadable = 0;
  for (const pageId of scopes) {
    let rows: AttachmentMeta[] = [];
    try {
      rows = await api.listPageAttachments(pageId);
    } catch {
      unreadable += 1;
      continue;
    }
    for (const row of rows ?? []) {
      if (!row?.hash || seen.has(row.hash)) continue;
      seen.add(row.hash);
      assetCount += 1;
      const size = Number(row.size);
      if (Number.isFinite(size) && size > 0) knownBytes += size;
      else unknownSize += 1;
    }
  }
  return { pageCount, assetCount, knownBytes, unknownSize, unreadable };
}

/**
 * 一键导出的**字节上限**（`300 MB`）。
 *
 * ⚠️ 为什么要有它：`packBundle` 用的是 `fflate` 的 `zipSync` —— **同步** ✗ ⇒ 大空间会把主线程
 * 冻住（用户看到的是"点了没反应"✗，而那正是最坏的一种失败：看起来像卡死 ✓）。
 * ⇒ 超过上限就**不打**：如实报出体积、建议分批 ✓（⛔ 不默默卡住 ✗、⛔ 不截断内容却假装成功 ✗）。
 * ⭐ 这是 **V1.1 的兜底**；真正的解是异步/流式打包 ＋ 进度条（V1.5 ✓）。
 */
export const BUNDLE_BYTE_CAP = 300 * 1024 * 1024;

/** 超过上限时**给用户的那句话**（纯函数 ⇒ 好测 ✓；⛔ 不在这里读任何外部状态 ✗）。 */
export function bundleTooLargeMessage(totalBytes: number): string | null {
  if (totalBytes <= BUNDLE_BYTE_CAP) return null;
  const mb = Math.round(totalBytes / (1024 * 1024));
  const capMb = Math.round(BUNDLE_BYTE_CAP / (1024 * 1024));
  return (
    `这次导出约 ${mb} MB，超过一键导出的上限（${capMb} MB）—— 太大容易把界面卡住，` +
    `已**没有**开始打包。建议**分批**导：先选一个子树导出，或把大附件移出这个空间再导`
  );
}

/**
 * 导出核心：转换 → 问类型（空间导出还要列**全部**附件）→ 取字节（同 hash 只取一次）→ 排版 → 打包。
 *
 * ⭐ 2026-10-18：加了 `onProgress`（每取一个附件报一次 ✓）与 `allAttachments`（完整备份口径 ✓）；
 * 又加了 `flat` / `yaml`（C 弹窗的两个勾选项 ✓）。
 *
 * ⚠️ 新选项**缺省时与原行为逐字相同** ✓ —— 老的四个命令一字不改。
 */
export async function prepareBundle(
  pages: readonly MarkdownPageInput[],
  opts: BundleForOptions = {},
): Promise<BundleResult> {
  const prepared = preparePages(pages);
  // 空间导出 ⇒ 逐页求并集拿到**全部**附件（含未被正文引用的 ✓）；单页导出仍只问正文引用的那些 ✓
  const all = opts.allAttachments ? await allAttachmentMeta(pages) : null;
  const meta = all ? all.meta : await attachmentMetaMap(pages, prepared);
  const unlisted = all ? all.unreadable : 0;
  const extraHashes = all ? [...all.meta.keys()] : [];
  const metaOf = (hash: string) => meta.get(hash);
  const planOpts: BundlePlanOptions = {
    extraHashes,
    attachmentIndex: Boolean(opts.allAttachments),
    flat: Boolean(opts.flat),
    yaml: Boolean(opts.yaml),
  };
  const referenced = new Set(referencedHashes(prepared));

  // 先按"全都取得到"排一次版（拿到完整附件清单），再去取字节。
  const planned = planBundle(prepared, metaOf, undefined, planOpts);
  const bytesOf = new Map<string, Uint8Array>();
  const failed = new Set<string>();
  let done = 0;
  for (const asset of planned.assets) {
    try {
      bytesOf.set(asset.hash, toBytes(await api.readAttachmentBytes(asset.hash)));
    } catch {
      // 没同步到本机 / 盘上没有 ⇒ **不装进 zip**；正文里的引用会在下面第二趟里**原样留着**
      // （⛔ 不改成 `assets/…` 留一个坏链接 ✗，也⛔ 不静默删掉那行 ✗）
      failed.add(asset.hash);
    }
    // ⭐ 2026-10-18：**每取一件报一次**（成功/失败都算走了一件）⇒ 单调递增、总次数 ＝ 附件数 ✓
    done += 1;
    opts.onProgress?.(done, planned.assets.length, "取附件");
  }

  const final =
    failed.size === 0
      ? planned
      : planBundle(
          prepared,
          metaOf,
          new Set(planned.assets.filter((a) => !failed.has(a.hash)).map((a) => a.hash)),
          planOpts,
        );

  // 说明账：未被正文引用的那些装了几个 / 漏了几个（⛔ 不静默漏 ✗）
  const extras = final.assets.filter((a) => !referenced.has(a.hash)).length;
  const extraMissing = extraHashes.filter((h) => !referenced.has(h) && !bytesOf.has(h)).length;
  // 页面数只数页面文件（索引那一页不算"页" ✓；folder 节点本来就不在 `files` 里 ✓）
  const pageCount = final.files.length - (final.indexPath ? 1 : 0);

  // ⚠️ `zipSync` 是**同步**的 ✗（见 `BUNDLE_BYTE_CAP` 的注释）⇒ 超限就**先别打** ✓
  const textBytes = final.files.reduce((n, f) => n + f.text.length, 0);
  const assetBytes = final.assets.reduce((n, a) => n + (bytesOf.get(a.hash)?.length ?? 0), 0);
  const totalBytes = textBytes + assetBytes;
  if (bundleTooLargeMessage(totalBytes)) {
    return {
      bytes: new Uint8Array(0),
      files: final.files,
      pages: pageCount,
      assets: final.assets.length,
      unresolved: final.unresolved.length,
      bins: final.assets.filter((a) => a.path.endsWith(".bin")).length,
      skipped: final.skipped,
      extras,
      extraMissing,
      unlisted,
      tooLarge: totalBytes,
    };
  }

  return {
    bytes: packBundle(final, bytesOf),
    files: final.files,
    pages: pageCount,
    assets: final.assets.length,
    unresolved: final.unresolved.length,
    bins: final.assets.filter((a) => a.path.endsWith(".bin")).length,
    skipped: final.skipped,
    extras,
    extraMissing,
    unlisted,
  };
}

/** 一句给用户的话：成功的部分说清，**没装进去的那几件也如实说** ✓。 */
export function bundleMessage(title: string, path: string, r: BundleResult): string {
  const bits = [`${r.pages} 页`, `${r.assets} 个附件`];
  if (r.extras) bits.push(`其中 ${r.extras} 个未被正文引用（完整备份口径一并带走）`);
  if (r.bins) bits.push(`其中 ${r.bins} 个拿不到类型 ⇒ 存成 .bin`);
  if (r.unresolved) {
    bits.push(`${r.unresolved} 个附件字节没取到 ⇒ 正文里保留 attachment:// 原引用（没静默删）`);
  }
  if (r.extraMissing) {
    bits.push(`${r.extraMissing} 个未被正文引用的附件字节没取到 ⇒ 没装进 zip（没假装带走）`);
  }
  if (r.unlisted) bits.push(`${r.unlisted} 处附件清单没列出来 ⇒ 可能漏带附件`);
  if (r.skipped) bits.push(`${r.skipped} 页转换失败已跳过`);
  return `已导出「${title}」到 ${path}（${bits.join(" · ")}）`;
}

/**
 * ⭐ **把当前这一页存成一个 zip**：`<标题>.md` ＋ `assets/<原名或 hash>.<ext>`。
 *
 * 与 [`exportPageToMarkdown`]（纯 .md）**并存**：那一个不碰附件、也不改引用，判据在那儿钉着。
 * 这一页的正文经 `docJsonOfPage` 那层取（⛔ 不在这里提存储列名 ✗）。
 *
 * ⚠️ 这一条**只带这一页正文引用到的附件** ✓（"整份带走"的口径在空间导出那条 —— 那里才是完整备份 ✓）。
 *
 * @returns 一句给用户的话（取消 ⇒ 明确说"已取消"，⛔ 不假装成功 ✗）
 */
export async function exportPageBundleToZip(
  page: MarkdownPageInput,
  opts: BundleExportOptions = {},
): Promise<string> {
  const title = page.title || "未命名";
  // ⭐ 2026-10-18：先弹**持久 toast**，后面每一步都以它为准（⛔ 中途无声无息 ✗）
  const progress = startExportProgress("正在导出", opts.onProgress);
  try {
    // ⭐ 2026-10-18：文件夹节点没有正文（它只是目录层，见 `treePaths`）⇒ **一个字节都不写**，
    //   也⛔ 不产出一个"0 页的空 zip"假装成功 ✗。
    if (page.kind === "folder") {
      const folderMsg = `「${title}」是文件夹，没有正文可导出 —— 要整棵子树请用「导出本空间为 Markdown ＋ 附件」（这次没有写文件）`;
      progress.finish(folderMsg, "info");
      return folderMsg;
    }
    const path = await platform.dialog.save({
      title: "导出 Markdown ＋ 附件（zip）",
      // ⭐ 2026-10-18（owner：「压缩包名加上空间名称」）：带上空间名 ⇒ 同名页跨空间也分得清 ✓
      defaultPath: await defaultBundleZipName(`${sanitizeName(page.title || page.id)}.zip`),
      filters: [{ name: "Zip", extensions: ["zip"] }],
    });
    // 取消 ⇒ 一个字节都不写 ✓，但那条持久 toast 也要**如实**变成"已取消"（⛔ 不能假装成功 ✗）
    if (!path) {
      progress.finish("已取消导出", "info");
      return "已取消导出";
    }
    const result = await prepareBundle([page], { onProgress: progress.onProgress });
    // ⚠️ 超限 ⇒ **一个字节都不写** ✓，把原因如实返回（⛔ 不假装成功 ✗）
    if (result.tooLarge) {
      const tooLargeMsg = bundleTooLargeMessage(result.tooLarge) ?? "导出体积超过上限";
      progress.finish(tooLargeMsg, "error");
      return tooLargeMsg;
    }
    // Web 侧 `write_binary_file` 是 Blob ＋ `<a download>`（见 `web.ts`）；桌面是真实落盘 ✓
    await api.writeBinaryFile(path, Array.from(result.bytes));
    const msg = bundleMessage(title, path, result);
    progress.finish(msg, "success");
    return msg;
  } catch (e) {
    const text = `导出失败：${e instanceof Error ? e.message : String(e)}`;
    progress.finish(text, "error");
    throw new ExportReportedError(text);
  }
}

/**
 * 把**本空间所有页面**＋**全部附件**打成一个 zip（同一 hash 只出现一次 ✓）。
 *
 * ⭐ 2026-10-18：口径从"正文引用的附件"改成**完整备份** ✓ —— 未被正文引用的附件也进 `assets/`，
 * 并生成 `_attachments.md` 索引（原名 → 路径 ✓）。
 */
export async function exportWorkspaceBundleToZip(opts: BundleExportOptions = {}): Promise<string> {
  // ⭐ 2026-10-18：先弹**持久 toast**（「正在导出…」⇒「取附件 3/32」⇒ 结果 ✓）
  const progress = startExportProgress("正在导出本空间", opts.onProgress);
  try {
    // ⭐ 2026-10-18（owner：「压缩包名加上空间名称」）：默认文件名带上**当前空间名** ✓ ——
    //   否则多个空间各导一份时全叫「空间导出.zip」（浏览器只会加 (1)/(2) ✗，分不出是哪个空间 ✓）。
    //   ⚠️ 读不到名字 ⇒ **退回原来的名字**（⛔ 不因为一个文件名让整个导出失败 ✗）。
    const path = await platform.dialog.save({
      title: "导出本空间为 Markdown ＋ 附件（zip）",
      defaultPath: await defaultBundleZipName("空间导出.zip"),
      filters: [{ name: "Zip", extensions: ["zip"] }],
    });
    if (!path) {
      progress.finish("已取消导出", "info"); // 取消也如实说 ✓
      return "已取消导出";
    }

    const metas = await api.listPages();
    const pages: MarkdownPageInput[] = [];
    let unreadable = 0;
    for (const m of metas) {
      try {
        const page = await api.getPage(m.id);
        // 正文经 `docContent.ts` 那一层取 ✓（⛔ 不在这里写存储列名 ✗ —— 门禁只减不增）
        // ⭐ 2026-10-17：带上 `parent_id` ⇒ zip 内按页面树建目录 ✓（`PageMeta.parent_id` ✓）
        // ⭐ 2026-10-18：带上 `kind` ⇒ 文件夹节点只作目录、不出 `.md` ✓（`PageMeta.kind` ✓）
        pages.push({
          id: page.id,
          title: page.title,
          docJson: docJsonOfPage(page),
          parentId: m.parent_id ?? null,
          kind: m.kind,
        });
      } catch {
        unreadable += 1; // 单页读不出来 ⇒ 跳过，但**不假装它不存在**（下面报数）
      }
    }

    const result = await prepareBundle(pages, { onProgress: progress.onProgress, allAttachments: true });
    // ⚠️ 超限 ⇒ **一个字节都不写** ✓（与单页那条同口径 ✓）
    if (result.tooLarge) {
      const tooLargeMsg = bundleTooLargeMessage(result.tooLarge) ?? "导出体积超过上限";
      progress.finish(tooLargeMsg, "error");
      return tooLargeMsg;
    }
    await api.writeBinaryFile(path, Array.from(result.bytes));
    const baseMsg = bundleMessage("本空间", path, result);
    const msg = unreadable ? `${baseMsg}；另有 ${unreadable} 页读不出来已跳过` : baseMsg;
    progress.finish(msg, "success");
    return msg;
  } catch (e) {
    const text = `导出失败：${e instanceof Error ? e.message : String(e)}`;
    progress.finish(text, "error");
    throw new ExportReportedError(text);
  }
}
