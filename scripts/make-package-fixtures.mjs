// 生成"个人版真实样例包"（.shuyodoc / .shuyospace），供企业版 D2/S2 方向互读验收与回归夹具。
//
// 用法：node scripts/make-package-fixtures.mjs [输出目录]
//   默认输出 `src/lib/__fixtures__/package-fixtures/`（入库；`fixtures.json` 记 size/sha256）。
//
// ⚠️ 本脚本用 vite 的 `ssrLoadModule` 直接加载**我们的 TS 写侧**（不是第二套实现），并用
// 同一套读侧读回自证；输出字节必须稳定（固定时间戳/顺序）⇒ 重复生成逐字节相等。
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const req = createRequire(join(root, "package.json"));
const { createServer } = await import(pathToFileURL(req.resolve("vite")).href);

const outDir = process.argv[2]
  ? resolve(process.argv[2])
  : join(root, "src/lib/__fixtures__/package-fixtures");
mkdirSync(outDir, { recursive: true });

const server = await createServer({
  root,
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "error",
});
try {
  const docWriter = await server.ssrLoadModule("/src/lib/docPackWriter.ts");
  const spaceWriter = await server.ssrLoadModule("/src/lib/docSpacePackWriter.ts");
  const docOpen = await server.ssrLoadModule("/src/lib/docPackageOpen.ts");
  const spaceOpen = await server.ssrLoadModule("/src/lib/docSpacePackOpen.ts");
  const docZip = await server.ssrLoadModule("/src/lib/docZip.ts");

  const sha256 = (b) => createHash("sha256").update(Buffer.from(b)).digest("hex");
  const utf8 = (s) => new TextEncoder().encode(s);
  const textDoc = (text) =>
    JSON.stringify({
      root: { children: [{ type: "paragraph", children: [{ type: "text", text }] }] },
    });
  const results = [];

  async function writeDoc(name, input) {
    const bytes = await docWriter.buildDocumentPackage(input);
    writeFileSync(join(outDir, name), bytes);
    const entries = await docZip.unzipDocument(bytes);
    const opened = await docOpen.openDocumentPackage(entries, {});
    results.push({
      name,
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
      readBack: opened.ok ? { ok: true, title: opened.pkg.manifest?.title } : { ok: false, reason: opened.error },
    });
    return { bytes, sha256: sha256(bytes) };
  }

  // ① 最小文档包：中文标题 + 一段正文
  await writeDoc("personal-minimal.shuyodoc", {
    documentId: "doc-personal-minimal",
    title: "个人版样例：最小文档包",
    createdAt: "2026-10-30T00:00:00.000Z",
    updatedAt: "2026-10-30T00:00:00.000Z",
    docJson: textDoc("这是个人版导出的最小 `.shuyodoc` 样例。"),
    sourceAppVersion: "1.0.0",
  });

  // ② 带附件的文档包：正文引用 attachment://<sha>
  const attachBytes = utf8("个人版附件样例：你好，ShuyoNote。\n");
  const attachSha = sha256(attachBytes);
  await writeDoc("personal-with-attachment.shuyodoc", {
    documentId: "doc-personal-attachment",
    title: "个人版样例：带附件",
    createdAt: "2026-10-30T00:00:00.000Z",
    updatedAt: "2026-10-30T00:00:00.000Z",
    docJson: textDoc(`附件引用：attachment://${attachSha}`),
    assets: [{ path: `assets/${attachSha}.txt`, bytes: attachBytes }],
    sourceAppVersion: "1.0.0",
  });

  // ③ 数据库页文档包：content.json 根带 db 命名空间
  await writeDoc("personal-database.shuyodoc", {
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
  });

  // ④ 空间包：空文件夹 + 混排 children + database 节点 + 一个附件
  const space = await spaceWriter.buildSpacePackage({
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
  writeFileSync(join(outDir, "personal-sample.shuyospace"), space.bytes);
  const spaceEntries = await docZip.unzipDocument(space.bytes);
  const spaceOpened = await spaceOpen.openSpacePackage(spaceEntries, {});
  results.push({
    name: "personal-sample.shuyospace",
    bytes: space.bytes.byteLength,
    sha256: sha256(space.bytes),
    warnings: space.warnings,
    readBack: spaceOpened.ok
      ? {
          ok: true,
          nodes: spaceOpened.pkg.tree.nodes.size,
          attachments: spaceOpened.pkg.attachments.length,
          documents: spaceOpened.pkg.documents.size,
          warnings: spaceOpened.pkg.warnings,
        }
      : { ok: false, reason: spaceOpened.error },
  });

  // fixtures.json：字节稳定判据比对这份清单；**只记 size/sha256**，不记时间/机器。
  const manifest = {
    format: "shuyonote.package-fixtures",
    version: 1,
    generatedBy: "scripts/make-package-fixtures.mjs",
    fixtures: results.map((r) => ({ name: r.name, bytes: r.bytes, sha256: r.sha256 })),
  };
  writeFileSync(join(outDir, "fixtures.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(JSON.stringify({ outDir, fixtures: results }, null, 2));
} finally {
  await server.close();
}
