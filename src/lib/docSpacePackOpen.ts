// ⭐ M2b（读侧/校验骨架）：`.shuyospace` 解析与**整包校验**（仍不落库；导入语义下一批）。
//
// 依据 §2/§4/§9：manifest（min_reader_version 高拒/encrypted 拒）、tree（roots/kind/环/深度/
// children-parent 冲突/空文件夹/混排）、attachments（sha/size/字节缺失）、documents 内层复用
// 现有文档包读侧且**禁止再嵌包**、checksums 必须覆盖 manifest（A.1）、不认识 id_map 只用 warning。
import {
  CHECKSUMS_PATH,
  MANIFEST_PATH,
  READER_VERSION,
  checkEntryPath,
  versionGt,
  verifyChecksums,
} from "./docPackage";
import { openDocumentPackage, type ZipEntry } from "./docPackageOpen";
import { unzipDocument } from "./docZip";

export const SPACE_FORMAT = "shuyonote.space";
export const TREE_PATH = "tree.json";
export const ATTACHMENTS_PATH = "attachments.json";
const KINDS = new Set(["page", "folder", "database"]);
const SHA_RE = /^[0-9a-f]{64}$/;
/** 空间包上限（§3 默认值：256 MiB / 10000 条）。 */
export const SPACE_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
export const SPACE_MAX_ENTRIES = 10000;

export interface SpaceTreeNode {
  id: string;
  kind: "page" | "folder" | "database";
  title: string;
  parent_id: string | null;
  children: Array<{ type: "node"; id: string } | { type: "file"; sha256: string; name: string; mime?: string }>;
  documentPath?: string;
}

export interface OpenedSpacePackage {
  manifest: Record<string, unknown>;
  tree: { roots: string[]; nodes: Map<string, SpaceTreeNode> };
  attachments: Array<{ sha256: string; name: string; mime?: string; size: number }>;
  documents: Map<string, string>; // node id -> content.json 原文
  files: Map<string, Uint8Array>; // sha256 -> bytes
  warnings: string[];
}

export type OpenSpaceResult = { ok: true; pkg: OpenedSpacePackage } | { ok: false; error: string };
const fail = (error: string): OpenSpaceResult => ({ ok: false, error });

