import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { blake2b512 } from "./blake2b512.mjs";
import {
  ANDROID_PLATFORM_KEY,
  androidApkProblems,
  coverageProblems,
  extensionOf,
  manifestPicks,
  parseMinisignPublicKey,
  parseMinisignSignature,
  platformKeyFor,
  platformKeysFor,
  selectArtifacts,
  validateManifest,
  verifyArtifactSignature,
  versionMatcher,
} from "./releaseArtifacts.mjs";

const entry = (dir, name, extra = {}) => ({
  dir,
  name,
  size: 1024,
  mtimeMs: Date.parse("2026-09-10T06:20:00Z"),
  sigPath: `/tmp/${name}.sig`,
  sigText: "sig",
  ...extra,
});

describe("versionMatcher（版本号必须整词匹配）", () => {
  const re = versionMatcher("1.84.6");

  it("认得正常产物名", () => {
    expect(re.test("ShuyoNote_1.84.6_x64-setup.exe")).toBe(true);
    expect(re.test("ShuyoNote_1.84.6_amd64.deb")).toBe(true);
    expect(re.test("ShuyoNote_1.84.6-beta_x64-setup.exe")).toBe(true);
  });

  it("不会被相邻数字骗到（旧实现的子串匹配会误纳）", () => {
    expect(re.test("ShuyoNote_1.84.60_x64-setup.exe")).toBe(false);
    expect(re.test("ShuyoNote_11.84.6_x64-setup.exe")).toBe(false);
    expect(re.test("ShuyoNote_1.84.61_amd64.deb")).toBe(false);
  });
});

describe("platformKeyFor", () => {
  it("映射到更新器清单的平台键", () => {
    expect(platformKeyFor("ShuyoNote_1.84.6_x64-setup.exe")).toBe("windows-x86_64");
    expect(platformKeyFor("ShuyoNote_1.84.6_amd64.deb")).toBe("linux-x86_64");
    expect(platformKeyFor("ShuyoNote_1.84.6_amd64.AppImage")).toBe("linux-x86_64");
    expect(platformKeyFor("ShuyoNote_1.84.6_aarch64.dmg")).toBe("darwin-aarch64");
    expect(platformKeyFor("readme.txt")).toBeNull();
  });

  it("apk → android-aarch64（**不新开顶层键**，放进 platforms 里）", () => {
    const apk = "ShuyoNote_1.84.6_andro" + "id-arm64-release.apk";
    expect(platformKeyFor(apk)).toBe(ANDROID_PLATFORM_KEY);
    expect(extensionOf(apk)).toBe("apk");
  });

  it("非 arm64 的 apk 不进这个通道（目前只出 arm64-v8a）", () => {
    const apk = "ShuyoNote_1.84.6_andro" + "id-armv7-release.apk";
    expect(platformKeyFor(apk)).toBeNull();
  });

  it("macOS：x64 / aarch64 / universal 三种 dmg 的归属", () => {
    // x64 与 aarch64 各归各的键
    expect(platformKeyFor("ShuyoNote_1.84.6_x64.dmg")).toBe("darwin-x86_64");
    expect(platformKeyFor("ShuyoNote_1.84.6_aarch64.dmg")).toBe("darwin-aarch64");
    // ⚠️ universal 同时占**两个**键：只归 darwin-x86_64 的话，
    // 清单里就没有 darwin-aarch64 ⇒ Apple Silicon 用户收不到任何 macOS 更新（且不报错）。
    expect(platformKeysFor("ShuyoNote_1.84.6_universal.dmg")).toEqual(["darwin-aarch64", "darwin-x86_64"]);
    // 主键沿用旧口径（数组第一个），别把老调用点的语义改了
    expect(platformKeyFor("ShuyoNote_1.84.6_universal.dmg")).toBe("darwin-aarch64");
  });

  it("macOS：没有 dmg 就没有任何 darwin 键（别凭空造键）", () => {
    expect(platformKeysFor("ShuyoNote_1.84.6_x64-setup.exe")).toEqual(["windows-x86_64"]);
    expect(platformKeysFor("readme.txt")).toEqual([]);
  });
});

