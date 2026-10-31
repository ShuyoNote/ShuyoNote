// `docPackage` 的判据（M1 第一步）：manifest 校验 / 条目路径安全 / 资产自证。
//
// 这些是**导入侧的红线**：任何一条不过，整个包必须被拒（⛔ 不许导一半）。所以每条都要有
// "必须被拒"的用例 —— 它们不是"顺手写的检查"，是对恶意/损坏包的闸门。
import { describe, expect, it } from "vitest";
import {
  DOC_FORMAT,
  DOC_FORMAT_VERSION,
  KNOWN_FEATURES,
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

// v1.1 `features`（包格式定稿 §1.2）：写侧声明能力，**读侧不认识就拒收并点名**。
// 现场：以前的实现是"记一条 notice 继续打开" —— 那会让旧读端拿残缺语义落库，
// 用户看到"打开成功但内容少了"；规范明确要拒（升级提示才会出现）。
describe("manifest.features 白名单（不认识 ⇒ 拒收并点名）", () => {
  it("⑨ 认识的 features 原样读出（attachments / db-namespace / checksums-self）", () => {
    const r = parseManifest({ ...goodManifest(), features: [...KNOWN_FEATURES] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.features).toEqual([...KNOWN_FEATURES]);
    // 空数组 = 没声明任何扩展（v1 形状），也照常通过
    expect(parseManifest({ ...goodManifest(), features: [] }).ok).toBe(true);
  });

  it("⑩ ⛔ 不认识的 feature ⇒ 整包拒收、点名、带升级提示（E_FEATURE）", () => {
    const r = parseManifest({ ...goodManifest(), features: ["attachments", "quantum-blocks"] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("E_FEATURE");
      expect(r.error).toContain("quantum-blocks");
      expect(r.error).toContain("升级");
      // 认识的那个不该被误报（点名只点不认识的值）
      expect(r.error).not.toContain("「attachments」");
    }
  });

  it("⑪ ⛔ 多个未知 feature 一次点名（⛔ 不许只报第一个就让人反复重试）", () => {
    const r = parseManifest({ ...goodManifest(), features: ["graph-v2", "quantum-blocks"] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("graph-v2");
      expect(r.error).toContain("quantum-blocks");
    }
  });

  it("⑫ features 形状不对仍按旧口径拒（不是字符串数组）", () => {
    expect(parseManifest({ ...goodManifest(), features: "attachments" }).ok).toBe(false);
    expect(parseManifest({ ...goodManifest(), features: [3] }).ok).toBe(false);
  });
});
