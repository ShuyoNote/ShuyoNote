// ⭐ 样例包夹具的**字节稳定判据**：用生产写侧在**进程内**重建 ⇒ 与入库逐字节相等、sha 与 fixtures.json 一致。
// ⚠️ 不 spawn 子进程（全量并行时会与 vite 冷启动抢资源、CI 上偶发失败）；生成器脚本仍保留给人用。
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildDocumentPackage } from "./docPackWriter";
import { buildSpacePackage } from "./docSpacePackWriter";
import { openDocumentPackage } from "./docPackageOpen";
import { openSpacePackage } from "./docSpacePackOpen";
import { unzipDocument } from "./docZip";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtureDir = join(root, "src/lib/__fixtures__/package-fixtures");
const sha256 = (b: Uint8Array) => createHash("sha256").update(Buffer.from(b)).digest("hex");
const utf8 = (s: string) => new TextEncoder().encode(s);
const textDoc = (text: string) =>
  JSON.stringify({ root: { children: [{ type: "paragraph", children: [{ type: "text", text }] }] } });

const manifest = JSON.parse(readFileSync(join(fixtureDir, "fixtures.json"), "utf8")) as {
  fixtures: { name: string; bytes: number; sha256: string }[];
};

/** 与 `scripts/make-package-fixtures.mjs` **同一组输入**（改夹具时两处一起改；判据会立即顶红）。 */
async function rebuild(): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  out.set(
    "personal-minimal.shuyodoc",
    await buildDocumentPackage({
      documentId: "doc-personal-minimal",
      title: "个人版样例：最小文档包",
      createdAt: "2026-10-30T00:00:00.000Z",
      updatedAt: "2026-10-30T00:00:00.000Z",
      docJson: textDoc("这是个人版导出的最小 `.shuyodoc` 样例。"),
      sourceAppVersion: "1.0.0",
    }),
  );
  const attachBytes = utf8("个人版附件样例：你好，ShuyoNote。\n");
  const attachSha = sha256(attachBytes);
  out.set(
    "personal-with-attachment.shuyodoc",
    await buildDocumentPackage({
      documentId: "doc-personal-attachment",
      title: "个人版样例：带附件",
      createdAt: "2026-10-30T00:00:00.000Z",
      updatedAt: "2026-10-30T00:00:00.000Z",
      docJson: textDoc(`附件引用：attachment://${attachSha}`),
      assets: [{ path: `assets/${attachSha}.txt`, bytes: attachBytes }],
      sourceAppVersion: "1.0.0",
    }),
  );
  out.set(
    "personal-database.shuyodoc",
    await buildDocumentPackage({
      documentId: "doc-personal-database",
      title: "个人版样例：数据库页",
      createdAt: "2026-10-30T00:00:00.000Z",
      updatedAt: "2026-10-30T00:00:00.000Z",
      docJson: JSON.stringify({
        root: { children: [{ type: "paragraph", children: [{ type: "text", text: "台账" }] }] },
        db: {
          columns: [{ id: "c1", name: "事项", type: "text" }],
          views: [{ id: "v1", name: "默认视图" }],
          rows: [{ id: "r1", values: { c1: "第一行" } }],
        },
      }),
      sourceAppVersion: "1.0.0",
    }),
  );
  const space = await buildSpacePackage({
    space: { id: "space-personal-sample", name: "个人版样例空间", type: "personal", createdAt: "2026-10-30T00:00:00.000Z" },
    source: "personal",
    sourceAppVersion: "1.0.0",
    nodes: [
      {
        id: "n-folder",
        parentId: null,
        kind: "folder",
        title: "资料",
        children: [
          { type: "node", id: "n-page" },
          { type: "file", sha256: attachSha, name: "样例.txt", mime: "text/plain" },
        ],
      },
      { id: "n-page", parentId: "n-folder", kind: "page", title: "招标文件", docJson: textDoc("空间包里的页面。"), children: [] },
      {
        id: "n-db",
        parentId: null,
        kind: "database",
        title: "台账",
        docJson: textDoc("空间包里的数据库页。"),
        db: { columns: [{ id: "c1", name: "事项", type: "text" }], rows: [{ id: "r1", values: { c1: "第一行" } }] },
        children: [],
      },
      { id: "n-empty", parentId: null, kind: "folder", title: "空文件夹", children: [] },
    ],
    files: [{ sha256: attachSha, name: "样例.txt", mime: "text/plain", bytes: attachBytes }],
  });
  out.set("personal-sample.shuyospace", space.bytes);
  return out;
}

describe("样例包夹具（字节稳定 + 可读回；进程内重建，不 spawn）", () => {
  it("入库文件与 fixtures.json 的 size/sha256 一致", () => {
    expect(manifest.fixtures).toHaveLength(4);
    for (const f of manifest.fixtures) {
      const bytes = readFileSync(join(fixtureDir, f.name));
      expect(bytes.byteLength, f.name).toBe(f.bytes);
      expect(sha256(bytes), f.name).toBe(f.sha256);
    }
  });

  it("用生产写侧进程内重建 ⇒ 与入库文件逐字节相等（固定时间戳/顺序）", async () => {
    const rebuilt = await rebuild();
    expect([...rebuilt.keys()].sort()).toEqual(manifest.fixtures.map((f) => f.name).sort());
    for (const f of manifest.fixtures) {
      const fresh = rebuilt.get(f.name)!;
      expect(fresh.byteLength, f.name).toBe(f.bytes);
      expect(sha256(fresh), f.name).toBe(f.sha256);
      expect(Buffer.compare(Buffer.from(fresh), readFileSync(join(fixtureDir, f.name))), f.name).toBe(0);
    }
  });

  it("读回：3 个 .shuyodoc 走 openDocumentPackage、1 个 .shuyospace 走 openSpacePackage", async () => {
    const docs = manifest.fixtures.filter((f) => f.name.endsWith(".shuyodoc"));
    const spaces = manifest.fixtures.filter((f) => f.name.endsWith(".shuyospace"));
    expect(docs).toHaveLength(3);
    expect(spaces).toHaveLength(1);
    for (const f of docs) {
      const entries = await unzipDocument(readFileSync(join(fixtureDir, f.name)));
      const opened = await openDocumentPackage(entries);
      expect(opened.ok, `${f.name}: ${!opened.ok ? opened.error : ""}`).toBe(true);
    }
    for (const f of spaces) {
      const entries = await unzipDocument(readFileSync(join(fixtureDir, f.name)));
      const opened = await openSpacePackage(entries);
      expect(opened.ok, `${f.name}: ${!opened.ok ? opened.error : ""}`).toBe(true);
      if (opened.ok) {
        expect(opened.pkg.tree.nodes.size).toBe(4);
        expect(opened.pkg.attachments).toHaveLength(1);
      }
    }
  });
});
