// ⭐ 样例包夹具的**字节稳定判据**：重新生成 ⇒ 与入库逐字节相等、sha 与 fixtures.json 一致。
// 夹具同时必须能被现有读侧读回（文档包/空间包各用各的读侧，⛔ 不造第二套解包）。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { openDocumentPackage } from "./docPackageOpen";
import { openSpacePackage } from "./docSpacePackOpen";
import { unzipDocument } from "./docZip";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtureDir = join(root, "src/lib/__fixtures__/package-fixtures");
const sha256 = (b: Uint8Array) => createHash("sha256").update(Buffer.from(b)).digest("hex");

const manifest = JSON.parse(readFileSync(join(fixtureDir, "fixtures.json"), "utf8")) as {
  fixtures: { name: string; bytes: number; sha256: string }[];
};

describe("样例包夹具（字节稳定 + 可读回）", () => {
  it("入库文件与 fixtures.json 的 size/sha256 一致", () => {
    expect(manifest.fixtures).toHaveLength(4);
    for (const f of manifest.fixtures) {
      const bytes = readFileSync(join(fixtureDir, f.name));
      expect(bytes.byteLength, f.name).toBe(f.bytes);
      expect(sha256(bytes), f.name).toBe(f.sha256);
    }
  });

  it("重新生成 ⇒ 与入库文件逐字节相等（固定时间戳/顺序；vite 冷启动给 60s）", { timeout: 60000 }, () => {
    const out = mkdtempSync(join(tmpdir(), "shuyo-fixtures-"));
    try {
      execFileSync(process.execPath, ["scripts/make-package-fixtures.mjs", out], { cwd: root, stdio: "pipe" });
      const regenerated = readdirSync(out).filter((n) => n.endsWith(".shuyodoc") || n.endsWith(".shuyospace"));
      expect(regenerated.sort()).toEqual(manifest.fixtures.map((f) => f.name).sort());
      for (const f of manifest.fixtures) {
        expect(Buffer.compare(readFileSync(join(out, f.name)), readFileSync(join(fixtureDir, f.name))), f.name).toBe(0);
      }
      const fresh = JSON.parse(readFileSync(join(out, "fixtures.json"), "utf8"));
      expect(fresh.fixtures).toEqual(manifest.fixtures);
    } finally {
      rmSync(out, { recursive: true, force: true });
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