describe("selectArtifacts", () => {
  it("正常挑出本版本产物", () => {
    const { picked, problems } = selectArtifacts({
      version: "1.84.6",
      entries: [
        entry("nsis", "ShuyoNote_1.84.6_x64-setup.exe"),
        entry("deb", "ShuyoNote_1.84.6_amd64.deb"),
        entry("appimage", "ShuyoNote_1.84.6_amd64.AppImage"),
        entry("nsis", "ShuyoNote_1.84.5_x64-setup.exe"), // 旧版本，忽略
        entry("appimage", "ShuyoNote.AppDir"), // 中间产物，忽略
      ],
    });
    expect(problems).toEqual([]);
    expect(picked.map((e) => e.name).sort()).toEqual([
      "ShuyoNote_1.84.6_amd64.AppImage",
      "ShuyoNote_1.84.6_amd64.deb",
      "ShuyoNote_1.84.6_x64-setup.exe",
    ]);
  });

  it("同平台同扩展名的多个候选 → 报错而不是随便挑一个", () => {
    const { problems } = selectArtifacts({
      version: "1.84.6",
      entries: [
        entry("nsis", "ShuyoNote_1.84.6_x64-setup.exe", { size: 100 }),
        entry("nsis", "ShuyoNote_1.84.6_x64-setup (1).exe", { size: 200 }),
      ],
    });
    expect(problems.join()).toMatch(/有 2 个同类候选/);
  });

  it("同平台不同扩展名（deb + AppImage）不算歧义：两个都发", () => {
    const { picked, problems } = selectArtifacts({
      version: "1.84.6",
      entries: [entry("deb", "ShuyoNote_1.84.6_amd64.deb"), entry("appimage", "ShuyoNote_1.84.6_amd64.AppImage")],
    });
    expect(problems).toEqual([]);
    expect(picked).toHaveLength(2);
  });

  it("缺 .sig → 硬错误（旧实现只 warn 后静默丢弃），签名空 → 同样报错", () => {
    const noSig = selectArtifacts({
      version: "1.84.6",
      entries: [entry("nsis", "ShuyoNote_1.84.6_x64-setup.exe", { sigPath: null, sigText: null })],
    });
    expect(noSig.problems.join()).toMatch(/缺签名文件/);
    const emptySig = selectArtifacts({
      version: "1.84.6",
      entries: [entry("nsis", "ShuyoNote_1.84.6_x64-setup.exe", { sigText: "  " })],
    });
    expect(emptySig.problems.join()).toMatch(/签名文件为空/);
  });

  it("一个产物都没有 → 报错", () => {
    const { picked, problems } = selectArtifacts({ version: "1.84.6", entries: [] });
    expect(picked).toEqual([]);
    expect(problems.join()).toMatch(/未找到任何属于 v1\.84\.6/);
  });

  it("apk 免 `.sig`（签名在包内，由 apksigner 打、系统安装器强制校验）", () => {
    const apkName = "ShuyoNote_1.84.6_andro" + "id-arm64-release.apk";
    const { picked, problems } = selectArtifacts({
      version: "1.84.6",
      entries: [entry("nsis", apkName, { sigPath: null, sigText: null })],
    });
    expect(problems).toEqual([]);
    expect(picked.map((e) => e.name)).toEqual([apkName]);
  });

  it("桌面产物仍然**必须**有 `.sig`（apk 的例外不许扩散）", () => {
    const { problems } = selectArtifacts({
      version: "1.84.6",
      entries: [
        entry("nsis", "ShuyoNote_1.84.6_x64-setup.exe", { sigPath: null, sigText: null }),
        entry("nsis", "ShuyoNote_1.84.6_andro" + "id-arm64-release.apk", { sigPath: null, sigText: null }),
      ],
    });
    expect(problems.join()).toMatch(/缺签名文件：ShuyoNote_1\.84\.6_x64-setup\.exe\.sig/);
    expect(problems.join()).not.toMatch(/apk/);
  });

  it("--artifacts 显式指定时不再依赖版本号启发式", () => {
    const entries = [entry("nsis", "ShuyoNote_1.84.6_x64-setup.exe"), entry("deb", "ShuyoNote_1.84.6_amd64.deb")];
    const { picked, problems, warnings } = selectArtifacts({
      version: "1.84.6",
      entries,
      explicit: ["ShuyoNote_1.84.6_x64-setup.exe"],
    });
    expect(problems).toEqual([]);
    expect(warnings).toEqual([]);
    expect(picked.map((e) => e.name)).toEqual(["ShuyoNote_1.84.6_x64-setup.exe"]);
  });

  it("--artifacts 指定了不存在的产物 → 报错（不静默少发）", () => {
    const { problems } = selectArtifacts({ version: "1.84.6", entries: [], explicit: ["ShuyoNote_1.84.6_x64-setup.exe"] });
    expect(problems.join()).toMatch(/显式指定的产物不存在/);
  });

  it("--artifacts 指定了文件名不含版本号的产物 → 警告（可能是跨版本误发）", () => {
    const { warnings } = selectArtifacts({
      version: "1.84.6",
      entries: [entry("nsis", "ShuyoNote_setup.exe")],
      explicit: ["ShuyoNote_setup.exe"],
    });
    expect(warnings.join()).toMatch(/不含版本号/);
  });
});

