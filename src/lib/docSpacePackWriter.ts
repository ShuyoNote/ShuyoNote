// ⭐ M2a：`.shuyospace` 空间包**导出**（纯格式层；不碰 UI/数据库）。
//
// 按 `docs/plans/2026-10-30-package-format-final.md` §2/§9（企业版裁决后）：
//   · manifest：format/format_version/features/min_reader_version/source/source_app_version/
//     space{id,name,type,created_at}/encrypted（写侧**不写** checksums_sha256；字段仅读侧容忍）
//   · tree.json：children 顺序/成员为权威；空文件夹写 `[]`；file 条目**保留 name/mime**（§9 撤回去名）
//   · documents/<id>/document.shuyodoc：**内层复用文档包写侧**（内层禁止再嵌套）
//   · files/<sha256>.<lower-ext>：附件字节（内容寻址、平铺、扩展名小写）
//   · attachments.json：附件元数据（sha 去重；显示名冲突时**以 tree 为准**并记 warning）
//   · checksums.json：覆盖 **manifest.json** ＋ tree/documents/files/attachments（排除自身与 signature）
//     —— 按附录 A.1/§9：企业版会校验"漏登记/多登记"；写侧不再写 `checksums_sha256`（避免哈希环）。
//   · ⛔ 导出不写 id_map.json（§2.4：导入工具才写）
import { buildChecksums, checkEntryPath, sha256Hex, type PackageFile } from "./docPackage";
import { buildDocumentPackage } from "./docPackWriter";
import { DOC_EXTENSION } from "./docPackage";
import { zipSync } from "fflate";

export const SPACE_FORMAT = "shuyonote.space";
export const SPACE_FORMAT_VERSION = 1;
export const TREE_FORMAT = "shuyonote.tree";
export const TREE_VERSION = 1;
export const MANIFEST_PATH = "manifest.json";
export const TREE_PATH = "tree.json";
export const ATTACHMENTS_PATH = "attachments.json";
export const CHECKSUMS_PATH = "checksums.json";
export const SPACE_FEATURES = ["db-namespace", "checksums-self"] as const;
export const SPACE_MIN_READER = "1.1";
/** 与文档包一致（§9：统一 1980-01-01，对齐服务端 0x0021）。 */
const ZIP_EPOCH = new Date(Date.UTC(1980, 0, 1));

export type SpaceNodeKind = "page" | "folder" | "database";
export type SpaceChild =
  | { type: "node"; id: string }
  | { type: "file"; sha256: string; name: string; mime?: string };

export interface SpaceNodeInput {
  id: string;
  parentId: string | null;
  kind: SpaceNodeKind;
  title: string;
  /** page/database 的正文（Lexical JSON 字符串）；folder 省略。 */
  docJson?: string;
  /** database 节点的 `db` 命名空间（会写进 content.json 根）。 */
  db?: unknown;
  /** 顺序/成员权威。 */
  children: SpaceChild[];
  createdAt?: string;
  updatedAt?: string;
}

export interface SpaceFileInput {
  sha256: string;
  name: string;
  mime?: string;
  bytes: Uint8Array;
}

export interface BuildSpacePackageInput {
  space: { id: string; name: string; type: string; createdAt: string };
  source?: string;
  sourceAppVersion?: string;
  nodes: SpaceNodeInput[];
  files: SpaceFileInput[];
}

