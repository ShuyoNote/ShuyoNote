// 发布清单的**端到端**门禁：真的跑一遍 `scripts/release.mjs --dry-run`，用**合成产物**，
// 然后断言它写出来的 `latest.json`。
//
// 为什么需要它（2026-09-16 的真实教训）：darwin 的更新清单曾经指向 dmg，而更新器在 macOS 上
// **只解 `.app.tar.gz`**（能下载、装不上）；同一时期 universal 的 dmg 又只占一个平台键
// （另一架构静默收不到更新）。这两个规则在 `releaseArtifacts.mjs` 里各自都有单元测试，
// 但**"release.mjs 有没有按规则写清单"没人验**——测试全绿、真发布照样可能写错。
// 本条补的正是这道缝：不测规则，测**规则到产物的最后一段路**。
//
// 两个用例覆盖两条真实出包路径：
//   ① **universal**（`--target universal-apple-darwin`）：dmg 占**两个** darwin 键，
//      那两个键都要指向同一个 `.app.tar.gz`；
//   ② **只出 aarch64**：只有一个 darwin 键，且它指向 `.app.tar.gz`（dmg 不进清单）。
//
// 做法（不改生产代码、不联网、跑完就清）：
//   ① 在 bundle 目录里放合成产物（版本取 package.json，签名文件是占位内容 —— 用 --skip-sig-verify）；
//   ② `--dry-run --no-build --no-plugins --no-android --no-web --skip-sig-verify`；
//   ③ 用 `SHUYONOTE_PREV_MANIFEST_JSON` 注入一份"线上清单"当比较基准 ⇒ **不访问网络**；
//   ④ 断言清单内容（见各用例）；
//   ⑤ 每个用例先清掉上一个用例的合成产物，`afterAll` 再清一次 —— **别把假产物留给下一次真发布**。
//
// ⚠️ 这条会往 `src-tauri/target/release/` 里临时写文件（那是构建产物目录、不入库）。
// 断言失败时也会执行清理；若进程被强杀可能残留，残留下次跑会被覆盖，且文件名带本版本号，
// 真发布脚本按版本挑产物——但**别在准备真发布的目录上跑它**。

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = join(root, "src-tauri", "target", "release");
const bundleDir = join(releaseDir, "bundle");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const prevManifestPath = join(releaseDir, "prev-manifest-for-test.json");

const created = [];
function fakeArtifact(rel) {
  const p = join(bundleDir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `synthetic artifact for the release-manifest gate (${rel})\n`);
  created.push(p);
  writeFileSync(`${p}.sig`, "dW50cnVzdGVkIGNvbW1lbnQ6IHN5bnRoZXRpYyBzaWcK\n");
  created.push(`${p}.sig`);
}

/** 每个用例先清掉上一个用例留下的合成产物（否则两次 dry-run 会互相看见对方的文件）。 */
function clearFakes() {
  while (created.length > 0) rmSync(created.pop(), { force: true });
  rmSync(join(releaseDir, "latest.json"), { force: true });
}

afterAll(() => {
  clearFakes();
  rmSync(prevManifestPath, { force: true });
});

/** 跑一遍 `release.mjs --dry-run`，返回它写出来的 latest.json 与 stdout。 */
function dryRun() {
  // 注入"线上清单"当比较基准：覆盖检查因此不需要联网（生产发布**绝不能**设这个变量）
  writeFileSync(
    prevManifestPath,
    JSON.stringify({
      version,
      platforms: {
        "windows-x86_64": { url: "https://example.invalid/x.exe", signature: "sig" },
        "linux-x86_64": { url: "https://example.invalid/x.deb", signature: "sig" },
      },
    }),
  );
  const out = execFileSync(
    process.execPath,
    [
      "scripts/release.mjs",
      "--dry-run",
      "--no-build",
      "--no-plugins",
      "--no-android",
      "--no-web",
      "--skip-sig-verify",
    ],
    {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        // 这台机器上 node 是 Electron 的包装（DSH 沙箱）；CI 上是真 node，设了也无害
        ELECTRON_RUN_AS_NODE: "1",
        SHUYONOTE_PREV_MANIFEST_JSON: prevManifestPath,
      },
    },
  );
  const manifest = JSON.parse(readFileSync(join(releaseDir, "latest.json"), "utf8"));
  const name = (k) => (manifest.platforms[k]?.url ?? "").split("/").pop();
  return { manifest, name, out };
}

