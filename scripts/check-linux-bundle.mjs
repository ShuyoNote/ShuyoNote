// Linux 打包产物的自检门禁（**在 runner 或本机上都能跑**，不需要任何密钥）。
//
// 为什么需要它（与 `check-macos-bundle.mjs` 同一族理由，2026-09-19 AMD）：
// `libpdfium.so` 是 `libloading` **运行时**加载的（`src-tauri/src/pdfium_native.rs`），
// 库不在包里时**装完不会立刻报错** —— 只有用户切到 PDFium（P5 之后是默认）才变成
// 「找不到 PDFium 动态库」。而 Linux 的库**不在 exe 同目录**（deb = `/usr/lib/<id>`、
// AppImage = `$APPDIR/usr/lib/<id>`），所以"配了 resources 映射"还不够，**位置也得对**。
//
// 它断言什么（一条比一条"晚才发现"）：
//   1. deb 产物存在（Linux 档的发布产物）；
//   2. 包里有 `libpdfium.so`；
//   3. **它就在资源目录那一层**（`…/usr/lib/<一段>/libpdfium.so`），没有被塞进更深的子目录
//      —— Rust 侧只探"资源目录根"，深一层就等于没带；
//   4. 包里那份与 `vendor/pdfium/linux-x64/lib/libpdfium.so` 的 **sha256 一致**
//      （拷错了、或拿到的是上一次构建的残留）；
//   5. AppImage 若在，同样查一遍（读不到就**如实报"问不到"**，不假装通过）。
//
// 用法：
//   node scripts/check-linux-bundle.mjs                 # 默认 src-tauri/target/release/bundle
//   node scripts/check-linux-bundle.mjs <bundle 目录>
// 退出码：0 = 通过；非 0 = 有问题（逐条打印原因）。

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 库文件名（与 `fetch-pdfium.mjs` 的 `spec.lib` 末段一致）。 */
export const PDFIUM_LIB = "libpdfium.so";

/**
 * 这条路径是不是"资源目录根上的库"？
 *
 * 允许：`./usr/lib/shuyonote/libpdfium.so`、`./usr/lib/cn.shuyo.shuyonote/libpdfium.so`
 * 拒绝：`./usr/lib/shuyonote/resources/libpdfium.so`（深一层 ⇒ `library_dir()` 探不到）
 *       `./usr/share/libpdfium.so`（不在 `/usr/lib` 下 ⇒ 不是 Tauri 的资源目录）
 *
 * 为什么用"层数"而不是写死 `<id>`：Tauri 的 deb 资源目录名取自产品名/标识符，
 * 跨版本变过一次；**层数**才是我们真正依赖的性质（`resource_dir()` 给的就是那一层）。
 */
