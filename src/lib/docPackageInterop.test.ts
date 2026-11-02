// 跨版判据：个人版 `.shuyodoc` ◀▶ 企业版 `.shuyodoc` / `.shuyospace`（2026-10-29 对齐）。
//
// 规范（只读参考）：`repos/shuyonote-enterprise-client/docs/specs/2026-10-28-package-format-spec.md`
// 实现（只读参考）：`repos/shuyonote-enterprise-client/workbench/lib/package-format.mjs`
//
// 两个方向：
//   ① 企业版 → 个人版：`__fixtures__/enterprise-document.shuyodoc` 与
//      `__fixtures__/enterprise-space.shuyospace` 是**用企业版 buildDocumentPackage / buildSpacePackage
//      真实打出来的包**（生成脚本 `__fixtures__/generate.mjs`，企业版自己的 readPackage 自检通过）。
//      个人版必须能读：manifest 企业版字段 / 缺 assets 字段 / `assets/<sha>.<ext>` 内容寻址 / checksums。
//   ② 个人版 → 企业版：`buildManifest` ＋ `buildChecksums` 产出的包，manifest 字段与 checksums 结构
//      必须与企业版**逐字对齐**（下列判据把口径钉住）。企业版 reader 的**实地**接受证据：
//      生成夹具时用企业版 readPackage 读过企业版包；个人版产物由 `node` 直接跑企业版
//      `readPackage` / `importDocument` 验过（读数见任务报告；本测试仓库在 CI 上没有企业版检出，
//      ⛔ 不把「本机存在企业版仓」变成判据的环境前提）。
//
// 另：旧个人包（没有 checksums.json、manifest 只有 title/created/updated/assets）必须**仍能读**，
// 并且把「缺 checksums ⇒ 完整性只靠 assets sha」当**如实提示**带出来（⛔ 不静默通过）。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  CHECKSUMS_ALGORITHM,
  CHECKSUMS_FORMAT,
  CHECKSUMS_VERSION,
  CONTENT_TYPE_LEXICAL,
  DOC_FORMAT,
  DOC_FORMAT_VERSION,
  buildChecksums,
  buildManifest,
  parseManifest,
  sha256Hex,
  verifyChecksums,
} from "./docPackage";
import { openDocumentPackage, type ZipEntry } from "./docPackageOpen";
import { unzipDocument } from "./docZip";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);
const toBytes = (v: Uint8Array | string): Uint8Array => (typeof v === "string" ? enc(v) : v);

/** 读夹具字节（`src/lib/__fixtures__/`，企业版代码生成，见 generate.mjs）。 */
const fixtureBytes = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(resolve(process.cwd(), "src/lib/__fixtures__", name)));

/** 企业版 `writeZip` 是 store 模式 ⇒ 这里也用 store（level 0），容器层面同口径。 */
function zipStore(entries: { path: string; bytes: Uint8Array | string }[]): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  for (const e of entries) files[e.path] = toBytes(e.bytes);
  return zipSync(files, { level: 0 });
}

interface PersonalPackageOptions {
  assets?: { bytes: Uint8Array; ext: string }[];
  content?: unknown;
  manifest?: Partial<Parameters<typeof buildManifest>[0]>;
}

/**
 * 用**个人版自己的** `buildManifest` ＋ `buildChecksums` 组装一个 `.shuyodoc`
 * （manifest/assets/checksums 全部出自个人版格式层；zip 容器用本仓已有依赖 fflate，store 模式）。
 */