describe("manifestPicks（清单在同一平台键下只能留一个，取哪个必须可预期）", () => {
  it("linux 同时有 deb 与 AppImage → 清单指向 deb（沿用线上既有约定），并给出说明", () => {
    const { picks, notes } = manifestPicks([
      entry("appimage", "ShuyoNote_1.84.6_amd64.AppImage"),
      entry("deb", "ShuyoNote_1.84.6_amd64.deb"),
      entry("nsis", "ShuyoNote_1.84.6_x64-setup.exe"),
    ]);
    expect(picks.get("linux-x86_64").name).toBe("ShuyoNote_1.84.6_amd64.deb");
    expect(picks.get("windows-x86_64").name).toBe("ShuyoNote_1.84.6_x64-setup.exe");
    expect(notes.join()).toMatch(/清单指向 ShuyoNote_1\.84\.6_amd64\.deb/);
  });

  it("结果与遍历顺序无关", () => {
    const entries = [entry("deb", "ShuyoNote_1.84.6_amd64.deb"), entry("appimage", "ShuyoNote_1.84.6_amd64.AppImage")];
    const a = manifestPicks(entries).picks.get("linux-x86_64").name;
    const b = manifestPicks([...entries].reverse()).picks.get("linux-x86_64").name;
    expect(a).toBe(b);
  });

  it("macOS universal dmg → **两个** darwin 键都指向它（否则 Apple Silicon 收不到更新）", () => {
    const universal = "ShuyoNote_1.84.6_universal.dmg";
    const { picks } = manifestPicks([entry("dmg", universal)]);
    expect(picks.get("darwin-aarch64")?.name).toBe(universal);
    expect(picks.get("darwin-x86_64")?.name).toBe(universal);
    // 只有一个 dmg 时不该凭空多出别的平台键
    expect([...picks.keys()].sort()).toEqual(["darwin-aarch64", "darwin-x86_64"]);
  });

  it("macOS 分别出 x64 与 aarch64 时各归各的键", () => {
    const { picks } = manifestPicks([entry("dmg", "ShuyoNote_1.84.6_x64.dmg"), entry("dmg", "ShuyoNote_1.84.6_aarch64.dmg")]);
    expect(picks.get("darwin-x86_64").name).toBe("ShuyoNote_1.84.6_x64.dmg");
    expect(picks.get("darwin-aarch64").name).toBe("ShuyoNote_1.84.6_aarch64.dmg");
  });

  it("apk 进 android-aarch64，且**不影响**三个桌面键", () => {
    const apkName = "ShuyoNote_1.84.6_andro" + "id-arm64-release.apk";
    const { picks } = manifestPicks([
      entry("nsis", "ShuyoNote_1.84.6_x64-setup.exe"),
      entry("deb", "ShuyoNote_1.84.6_amd64.deb"),
      entry("dmg", "ShuyoNote_1.84.6_aarch64.dmg"),
      entry("nsis", apkName, { sigPath: null, sigText: null }),
    ]);
    expect([...picks.keys()].sort()).toEqual(["android-aarch64", "darwin-aarch64", "linux-x86_64", "windows-x86_64"]);
    expect(picks.get(ANDROID_PLATFORM_KEY).name).toBe(apkName);
  });
});

