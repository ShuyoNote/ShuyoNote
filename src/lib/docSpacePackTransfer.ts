// ⭐ M2e：空间包（.shuyospace）导出/导入的**胶水层**（UI 只调这两个函数）。
// 导出：当前空间 pages/attachments → buildSpacePackage → 保存对话框 → writeBinaryFile。
// 导入：文件选择 → readBinaryFile → openSpacePackage/space_package_import → 切到新空间。
import { api } from "./api";
import { platform } from "./platform";
import { docJsonOfPage } from "./docContent";
import { buildSpacePackage, type SpaceChild, type SpaceFileInput, type SpaceNodeInput } from "./docSpacePackWriter";
import { importSpacePackageFromZip } from "./docSpacePackImport";

export interface TransferOutcome {
  ok: boolean;
  cancelled?: boolean;
  message: string;
  warnings?: string[];
  spaceId?: string;
}

const SHUYOSPACE = { name: "ShuyoNote 空间包", extensions: ["shuyospace"] };
const MAX_TOTAL = 256 * 1024 * 1024;

export async function exportWorkspaceAsSpacePackage(): Promise<TransferOutcome> {
  try {
    const activeId = (await api.getActiveWorkspaceId()) as string;
    const workspaces = (await api.listWorkspaces()) as Array<{ id: string; name: string; kind?: string; created_at?: number }>;
    const ws = workspaces.find((w) => w.id === activeId);
    if (!ws) return { ok: false, message: "找不到当前空间" };
    const pages = (await api.listPages()) as Array<{
      id: string;
      parent_id: string | null;
      title: string;
      kind: string;
      sort_order: number;
    }>;
    if (pages.length === 0) return { ok: false, message: "当前空间没有可导出的内容" };

    const files: SpaceFileInput[] = [];
    const fileBySha = new Map<string, SpaceFileInput>();
    let total = 0;

    const childrenOf = new Map<string | null, SpaceNodeInput[]>();
    const fileChildren = new Map<string, SpaceChild[]>();
    for (const p of pages) {
      const kind = p.kind === "folder" || p.kind === "database" ? p.kind : "page";
      const node: SpaceNodeInput = {
        id: p.id,
        parentId: p.parent_id,
        kind,
        title: p.title || "未命名",
        children: [],
      };
      if (kind !== "folder") {
        const detail = await api.getPage(p.id);
        if (!detail) return { ok: false, message: `页面 ${p.id} 读取失败` };
        node.docJson = docJsonOfPage(detail);
        if (kind === "database") {
          try {
            const parsed = JSON.parse(node.docJson);
            if (parsed.db !== undefined) node.db = parsed.db;
          } catch {
            /* 写侧会再校验 */
          }
        }
        const atts = (await api.listPageAttachments(p.id)) as Array<{
          name: string;
          hash: string;
          mime: string;
          size: number;
        }>;
        for (const a of atts) {
          if (!a.hash) continue;
          let f = fileBySha.get(a.hash);
          if (!f) {
            const bytes = new Uint8Array(await api.readAttachmentBytes(a.hash));
            total += bytes.byteLength;
            if (total > MAX_TOTAL) return { ok: false, message: `E_LIMIT: 总大小超过 ${MAX_TOTAL} 字节` };
            f = { sha256: a.hash, name: a.name, mime: a.mime, bytes };
            fileBySha.set(a.hash, f);
            files.push(f);
          }
          fileChildren.set(p.id, [...(fileChildren.get(p.id) ?? []), { type: "file", sha256: a.hash, name: a.name, ...(a.mime ? { mime: a.mime } : {}) }]);
        }
      }
      childrenOf.set(p.parent_id, [...(childrenOf.get(p.parent_id) ?? []), node]);
    }
    // 组装 children（节点的儿子在前、附件 file 条目追加；顺序按 sort_order 已随 listPages）
    for (const p of pages) {
      const node = childrenOf.get(p.parent_id)?.find((n) => n.id === p.id);
      if (!node) continue;
      node.children = [
        ...(childrenOf.get(p.id) ?? []).map((c) => ({ type: "node", id: c.id }) as SpaceChild),
        ...(fileChildren.get(p.id) ?? []),
      ];
    }
    const nodes = [...childrenOf.values()].flat();
    const built = await buildSpacePackage({
      space: {
        id: activeId,
        name: ws.name,
        type: ws.kind === "team" ? "team" : "personal",
        createdAt: new Date(ws.created_at ?? Date.now()).toISOString(),
      },
      source: "personal",
      sourceAppVersion: "1.0.0",
      nodes,
      files,
    });
    const path = await platform.dialog.save({
      title: "导出为 .shuyospace",
      defaultPath: `${ws.name || "空间"}.shuyospace`,
      filters: [SHUYOSPACE],
    });
    if (!path) return { ok: false, cancelled: true, message: "已取消导出" };
    await api.writeBinaryFile(String(path), Array.from(built.bytes));
    return {
      ok: true,
      message: `已导出 ${nodes.length} 个节点、${files.length} 个附件${built.warnings.length ? `（${built.warnings.length} 条提示）` : ""}`,
      warnings: built.warnings,
    };
  } catch (e) {
    return { ok: false, message: `导出失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

export async function importSpacePackageFromDialog(): Promise<TransferOutcome> {
  try {
    const picked = await platform.dialog.open({ title: "导入空间包", multiple: false, filters: [SHUYOSPACE] });
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (!path) return { ok: false, cancelled: true, message: "已取消导入" };
    const bytes = await api.readBinaryFile(String(path));
    const res = await importSpacePackageFromZip(bytes);
    if (!res.ok) return { ok: false, message: res.error };
    await api.setActiveWorkspaceId(res.result.spaceId);
    return {
      ok: true,
      spaceId: res.result.spaceId,
      message: `已导入到新空间（${res.result.nodes} 节点 / ${res.result.attachments} 附件）`,
      warnings: res.result.warnings,
    };
  } catch (e) {
    return { ok: false, message: `导入失败：${e instanceof Error ? e.message : String(e)}` };
  }
}
