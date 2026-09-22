// `scripts/sign-macos-app.mjs` 的判据。
//
// 为什么值得单独判：这一步是 P4「签名/公证」那格的**可做部分**，而它的失败形态全是"看起来做了"——
//   · **漏签嵌套库**（判据说"签完了"，其实一个嵌套二进制都没签）—— 我在写第一版时真的踩了：
//     `isMachO` 只认单架构魔数，而 `libpdfium.dylib` 是 **universal（fat）** ⇒ 被判成"不是 Mach-O"。
//   · **顺序反了**（先签外层、再签里层）：`--verify --deep --strict` 会红，而"签名那一步没报错"。
// 所以：魔数夹具里必须有 **fat**，顺序判据必须真的能抓住"由内到外"。

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { isMachO, signOutcome, signingOrder } from "./sign-macos-app.mjs";

const dirs = [];
function magicFile(name, bytes) {
  const dir = mkdtempSync(join(tmpdir(), "sign-macos-test-"));
  dirs.push(dir);
  const p = join(dir, name);
  writeFileSync(p, Buffer.from(bytes));
  return p;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("sign-macos-app：什么算 Mach-O（漏了 fat 就会静默漏签）", () => {
  it("★ universal（fat，`cafebabe`）**必须**算 —— 漏了它 ⇒ 嵌套库一个都不签（真实事故）", () => {
    // 真实产物就是这样：libpdfium.dylib 是 x86_64＋arm64 的 fat
    expect(isMachO(magicFile("fat.dylib", [0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2]))).toBe(true);
  });

  it("单架构 64 位（`cffaedfe`，little-endian）也算 —— 主可执行文件与 helper 是这种", () => {
    expect(isMachO(magicFile("thin", [0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01]))).toBe(true);
  });

  it("普通文本 / 太短的文件 ⇒ 不算（否则会把 README、plist 也拿去签）", () => {
    expect(isMachO(magicFile("readme.txt", [...Buffer.from("hello world, not a mach-o")]))).toBe(false);
    expect(isMachO(magicFile("short", [0xca, 0xfe]))).toBe(false);
  });
});

describe("sign-macos-app：签名顺序（Apple 要求由内到外）", () => {
  it("★ 更深的先签（嵌套 dylib／helper 先于同层文件）", () => {
    const order = signingOrder([
      "Contents/MacOS/helper",
      "Contents/Frameworks/sub/nested.dylib",
      "Contents/Frameworks/libpdfium.dylib",
    ]);
    expect(order[0]).toBe("Contents/Frameworks/sub/nested.dylib");
    expect(order.indexOf("Contents/Frameworks/libpdfium.dylib")).toBeLessThan(order.indexOf("Contents/MacOS/helper"));
  });

  it("主可执行文件**不进**这个清单（它由最后「签整个 bundle」那一步覆盖）", () => {
    const order = signingOrder(["Contents/MacOS/shuyonote", "Contents/Frameworks/libpdfium.dylib"], "Contents/MacOS/shuyonote");
    expect(order).toEqual(["Contents/Frameworks/libpdfium.dylib"]);
  });

  it("同一层按路径排序 ⇒ 顺序可复现（别依赖 readdir 的顺序）", () => {
    const a = signingOrder(["Contents/Frameworks/b.dylib", "Contents/Frameworks/a.dylib"]);
    const b = signingOrder(["Contents/Frameworks/a.dylib", "Contents/Frameworks/b.dylib"]);
    expect(a).toEqual(b);
    expect(a).toEqual(["Contents/Frameworks/a.dylib", "Contents/Frameworks/b.dylib"]);
  });
});

describe("sign-macos-app：判定（空 problems 才算过）", () => {
  const ok = {
    preSignIdentical: true,
    libSha: "a".repeat(64),
    vendorSha: "a".repeat(64),
    verifyDeepStrictPassed: true,
    verifyOutput: "",
    signedCount: 1,
  };

  it("签前一致 ＋ 签了 ≥1 个 ＋ `--deep --strict` 通过 ⇒ 通过", () => {
    expect(signOutcome(ok)).toEqual([]);
  });

  it("★ 签**之前**包内与 vendor 不一致 ⇒ 报错（并指向拷贝那一步，别在签名上找原因）", () => {
    const p = signOutcome({ ...ok, preSignIdentical: false, libSha: "b".repeat(64) }).join();
    expect(p).toMatch(/签名\*\*之前\*\*/);
    expect(p).toMatch(/tauri\.macos\.conf\.json/);
  });

  it("★ 一个嵌套二进制都没找到 ⇒ 报错（否则「签完了」其实是没签）", () => {
    expect(signOutcome({ ...ok, signedCount: 0 }).join()).toMatch(/一个嵌套二进制都没找到/);
  });

  it("`--verify --deep --strict` 不过 ⇒ 报错并**带上原文**（否则没人知道是哪种不过）", () => {
    const p = signOutcome({ ...ok, verifyDeepStrictPassed: false, verifyOutput: "code has no resources but signature indicates they must be present" }).join();
    expect(p).toMatch(/code has no resources/);
  });
});
