// `openDocumentPackage` 的判据：正常包通过，缺/多/重复/sha 不符/路径恶意 一律**整包拒绝**。
import { describe, expect, it } from "vitest";
import { CHECKSUMS_PATH, DOC_FORMAT, DOC_FORMAT_VERSION, buildChecksums } from "./docPackage";
import { openDocumentPackage, type ZipEntry } from "./docPackageOpen";

const enc = (s: string) => new TextEncoder().encode(s);
const SHA_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

const manifest = (assets: unknown[]) =>
  JSON.stringify({ format: DOC_FORMAT, format_version: DOC_FORMAT_VERSION, title: "周报", assets });

async function withSums(entries: ZipEntry[]): Promise<ZipEntry[]> {
  const base = entries.filter((e) => e.path !== CHECKSUMS_PATH);
  const sums = await buildChecksums(
    base.map((e) => ({ path: e.path, bytes: new TextDecoder().decode(e.bytes) })),
  );
  return [...base, { path: CHECKSUMS_PATH, bytes: enc(JSON.stringify(sums)) }];
}

async function goodEntries(): Promise<ZipEntry[]> {
  const asset = enc("abc");
  return withSums([
    { path: "manifest.json", bytes: enc(manifest([{ path: `assets/${SHA_ABC}.bin`, sha256: SHA_ABC, size: 3 }])) },
    { path: "content.json", bytes: enc(JSON.stringify({ root: { children: [] } })) },
    { path: `assets/${SHA_ABC}.bin`, bytes: asset },
  ]);
}

const content = { path: "content.json", bytes: enc(JSON.stringify({ root: {} })) };

describe("打开 .shuyodoc（整包完整性）", () => {
  it("① 正常包：返回清单、正文与资产", async () => {
    const r = await openDocumentPackage(await goodEntries());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.pkg.manifest.title).toBe("周报");
      expect(r.pkg.assets).toHaveLength(1);
      expect(r.pkg.docJson).toContain("root");
    }
  });

  it("② ⛔ 没有 manifest / 版本未知 / content 不是 JSON ⇒ 拒绝", async () => {
    const noManifest = (await goodEntries()).filter((e) => e.path !== "manifest.json");
    expect((await openDocumentPackage(noManifest)).ok).toBe(false);

    const entries = await goodEntries();
    entries[0] = { path: "manifest.json", bytes: enc(manifest([]).replace('"format_version":1', '"format_version":2')) };
    const v2 = await openDocumentPackage(entries);
    expect(v2.ok).toBe(false);
    if (!v2.ok) expect(v2.error).toContain("版本不认识");

    const badContent = await withSums((await goodEntries()).map((e) => (e.path === "content.json" ? { ...e, bytes: enc("{oops") } : e)));
    const bad = await openDocumentPackage(badContent);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("content.json 不是合法 JSON");
  });

  it("③ ⛔ 清单列了资产但包里没带 ⇒ 拒绝（不许悄悄缺图）", async () => {
    const entries = (await goodEntries()).filter((e) => !e.path.startsWith("assets/"));
    const r = await openDocumentPackage(entries);
    expect(r.ok).toBe(false);
  });

  it("④ ⛔ 包里夹带清单外的条目 / 同路径出现两次 ⇒ 拒绝", async () => {
    const smuggled = [...(await goodEntries()), { path: "evil.sh", bytes: enc("rm -rf /") }];
    const s = await openDocumentPackage(smuggled, { allowUnverifiedChecksums: true });
    expect(s.ok).toBe(false);
    if (!s.ok) expect(s.error).toMatch(/拒绝夹带|没登记/);

    const dup = [...(await goodEntries()), content];
    const d = await openDocumentPackage(dup);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.error).toContain("出现了两次");
  });

  it("⑤ ⛔ 资产字节与 sha 不符 ⇒ 拒绝并点名", async () => {
    const entries = await withSums(
      (await goodEntries()).map((e) => (e.path.startsWith("assets/") ? { ...e, bytes: enc("abd") } : e)),
    );
    const r = await openDocumentPackage(entries);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("与 sha256 不符");
  });

  it("⑥ ⛔ zip-slip 条目 ⇒ 拒绝（先于任何读取）", async () => {
    const entries = [...(await goodEntries()), { path: "../evil.txt", bytes: enc("x") }];
    const r = await openDocumentPackage(entries);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("zip-slip");
  });

  it("⑦ 正文里的块结构原样带回（往返前提：不解析、不改写）", async () => {
    const rich = { root: { type: "root", children: [{ type: "paragraph", children: [{ type: "text", text: "你好" }] }] } };
    const entries = await withSums(
      (await goodEntries()).map((e) => (e.path === "content.json" ? { ...e, bytes: enc(JSON.stringify(rich)) } : e)),
    );
    const r = await openDocumentPackage(entries);
    expect(r.ok).toBe(true);
    if (r.ok) expect(JSON.parse(r.pkg.docJson)).toEqual(rich);
  });

  it("⑧ v1.1 features：认识的照常打开；不认识 ⇒ 整包拒收并点名（E_FEATURE，提示升级）", async () => {
    const withFeatures = async (features: unknown): Promise<ZipEntry[]> =>
      withSums([
        {
          path: "manifest.json",
          bytes: enc(
            JSON.stringify({ format: DOC_FORMAT, format_version: DOC_FORMAT_VERSION, title: "周报", assets: [], features }),
          ),
        },
        { path: "content.json", bytes: enc(JSON.stringify({ root: { children: [] } })) },
      ]);

    // 认识的（v1.1 白名单）⇒ 放行，manifest 里能看到声明
    const known = await openDocumentPackage(await withFeatures(["attachments", "checksums-self"]));
    expect(known.ok).toBe(true);
    if (known.ok) expect(known.pkg.manifest.features).toEqual(["attachments", "checksums-self"]);

    // 不认识的 ⇒ 拒收、点名那个值、带升级提示（⛔ 不是"记 notice 继续"）
    const unknown = await openDocumentPackage(await withFeatures(["checksums-self", "graph-v2"]));
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.error).toContain("E_FEATURE");
      expect(unknown.error).toContain("graph-v2");
      expect(unknown.error).toContain("升级");
    }
  });
});