describe("macOS 更新通道（清单必须指向 .app.tar.gz，不是 dmg）", () => {
  const macEntries = () => [entry("dmg", "ShuyoNote_1.84.6_aarch64.dmg"), entry("macos", "ShuyoNote.app.tar.gz")];

  it("platformKeyFor：名字里带架构就用，不带则返回 null（交给同批 dmg 推）", () => {
    expect(platformKeyFor("ShuyoNote.app.tar.gz")).toBeNull(); // tauri 生成的正是这个名字
    expect(platformKeyFor("ShuyoNote_aarch64.app.tar.gz")).toBe("darwin-aarch64");
    expect(platformKeyFor("ShuyoNote_x64.app.tar.gz")).toBe("darwin-x86_64");
    expect(extensionOf("ShuyoNote.app.tar.gz")).toBe("app.tar.gz");
  });

  it(".app.tar.gz 不带版本号，但同批有本版本 dmg 作证 → 照样收下，且与 dmg 并存不冲突", () => {
    const { picked, problems } = selectArtifacts({ version: "1.84.6", entries: macEntries() });
    expect(problems).toEqual([]);
    expect(picked.map((e) => e.name).sort()).toEqual(["ShuyoNote.app.tar.gz", "ShuyoNote_1.84.6_aarch64.dmg"]);
  });

  it("**清单里 darwin 指向 .app.tar.gz**（dmg 依旧发布，只是不进清单）", () => {
    const { picked } = selectArtifacts({ version: "1.84.6", entries: macEntries() });
    const { picks, notes } = manifestPicks(picked);
    expect(picks.get("darwin-aarch64").name).toBe("ShuyoNote.app.tar.gz");
    expect(notes.join()).toMatch(/清单指向 ShuyoNote\.app\.tar\.gz/);
  });

  it("universal 的 dmg 同时占两个 darwin 键（只占一个 ⇒ 另一架构静默收不到更新）", () => {
    expect(platformKeysFor("ShuyoNote_1.84.6_universal.dmg")).toEqual(["darwin-aarch64", "darwin-x86_64"]);
    expect(platformKeyFor("ShuyoNote_1.84.6_universal.dmg")).toBe("darwin-aarch64"); // 主键仍是第一个
    expect(platformKeysFor("ShuyoNote_1.84.6_aarch64.dmg")).toEqual(["darwin-aarch64"]);
    expect(platformKeysFor("ShuyoNote_1.84.6_x64.dmg")).toEqual(["darwin-x86_64"]);
  });

  it("**universal 构建**：一个 .app.tar.gz 跟着 dmg 一起占两个键，清单两个键指向同一个文件", () => {
    const entries = [entry("dmg", "ShuyoNote_1.84.6_universal.dmg"), entry("macos", "ShuyoNote.app.tar.gz")];
    const { picked, problems } = selectArtifacts({ version: "1.84.6", entries });
    expect(problems).toEqual([]); // 不许因为"两个键"就报错
    const { picks } = manifestPicks(picked);
    expect([...picks.keys()].sort()).toEqual(["darwin-aarch64", "darwin-x86_64"]);
    expect(picks.get("darwin-aarch64").name).toBe("ShuyoNote.app.tar.gz");
    expect(picks.get("darwin-x86_64").name).toBe("ShuyoNote.app.tar.gz");
  });

  it("universal 的 dmg 若**漏了** .app.tar.gz，两个键都要报缺（不是只报一个）", () => {
    const { problems } = selectArtifacts({
      version: "1.84.6",
      entries: [entry("dmg", "ShuyoNote_1.84.6_universal.dmg")],
    });
    expect(problems.filter((p) => /缺少 macOS 更新通道产物/.test(p))).toHaveLength(2);
    expect(problems.join()).toMatch(/darwin-aarch64/);
    expect(problems.join()).toMatch(/darwin-x86_64/);
  });

  it("分别出了 aarch64 与 x64 两个 dmg、却只有一个不带架构的 .app.tar.gz → 报错不猜", () => {
    const { problems } = selectArtifacts({
      version: "1.84.6",
      entries: [
        entry("dmg", "ShuyoNote_1.84.6_aarch64.dmg"),
        entry("dmg", "ShuyoNote_1.84.6_x64.dmg"),
        entry("macos", "ShuyoNote.app.tar.gz"),
      ],
    });
    expect(problems.join()).toMatch(/无法判定 ShuyoNote\.app\.tar\.gz 属于哪个 macOS 架构/);
  });

  it("**只有 dmg、没有 .app.tar.gz → 硬失败**（否则 mac 上「能下载、装不上」）", () => {
    const { problems } = selectArtifacts({
      version: "1.84.6",
      entries: [entry("dmg", "ShuyoNote_1.84.6_aarch64.dmg")],
    });
    expect(problems.join()).toMatch(/缺少 macOS 更新通道产物/);
    expect(problems.join()).toMatch(/darwin-aarch64/);
  });

  it("`.app.tar.gz` 存在但没有本版本 dmg 佐证 → 跳过并警告（不发来路不明的更新包）", () => {
    const { picked, warnings, problems } = selectArtifacts({
      version: "1.84.6",
      entries: [entry("macos", "ShuyoNote.app.tar.gz"), entry("nsis", "ShuyoNote_1.84.6_x64-setup.exe")],
    });
    expect(problems).toEqual([]);
    expect(picked.map((e) => e.name)).toEqual(["ShuyoNote_1.84.6_x64-setup.exe"]);
    expect(warnings.join()).toMatch(/不带版本号/);
  });

  it("bundle 里的 `.app`（目录）不会被当成产物", () => {
    const { picked } = selectArtifacts({
      version: "1.84.6",
      entries: [...macEntries(), entry("macos", "ShuyoNote.app")],
    });
    expect(picked.map((e) => e.name)).not.toContain("ShuyoNote.app");
  });

  it("一次构建里出现两个 dmg（aarch64 + x86_64）时，架构无法判定 → 报错而不是猜", () => {
    const { problems } = selectArtifacts({
      version: "1.84.6",
      entries: [
        entry("dmg", "ShuyoNote_1.84.6_aarch64.dmg"),
        entry("dmg", "ShuyoNote_1.84.6_x64.dmg"),
        entry("macos", "ShuyoNote.app.tar.gz"),
      ],
    });
    expect(problems.join()).toMatch(/无法判定 ShuyoNote\.app\.tar\.gz 属于哪个 macOS 架构/);
  });
});

