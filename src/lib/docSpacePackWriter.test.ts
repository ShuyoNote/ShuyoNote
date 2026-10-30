// ⭐ M2a：`.shuyospace` 导出判据（纯格式层）。
import { describe, expect, it } from "vitest";
import { unzipDocument } from "./docZip";
import { openDocumentPackage } from "./docPackageOpen";
import { sha256Hex } from "./docPackage";
import {
  ATTACHMENTS_PATH,
  CHECKSUMS_PATH,
  MANIFEST_PATH,
  SPACE_FORMAT,
  TREE_PATH,
  buildSpacePackage,
  type BuildSpacePackageInput,
} from "./docSpacePackWriter";

const enc = (s: string) => new TextEncoder().encode(s);
const byPath = (entries: { path: string; bytes: Uint8Array }[], p: string) =>
  entries.find((e) => e.path === p)!;

async function sample(): Promise<BuildSpacePackageInput> {
  const bytes = enc("hello");
  const sha = await sha256Hex(bytes);
  return {
    space: { id: "sp1", name: "团队空间", type: "team", createdAt: "2026-10-30T00:00:00.000Z" },
    sourceAppVersion: "1.2.3",
    files: [{ sha256: sha, name: "A.PDF", mime: "application/pdf", bytes }],
    nodes: [
      {
        id: "p1",
        parentId: null,
        kind: "page",
        title: "首页",
        docJson: JSON.stringify({ root: { type: "root", children: [] } }),
        children: [
          { type: "node", id: "d1" },
          { type: "file", sha256: sha, name: "A.PDF", mime: "application/pdf" },
        ],
        createdAt: "2026-10-30T00:00:00.000Z",
        updatedAt: "2026-10-30T00:00:00.000Z",
      },
      { id: "d1", parentId: "p1", kind: "database", title: "任务库", docJson: JSON.stringify({ root: { type: "root", children: [] } }), db: { tables: [{ id: "t1" }] }, children: [] },
      { id: "f1", parentId: null, kind: "folder", title: "空夹", children: [] },
    ],
  };
}