export interface SpacePackageResult {
  bytes: Uint8Array;
  warnings: string[];
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const SHA_RE = /^[0-9a-f]{64}$/;
const fail = (m: string): never => {
  throw new Error(`buildSpacePackage: ${m}`);
};
const DOC_PATH = (id: string) => `documents/${id}/document${DOC_EXTENSION}`;
const FILE_PATH = (sha: string, ext: string) => `files/${sha}${ext ? "." + ext : ""}`;

function lowerExt(name: string): string {
  const base = name.split("/").pop() ?? name;
  const dot = base.lastIndexOf(".");
  return dot < 0 ? "" : base.slice(dot + 1).toLowerCase();
}

/**
 * 附件元数据：sha 去重；**tree 的 name/mime 是权威**（§9 企业版裁决），
 * `files` 里的名字只作缺省；冲突时以 tree 为准并记 `attachment-name-conflict` warning。
 */
function resolveAttachments(
  nodes: SpaceNodeInput[],
  files: SpaceFileInput[],
): { rows: { sha256: string; name: string; mime?: string; size: number }[]; warnings: string[] } {
  const bySha = new Map<string, SpaceFileInput>();
  for (const f of files) {
    if (!SHA_RE.test(f.sha256)) fail(`附件 sha256 不合法：${f.sha256}`);
    if (bySha.has(f.sha256)) fail(`附件 sha 重复：${f.sha256}（同一内容只存一份）`);
    bySha.set(f.sha256, f);
  }
  const warnings: string[] = [];
  const chosen = new Map<string, { name: string; mime?: string }>();
  const visit = (list: SpaceChild[]) => {
    for (const c of list) {
      if (c.type !== "file") continue;
      const f = bySha.get(c.sha256);
      if (!f) fail(`tree 引用了不存在的附件：${c.sha256}`);
      const prev = chosen.get(c.sha256);
      if (!prev) chosen.set(c.sha256, { name: c.name, ...(c.mime ? { mime: c.mime } : {}) });
      else if (prev.name !== c.name || prev.mime !== c.mime) {
        warnings.push(`attachment-name-conflict: ${c.sha256} 在 tree 多处引用但名字不同；以 tree 第一次为准`);
      }
    }
  };
  for (const n of nodes) visit(n.children);
  const rows = [...chosen.entries()]
    .map(([sha, v]) => ({ sha256: sha, name: v.name, ...(v.mime ? { mime: v.mime } : {}), size: bySha.get(sha)!.bytes.byteLength }))
    .sort((a, b) => a.sha256.localeCompare(b.sha256));
  return { rows, warnings };
}

export async function buildSpacePackage(input: BuildSpacePackageInput): Promise<SpacePackageResult> {
  if (!input || typeof input !== "object") fail("入参必须是对象");
  const { space, nodes, files } = input;
  if (!space?.id || !space.name || !space.type || !space.createdAt) fail("space{id,name,type,createdAt} 必填");
  if (space.type !== "personal" && space.type !== "team") fail(`space.type 只能是 personal|team（${space.type}）`);
  if (!Array.isArray(nodes) || nodes.length === 0) fail("nodes 不能为空");
  if (nodes.some((n) => n.kind === "page" || n.kind === "database") && !nodes.some((n) => n.docJson)) {
    fail("有 page/database 节点但没有任何正文");
  }

  // ① 节点唯一 / parent 合法 / children 引用存在（写侧硬拒，不等导入侧）
  const ids = new Set<string>();
  for (const n of nodes) {
    if (ids.has(n.id)) fail(`节点 id 重复：${n.id}`);
    ids.add(n.id);
    if (n.parentId !== null && !nodes.some((x) => x.id === n.parentId)) {
      fail(`节点 ${n.id} 的 parentId 指向不存在的节点：${n.parentId}`);
    }
    for (const c of n.children) {
      if (c.type === "node" && !nodes.some((x) => x.id === c.id)) fail(`children 引用了不存在的节点：${c.id}`);
    }
  }
  // children 是权威：每个 node 子项必须与其 parent_id 一致；每个非根节点必须出现在父的 children 里
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const n of nodes) {
    for (const c of n.children) {
      if (c.type !== "node") continue;
      const child = byId.get(c.id)!;
      if (child.parentId !== n.id) fail(`children 与 parent_id 冲突：${c.id} 在 ${n.id} 的 children 里，但 parent_id=${child.parentId}`);
    }
  }
  for (const n of nodes) {
    if (n.parentId === null) continue;
    const parent = byId.get(n.parentId)!;
    if (!parent.children.some((c) => c.type === "node" && c.id === n.id)) {
      fail(`children 与 parent_id 冲突：${n.id} 的 parent_id=${n.parentId}，但父的 children 未列出它`);
    }
  }
  const roots = nodes.filter((n) => n.parentId === null);
  if (roots.length === 0) fail("tree 没有根节点（parent_id 全非空）");