describe("validateManifest（写盘前门禁：每个平台条目必须 url + signature 都在）", () => {
  const okPlatforms = () => ({
    "windows-x86_64": { url: "https://gitcode.com/a/b/releases/download/v1.2.3/x.exe", signature: "sig-minisign" },
    "linux-x86_64": { url: "https://gitcode.com/a/b/releases/download/v1.2.3/x.deb", signature: "sig-minisign" },
    "darwin-aarch64": {
      url: "https://gitcode.com/a/b/releases/download/v1.2.3/ShuyoNote.app.tar.gz",
      signature: "sig-minisign",
    },
    "android-aarch64": {
      url: "https://gitcode.com/a/b/releases/download/v1.2.3/ShuyoNote_1.2.3_android-arm64-release.apk",
      signature: "sha256:" + "a".repeat(64),
    },
  });

  it("齐全（含 android 的 sha256 签名）→ 通过", () => {
    const { problems } = validateManifest({ version: "1.2.3", platforms: okPlatforms() });
    expect(problems).toEqual([]);
  });

  it("**android 条目缺 signature → 必须失败**（这条缺了会让整份 latest.json 解析失败、桌面更新一起挂）", () => {
    const platforms = okPlatforms();
    delete platforms["android-aarch64"].signature;
    const { problems } = validateManifest({ version: "1.2.3", platforms });
    expect(problems.join()).toMatch(/platforms\["android-aarch64"\]\.signature 缺失或为空/);
    expect(problems.join()).toMatch(/桌面更新通道一起挂/);
  });

  it("任何平台条目缺 url / url 非绝对 https → 失败", () => {
    const missing = okPlatforms();
    delete missing["linux-x86_64"].url;
    expect(validateManifest({ version: "1.2.3", platforms: missing }).problems.join()).toMatch(/url 缺失或为空/);
    const relative = okPlatforms();
    relative["windows-x86_64"].url = "/releases/download/v1.2.3/x.exe";
    expect(validateManifest({ version: "1.2.3", platforms: relative }).problems.join()).toMatch(/必须是绝对 https/);
    const plain = okPlatforms();
    plain["windows-x86_64"].url = "http://gitcode.com/x.exe";
    expect(validateManifest({ version: "1.2.3", platforms: plain }).problems.join()).toMatch(/必须是绝对 https/);
  });

  it("android 的 signature 必须是 sha256:<64 hex>（不是 minisign 串）", () => {
    const platforms = okPlatforms();
    platforms["android-aarch64"].signature = "untrusted comment: minisign...";
    expect(validateManifest({ version: "1.2.3", platforms }).problems.join()).toMatch(/应为 sha256:<64 位 hex>/);
    platforms["android-aarch64"].signature = "sha256:XYZ";
    expect(validateManifest({ version: "1.2.3", platforms }).problems.join()).toMatch(/应为 sha256:<64 位 hex>/);
  });

  it("空 signature / 空 platforms / 缺 version → 失败", () => {
    const emptySig = okPlatforms();
    emptySig["windows-x86_64"].signature = "   ";
    expect(validateManifest({ version: "1.2.3", platforms: emptySig }).problems.length).toBeGreaterThan(0);
    expect(validateManifest({ version: "1.2.3", platforms: {} }).problems.join()).toMatch(/platforms 为空/);
    expect(validateManifest({ platforms: okPlatforms() }).problems.join()).toMatch(/缺 version/);
  });

  it("没有 android 条目的清单照样合法（老清单 / --no-android 都要能过）", () => {
    const platforms = okPlatforms();
    delete platforms["android-aarch64"];
    expect(validateManifest({ version: "1.2.3", platforms }).problems).toEqual([]);
  });
});

