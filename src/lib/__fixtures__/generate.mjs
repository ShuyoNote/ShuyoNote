// 跨版夹具生成器（**只读**企业版代码：只 import，不写它仓）。
//
// 用法（个人版 worktree 根目录）：
//   node src/lib/__fixtures__/generate.mjs
//
// 它用企业版 `workbench/lib/package-format.mjs` **真实打包**出两个包：
//   · enterprise-document.shuyodoc   —— 企业版 buildDocumentPackage（含 1 个小资产）
//   · enterprise-space.shuyospace    —— 企业版 buildSpacePackage（单文档空间，tree v1）
// 产物入库（体积各 ~1–3 KB），跨版判据直接读它们，不依赖企业版检出存在。
//
// 企业版仓位置默认是同工作区的兄弟目录，可用环境变量 SHUYONOTE_ENTERPRISE_CLIENT 覆盖。

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const OUT_DIR = dirname(fileURLToPath(import.meta.url));
// 默认同工作区兄弟目录 repos/shuyonote-enterprise-client（本脚本在 worktrees/<worktree>/src/lib/__fixtures__/）
const ENT = process.env.SHUYONOTE_ENTERPRISE_CLIENT
  ? pathToFileURL(process.env.SHUYONOTE_ENTERPRISE_CLIENT)
  : new URL('../../../../../repos/shuyonote-enterprise-client/workbench/lib/package-format.mjs', import.meta.url);
const { buildDocumentPackage, buildSpacePackage, readPackage, sha256Hex, TREE_FORMAT } = await import(ENT.href);

const text = (s) => new TextEncoder().encode(s);
const dec = new TextDecoder();
const enc = new TextEncoder();

const CREATED = '2026-10-29T00:00:00.000Z';
const UPDATED = '2026-10-29T01:00:00.000Z';

// ── 夹具 1：.shuyodoc（企业版生成；manifest 不带 assets 字段，资产在 assets/<sha>.txt） ──
const assetBytes = text('数友互导夹具：附件正文（企业版生成）');
const assetSha = sha256Hex(assetBytes);
const docContent = {
  root: {
    type: 'root',
    children: [
      {
        type: 'paragraph',
        children: [{ type: 'text', text: '企业版生成的 .shuyodoc —— 个人版必须能直接读' }],
        version: 1,
        direction: 'ltr',
        format: '',
        indent: 0,
        textFormat: 0,
        textStyle: '',
      },
    ],
    version: 1,
    direction: 'ltr',
    format: '',
    indent: 0,
  },
};
const doc = buildDocumentPackage({
  title: '企业版生成的互导夹具',
  contentJson: docContent,
  assets: new Map([[assetSha, { bytes: assetBytes, ext: 'txt' }]]),
  source: 'enterprise',
  sourceAppVersion: '9.9.9-interop-fixture',
  documentId: 'doc-enterprise-fixture-1',
  createdAt: CREATED,
  updatedAt: UPDATED,
});
writeFileSync(join(OUT_DIR, 'enterprise-document.shuyodoc'), doc.bytes);

// ── 夹具 2：.shuyospace（单文档空间；tree.json 是结构唯一真相） ──
const nestedDoc = buildDocumentPackage({
  title: '空间里的那一篇',
  contentJson: { root: { type: 'root', children: [] } },
  source: 'enterprise',
  sourceAppVersion: '9.9.9-interop-fixture',
  documentId: 'doc-space-fixture-1',
  createdAt: CREATED,
  updatedAt: UPDATED,
});
const tree = {
  format: TREE_FORMAT,
  version: 1,
  roots: ['n-root'],
  nodes: {
    'n-root': { kind: 'folder', title: '企业版空间夹具', parent_id: null },
    'n-page': { kind: 'page', title: '空间里的那一篇', parent_id: 'n-root', document: 'doc-space-fixture-1' },
  },
  children: { 'n-root': [{ type: 'node', id: 'n-page' }] },
};
const space = buildSpacePackage({
  space: { id: 'space-enterprise-fixture-1', name: '企业版单文档空间夹具', type: 'team', created_at: CREATED },
  tree,
  documents: new Map([['doc-space-fixture-1', nestedDoc.bytes]]),
  source: 'enterprise',
  sourceAppVersion: '9.9.9-interop-fixture',
  createdAt: CREATED,
});
writeFileSync(join(OUT_DIR, 'enterprise-space.shuyospace'), space.bytes);

// ── 自检：用企业版自己的读端再读一遍（⛔ 不把坏夹具入库） ──
const readings = [];
for (const [name, built] of [
  ['enterprise-document.shuyodoc', doc],
  ['enterprise-space.shuyospace', space],
]) {
  const bytes = built.bytes;
  const pkg = readPackage(bytes);
  readings.push({
    file: name,
    bytes: bytes.length,
    sha256: sha256Hex(bytes),
    kind: pkg.kind,
    checksumsOk: pkg.checksumsOk,
    errors: pkg.errors,
    entries: [...pkg.entries.keys()].sort(),
    manifestKeys: Object.keys(pkg.manifest).sort(),
    checksums: JSON.parse(dec.decode(pkg.entries.get('checksums.json'))),
    title: pkg.manifest.title ?? pkg.manifest.space?.name,
    documentId: pkg.manifest.document_id ?? null,
    source: pkg.manifest.source,
    sourceAppVersion: pkg.manifest.source_app_version,
    contentJsonSnippet: pkg.kind === 'document' ? pkg.content.slice(0, 60) : null,
  });
}
console.log(JSON.stringify(readings, null, 2));
console.log('FIXTURES-OK');