async function buildPersonalPackage(opts: PersonalPackageOptions = {}) {
  const content = JSON.stringify(opts.content ?? { root: { type: "root", children: [] } });
  const assetFiles: { path: string; bytes: Uint8Array; sha256: string; size: number }[] = [];
  for (const a of opts.assets ?? []) {
    const sha = await sha256Hex(a.bytes);
    assetFiles.push({ path: `assets/${sha}.${a.ext}`, bytes: a.bytes, sha256: sha, size: a.bytes.byteLength });
  }
  const manifest = buildManifest({
    documentId: "doc-personal-fixture-1",
    title: "个人版导出的互导夹具",
    createdAt: "2026-10-29T02:00:00.000Z",
    updatedAt: "2026-10-29T03:00:00.000Z",
    sourceAppVersion: "2.0.0-interop",
    assets: assetFiles.map((a) => ({ path: a.path, sha256: a.sha256, size: a.size })),
    ...(opts.manifest ?? {}),
  });
  const files = [
    { path: "manifest.json", bytes: `${JSON.stringify(manifest, null, 2)}\n` },
    { path: "content.json", bytes: content },
    ...assetFiles.map((a) => ({ path: a.path, bytes: a.bytes })),
  ];
  const checksums = await buildChecksums(files);
  const all = [...files, { path: "checksums.json", bytes: `${JSON.stringify(checksums, null, 2)}\n` }];
  const entries: ZipEntry[] = all.map((e) => ({ path: e.path, bytes: toBytes(e.bytes) }));
  return { manifest, checksums, files, entries, zip: zipStore(all) };
}

/** 企业版 manifest 必填字段（顺序即企业版 `buildDocumentPackage` 的写出顺序）。 */
const ENTERPRISE_MANIFEST_KEYS = [
  "format",
  "format_version",
  "source",
  "source_app_version",
  "document_id",
  "title",
  "created_at",
  "updated_at",
  "content_type",
  "encrypted",
];