describe("androidApkProblems（apk 是外部输入：缺了就硬失败，并给出可操作提示）", () => {
  const apkName = "ShuyoNote_1.90.1_andro" + "id-arm64-release.apk";

  it("没提供 → 失败，且提示里带三条出路", () => {
    const { problems } = androidApkProblems({ name: null, version: "1.90.1" });
    expect(problems.join()).toMatch(/未提供 Android 发版件/);
    expect(problems.join()).toMatch(/--no-android/);
    expect(problems.join()).toMatch(/android-release-apk/);
  });

  it("文件不存在 → 失败", () => {
    const { problems } = androidApkProblems({ name: apkName, version: "1.90.1", exists: false });
    expect(problems.join()).toMatch(/不存在或不是普通文件/);
  });

  it("给的不是 apk → 失败", () => {
    const { problems } = androidApkProblems({ name: "ShuyoNote_1.90.1_x64-setup.exe", version: "1.90.1", exists: true, statIsFile: true });
    expect(problems.join()).toMatch(/不是 \.apk/);
  });

  it("文件名不含本次版本号 → 只警告（不静默，也不卡发布）", () => {
    const r = androidApkProblems({ name: "app-release.apk", version: "1.90.1", exists: true, statIsFile: true });
    expect(r.problems).toEqual([]);
    expect(r.warnings.join()).toMatch(/不含本次版本号/);
  });

  it("正常提供 → 无问题无警告", () => {
    const r = androidApkProblems({ name: apkName, version: "1.90.1", exists: true, statIsFile: true });
    expect(r.problems).toEqual([]);
    expect(r.warnings).toEqual([]);
  });
});