export async function openSpacePackage(
  entries: ZipEntry[],
  opts: { maxDepth?: number; allowUnverifiedChecksums?: boolean; maxTotalBytes?: number; maxEntries?: number } = {},
): Promise<OpenSpaceResult> {
  const warnings: string[] = [];
  const maxEntries = opts.maxEntries ?? SPACE_MAX_ENTRIES;
  const maxTotalBytes = opts.maxTotalBytes ?? SPACE_MAX_TOTAL_BYTES;
  if (entries.length > maxEntries) return fail(`E_LIMIT: 条目数 ${entries.length} 超过上限 ${maxEntries}`);
  const totalBytes = entries.reduce((n, e) => n + e.bytes.byteLength, 0);
  if (totalBytes > maxTotalBytes) return fail(`E_LIMIT: 总大小 ${totalBytes} 字节超过上限 ${maxTotalBytes}`);
  const byPath = new Map<string, Uint8Array>();
  for (const e of entries) {
    const err = checkEntryPath(e.path);
    if (err) return fail(`E_PATH: 条目 ${e.path} ${err}`);
    if (byPath.has(e.path)) return fail(`E_ZIP_STRUCTURE: 条目 ${e.path} 出现了两次`);
    const nested = /\.(zip|shuyodoc)$/i.test(e.path);
    const innerDoc = /^documents\/[^/]+\/document\.shuyodoc$/.test(e.path);
    if (nested && !innerDoc) return fail(`E_ZIP_STRUCTURE: 条目 ${e.path} 是内层压缩包（v1.1 硬拒嵌套）`);
    byPath.set(e.path, e.bytes);
  }

  // ① manifest
  const manifestBytes = byPath.get(MANIFEST_PATH);
  if (!manifestBytes) return fail(`E_MANIFEST: 包里没有 ${MANIFEST_PATH}`);
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as Record<string, unknown>;
  } catch (e) {
    return fail(`E_MANIFEST: manifest.json 不是合法 JSON（${e instanceof Error ? e.message : String(e)}）`);
  }
  if (manifest.format !== SPACE_FORMAT) return fail(`E_MANIFEST: format 必须是 ${SPACE_FORMAT}`);
  if (manifest.format_version !== 1) return fail("E_MANIFEST: format_version 只支持 1");
  if (manifest.encrypted === true) return fail("E_MANIFEST: 该包已加密，当前版本不支持");
  const mr = manifest.min_reader_version;
  if (typeof mr === "string" && versionGt(mr, READER_VERSION)) {
    return fail(`E_VERSION: 需要读端 ≥ ${mr}（本版 ${READER_VERSION}），请升级后再导入`);
  }
  const space = manifest.space as Record<string, unknown> | undefined;
  if (!space || typeof space.id !== "string" || typeof space.name !== "string") {
    return fail("E_MANIFEST: manifest.space{id,name} 必填");
  }

  // ② checksums（必须覆盖 manifest；缺 ⇒ 默认拒）
  const checksumsBytes = byPath.get(CHECKSUMS_PATH);
  if (!checksumsBytes) {
    if (!opts.allowUnverifiedChecksums) return fail("E_IO_CHECKSUMS: 缺 checksums.json（导入默认拒绝；旧包需显式 allowUnverifiedChecksums）");
    warnings.push("allowUnverifiedChecksums：未做整包校验");
  } else {
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder().decode(checksumsBytes));
    } catch {
      return fail("E_CHECKSUMS: checksums.json 不是合法 JSON");
    }
    const problems = await verifyChecksums(raw, entries.map((e) => ({ path: e.path, bytes: e.bytes })));
    if (problems.length > 0) return fail(`E_CHECKSUMS: ${problems.join("；")}`);
  }

  // ③ tree
  const treeBytes = byPath.get(TREE_PATH);
  if (!treeBytes) return fail(`E_TREE: 包里没有 ${TREE_PATH}`);
  let tree: {
    format?: unknown;
    version?: unknown;
    roots?: unknown;
    nodes?: unknown;
    children?: unknown;
  };
  try {
    tree = JSON.parse(new TextDecoder().decode(treeBytes));
  } catch {
    return fail("E_TREE: tree.json 不是合法 JSON");
  }
  if (tree.format !== "shuyonote.tree" || tree.version !== 1) return fail("E_TREE: tree format/version 不认识");
  const rawNodes = tree.nodes as Record<string, Record<string, unknown>> | undefined;
  const rawChildren = tree.children as Record<string, unknown[]> | undefined;
  const roots = tree.roots as Array<{ type?: string; id?: string }> | undefined;
  if (!rawNodes || typeof rawNodes !== "object") return fail("E_TREE: nodes 必须是对象");
  if (!Array.isArray(roots) || roots.length === 0) return fail("E_TREE: roots 不能为空");
  const nodes = new Map<string, SpaceTreeNode>();
  for (const [id, n] of Object.entries(rawNodes)) {
    const kind = n.kind;
    if (typeof kind !== "string" || !KINDS.has(kind)) return fail(`E_TREE: 节点 ${id} 的 kind 不认识（${String(kind)}）`);
    const title = typeof n.title === "string" ? n.title : "";
    const parent = n.parent_id === null ? null : typeof n.parent_id === "string" ? n.parent_id : undefined;
    if (parent === undefined) return fail(`E_TREE: 节点 ${id} 的 parent_id 必须是 null|string`);
    nodes.set(id, {
      id,
      kind: kind as SpaceTreeNode["kind"],
      title,
      parent_id: parent,
      children: [],
      ...(typeof n.document === "string" ? { documentPath: n.document } : {}),
    });
  }
  const childrenOf = (id: string): unknown[] => (rawChildren && Array.isArray(rawChildren[id]) ? rawChildren[id] : []);
  for (const [pid, node] of nodes) {
    for (const c of childrenOf(pid)) {
      if (!c || typeof c !== "object") return fail(`E_TREE: 节点 ${pid} 的 children 条目不是对象`);
      const cc = c as Record<string, unknown>;
      if (cc.type === "node") {
        if (typeof cc.id !== "string" || !nodes.has(cc.id)) return fail(`E_TREE: children 引用了不存在的节点 ${String(cc.id)}`);
        const child = nodes.get(cc.id)!;
        if (child.parent_id !== pid) {
          return fail(`E_TREE: children 与 parent_id 冲突（${child.id} 在 ${pid} 的 children 里，但 parent_id=${String(child.parent_id)}）`);
        }
        node.children.push({ type: "node", id: child.id });
      } else if (cc.type === "file") {
        if (typeof cc.sha256 !== "string" || typeof cc.name !== "string") {
          return fail(`E_TREE: 节点 ${pid} 的 file 条目必须有 sha256+name（§9）`);
        }
        if (!SHA_RE.test(cc.sha256)) return fail(`E_ATTACHMENT: file 条目 sha256 不合法：${cc.sha256}`);
        node.children.push({
          type: "file",
          sha256: cc.sha256,
          name: cc.name,
          ...(typeof cc.mime === "string" ? { mime: cc.mime } : {}),
        });
      } else {
        return fail(`E_TREE: 节点 ${pid} 的 children 条目 type 不认识（${String(cc.type)}）`);
      }
    }
  }
  const rootIds = roots.map((r) => r?.id);
  for (const r of roots) {
    if (!r || r.type !== "node" || typeof r.id !== "string" || !nodes.has(r.id)) return fail("E_TREE: roots 条目必须是现有节点 {type:node,id}");
    if (nodes.get(r.id)!.parent_id !== null) return fail(`E_TREE: root ${r.id} 的 parent_id 必须为 null`);
  }
  for (const [id, n] of nodes) {
    if (n.parent_id === null && !rootIds.includes(id)) return fail(`E_TREE: 节点 ${id} 是根但不在 roots 里`);
    if (n.parent_id !== null) {
      const parent = nodes.get(n.parent_id);
      if (!parent) return fail(`E_TREE: 节点 ${id} 的 parent_id 指向不存在的节点`);
      if (!parent.children.some((c) => c.type === "node" && c.id === id)) {
        return fail(`E_TREE: children 与 parent_id 冲突（${id} 的父 ${n.parent_id} 未在 children 列出它）`);
      }
    }
  }
  // 环 + 深度（children 权威）
  const maxDepth = opts.maxDepth ?? 1000;
  const state = new Map<string, 0 | 1 | 2>();
  const walk = (id: string, depth: number): string | null => {
    if (depth > maxDepth) return `E_TREE: 深度超过 ${maxDepth}`;
    const st = state.get(id) ?? 0;
    if (st === 1) return `E_TREE: 检测到环（${id}）`;
    if (st === 2) return null;
    state.set(id, 1);
    for (const c of nodes.get(id)!.children) {
      if (c.type !== "node") continue;
      const err = walk(c.id, depth + 1);
      if (err) return err;
    }
    state.set(id, 2);
    return null;
  };
  for (const r of roots) {
    const err = walk(r.id!, 1);
    if (err) return fail(err);
  }

  // ④ 附件（字节 + 元数据）
  const attachmentsBytes = byPath.get(ATTACHMENTS_PATH);
  const attachments: OpenedSpacePackage["attachments"] = [];
  if (attachmentsBytes) {
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder().decode(attachmentsBytes));
    } catch {
      return fail("E_ATTACHMENT: attachments.json 不是合法 JSON");
    }
    if (!Array.isArray(raw)) return fail("E_ATTACHMENT: attachments.json 必须是数组");
    const seen = new Set<string>();
    for (const a of raw) {
      if (!a || typeof a !== "object") return fail("E_ATTACHMENT: 条目不是对象");
      const r = a as Record<string, unknown>;
      if (typeof r.sha256 !== "string" || !SHA_RE.test(r.sha256)) return fail("E_ATTACHMENT: sha256 不合法");
      if (seen.has(r.sha256)) return fail(`E_ATTACHMENT: sha 重复：${r.sha256}`);
      seen.add(r.sha256);
      if (typeof r.name !== "string" || typeof r.size !== "number") return fail("E_ATTACHMENT: name/size 必填");
      const fp = [...byPath.keys()].find((p) => p.startsWith(`files/${r.sha256}.`));
      if (!fp) return fail(`E_ATTACHMENT: 附件 ${r.sha256} 的字节缺失（files/）`);
      const bytes = byPath.get(fp)!;
      if (bytes.byteLength !== r.size) return fail(`E_ATTACHMENT: ${r.sha256} size 与字节不符`);
      attachments.push({
        sha256: r.sha256,
        name: r.name,
        size: r.size,
        ...(typeof r.mime === "string" ? { mime: r.mime } : {}),
      });
    }
  }

  // ⑤ 文档：内层复用现有读侧；内层禁止再嵌包
  const documents = new Map<string, string>();
  for (const [id, n] of nodes) {
    if (n.kind === "folder") continue;
    const path = n.documentPath ?? `documents/${id}/document.shuyodoc`;
    const bytes = byPath.get(path);
    if (!bytes) return fail(`E_CONTENT: 节点 ${id} 缺内层文档包（${path}）`);
    let innerEntries: ZipEntry[];
    try {
      innerEntries = await unzipDocument(bytes);
    } catch (e) {
      return fail(`E_CONTENT: 节点 ${id} 的内层包解不开（${e instanceof Error ? e.message : String(e)}）`);
    }
    if (innerEntries.some((e) => /\.(zip|shuyodoc)$/i.test(e.path))) return fail("E_ZIP_STRUCTURE: 内层包再嵌包（v1.1 硬拒）");
    const opened = await openDocumentPackage(innerEntries);
    if (!opened.ok) return fail(`E_CONTENT: 节点 ${id} 的内层文档包不合法：${opened.error}`);
    let content: Record<string, unknown>;
    try {
      content = JSON.parse(opened.pkg.docJson);
    } catch {
      return fail(`E_CONTENT: 节点 ${id} 的 content.json 不是 JSON 对象`);
    }
    if (n.kind === "database" && content.db === undefined) {
      return fail(`E_TREE: database 节点 ${id} 缺 db 命名空间（§1.3）`);
    }
    documents.set(id, opened.pkg.docJson);
  }

  // ⑤b tree ↔ attachments 名字冲突：tree 权威 + warning（§9 补充权威口径）
  for (const n of nodes.values()) {
    for (const c of n.children) {
      if (c.type !== "file") continue;
      const att = attachments.find((a) => a.sha256 === c.sha256);
      if (att && att.name !== c.name) {
        warnings.push(`attachment-name-mismatch: ${c.sha256} tree=${c.name} attachments=${att.name}；以 tree 为准`);
        att.name = c.name;
      }
    }
  }

  // ⑥ id_map 不信任（只提示）
  if (byPath.has("id_map.json")) warnings.push("id-map-ignored: 包里的 id_map.json 仅作诊断参考，导入会重算新 id");

  return {
    ok: true,
    pkg: { manifest, tree: { roots: rootIds as string[], nodes }, attachments, documents, files: new Map([...byPath].filter(([p]) => p.startsWith("files/")).map(([p, b]) => [p.slice("files/".length).split(".")[0], b])), warnings },
  };
}
