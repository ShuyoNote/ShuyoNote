// ⭐ M2c：`.shuyospace` 导入前端胶水 —— 解包 → 调 Rust 单命令（原子）→ 结果映射。
// 格式校验全部复用 `openSpacePackage`；这里**不做第二套解析**。
import { unzipDocument } from "./docZip";
import { openSpacePackage } from "./docSpacePackOpen";
import { api } from "./api";

export interface SpaceImportOutcome {
  spaceId: string;
  nodes: number;
  documents: number;
  attachments: number;
  warnings: string[];
}

export type SpaceImportResult = { ok: true; result: SpaceImportOutcome } | { ok: false; error: string };

export async function importSpacePackageFromZip(zipBytes: Uint8Array): Promise<SpaceImportResult> {
  let entries;
  try {
    entries = await unzipDocument(zipBytes);
  } catch (e) {
    return { ok: false, error: `包解不开：${e instanceof Error ? e.message : String(e)}` };
  }
  const opened = await openSpacePackage(entries);
  if (!opened.ok) return { ok: false, error: opened.error };
  const pkg = opened.pkg;
  const spaceName = String((pkg.manifest.space as { name?: unknown }).name ?? "");
  const nodes = [...pkg.tree.nodes.values()].map((n) => ({
    old_id: n.id,
    parent_old_id: n.parent_id,
    kind: n.kind,
    title: n.title,
    ...(pkg.documents.has(n.id) ? { doc_json: pkg.documents.get(n.id)! } : {}),
  }));
  const files = pkg.attachments.map((a) => {
    const owner = [...pkg.tree.nodes.values()].find((n) => n.children.some((c) => c.type === "file" && c.sha256 === a.sha256));
    return {
      sha256: a.sha256,
      name: a.name,
      ...(a.mime ? { mime: a.mime } : {}),
      ...(owner ? { page_old_id: owner.id } : {}),
      bytes: Array.from(pkg.files.get(a.sha256) ?? new Uint8Array()),
    };
  });
  try {
    const r = (await api.importSpacePackage({ space_name: spaceName, nodes, files })) as SpaceImportOutcome;
    return { ok: true, result: r };
  } catch (e) {
    return { ok: false, error: `导入失败：${e instanceof Error ? e.message : String(e)}` };
  }
}