describe("coverageProblems：Android 通道不许被静默砍掉", () => {
  it("线上有 android-aarch64、本次没有 → 报错", () => {
    const p = coverageProblems({
      previousKeys: ["windows-x86_64", "linux-x86_64", "android-aarch64"],
      nextKeys: ["windows-x86_64", "linux-x86_64"],
    });
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/android-aarch64/);
    expect(p[0]).toMatch(/收不到更新/);
  });
});

describe("coverageProblems（别把某个平台的更新通道砍掉）", () => {
  it("少了线上已有的平台 → 报错", () => {
    const p = coverageProblems({ previousKeys: ["windows-x86_64", "linux-x86_64"], nextKeys: ["linux-x86_64"] });
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/windows-x86_64/);
  });

  it("平台变多或不变 → 没问题；首次发布（无历史）→ 没问题", () => {
    expect(coverageProblems({ previousKeys: ["linux-x86_64"], nextKeys: ["linux-x86_64", "windows-x86_64"] })).toEqual([]);
    expect(coverageProblems({ previousKeys: ["linux-x86_64"], nextKeys: ["linux-x86_64"] })).toEqual([]);
    expect(coverageProblems({ previousKeys: [], nextKeys: ["linux-x86_64"] })).toEqual([]);
    expect(coverageProblems({ previousKeys: undefined, nextKeys: ["linux-x86_64"] })).toEqual([]);
  });
});

describe("minisign 解析", () => {
  it("解析 tauri.conf.json 里的真实公钥", () => {
    const key = parseMinisignPublicKey(
      "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDIyQTk3Rjg1REVGOEQwMTMKUldRVDBQamVoWCtwSXJGS2UzbDU2akoyaTduQlJvZi9NT1cvb25mYzJaSHZieXZDQktCZDJGVS8K",
    );
    expect(key.alg).toBe("Ed");
    expect(key.keyId).toBe("13d0f8de857fa922");
    expect(key.raw).toHaveLength(32);
  });

  it("解析双层 base64 的 .sig，并读出被签文件名", () => {
    const blob = Buffer.concat([Buffer.from("ED"), Buffer.alloc(8, 1), Buffer.alloc(64, 2)]);
    const text = `untrusted comment: signature from tauri secret key\n${blob.toString("base64")}\ntrusted comment: timestamp:1\tfile:ShuyoNote_1.84.6_x64-setup.exe\nAAAA\n`;
    const parsed = parseMinisignSignature(Buffer.from(text).toString("base64"));
    expect(parsed.alg).toBe("ED");
    expect(parsed.signature).toHaveLength(64);
    expect(parsed.signedFileName).toBe("ShuyoNote_1.84.6_x64-setup.exe");
  });

  it("畸形签名抛错（由 verifyArtifactSignature 转成 unsupported）", () => {
    expect(() => parseMinisignSignature("not-base64-at-all")).toThrow();
  });
});

