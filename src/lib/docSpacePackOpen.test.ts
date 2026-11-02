// ⭐ M2b 读侧判据：`.shuyospace` 解析/整包校验（导入落库下一批）。
import { describe, expect, it } from "vitest";
import { unzipDocument } from "./docZip";
import { sha256Hex, buildChecksums, CHECKSUMS_PATH } from "./docPackage";
import { buildSpacePackage, type BuildSpacePackageInput } from "./docSpacePackWriter";
import { openSpacePackage } from "./docSpacePackOpen";
import type { ZipEntry } from "./docPackageOpen";

const enc = (s: string) => new TextEncoder().encode(s);

async function sample(): Promise<BuildSpacePackageInput> {
  const bytes = enc("hello");
  const sha = await sha256Hex(bytes);
  return {
    space: { id: "sp1", name: "团队空间", type: "team", createdAt: "2026-10-30T00:00:00.000Z" },
    sourceAppVersion: "1.2.3",
    files: [{ sha256: sha, name: "a.pdf", mime: "application/pdf", bytes }],
    nodes: [
      {
        id: "p1",
        parentId: null,
        kind: "page",
        title: "首页",
        docJson: JSON.stringify({ root: { type: "root", children: [] } }),
        children: [{ type: "file", sha256: sha, name: "a.pdf" }],
        createdAt: "2026-10-30T00:00:00.000Z",
      },
      { id: "f1", parentId: null, kind: "folder", title: "空夹", children: [] },
      { id: "d1", parentId: null, kind: "database", title: "库", docJson: JSON.stringify({ root: {} }), db: { tables: [] }, children: [] },
    ],
  };
}

async function built(): Promise<ZipEntry[]> {
  const r = await buildSpacePackage(await sample());
  return unzipDocument(r.bytes);
}

/** 重新算 checksums（manifest 也登记），便于构造"结构合法但内容被改"的包。 */
async function repack(entries: ZipEntry[]): Promise<ZipEntry[]> {
  const base = entries.filter((e) => e.path !== CHECKSUMS_PATH);
  const sums = await buildChecksums(base.map((e) => ({ path: e.path, bytes: e.bytes })));
  return [...base, { path: CHECKSUMS_PATH, bytes: enc(JSON.stringify(sums)) }];
}
const treeOf = (entries: ZipEntry[]) => JSON.parse(new TextDecoder().decode(entries.find((e) => e.path === "tree.json")!.bytes));