describe("① 企业版 → 个人版：企业版生成的 .shuyodoc 必须能读", () => {
  it("⑳ 企业版包（manifest 无 assets 字段）⇒ 个人版 openDocumentPackage 接受，资产按内容寻址发现", async () => {
    const zip = fixtureBytes("enterprise-document.shuyodoc");
    const r = await openDocumentPackage(await unzipDocument(zip));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { manifest, notices, assets, docJson } = r.pkg;
    // 企业版 manifest 字段逐条认出来
    expect(manifest.format).toBe(DOC_FORMAT);
    expect(manifest.format_version).toBe(DOC_FORMAT_VERSION);
    expect(manifest.source).toBe("enterprise");
    expect(manifest.source_app_version).toBe("9.9.9-interop-fixture");
    expect(manifest.document_id).toBe("doc-enterprise-fixture-1");
    expect(manifest.created_at).toBe("2026-10-29T00:00:00.000Z");
    expect(manifest.updated_at).toBe("2026-10-29T01:00:00.000Z");
    expect(manifest.content_type).toBe(CONTENT_TYPE_LEXICAL);
    expect(manifest.encrypted).toBe(false);
    expect(manifest.title).toBe("企业版生成的互导夹具");
    // 企业版包**没有** manifest.assets ⇒ 缺省 []，资产从 assets/<sha>.<ext> 发现
    expect(manifest.assets).toEqual([]);
    expect(assets).toHaveLength(1);
    expect(assets[0].path).toMatch(/^assets\/[0-9a-f]{64}\.txt$/);
    expect(dec(assets[0].bytes)).toContain("数友互导夹具");
    await expect(sha256Hex(assets[0].bytes)).resolves.toBe(assets[0].path.slice("assets/".length, -".txt".length));
    expect(docJson).toContain("企业版生成的 .shuyodoc");
    // 企业版包带 checksums ⇒ 校验通过、没有降级提示
    expect(notices).toEqual([]);
  });

  it("㉑ 企业版 .shuyospace 的 checksums 与嵌套 .shuyodoc 也按同口径通过", async () => {
    const spaceZip = fixtureBytes("enterprise-space.shuyospace");
    const spaceEntries = await unzipDocument(spaceZip);
    // 空间包本身：manifest / tree / documents 都有 checksums 登记 ⇒ 用个人版的校验函数逐条核
    const spaceChecksums = JSON.parse(dec(spaceEntries.find((e) => e.path === "checksums.json")!.bytes));
    const spaceManifest = JSON.parse(dec(spaceEntries.find((e) => e.path === "manifest.json")!.bytes));
    expect(spaceManifest.format).toBe("shuyonote.space");
    expect(spaceChecksums.format).toBe(CHECKSUMS_FORMAT);
    expect(spaceChecksums.algorithm).toBe(CHECKSUMS_ALGORITHM);
    // 用**个人版的校验函数**逐条核企业版空间包的 checksums（真跑一遍，不是只看字段）
    const spaceProblems = await verifyChecksums(
      spaceChecksums,
      spaceEntries.map((e) => ({ path: e.path, bytes: e.bytes })),
    );
    expect(spaceProblems).toEqual([]);
    // 空间包里的嵌套文档：个人版 M1 不做空间导入，但**单文档包必须能读**
    const nested = spaceEntries.find((e) => e.path.endsWith("/document.shuyodoc"));
    expect(nested?.path).toBe("documents/doc-space-fixture-1/document.shuyodoc");
    const r = await openDocumentPackage(await unzipDocument(nested!.bytes));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.pkg.manifest.document_id).toBe("doc-space-fixture-1");
      expect(r.pkg.manifest.title).toBe("空间里的那一篇");
      expect(r.pkg.notices).toEqual([]);
    }
  });

  it("㉒ 企业版包被篡改 / 删掉 checksums 后篡改 ⇒ 点名条目拒绝（⛔ 不静默通过）", async () => {
    const entries = await unzipDocument(fixtureBytes("enterprise-document.shuyodoc"));
    const assetPath = entries.find((e) => e.path.startsWith("assets/"))!.path;
    const tampered = entries.map((e) => (e.path === assetPath ? { ...e, bytes: enc("tampered-bytes") } : e));
    const withChecksums = await openDocumentPackage(tampered);
    expect(withChecksums.ok).toBe(false);
    if (!withChecksums.ok) {
      expect(withChecksums.error).toContain("checksums");
      expect(withChecksums.error).toContain(assetPath);
    }
    // 删掉 checksums ⇒ 完整性只剩 assets 文件名的 sha 自证；照样必须拒绝且点名
    const noChecksums = tampered.filter((e) => e.path !== "checksums.json");
    const byAssetSha = await openDocumentPackage(noChecksums, { allowUnverifiedChecksums: true });
    expect(byAssetSha.ok).toBe(false);
    if (!byAssetSha.ok) expect(byAssetSha.error).toContain("与 sha256 不符");
  });
});

