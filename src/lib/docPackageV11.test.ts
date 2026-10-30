// ⭐ M1.1（按包格式定稿 §9 企业版裁决）判据：manifest 可选字段 / checksums 默认拒 / 嵌套包 /
// 未知条目必须登记 / db 命名空间透传 / 写侧硬拒。期望错误码按规范 §4。
import { describe, expect, it } from "vitest";
import {
  CHECKSUMS_PATH,
  DOC_FORMAT,
  DOC_FORMAT_VERSION,
  buildChecksums,
  checkWritePaths,
  type PackageFile,
} from "./docPackage";
import { openDocumentPackage, type ZipEntry } from "./docPackageOpen";

const enc = (s: string) => new TextEncoder().encode(s);

function manifest(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    format: DOC_FORMAT,
    format_version: DOC_FORMAT_VERSION,
    title: "周报",
    ...extra,
  });
}

async function pack(extraManifest: Record<string, unknown> = {}, extra: ZipEntry[] = []): Promise<ZipEntry[]> {
  const base: ZipEntry[] = [
    { path: "manifest.json", bytes: enc(manifest(extraManifest)) },
    { path: "content.json", bytes: enc(JSON.stringify({ root: { children: [] } })) },
    ...extra,
  ];
  const sums = await buildChecksums(
    base.map((e) => ({ path: e.path, bytes: new TextDecoder().decode(e.bytes) })),
  );
  return [...base, { path: CHECKSUMS_PATH, bytes: enc(JSON.stringify(sums)) }];
}

describe("M1.1 · 读侧（§9）", () => {
  it("min_reader_version > 1.1 ⇒ 拒收并提示升级（E_VERSION）", async () => {
    const r = await openDocumentPackage(await pack({ min_reader_version: "2.0" }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("E_VERSION");
      expect(r.error).toContain("升级");
    }
  });

  it("缺 checksums.json ⇒ 默认拒（E_IO_CHECKSUMS）；allowUnverifiedChecksums:true 才继续并记 warning", async () => {
    const entries = (await pack()).filter((e) => e.path !== CHECKSUMS_PATH);
    const denied = await openDocumentPackage(entries);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error).toContain("E_IO_CHECKSUMS");
    const allowed = await openDocumentPackage(entries, { allowUnverifiedChecksums: true });
    expect(allowed.ok).toBe(true);
    if (allowed.ok) {
      expect(allowed.pkg.notices.join("\n")).toContain("allowUnverifiedChecksums");
    }
  });

  it("manifest.checksums_sha256 存在也不验（v1.1）", async () => {
    const r = await openDocumentPackage(await pack({ checksums_sha256: "0".repeat(64) }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.pkg.notices.join("\n")).toContain("存在也不验");
    }
  });

  it("内层再嵌 zip/shuyodoc ⇒ 硬拒（E_ZIP_STRUCTURE）", async () => {
    for (const name of ["inner.zip", "nested/other.shuyodoc"]) {
      const entries = [...(await pack()), { path: name, bytes: enc("PK") }];
      // 未知条目先被 checksums 拦；这里显式把它登记进 checksums 以证明**嵌套**规则自己拦
      const base = entries.filter((e) => e.path !== CHECKSUMS_PATH);
      const sums = await buildChecksums(base.map((e) => ({ path: e.path, bytes: new TextDecoder().decode(e.bytes) })));
      const r = await openDocumentPackage([...base, { path: CHECKSUMS_PATH, bytes: enc(JSON.stringify(sums)) }]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("E_ZIP_STRUCTURE");
    }
  });

  it("未知条目：登记进 checksums ⇒ 允许并记 notice（不理解也保留）", async () => {
    const r = await openDocumentPackage(
      await pack({}, [{ path: "extensions/x.bin", bytes: enc("x") }]),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pkg.notices.join("\n")).toContain("未知条目");
  });

  it("重复条目名 ⇒ 拒收", async () => {
    const r = await openDocumentPackage([...(await pack()), { path: "content.json", bytes: enc("{}") }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("出现了两次");
  });

  it("content 根上的 db 命名空间原样带回（dbJson）", async () => {
    const entries = (await pack()).map((e) =>
      e.path === "content.json"
        ? { path: e.path, bytes: enc(JSON.stringify({ root: { children: [] }, db: { tables: [{ id: "t1" }] } })) }
        : e,
    );
    const base = entries.filter((e) => e.path !== CHECKSUMS_PATH);
    const sums = await buildChecksums(base.map((e) => ({ path: e.path, bytes: new TextDecoder().decode(e.bytes) })));
    const r = await openDocumentPackage([...base, { path: CHECKSUMS_PATH, bytes: enc(JSON.stringify(sums)) }]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.pkg.dbJson).not.toBeNull();
      expect(JSON.parse(r.pkg.dbJson!)).toEqual({ tables: [{ id: "t1" }] });
    }
  });
});

describe("M1.1 · 写侧硬拒（§9 S8）", () => {
  const files = (paths: string[]): PackageFile[] => paths.map((path) => ({ path, bytes: "" }));
  it("非 NFC 规范化 / 大小写冲突 / 尾点尾空格 / 资产扩展名非小写 ⇒ 各自拒绝", () => {
    expect(checkWritePaths(files(["assets/a\u0301.bin"]))).toContain("NFC");
    expect(checkWritePaths(files(["A.txt", "a.txt"]))).toContain("大小写");
    expect(checkWritePaths(files(["assets/dir./x.bin"]))).toContain("结尾");
    expect(checkWritePaths(files(["assets/abc.TXT"]))).toContain("扩展名必须小写");
    expect(checkWritePaths(files(["assets/abc.txt", "content.json"]))).toBeNull();
  });
});