describe("M2b · .shuyospace 读侧", () => {
  it("往返：导出 → 打开（tree 等价、文档/附件 sha 全对）", async () => {
    const entries = await built();
    const r = await openSpacePackage(entries);
    expect(r.ok, !r.ok ? r.error : "").toBe(true);
    if (!r.ok) return;
    expect(r.pkg.tree.roots.sort()).toEqual(["d1", "f1", "p1"]);
    expect(r.pkg.tree.nodes.get("p1")!.children.map((c) => c.type)).toEqual(["file"]);
    expect(r.pkg.documents.size).toBe(2);
    expect(r.pkg.attachments).toHaveLength(1);
    const sha = r.pkg.attachments[0].sha256;
    expect(await sha256Hex(r.pkg.files.get(sha)!)).toBe(sha);
    expect(JSON.parse(r.pkg.documents.get("d1")!).db).toEqual({ tables: [] });
  });

  it("未知 kind ⇒ E_TREE", async () => {
    const entries = await built();
    const tree = treeOf(entries);
    tree.nodes.p1.kind = "weird";
    const r = await openSpacePackage(await repack(entries.map((e) => (e.path === "tree.json" ? { ...e, bytes: enc(JSON.stringify(tree)) } : e))));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("E_TREE");
  });

  it("children 与 parent_id 冲突 ⇒ E_TREE", async () => {
    const entries = await built();
    const tree = treeOf(entries);
    tree.nodes.f1.parent_id = "p1"; // f1 是 root、不在 p1.children 里
    const r = await openSpacePackage(await repack(entries.map((e) => (e.path === "tree.json" ? { ...e, bytes: enc(JSON.stringify(tree)) } : e))));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("E_TREE");
  });

  it("深度超限 ⇒ E_TREE（maxDepth 注入）", async () => {
    const input = await sample();
    for (let i = 0; i < 6; i++) input.nodes.push({ id: `x${i}`, parentId: i === 0 ? null : `x${i - 1}`, kind: "folder", title: `x${i}`, children: i === 5 ? [] : [{ type: "node", id: `x${i + 1}` }] });
    const r0 = await buildSpacePackage(input);
    const entries = await unzipDocument(r0.bytes);
    const r = await openSpacePackage(entries, { maxDepth: 3 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("E_TREE");
  });

  it("坏 checksums ⇒ E_CHECKSUMS", async () => {
    const entries = await built();
    const f = entries.find((e) => e.path.startsWith("files/"))!;
    const r = await openSpacePackage(entries.map((e) => (e.path === f.path ? { ...e, bytes: enc("tampered") } : e)));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("E_CHECKSUMS");
  });

  it("缺 checksums ⇒ E_IO_CHECKSUMS", async () => {
    const entries = (await built()).filter((e) => e.path !== CHECKSUMS_PATH);
    const r = await openSpacePackage(entries);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("E_IO_CHECKSUMS");
  });

  it("内层再嵌包 ⇒ E_ZIP_STRUCTURE", async () => {
    const entries = await built();
    const r = await openSpacePackage(await repack([...entries, { path: "evil.zip", bytes: enc("PK") }]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("E_ZIP_STRUCTURE");
  });

  it("附件字节缺失 ⇒ E_ATTACHMENT", async () => {
    const entries = await built();
    const r = await openSpacePackage(await repack(entries.filter((e) => !e.path.startsWith("files/"))));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("E_ATTACHMENT");
  });

  it("id_map.json 不信任：只提示 id-map-ignored，不用于结构", async () => {
    const entries = await built();
    const r = await openSpacePackage(await repack([...entries, { path: "id_map.json", bytes: enc(JSON.stringify({ nodes: { p1: "hacked" } })) }]));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pkg.warnings.join("\n")).toContain("id-map-ignored");
  });

  it("未知 kind 之前的 manifest 高版本 ⇒ E_VERSION；加密 ⇒ E_MANIFEST", async () => {
    for (const [mut, code] of [
      [{ min_reader_version: "9.0" }, "E_VERSION"],
      [{ encrypted: true }, "E_MANIFEST"],
    ] as const) {
      const entries = await built();
      const m = JSON.parse(new TextDecoder().decode(entries.find((e) => e.path === "manifest.json")!.bytes));
      const r = await openSpacePackage(await repack(entries.map((e) => (e.path === "manifest.json" ? { ...e, bytes: enc(JSON.stringify({ ...m, ...mut })) } : e))));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain(code);
    }
  });

  it("上限：条目数/总大小超限 ⇒ E_LIMIT；边界恰好通过（可注入小阈值）", async () => {
    const entries = await built();
    const total = entries.reduce((n, e) => n + e.bytes.byteLength, 0);
    expect((await openSpacePackage(entries, { maxEntries: entries.length })).ok).toBe(true);
    const overCount = await openSpacePackage(entries, { maxEntries: entries.length - 1 });
    expect(overCount.ok).toBe(false);
    if (!overCount.ok) expect(overCount.error).toContain("E_LIMIT");
    expect((await openSpacePackage(entries, { maxTotalBytes: total })).ok).toBe(true);
    const overBytes = await openSpacePackage(entries, { maxTotalBytes: total - 1 });
    expect(overBytes.ok).toBe(false);
    if (!overBytes.ok) expect(overBytes.error).toContain("E_LIMIT");
  });

  it("tree↔attachments 名字冲突：以 tree 为准 + attachment-name-mismatch warning；一致时无 warning", async () => {
    const entries = await built();
    const att = JSON.parse(new TextDecoder().decode(entries.find((e) => e.path === "attachments.json")!.bytes));
    att[0].name = "conflict-name.pdf";
    const mutated = await repack(entries.map((e) => (e.path === "attachments.json" ? { ...e, bytes: enc(JSON.stringify(att)) } : e)));
    const r = await openSpacePackage(mutated);
    expect(r.ok, !r.ok ? r.error : "").toBe(true);
    if (r.ok) {
      expect(r.pkg.warnings.join("\n")).toContain("attachment-name-mismatch");
      const treeName = r.pkg.tree.nodes.get("p1")!.children.find((c) => c.type === "file") as { name: string };
      expect(r.pkg.attachments[0].name).toBe(treeName.name);
    }
    const clean = await openSpacePackage(entries);
    expect(clean.ok).toBe(true);
    if (clean.ok) expect(clean.pkg.warnings.join("\n")).not.toContain("attachment-name-mismatch");
  });

});