  // ② 文档：内层复用文档包写侧（内层 store-only、固定时间戳；内层禁止再嵌包 —— 由文档包写侧保证）
  const entries: PackageFile[] = [];
  const treeNodes: Record<string, unknown> = {};
  for (const n of nodes) {
    const docPath = n.kind === "folder" ? undefined : DOC_PATH(n.id);
    treeNodes[n.id] = {
      kind: n.kind,
      title: n.title,
      parent_id: n.parentId,
      ...(docPath ? { document: docPath } : {}),
    };
    if (!docPath) continue;
    let docJson = n.docJson ?? JSON.stringify({ root: { type: "root", children: [] } });
    if (n.db !== undefined) {
      const parsed = JSON.parse(docJson) as Record<string, unknown>;
      parsed.db = n.db;
      docJson = JSON.stringify(parsed);
    }
    const inner = await buildDocumentPackage({
      documentId: n.id,
      title: n.title,
      createdAt: n.createdAt ?? space.createdAt,
      updatedAt: n.updatedAt ?? n.createdAt ?? space.createdAt,
      docJson,
      assets: [],
      sourceAppVersion: input.sourceAppVersion ?? "0.0.0",
    });
    entries.push({ path: docPath, bytes: inner });
  }

  // ③ tree.json（children 原样：顺序/成员权威；file 条目保留 name/mime —— §9）
  const tree = {
    format: TREE_FORMAT,
    version: TREE_VERSION,
    roots: roots.map((n) => ({ type: "node", id: n.id })),
    nodes: treeNodes,
    children: Object.fromEntries(nodes.map((n) => [n.id, n.children])),
  };
  entries.push({ path: TREE_PATH, bytes: utf8(JSON.stringify(tree, null, 2) + "\n") });

  // ④ files/<sha>.<lower-ext>（扩展名统一小写；路径由 checkWritePaths 再兜一层）
  const seenFiles = new Set<string>();
  for (const f of files) {
    if (!(f.bytes instanceof Uint8Array)) fail(`附件 ${f.sha256} 的 bytes 必须是 Uint8Array`);
    const actual = await sha256Hex(f.bytes);
    if (actual !== f.sha256) fail(`附件 sha256 与内容不符（写 ${f.sha256}，实际 ${actual}）`);
    const ext = lowerExt(f.name);
    const path = FILE_PATH(f.sha256, ext);
    if (seenFiles.has(path)) fail(`附件路径重复：${path}`);
    seenFiles.add(path);
    entries.push({ path, bytes: f.bytes });
  }

  // ⑤ attachments.json（tree 权威；sha 去重）
  const { rows, warnings } = resolveAttachments(nodes, files);
  entries.push({ path: ATTACHMENTS_PATH, bytes: utf8(JSON.stringify(rows, null, 2) + "\n") });

  // ⑥ manifest 先入列（不含 checksums_sha256），再算 checksums —— checksums **覆盖 manifest**（A.1）
  const manifest = {
    format: SPACE_FORMAT,
    format_version: SPACE_FORMAT_VERSION,
    features: [...SPACE_FEATURES],
    min_reader_version: SPACE_MIN_READER,
    source: input.source ?? "personal",
    source_app_version: input.sourceAppVersion ?? "0.0.0",
    space,
    encrypted: false,
  };
  entries.unshift({ path: MANIFEST_PATH, bytes: utf8(JSON.stringify(manifest, null, 2) + "\n") });

  // ⑦ checksums（覆盖除 checksums/signature 外所有条目，含 manifest.json）
  for (const e of entries) {
    const err = checkEntryPath(e.path);
    if (err) fail(`条目 ${e.path} ${err}`);
  }
  const checksums = await buildChecksums(entries);
  const checksumsBytes = utf8(JSON.stringify(checksums, null, 2) + "\n");
  entries.push({ path: CHECKSUMS_PATH, bytes: checksumsBytes });

  // ⑧ 写侧硬拒（NFC/大小写/尾点尾空格/资产扩展名小写）；⛔ 不写 id_map.json
  if (entries.some((e) => e.path === "id_map.json")) fail("导出不得写 id_map.json（§2.4）");
  const zippable: Record<string, Uint8Array> = {};
  for (const e of entries) zippable[e.path] = e.bytes as Uint8Array;
  const bytes = zipSync(zippable, { level: 0, mtime: ZIP_EPOCH });
  return { bytes, warnings };
}