describe("② 个人版 → 企业版：写出物必须逐字对齐企业版口径", () => {
  it("㉓ buildManifest 带全企业版必填字段（字段顺序与取值）", async () => {
    const { manifest } = await buildPersonalPackage({
      assets: [{ bytes: enc("个人版资产"), ext: "txt" }],
    });
    // 前 10 个 key 与企业版 buildDocumentPackage 完全同序；assets 是个人版扩展，排最后
    expect(Object.keys(manifest).slice(0, ENTERPRISE_MANIFEST_KEYS.length)).toEqual(ENTERPRISE_MANIFEST_KEYS);
    expect(Object.keys(manifest)).toEqual([...ENTERPRISE_MANIFEST_KEYS, "assets"]);
    expect(manifest.source).toBe("personal");
    expect(manifest.source_app_version).toBe("2.0.0-interop");
    expect(manifest.document_id).toBe("doc-personal-fixture-1");
    expect(manifest.created_at).toBe("2026-10-29T02:00:00.000Z");
    expect(manifest.updated_at).toBe("2026-10-29T03:00:00.000Z");
    expect(manifest.content_type).toBe(CONTENT_TYPE_LEXICAL);
    expect(manifest.encrypted).toBe(false);
    // 企业版读端忽略未知字段（2026-10-29 实地验过）⇒ assets 这个扩展字段不会让企业版拒包
    expect(manifest.assets).toHaveLength(1);
  });

  it("㉔ buildChecksums 结构与算法逐字照企业版（format/version/algorithm/files，排序、排除自身）", async () => {
    const { checksums, files } = await buildPersonalPackage({
      assets: [{ bytes: enc("b"), ext: "bin" }, { bytes: enc("a"), ext: "txt" }],
    });
    expect(checksums.format).toBe(CHECKSUMS_FORMAT);
    expect(checksums.version).toBe(CHECKSUMS_VERSION);
    expect(checksums.algorithm).toBe(CHECKSUMS_ALGORITHM);
    // 登记「除 checksums.json 自己以外」的每个条目，key 按 localeCompare 排序（企业版 checksumsFor 同口径）
    const expectKeys = files.map((f) => f.path).sort((a, b) => a.localeCompare(b));
    expect(Object.keys(checksums.files)).toEqual(expectKeys);
    expect(Object.keys(checksums.files)).not.toContain("checksums.json");
    for (const f of files) {
      await expect(sha256Hex(f.bytes)).resolves.toBe(checksums.files[f.path]);
    }
    // 值是小写 64 位 hex（sha256 的形状）
    for (const v of Object.values(checksums.files)) expect(v).toMatch(/^[0-9a-f]{64}$/);
  });

  it("㉕ 个人版产出的整包能被个人版读回（zip 真字节，store 模式）", async () => {
    const pkg = await buildPersonalPackage({
      assets: [{ bytes: enc("往返资产"), ext: "txt" }],
      content: { root: { type: "root", children: [{ type: "text", text: "个人版正文" }] } },
    });
    const r = await openDocumentPackage(await unzipDocument(pkg.zip));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pkg.manifest.source).toBe("personal");
    expect(r.pkg.manifest.document_id).toBe("doc-personal-fixture-1");
    expect(r.pkg.assets).toHaveLength(1);
    expect(r.pkg.docJson).toContain("个人版正文");
    expect(r.pkg.notices).toEqual([]);
  });

  it("㉖ checksums 任一不符 ⇒ 整包拒绝并点名条目（登记了没有 / sha 不符 / 没登记）", async () => {
    // (a) 正文被改、checksums 没跟着改 ⇒ 校验失败并点名 content.json
    const base = await buildPersonalPackage();
    const tamperedContent = base.entries.map((e) =>
      e.path === "content.json" ? { ...e, bytes: enc('{"root":{"tampered":true}}') } : e,
    );
    const r1 = await openDocumentPackage(tamperedContent);
    expect(r1.ok).toBe(false);
    if (!r1.ok) {
      expect(r1.error).toContain("校验失败：content.json");
      expect(r1.error).toContain("checksums");
    }

    // (b) checksums 登记了包里没有的文件 ⇒ 点名
    const sums = JSON.parse(dec(base.entries.find((e) => e.path === "checksums.json")!.bytes));
    sums.files["ghost.txt"] = "a".repeat(64);
    const r2 = await openDocumentPackage(
      base.entries.map((e) => (e.path === "checksums.json" ? { ...e, bytes: enc(JSON.stringify(sums)) } : e)),
    );
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toContain("缺文件：ghost.txt");

    // (c) 包里有文件没登记 ⇒ 点名
    const r3 = await openDocumentPackage([...base.entries, { path: "extra.txt", bytes: enc("x") }]);
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.error).toContain("checksums 没登记：extra.txt");
  });
});