export function isResourceDirLibPath(entry) {
  let parts = String(entry)
    .replace(/^\.\//, "")
    .split("/")
    .filter((p) => p.length > 0);
  // ⚠️ AppImage 的清单来自 `--appimage-extract` 展开的目录，**第一段是 squashfs 的根名**
  //（`squashfs-root/usr/lib/<一段>/libpdfium.so`）。那是"打包容器的根"，不是包内路径的一部分，
  // 所以要比层数之前先摘掉它 —— 2026-09-19 的 CI 就是被这一点误判成"位置不对"的
  //（库其实位置正确：`usr/lib/ShuyoNote/libpdfium.so`）。
  if (parts[0] === "squashfs-root") parts = parts.slice(1);
  return parts.length === 4 && parts[0] === "usr" && parts[1] === "lib" && parts[3] === PDFIUM_LIB;
}

/**
 * 纯函数形式的断言（便于单测；不做任何 IO）。
 * @returns {string[]} problems，空数组表示通过
 */
export function checkLinuxBundle({
  debNames = [],
  libPathsInDeb = [],
  appImageNames = [],
  libPathsInAppImage = null, // null = 问不到（如实报，不算通过也不算失败）
  pdfiumDebSha = null,
  pdfiumAppImageSha = null,
  pdfiumVendorSha = null,
  pdfiumVendorExists = true,
}) {
  const problems = [];

  if (debNames.length === 0) {
    problems.push("没有找到 deb 产物（src-tauri/target/release/bundle/deb/*.deb）—— `--bundles` 里漏了 deb？");
  } else if (libPathsInDeb.length === 0) {
    problems.push(
      `${PDFIUM_LIB} 不在 deb 里 —— Linux 上切到 PDFium 会报「找不到 PDFium 动态库」` +
        `（映射见 src-tauri/tauri.linux.conf.json；库由 node scripts/fetch-pdfium.mjs 现拉）`,
    );
  } else if (!libPathsInDeb.some(isResourceDirLibPath)) {
    problems.push(
      `${PDFIUM_LIB} 在 deb 里的位置不对：${libPathsInDeb.join("、")} —— ` +
        `库必须在**资源目录那一层**（usr/lib/<一段>/libpdfium.so）；深一层或换目录，` +
        `Rust 侧 pdfium_native::library_dir() 都探不到`,
    );
  }

  if (!pdfiumVendorExists) {
    problems.push(
      "vendor 里没有 linux-x64 的 PDFium（先跑 node scripts/fetch-pdfium.mjs --platform linux-x64）" +
        " —— 这是**前置缺失**，不是产物问题",
    );
  } else if (pdfiumDebSha && pdfiumVendorSha && pdfiumDebSha !== pdfiumVendorSha) {
    problems.push(
      `deb 里的 ${PDFIUM_LIB} 与 vendor 源文件 sha256 不一致（${pdfiumDebSha.slice(0, 12)}… vs ` +
        `${pdfiumVendorSha.slice(0, 12)}…）—— 拷错了，或拿到的是上一次构建的产物`,
    );
  }

  // AppImage：问得到就查（同一套位置判据），问不到如实说明、不冒充通过。
  if (appImageNames.length > 0) {
    if (libPathsInAppImage === null) {
      problems.push(
        "AppImage 在，但**读不到内容**（本机与 runner 都没有可用的解包方式）—— 这条没验过，" +
          "不要当成通过（deb 那条已覆盖打包配置本身）",
      );
    } else if (libPathsInAppImage.length === 0) {
      problems.push(`${PDFIUM_LIB} 不在 AppImage 里（AppImage 用户的 PDFium 会找不到库）`);
    } else if (!libPathsInAppImage.some(isResourceDirLibPath)) {
      problems.push(`${PDFIUM_LIB} 在 AppImage 里的位置不对：${libPathsInAppImage.join("、")}`);
    } else if (pdfiumAppImageSha && pdfiumVendorSha && pdfiumAppImageSha !== pdfiumVendorSha) {
      problems.push(
        `AppImage 里的 ${PDFIUM_LIB} 与 vendor 源文件 sha256 不一致` +
          `（AppImage ${String(pdfiumAppImageSha).slice(0, 12)}… vs vendor ${String(pdfiumVendorSha).slice(0, 12)}…）` +
          ` —— 最常见的原因是 **linuxdeploy 打包时默认会 strip 所有 ELF**（我们当资源带进去的库也会被改写字节）。` +
          `修法：打包时设 \`NO_STRIP=1\`（见 .github/workflows/release.yml 的 Build bundles 步骤）。` +
          `⚠️ 别把这条判据放宽成「只看大小」—— 「包里那份 == 源那份」是**可证**的，` +
          `且 AppImage 里那份应当与 deb 里那份、与 vendor 源都一致。`,
      );
    }
  }

  return problems;
}

function sha256File(p) {
  return existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : null;
}

/** `dpkg-deb -c` 的每一行形如 `-rw-r--r-- root/root 1234 2026-.. ..:.. <路径>`。
 *
 *  ⚠️ **路径前缀不是稳定的**：老 dpkg 输出 `./usr/...`，**dpkg 1.22.x 输出 `usr/...`（没有 `./`）**。
 *  2026-09-19 的 CI 假红就是这里 —— 旧实现的正则写死了 `(\.\/.*)`，于是在 1.22 上**一行都匹配不上**，
 *  返回空数组，被上层当成"deb 里没有库"（**把读数失败说成了事实**）。
 *  现在只按"前 5 个字段 + 其余整段当作路径"来切，前缀有没有都认。
 */
export function parseDpkgDebList(output) {
  return String(output)
    .split(/\r?\n/)
    .map((line) => {
      const m = /^(?:\S+\s+){5}(.+)$/.exec(line.trim());
      return m ? m[1].trim() : null;
    })
    .filter(Boolean);
}

function tryRun(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
  } catch {
    return null;
  }
}

