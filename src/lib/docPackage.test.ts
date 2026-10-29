// `docPackage` 的判据（M1 第一步）：manifest 校验 / 条目路径安全 / 资产自证。
//
// 这些是**导入侧的红线**：任何一条不过，整个包必须被拒（⛔ 不许导一半）。所以每条都要有
// "必须被拒"的用例 —— 它们不是"顺手写的检查"，是对恶意/损坏包的闸门。
import { describe, expect, it } from "vitest";
import {
  DOC_FORMAT,
  DOC_FORMAT_VERSION,
  checkEntryPath,
  checkSizeLimits,
  MAX_FILE_BYTES,
  parseManifest,
  sha256Hex,
  verifyAssets,
} from "./docPackage";

const SHA_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"; // sha256("abc")
const tiny = new TextEncoder().encode("abc");

const goodManifest = (assets: unknown[] = [{ path: `assets/${SHA_ABC}.bin`, sha256: SHA_ABC, size: 3 }]) => ({
  format: DOC_FORMAT,
  format_version: DOC_FORMAT_VERSION,
  title: "周报",
  assets,
});

describe("manifest 校验", () => {
  it("① 正常包通过，资产清单原样读出", () => {
    const r = parseManifest(goodManifest());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.title).toBe("周报");
      expect(r.manifest.assets).toHaveLength(1);
    }
  });

  it("② ⛔ 不是文档包 / 版本未知 ⇒ 拒绝（不猜）", () => {
    const wrongFormat = parseManifest({ ...goodManifest(), format: "shuyonote.space" });
    expect(wrongFormat.ok).toBe(false);
    if (!wrongFormat.ok) expect(wrongFormat.error).toContain("不是文档包");
    const v2 = parseManifest({ ...goodManifest(), format_version: 2 });
    expect(v2.ok).toBe(false);
    if (!v2.ok) expect(v2.error).toContain("版本不认识");
    expect(parseManifest(null).ok).toBe(false);
    expect(parseManifest({ ...goodManifest(), title: "  " }).ok).toBe(false);
  });

  it("③ ⛔ sha256 形状不对 / 路径与 sha 各说各话 ⇒ 拒绝", () => {
    const badSha = parseManifest(goodManifest([{ path: "assets/x.bin", sha256: "abc", size: 1 }]));
    expect(badSha.ok).toBe(false);
    const mismatch = parseManifest(goodManifest([{ path: "assets/0000.bin", sha256: SHA_ABC, size: 3 }]));
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.error).toContain("与 sha256 不一致");
  });
});

describe("条目路径安全（zip-slip 等）", () => {
  it("④ `..` / 绝对路径 / 盘符 / 反斜杠 / 空段 一律拒绝，且原因点名", () => {
    expect(checkEntryPath("../evil.sh")).toContain("zip-slip");
    expect(checkEntryPath("assets/../../etc/passwd")).toContain("zip-slip");
    expect(checkEntryPath("/etc/passwd")).toContain("绝对路径");
    expect(checkEntryPath("C:/Windows/system32")).toContain("盘符");
    expect(checkEntryPath("assets\\a.png")).toContain("反斜杠");
    expect(checkEntryPath("assets//a.png")).toContain("空段");
    expect(checkEntryPath("assets/")).toContain("目录条目");
    expect(checkEntryPath("")).toBeTruthy();
  });

  it("⑤ 正常路径放行", () => {
    expect(checkEntryPath("assets/abc.png")).toBeNull();
    expect(checkEntryPath("content.json")).toBeNull();
  });

  it("⑥ 大小上限：单文件超限 / 整包超限都要拒", () => {
    expect(checkSizeLimits([{ path: "a.bin", size: MAX_FILE_BYTES + 1 }])).toContain("单文件上限");
    const many = Array.from({ length: 5 }, (_, i) => ({ path: `a${i}.bin`, size: MAX_FILE_BYTES }));
    expect(checkSizeLimits(many)).toContain("整包超过上限");
    expect(checkSizeLimits([{ path: "a.bin", size: 1024 }])).toBeNull();
  });
});

describe("资产自证（内容寻址）", () => {
  it("⑦ sha256 与已知向量一致（\"abc\"）", async () => {
    expect(await sha256Hex(tiny)).toBe(SHA_ABC);
  });

  it("⑧ 字节与清单不符 ⇒ 点名那个条目（⛔ 不许当作通过）", async () => {
    const ok = await verifyAssets([{ path: `assets/${SHA_ABC}.bin`, sha256: SHA_ABC, bytes: tiny }]);
    expect(ok).toBeNull();
    const bad = await verifyAssets([{ path: "assets/x.bin", sha256: SHA_ABC, bytes: new TextEncoder().encode("abd") }]);
    expect(bad).toContain("与 sha256 不符");
  });
});
