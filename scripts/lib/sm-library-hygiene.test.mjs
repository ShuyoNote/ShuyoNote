// `scripts/lib/sm-library-hygiene.mjs` 的判据。
//
// 这一条判据存在的意义：方案 §五「补丁留在共享 registry 上」原先**只有横幅 ＋ 人的纪律**，
// 而它一旦发生，表现是"12＋7 条看不懂的红"（macOS）或"后续默认构建被静默改成 SM4 页"（其它平台）。
// ⇒ 状态要能**只读**读出来、后果要能**判定**，并且这两件事都要有判据钉住。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { decideFromState, platformFromArgv } from "../check-gm-registry-clean.mjs";
import { hygieneVerdict, pageCipherOf, registryStateOf } from "./sm-library-hygiene.mjs";
import { MARKER } from "./sm-library-source.mjs";

const LOCK = `
version = 4

[[package]]
name = "libsqlite3-sys"
version = "0.38.2"
source = "registry+https://github.com/rust-lang/crates.io-index"
`;

const made = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 造一个临时 registry：`Cargo.lock` ＋ 指定版本的 sqlcipher 源码（可带/不带补丁标记）。 */
function fixture({ patched = true, cipher = "EVP_sm4_cbc()" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gm-hygiene-"));
  made.push(dir);
  const lockPath = join(dir, "Cargo.lock");
  writeFileSync(lockPath, LOCK, "utf8");
  const registry = join(dir, "registry");
  const sc = join(registry, "libsqlite3-sys-0.38.2", "sqlcipher");
  mkdirSync(sc, { recursive: true });
  const sqlite3c = join(sc, "sqlite3.c");
  writeFileSync(
    sqlite3c,
    `/* amalgamation */\n#define OPENSSL_CIPHER ${cipher}\n` + (patched ? `/* ${MARKER} */\n` : ""),
    "utf8",
  );
  return { lockPath, roots: [registry], sqlite3c };
}

describe("pageCipherOf：这份源码会编出哪种页加密", () => {
  it("补丁把 OPENSSL_CIPHER 改成 EVP_sm4_cbc() ⇒ sm4；原版 AES ⇒ aes", () => {
    expect(pageCipherOf("#define OPENSSL_CIPHER EVP_sm4_cbc()\n")).toBe("sm4");
    expect(pageCipherOf("#define OPENSSL_CIPHER EVP_aes_256_cbc()\n")).toBe("aes");
  });

  it("★ 读不到那一行 ⇒ `unknown`（宁可说不知道，也别猜成 aes/sm4）", () => {
    expect(pageCipherOf("#define OTHER_THING 1\n")).toBe("unknown");
    expect(pageCipherOf("")).toBe("unknown");
  });
});

describe("hygieneVerdict：三档（纪律 → 断言）", () => {
  it("原版 ⇒ ok", () => {
    const v = hygieneVerdict({ patched: false, platform: "darwin" });
    expect(v.level).toBe("ok");
  });

  it("带补丁 ∧ 这次就是 sm-library 构建 ⇒ ok（那正是要的状态）", () => {
    expect(hygieneVerdict({ patched: true, platform: "darwin", featureSmLibrary: true }).level).toBe("ok");
    expect(hygieneVerdict({ patched: true, platform: "linux", featureSmLibrary: true }).level).toBe("ok");
  });

  it("★ 带补丁 ∧ macOS ∧ 默认构建 ⇒ **block**（那 12＋7 条红＋现场像加密库坏了）", () => {
    const v = hygieneVerdict({ patched: true, pageCipher: "sm4", platform: "darwin", featureSmLibrary: false });
    expect(v.level).toBe("block");
    expect(v.why).toMatch(/CommonCrypto/);
    expect(v.why).toMatch(/--revert/); // 必须给出**可执行**的修法，而不是只说"有风险"
  });

  it("★ 带补丁 ∧ 非 macOS ∧ 默认构建 ⇒ **notice**（不会红，但会被静默改页加密）—— 不许假装它红", () => {
    for (const platform of ["linux", "win32"]) {
      const v = hygieneVerdict({ patched: true, pageCipher: "sm4", platform, featureSmLibrary: false });
      expect(v.level).toBe("notice");
      expect(v.why).toMatch(/静默/);
      expect(v.why).toMatch(/--revert/);
    }
  });
});

describe("registryStateOf：只读地读真磁盘状态", () => {
  it("带标记的源码 ⇒ patched=true、pageCipher=sm4；不带 ⇒ patched=false", () => {
    const on = fixture({ patched: true, cipher: "EVP_sm4_cbc()" });
    const s1 = registryStateOf({ lockPath: on.lockPath, roots: on.roots });
    expect(s1.ok).toBe(true);
    expect(s1).toMatchObject({ patched: true, pageCipher: "sm4", version: "0.38.2" });

    const off = fixture({ patched: false, cipher: "EVP_aes_256_cbc()" });
    const s2 = registryStateOf({ lockPath: off.lockPath, roots: off.roots });
    expect(s2).toMatchObject({ patched: false, pageCipher: "aes" });
  });

  it("★★ **只读**：读一次状态，源码文件逐字节不变（「核一下状态却把状态改了」这类坑，2026-09-22 真踩过）", () => {
    const f = fixture({ patched: false });
    const before = readFileSync(f.sqlite3c);
    registryStateOf({ lockPath: f.lockPath, roots: f.roots });
    const after = readFileSync(f.sqlite3c);
    expect(after.equals(before)).toBe(true);
    // 反向自证：这条判据真的会咬人 —— 手工写一个字，逐字节比对必须发现
    writeFileSync(f.sqlite3c, Buffer.concat([before, Buffer.from("x")]));
    expect(readFileSync(f.sqlite3c).equals(before)).toBe(false);
  });

  it("读不出来 ⇒ `ok:false` 带分类，**不是** ok:true/patched:false（两者不能混）", () => {
    const s = registryStateOf({ lockPath: join(tmpdir(), "根本没这个 lock", "Cargo.lock"), roots: [] });
    expect(s.ok).toBe(false);
    expect(typeof s.reason).toBe("string");
  });
});

describe("decideFromState：门禁的退出码（读不出来**不判红**）", () => {
  const clean = { ok: true, version: "0.38.2", srcDir: "/x", patched: false, pageCipher: "aes" };
  const dirty = { ok: true, version: "0.38.2", srcDir: "/x", patched: true, pageCipher: "sm4" };

  it("★ 读不出来 ⇒ exit 0 ＋ 明说「未实查」（干净机器 / 没 fetch 过 registry 不该被判红）", () => {
    const r = decideFromState({ ok: false, reason: "version-mismatch", message: "registry 里没有锁定的版本" });
    expect(r.code).toBe(0);
    expect(r.level).toBe("notice");
    expect(r.lines.join("\n")).toMatch(/未实查/);
  });

  it("macOS 上留了补丁 ⇒ exit 1；本平台（非 darwin）留了补丁 ⇒ exit 0 但要说清", () => {
    expect(decideFromState(dirty, { platform: "darwin" }).code).toBe(1);
    expect(decideFromState(dirty, { platform: "win32" }).code).toBe(0);
    expect(decideFromState(dirty, { platform: "win32" }).level).toBe("notice");
    expect(decideFromState(clean, { platform: "darwin" }).code).toBe(0);
  });
});

// ★ 这一组是**实测踩出来的**：第一版 `argValue` 只认 `--k v`，于是 `--platform=darwin`
//   被静默忽略 ⇒ 本该 `block` 的场景安静地变成 `notice`（输出看起来一切正常）。
//   这个门禁存在的全部意义就是"不让状态被静静忽略" ⇒ 它自己的参数解析也不许静默降级。
describe("platformFromArgv：参数解析不许静默降级", () => {
  it("★ 两种写法都认：`--platform darwin` 与 `--platform=darwin`", () => {
    expect(platformFromArgv(["--platform", "darwin"], "win32")).toEqual({ platform: "darwin", error: null });
    expect(platformFromArgv(["--platform=darwin"], "win32")).toEqual({ platform: "darwin", error: null });
  });

  it("没给 ⇒ 用本机平台；给了但拼错 ⇒ **报错**（不许当成「非 darwin」降级成 notice）", () => {
    expect(platformFromArgv([], "win32")).toEqual({ platform: "win32", error: null });
    const bad = platformFromArgv(["--platform=dawrin"], "win32");
    expect(bad.error).toMatch(/dawrin/);
    expect(bad.platform).toBe("dawrin"); // 原样返回，便于报错里说清
  });
});