describe("发布清单端到端（真跑 release.mjs --dry-run + 合成产物）", () => {
  it("universal 构建：darwin 两个键都指向 .app.tar.gz，dmg 只发布、不进清单", () => {
    clearFakes();
    fakeArtifact(`dmg/ShuyoNote_${version}_universal.dmg`);
    fakeArtifact("macos/ShuyoNote.app.tar.gz");
    fakeArtifact(`nsis/ShuyoNote_${version}_x64-setup.exe`);
    fakeArtifact(`deb/ShuyoNote_${version}_amd64.deb`);

    const { manifest, name, out } = dryRun();

    // 核心断言：两个 darwin 键都要有，且都指向 .app.tar.gz（更新器只认它）
    expect(Object.keys(manifest.platforms).filter((k) => k.startsWith("darwin")).sort()).toEqual([
      "darwin-aarch64",
      "darwin-x86_64",
    ]);
    expect(name("darwin-aarch64")).toBe("ShuyoNote.app.tar.gz");
    expect(name("darwin-x86_64")).toBe("ShuyoNote.app.tar.gz");
    // dmg 照发但不进清单（清单里出现 dmg 就是"能下载、装不上"）
    expect(JSON.stringify(manifest.platforms)).not.toContain(".dmg");
    // 其它平台不受影响
    expect(name("windows-x86_64")).toBe(`ShuyoNote_${version}_x64-setup.exe`);
    expect(name("linux-x86_64")).toBe(`ShuyoNote_${version}_amd64.deb`);
    // 每个条目都得有非空签名（缺了整份清单解析失败、桌面更新一起挂）
    for (const [k, v] of Object.entries(manifest.platforms)) {
      expect(v.signature, `${k} 的 signature 不能为空`).toBeTruthy();
    }
    // 顺带把 release.mjs 自己打印的那行判据也钉住（人看的日志与机器读的清单必须一致）
    expect(out).toMatch(/darwin-aarch64、darwin-x86_64 的更新清单指向 ShuyoNote\.app\.tar\.gz/);
  }, 180_000);

  it("只出 aarch64：只有一个 darwin 键，同样指向 .app.tar.gz（dmg 不进清单）", () => {
    clearFakes();
    fakeArtifact(`dmg/ShuyoNote_${version}_aarch64.dmg`);
    fakeArtifact("macos/ShuyoNote.app.tar.gz");
    fakeArtifact(`nsis/ShuyoNote_${version}_x64-setup.exe`);
    fakeArtifact(`deb/ShuyoNote_${version}_amd64.deb`);

    const { manifest, name } = dryRun();

    expect(Object.keys(manifest.platforms).filter((k) => k.startsWith("darwin"))).toEqual(["darwin-aarch64"]);
    expect(name("darwin-aarch64")).toBe("ShuyoNote.app.tar.gz");
    expect(JSON.stringify(manifest.platforms)).not.toContain(".dmg");
  }, 180_000);

  it("有 dmg 却没有 .app.tar.gz ⇒ `release.mjs` 直接失败（macOS 更新通道不能静默失效）", () => {
    clearFakes();
    fakeArtifact(`dmg/ShuyoNote_${version}_universal.dmg`);
    fakeArtifact(`nsis/ShuyoNote_${version}_x64-setup.exe`);
    fakeArtifact(`deb/ShuyoNote_${version}_amd64.deb`);

    let failed = false;
    let stderr = "";
    try {
      dryRun();
    } catch (e) {
      failed = true;
      stderr = String(e.stderr ?? e.stdout ?? e.message ?? "");
    }
    expect(failed, "缺少 .app.tar.gz 时必须非零退出").toBe(true);
    expect(stderr).toMatch(/缺少 macOS 更新通道产物/);
  }, 180_000);
});