describe("M2a · .shuyospace 导出", () => {
  it("包结构：manifest/tree/documents/files/attachments/checksums（无 id_map）", async () => {
    const r = await buildSpacePackage(await sample());
    const entries = await unzipDocument(r.bytes);
    const paths = entries.map((e) => e.path);
    expect(paths).toContain(MANIFEST_PATH);
    expect(paths).toContain(TREE_PATH);
    expect(paths).toContain(ATTACHMENTS_PATH);
    expect(paths).toContain(CHECKSUMS_PATH);
    expect(paths.some((p) => p === "documents/p1/document.shuyodoc")).toBe(true);
    expect(paths.some((p) => p === "documents/d1/document.shuyodoc")).toBe(true);
    expect(paths.some((p) => /^files\/[0-9a-f]{64}\.pdf$/.test(p))).toBe(true);
    expect(paths).not.toContain("id_map.json");
    const manifest = JSON.parse(new TextDecoder().decode(byPath(entries, MANIFEST_PATH).bytes));
    expect(manifest.format).toBe(SPACE_FORMAT);
    expect(manifest.format_version).toBe(1);
    expect(manifest.features).toContain("db-namespace");
    expect(manifest.min_reader_version).toBe("1.1");
    expect(manifest.space).toEqual({ id: "sp1", name: "团队空间", type: "team", createdAt: "2026-10-30T00:00:00.000Z" });
    expect(manifest.checksums_sha256).toBeUndefined(); // 写侧不再写（仅读侧容忍）
    const sums = JSON.parse(new TextDecoder().decode(byPath(entries, CHECKSUMS_PATH).bytes)) as { files: Record<string, string> };
    expect(sums.files[MANIFEST_PATH]).toBe(await sha256Hex(byPath(entries, MANIFEST_PATH).bytes));
  });

  it("tree：children 顺序/成员权威；空文件夹 []；file 条目保留 name（§9）", async () => {
    const r = await buildSpacePackage(await sample());
    const entries = await unzipDocument(r.bytes);
    const tree = JSON.parse(new TextDecoder().decode(byPath(entries, TREE_PATH).bytes));
    expect(tree.format).toBe("shuyonote.tree");
    expect(tree.roots).toEqual([{ type: "node", id: "p1" }, { type: "node", id: "f1" }]);
    expect(tree.children.f1).toEqual([]);
    const fileChild = tree.children.p1.find((c: { type: string }) => c.type === "file");
    expect(fileChild.name).toBe("A.PDF");
    expect(fileChild.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(tree.nodes.d1.parent_id).toBe("p1");
  });

  it("attachments.json：sha 去重、名字取自 tree（权威）", async () => {
    const r = await buildSpacePackage(await sample());
    const entries = await unzipDocument(r.bytes);
    const atts = JSON.parse(new TextDecoder().decode(byPath(entries, ATTACHMENTS_PATH).bytes));
    expect(atts).toHaveLength(1);
    expect(atts[0]).toMatchObject({ name: "A.PDF", mime: "application/pdf", size: 5 });
  });

  it("内层文档包可被现有读侧读回；内层**不再嵌包**", async () => {
    const r = await buildSpacePackage(await sample());
    const outer = await unzipDocument(r.bytes);
    for (const p of ["documents/p1/document.shuyodoc", "documents/d1/document.shuyodoc"]) {
      const inner = await unzipDocument(byPath(outer, p).bytes);
      expect(inner.some((e) => /\.(zip|shuyodoc)$/i.test(e.path))).toBe(false);
      const opened = await openDocumentPackage(inner);
      expect(opened.ok, `${p}: ${!opened.ok ? opened.error : ""}`).toBe(true);
    }
  });

  it("database 节点的 db 命名空间写进内层 content.json", async () => {
    const r = await buildSpacePackage(await sample());
    const outer = await unzipDocument(r.bytes);
    const inner = await unzipDocument(byPath(outer, "documents/d1/document.shuyodoc").bytes);
    const content = JSON.parse(new TextDecoder().decode(byPath(inner, "content.json").bytes));
    expect(content.db).toEqual({ tables: [{ id: "t1" }] });
  });

  it("同一输入逐字节可复现（固定 1980-01-01 时间戳 + store-only）", async () => {
    const a = await buildSpacePackage(await sample());
    const b = await buildSpacePackage(await sample());
    expect(Buffer.from(a.bytes)).toEqual(Buffer.from(b.bytes));
  });

  it("checksums 覆盖 **manifest**/tree/documents/files/attachments（写侧不写 checksums_sha256）", async () => {
    const r = await buildSpacePackage(await sample());
    const entries = await unzipDocument(r.bytes);
    const sums = JSON.parse(new TextDecoder().decode(byPath(entries, CHECKSUMS_PATH).bytes)) as {
      files: Record<string, string>;
    };
    const covered = Object.keys(sums.files).sort();
    expect(covered).toContain(MANIFEST_PATH);
    expect(covered).toContain(TREE_PATH);
    expect(covered).toContain(ATTACHMENTS_PATH);
    expect(covered.some((p) => p.startsWith("documents/"))).toBe(true);
    expect(covered.some((p) => p.startsWith("files/"))).toBe(true);
    // 每个登记项的 sha 与真实字节一致
    for (const p of covered) {
      expect(await sha256Hex(byPath(entries, p).bytes)).toBe(sums.files[p]);
    }
  });

  it("附件名冲突：同一 sha 在 tree 多处引用名字不同 ⇒ 以 tree 第一次为准 + warning", async () => {
    const input = await sample();
    const p1 = input.nodes.find((n) => n.id === "p1")!;
    const fileChild = p1.children.find((c) => c.type === "file") as { type: "file"; sha256: string; name: string; mime?: string };
    p1.children = [...p1.children, { ...fileChild, name: "B.PDF" }];
    const r = await buildSpacePackage(input);
    expect(r.warnings.join("\n")).toContain("attachment-name-conflict");
    const entries = await unzipDocument(r.bytes);
    const atts = JSON.parse(new TextDecoder().decode(byPath(entries, ATTACHMENTS_PATH).bytes));
    expect(atts).toHaveLength(1);
    expect(atts[0].name).toBe("A.PDF");
  });

  it("写侧：children 与 parent_id 冲突 ⇒ 拒", async () => {
    const input = await sample();
    const d1 = input.nodes.find((n) => n.id === "d1")!;
    d1.parentId = null; // 仍在 p1.children 里 ⇒ 冲突
    await expect(buildSpacePackage(input)).rejects.toThrow(/children 与 parent_id 冲突/);
  });
});