function main() {
  const arg = process.argv[2];
  const bundleDir = arg ? resolve(arg) : join(root, "src-tauri", "target", "release", "bundle");
  const debDir = join(bundleDir, "deb");
  const appImageDir = join(bundleDir, "appimage");
  const debNames = existsSync(debDir) ? readdirSync(debDir).filter((n) => n.endsWith(".deb")) : [];
  const appImageNames = existsSync(appImageDir) ? readdirSync(appImageDir).filter((n) => n.endsWith(".AppImage")) : [];
  const vendorLib = join(root, "src-tauri", "vendor", "pdfium", "linux-x64", "lib", PDFIUM_LIB);
  const pdfiumVendorSha = sha256File(vendorLib);

  let libPathsInDeb = [];
  let pdfiumDebSha = null;
  if (debNames.length > 0) {
    const deb = join(debDir, debNames[0]);
    const listing = tryRun("dpkg-deb", ["-c", deb]);
    if (listing === null) {
      console.error("[check-linux-bundle] ❌ 读不了 deb（本机没有 dpkg-deb？）—— 这条**没验过**");
      process.exit(1);
    }
    libPathsInDeb = parseDpkgDebList(listing).filter((p) => p.endsWith(`/${PDFIUM_LIB}`) || p.endsWith(PDFIUM_LIB));
    // ⚠️ 防线：**读出来了行、却一条路径都没解析出来** ⇒ 那是解析器不认识这个格式，
    // 不是"包里没有库"。把这两种情况分开报 —— 2026-09-19 的 CI 假红就是被混为一谈的。
    if (libPathsInDeb.length === 0 && parseDpkgDebList(listing).length === 0 && listing.trim() !== "") {
      console.error(
        "[check-linux-bundle] ❌ `dpkg-deb -c` 有输出但**一条路径都没解析出来** —— 格式不认识（解析器的问题），" +
          "这条**没验过**；不要把「没读到」当成「包里没有」。前 3 行原样：\n" +
          listing.split(/\r?\n/).slice(0, 3).map((l) => "    " + l).join("\n"),
      );
      process.exit(2);
    }
    if (libPathsInDeb.length > 0) {
      const tmp = mkdtempSync(join(tmpdir(), "linux-bundle-"));
      try {
        if (tryRun("dpkg-deb", ["-x", deb, tmp]) !== null) {
          pdfiumDebSha = sha256File(join(tmp, libPathsInDeb[0]));
        }
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
  }

  let libPathsInAppImage = appImageNames.length > 0 ? null : [];
  let pdfiumAppImageSha = null;
  if (appImageNames.length > 0) {
    const img = join(appImageDir, appImageNames[0]);
    const tmp = mkdtempSync(join(tmpdir(), "linux-appimage-"));
    try {
      // AppImage 自带 `--appimage-extract`（不需要 FUSE）。它在**当前目录**展开 squashfs-root。
      const ok = tryRun(img, ["--appimage-extract"], { cwd: tmp });
      if (ok !== null) {
        const found = tryRun("find", [tmp, "-name", PDFIUM_LIB]);
        if (found !== null) {
          // find 输出是绝对路径 ⇒ 去掉 tmp 前缀，得到与 deb 同口径的相对路径。
          libPathsInAppImage = found
            .split(/\r?\n/)
            .filter(Boolean)
            .map((p) => "." + p.slice(tmp.length));
          if (libPathsInAppImage.length > 0) {
            pdfiumAppImageSha = sha256File(
              join(tmp, libPathsInAppImage[0].replace(/^\./, "")),
            );
          }
        }
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  const problems = checkLinuxBundle({
    debNames,
    libPathsInDeb,
    appImageNames,
    libPathsInAppImage,
    pdfiumDebSha,
    pdfiumAppImageSha,
    pdfiumVendorSha,
    pdfiumVendorExists: existsSync(vendorLib),
  });

  console.log(`[check-linux-bundle] bundle=${bundleDir}`);
  console.log(`  deb：${debNames.join("、") || "(无)"}`);
  console.log(`  AppImage：${appImageNames.join("、") || "(无)"}`);
  console.log(
    `  ${PDFIUM_LIB}：deb ${libPathsInDeb.length > 0 ? `${libPathsInDeb.join("、")}（${(pdfiumDebSha ?? "").slice(0, 12)}…）` : "(不在包里)"}` +
      ` · AppImage ${libPathsInAppImage === null ? "(问不到)" : libPathsInAppImage.join("、") || "(不在包里)"}` +
      ` · vendor 源：${pdfiumVendorSha ? pdfiumVendorSha.slice(0, 12) + "…" : "(缺)"}`,
  );
  if (problems.length > 0) {
    console.error("[check-linux-bundle] ❌ 不通过：");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log("[check-linux-bundle] ✅ 通过");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