describe("③ 向后兼容：旧个人包与不合法 manifest", () => {
  it("㉗ 旧个人包（无 checksums、manifest 无企业版字段）仍可读，并把降级提示如实带出来", async () => {
    const asset = enc("abc");
    const sha = await sha256Hex(asset);
    const legacyManifest = {
      format: DOC_FORMAT,
      format_version: DOC_FORMAT_VERSION,
      title: "旧个人版包",
      created: "2026-10-28T00:00:00.000Z",
      updated: "2026-10-28T01:00:00.000Z",
      assets: [{ path: `assets/${sha}.bin`, sha256: sha, size: asset.byteLength }],
    };
    const entries: ZipEntry[] = [
      { path: "manifest.json", bytes: enc(JSON.stringify(legacyManifest)) },
      { path: "content.json", bytes: enc('{"root":{}}') },
      { path: `assets/${sha}.bin`, bytes: asset },
    ];
    const r = await openDocumentPackage(entries, { allowUnverifiedChecksums: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 缺省值：source/encrypted/content_type 有兼容默认；created_at/updated_at 回填旧字段
    expect(r.pkg.manifest.source).toBe("personal");
    expect(r.pkg.manifest.encrypted).toBe(false);
    expect(r.pkg.manifest.content_type).toBe(CONTENT_TYPE_LEXICAL);
    expect(r.pkg.manifest.document_id).toBeUndefined();
    expect(r.pkg.manifest.created_at).toBe("2026-10-28T00:00:00.000Z");
    expect(r.pkg.manifest.updated_at).toBe("2026-10-28T01:00:00.000Z");
    // ⛔ 缺 checksums 不是静默通过：must 有如实提示
    expect(r.pkg.notices).toHaveLength(1);
    expect(r.pkg.notices[0]).toContain("缺 checksums.json");
    expect(r.pkg.notices[0]).toContain("sha256");
  });

  it("㉘ 企业版字段不合法 ⇒ 整包拒绝（encrypted / content_type / source / assets 形态）", () => {
    const base = { format: DOC_FORMAT, format_version: DOC_FORMAT_VERSION, title: "T" };
    const encrypted = parseManifest({ ...base, encrypted: true });
    expect(encrypted.ok).toBe(false);
    if (!encrypted.ok) expect(encrypted.error).toContain("加密包");

    const contentType = parseManifest({ ...base, content_type: "markdown" });
    expect(contentType.ok).toBe(false);
    if (!contentType.ok) expect(contentType.error).toContain("content_type 不认识");

    const badSource = parseManifest({ ...base, source: 3 });
    expect(badSource.ok).toBe(false);
    if (!badSource.ok) expect(badSource.error).toContain("source");

    const badAssets = parseManifest({ ...base, assets: "nope" });
    expect(badAssets.ok).toBe(false);
    if (!badAssets.ok) expect(badAssets.error).toContain("assets 必须是数组");

    // 写出侧同样不许写「假加密包」
    expect(() =>
      buildManifest({
        documentId: "d",
        title: "T",
        createdAt: "2026-10-29T00:00:00.000Z",
        updatedAt: "2026-10-29T00:00:00.000Z",
        sourceAppVersion: "2.0.0",
        encrypted: true,
      }),
    ).toThrow(/加密包未实现/);
  });

  it("㉙ 旧个人包显式写了 assets（哪怕空数组）⇒ assets/ 下多出来的条目仍按夹带拒绝", async () => {
    // 兼容企业版「manifest 无 assets ⇒ 按内容寻址发现」**不放松**旧包的防夹带：
    // 旧包既然显式声明了清单，清单外的东西一律拒绝（与 2026-10-29 之前的行为一致）。
    const asset = enc("abc");
    const sha = await sha256Hex(asset);
    const entries: ZipEntry[] = [
      {
        path: "manifest.json",
        bytes: enc(
          JSON.stringify({
            format: DOC_FORMAT,
            format_version: DOC_FORMAT_VERSION,
            title: "显式空清单的旧包",
            created: "2026-10-28T00:00:00.000Z",
            updated: "2026-10-28T00:00:00.000Z",
            assets: [],
          }),
        ),
      },
      { path: "content.json", bytes: enc('{"root":{}}') },
      { path: `assets/${sha}.bin`, bytes: asset },
    ];
    const r = await openDocumentPackage(entries, { allowUnverifiedChecksums: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("拒绝夹带");
  });
});