describe("verifyArtifactSignature（用合成密钥对端到端覆盖校验路径）", () => {
  const dir = mkdtempSync(join(tmpdir(), "shuyo-release-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPub = publicKey.export({ format: "der", type: "spki" }).subarray(12); // SPKI 头 12 字节
  const keyId = Buffer.from("1122334455667788", "hex");
  const pubkeyB64 = Buffer.from(
    `untrusted comment: minisign public key: 8877665544332211\n${Buffer.concat([Buffer.from("Ed"), keyId, rawPub]).toString("base64")}\n`,
  ).toString("base64");

  const makeSig = (name, data, { alg = "ED", breakBits = 0, signedName = name } = {}) => {
    const digest = alg === "ED" ? blake2b512(data) : data;
    const sig = cryptoSign(null, digest, privateKey);
    if (breakBits) sig[0] ^= 0xff; // 故意破坏签名，模拟「配对错了」
    const blob = Buffer.concat([Buffer.from(alg), keyId, sig]);
    const text = `untrusted comment: signature from tauri secret key\n${blob.toString("base64")}\ntrusted comment: timestamp:1\tfile:${signedName}\n${Buffer.alloc(64).toString("base64")}\n`;
    return Buffer.from(text).toString("base64");
  };

  const write = (name, data) => {
    const p = join(dir, name);
    writeFileSync(p, data);
    return p;
  };

  it("配对正确 → ok", async () => {
    const data = Buffer.from("installer bytes 安装包字节");
    const p = write("ShuyoNote_1.84.6_x64-setup.exe", data);
    const r = await verifyArtifactSignature({ filePath: p, sigText: makeSig("ShuyoNote_1.84.6_x64-setup.exe", data), publicKey: pubkeyB64 });
    expect(r.status, r.detail).toBe("ok");
  });

  it("文件被改过一个字节 → mismatch（这是发布前必须拦住的那类事故）", async () => {
    const data = Buffer.from("installer bytes");
    const sig = makeSig("ShuyoNote_1.84.6_x64-setup.exe", data);
    const p = write("ShuyoNote_1.84.6_x64-setup.exe", Buffer.concat([data, Buffer.from("!")]));
    const r = await verifyArtifactSignature({ filePath: p, sigText: sig, publicKey: pubkeyB64 });
    expect(r.status).toBe("mismatch");
    expect(r.detail).toMatch(/很可能不是同一次构建/);
  });

  it("签名本身损坏 → mismatch", async () => {
    const data = Buffer.from("installer bytes");
    const p = write("ShuyoNote_1.84.6_x64-setup.exe", data);
    const r = await verifyArtifactSignature({
      filePath: p,
      sigText: makeSig("ShuyoNote_1.84.6_x64-setup.exe", data, { breakBits: 1 }),
      publicKey: pubkeyB64,
    });
    expect(r.status).toBe("mismatch");
  });

  it("签名是给别的文件做的 → mismatch（同名同版本残留的典型形态）", async () => {
    const data = Buffer.from("installer bytes");
    const p = write("ShuyoNote_1.84.6_x64-setup.exe", data);
    const r = await verifyArtifactSignature({
      filePath: p,
      sigText: makeSig("ShuyoNote_1.84.6_x64-setup.exe", data, { signedName: "ShuyoNote_1.84.5_x64-setup.exe" }),
      publicKey: pubkeyB64,
    });
    expect(r.status).toBe("mismatch");
    expect(r.detail).toMatch(/签名是为 .* 做的/);
  });

  it("keyId 不匹配 → mismatch（不是这把密钥签的）", async () => {
    const data = Buffer.from("installer bytes");
    const p = write("ShuyoNote_1.84.6_x64-setup.exe", data);
    const blob = Buffer.concat([Buffer.from("ED"), Buffer.alloc(8, 9), cryptoSign(null, blake2b512(data), privateKey)]);
    const text = `untrusted comment: x\n${blob.toString("base64")}\ntrusted comment: timestamp:1\tfile:ShuyoNote_1.84.6_x64-setup.exe\nAAAA\n`;
    const r = await verifyArtifactSignature({ filePath: p, sigText: Buffer.from(text).toString("base64"), publicKey: pubkeyB64 });
    expect(r.status).toBe("mismatch");
    expect(r.detail).toMatch(/keyId/);
  });

  it("未知算法标识 → unsupported（只警告，不阻断发布）", async () => {
    const data = Buffer.from("installer bytes");
    const p = write("ShuyoNote_1.84.6_x64-setup.exe", data);
    const r = await verifyArtifactSignature({
      filePath: p,
      sigText: makeSig("ShuyoNote_1.84.6_x64-setup.exe", data, { alg: "XX" }),
      publicKey: pubkeyB64,
    });
    expect(r.status).toBe("unsupported");
  });

  it("非预哈希（Ed）模式也能校验", async () => {
    const data = Buffer.from("legacy raw-signed bytes");
    const p = write("ShuyoNote_1.84.6_x64-setup.exe", data);
    const r = await verifyArtifactSignature({
      filePath: p,
      sigText: makeSig("ShuyoNote_1.84.6_x64-setup.exe", data, { alg: "Ed" }),
      publicKey: pubkeyB64,
    });
    expect(r.status, r.detail).toBe("ok");
  });
});
