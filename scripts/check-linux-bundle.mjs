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
//   4. deb 里那份与 `vendor/pdfium/linux-x64/lib/libpdfium.so` 的 **sha256 一致**
//      （deb 是纯粹的 ar+tar，没人动过库的字节 ⇒ 这条能钉死"拷错了/上一次构建的残留"）；
//   5. AppImage 若在，位置同上，另外与源那份做**结构比对**（见下）。
//
// ⚠️ **AppImage 里那份字节必然不等于源那份，而且这消除不掉**（2026-09-19 第二次订正）：
//   linuxdeploy 对 AppDir 里 `usr/lib` 下**每个** ELF 都会无条件 `patchelf --set-rpath`
//   （`linuxdeploy/src/core/appdir.cpp` 的 `deployDependenciesForExistingFiles()`：即使
//   rpath 已经等于目标值，也照样排进 `setElfRPathOperations` 并执行），而我们的库是 Tauri
//   当**资源**放进 AppDir 的，于是被打上 `RUNPATH=$ORIGIN`。
//   实测（同一份 vendor 文件、WSL 里同一版 linuxdeploy）：
//     vendor:   7645184 字节  sha256 f728930966f50365…  （无 RUNPATH）
//     AppImage: 7664592 字节  sha256 eb19d385c3987b8c…  （+RUNPATH $ORIGIN；.dynstr +8 字节）
//     动态符号表 **786/786、名字集合完全相同**；除 RUNPATH 外的动态表条目完全相同。
//   ⇒ 上一版这里写的"linuxdeploy 默认 strip 所有 ELF，设 `NO_STRIP=1` 就好"是**错的诊断**
//     （`NO_STRIP=1` 挡的是 strip，挡不住 patchelf；1.91.8 因此照旧红）。
//     所以 AppImage 档改成断言"**只差一个 `$ORIGIN` 的 RUNPATH，别的全同**"：
//       ① 动态表（归一化后）除 RUNPATH 外逐条相同；RUNPATH 只允许是"源没有、包里补 $ORIGIN"；
//       ② 动态符号表（名字/类型/绑定/大小）多重集相同；
//       ③ 段名集合相同 —— 这一条专门咬 **strip**（strip 会搬走 .symtab/.debug_*）；
//       ④ 大小不比源小、且不超过源 + 256 KiB —— 咬截断/插桩/换成了另一个库。
//     `NO_STRIP=1` 仍留在 release.yml（它让③④更稳，代价 ~1–2 MB），但**它不是这条判据
//     成立的原因**，不要再把它当修法。
//
// 用法：
//   node scripts/check-linux-bundle.mjs                 # 默认 src-tauri/target/release/bundle
//   node scripts/check-linux-bundle.mjs <bundle 目录>
// 退出码：0 = 通过；1 = 有问题（逐条打印原因）；2 = **没验过**（工具/格式不认识，不许当成通过）。

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 库文件名（与 `fetch-pdfium.mjs` 的 `spec.lib` 末段一致）。 */
export const PDFIUM_LIB = "libpdfium.so";

/** AppImage 里那份允许比源大多少（实测 patchelf 只加 RUNPATH 时 +19408 字节 ≈ +0.25%）。 */
export const APPIMAGE_SIZE_SLACK_BYTES = 256 * 1024;

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
 * `readelf -d` 的输出 → 归一化后的动态表条目（已排序）。
 *
 * 只留「条目种类 + 字符串值」：地址、长度、条数全抹掉（`0x…` 与裸数字 → `#`）。
 * 这样两份库的差异就只剩**真正有语义的差别**（多/少一个条目、RUNPATH 的值）。
 */
export function normalizeDynamicSection(text) {
  return String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !/^Dynamic section at offset/.test(line) && !/^Tag\s+Type\s+Name\/Value/.test(line))
    .map((line) => {
      const m = /^0x[0-9a-f]+\s+\(([A-Z_0-9]+)\)\s*(.*)$/i.exec(line);
      if (!m) return null;
      // ⚠️ `[...]` 里的字符串**必须原样保留**：`Shared library: [libc.so.6]` 里的 `.6` 一被
      // 抹成 `#`，`libc.so.6` 与 `libc.so.5` 就成了同一条 —— 那正好把这条判据该咬的东西盖掉。
      // 只把括号外的地址/长度/条数抹掉。
      // （占位符用私用区字符而不是 `\u0000<数字>\u0000`：后者里的数字会被下面那条
      //  `\b\d+\b` 一起抹掉，占位符自己就还原不回来了。）
      const kept = [];
      const value = m[2]
        .replace(/\[[^\]]*\]/g, (s) => {
          kept.push(s);
          return String.fromCharCode(0xe000 + kept.length - 1);
        })
        .replace(/0x[0-9a-f]+/gi, "#")
        .replace(/\b\d+\b/g, "#")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/[\ue000-\uf8ff]/g, (ch) => kept[ch.charCodeAt(0) - 0xe000] ?? ch);
      return `${m[1]} ${value}`.trim();
    })
    .filter(Boolean)
    .sort();
}

/** 从归一化的动态表里取出 RUNPATH/RPATH 的值（没有则空串）。 */
export function dynamicSectionRunpath(normalized) {
  const hit = normalized.find((l) => /^RUNPATH /.test(l) || /^RPATH /.test(l));
  if (!hit) return "";
  const m = /\[([^\]]*)\]/.exec(hit);
  return m ? m[1] : "";
}

/**
 * `readelf --dyn-syms -W` 的输出 → 排序后的「名字|类型|绑定|大小」多重集。
 * 地址列**故意不取**：patchelf 会搬段，取地址会把"只是补了个 rpath"误判成"换了个库"。
 */
export function parseDynSyms(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*\d+:\s+[0-9a-f]+\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, size, type, bind, , , name] = m;
    out.push(`${name.trim()}|${type}|${bind}|${size}`);
  }
  return out.sort();
}

/**
 * `readelf -S -W` 的输出 → 段名集合（用来咬 strip：strip 会搬走 .symtab/.debug_*）。
 *
 * 只收**以 `.` 开头**的名字：`[ 0]` 那条是空名字（NULL 段），字段对齐会让它后面的
 * `NULL` 被当成名字 —— 那是个假的"段名"，收进来只会在两侧之间制造噪声。
 */
export function parseSectionNames(text) {
  const names = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*\[\s*\d+\]\s+(\.[^\s]+)/.exec(line);
    if (m) names.add(m[1]);
  }
  return names;
}

/**
 * AppImage 里那份库 vs vendor 源那份的**结构比对**（纯函数，不做 IO，便于单测）。
 *
 * @returns {{ ok: boolean, runpath: string, problems: string[], facts: string[] }}
 */
export function comparePdfiumLibs({
  vendorDynamic = "",
  packagedDynamic = "",
  vendorDynSyms = [],
  packagedDynSyms = [],
  vendorSections = [],
  packagedSections = [],
  vendorSize = 0,
  packagedSize = 0,
} = {}) {
  const problems = [];
  const facts = [];

  const vDyn = normalizeDynamicSection(vendorDynamic);
  const pDyn = normalizeDynamicSection(packagedDynamic);
  const vRunpath = dynamicSectionRunpath(vDyn);
  const pRunpath = dynamicSectionRunpath(pDyn);
  const withoutRunpath = (arr) => arr.filter((l) => !/^(RUNPATH|RPATH) /.test(l));
  const vRest = withoutRunpath(vDyn);
  const pRest = withoutRunpath(pDyn);

  facts.push(`动态表 ${vDyn.length}/${pDyn.length} 条`);
  if (vRest.join("\n") !== pRest.join("\n")) {
    const onlyV = vRest.filter((l) => !pRest.includes(l));
    const onlyP = pRest.filter((l) => !vRest.includes(l));
    problems.push(
      `AppImage 里那份的**动态表**与源那份不同（只允许差一个 RUNPATH）：` +
        `源独有 [${onlyV.join("、") || "无"}]，包里独有 [${onlyP.join("、") || "无"}]`,
    );
  }
  // RUNPATH：唯一允许的差异 —— 源没有、包里被 linuxdeploy 补上 $ORIGIN。
  if (!(vRunpath === pRunpath || (vRunpath === "" && pRunpath === "$ORIGIN"))) {
    problems.push(
      `AppImage 里那份的 RUNPATH 不是允许的形态（源「${vRunpath || "无"}」 vs 包里「${pRunpath || "无"}」）：` +
        `只允许"源没有、包里补一个 $ORIGIN"（linuxdeploy 对 AppDir 里每个 ELF 都这么做）`,
    );
  }
  if (pRunpath) facts.push(`RUNPATH=${pRunpath}`);

  if (vendorDynSyms.length !== packagedDynSyms.length) {
    problems.push(
      `AppImage 里那份的**动态符号条数**与源不同（源 ${vendorDynSyms.length} vs 包里 ${packagedDynSyms.length}）`,
    );
  } else {
    const missing = vendorDynSyms.filter((s) => !packagedDynSyms.includes(s));
    const extra = packagedDynSyms.filter((s) => !vendorDynSyms.includes(s));
    if (missing.length > 0 || extra.length > 0) {
      problems.push(
        `AppImage 里那份的**动态符号集**与源不同：源独有 ${missing.length} 个` +
          `（${missing.slice(0, 3).join("、")}），包里独有 ${extra.length} 个（${extra.slice(0, 3).join("、")}）` +
          ` —— 这已经不是同一个库的 ABI 了`,
      );
    }
  }
  facts.push(`动态符号 ${vendorDynSyms.length}/${packagedDynSyms.length}`);

  const vSec = new Set(vendorSections);
  const pSec = new Set(packagedSections);
  const secMissing = [...vSec].filter((s) => !pSec.has(s));
  const secExtra = [...pSec].filter((s) => !vSec.has(s));
  // 只把"**源有、包里没有**"当问题：strip 只会搬走段，不会凭空造段；
  // 反过来 patchelf 会搬动/追加段（实测它把 `.dynstr` 挪到后面），那是正常的，记成事实即可。
  if (secMissing.length > 0) {
    problems.push(
      `AppImage 里那份**少了源那份的段**：[${secMissing.join("、")}] —— ` +
        `少了 .symtab/.debug_* 就是被 **strip** 过（\`NO_STRIP=1\` 挡得住 strip，挡不住 patchelf 的 rpath 修补）`,
    );
  }
  if (secExtra.length > 0) facts.push(`包里多出段 ${secExtra.length} 个（${secExtra.slice(0, 2).join("、")}）`);

  if (packagedSize < vendorSize) {
    problems.push(
      `AppImage 里那份**比源小**（${packagedSize} < ${vendorSize} 字节）—— ` +
        `strip 或截断都会让它变小；源那份没被 strip 过，包里那份也不该小`,
    );
  } else if (packagedSize > vendorSize + APPIMAGE_SIZE_SLACK_BYTES) {
    problems.push(
      `AppImage 里那份**比源大太多**（${packagedSize} vs ${vendorSize} 字节，上限 +${APPIMAGE_SIZE_SLACK_BYTES}）` +
        ` —— 只补一个 RUNPATH 时实测只大 19408 字节，大这么多说明包里那份不是源那份`,
    );
  }
  facts.push(`大小 ${vendorSize}/${packagedSize}`);

  return { ok: problems.length === 0, runpath: pRunpath, problems, facts };
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
  appImageCompare = null, // comparePdfiumLibs 的结果；null = 没做结构比对
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

  // AppImage：问得到就查（位置判据 + 结构比对），问不到就如实说"没验过"、不冒充通过。
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
    } else if (pdfiumAppImageSha && pdfiumVendorSha && pdfiumAppImageSha === pdfiumVendorSha) {
      // 字节相同是最好的情况（将来 linuxdeploy 若不再改 rpath，就会走到这里）。
    } else if (appImageCompare === null) {
      problems.push(
        `AppImage 里那份的 sha256 与源不同（${String(pdfiumAppImageSha).slice(0, 12)}… vs ` +
          `${String(pdfiumVendorSha).slice(0, 12)}…），而**结构比对没做成**（readelf 不可用？）—— ` +
          `这条没验过。注意：这里**不是** strip（见文件顶部的订正），字节差异来自 linuxdeploy ` +
          `无条件给 AppDir 里每个 ELF 打 \`RUNPATH=$ORIGIN\``,
      );
    } else if (!appImageCompare.ok) {
      problems.push(
        `AppImage 里那份与源那份的**结构**对不上（不是"只差一个 $ORIGIN 的 RUNPATH"）：\n      ` +
          appImageCompare.problems.join("\n      "),
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

/** 对一份库跑三条 readelf，拿不到就返回 null（调用方负责报"没验过"）。 */
function readElfFacts(path) {
  return {
    dyn: tryRun("readelf", ["-d", path]),
    syms: tryRun("readelf", ["--dyn-syms", "-W", path]),
    secs: tryRun("readelf", ["-S", "-W", path]),
  };
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
          listing
            .split(/\r?\n/)
            .slice(0, 3)
            .map((l) => "    " + l)
            .join("\n"),
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
  let appImageCompare = null;
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
            const packagedLib = join(tmp, libPathsInAppImage[0].replace(/^\./, ""));
            pdfiumAppImageSha = sha256File(packagedLib);
            // 字节不同是**预期**（linuxdeploy 会给 AppDir 里每个 ELF 打 RUNPATH=$ORIGIN）⇒ 做结构比对。
            if (pdfiumAppImageSha !== pdfiumVendorSha && existsSync(vendorLib)) {
              const v = readElfFacts(vendorLib);
              const p = readElfFacts(packagedLib);
              if ([v.dyn, v.syms, v.secs, p.dyn, p.syms, p.secs].some((x) => x === null)) {
                console.error(
                  "[check-linux-bundle] ❌ 拿不到 `readelf`（binutils 缺失？）—— AppImage 那条**没验过**。" +
                    "别把「没读到」当成「包里那份没问题」。",
                );
                process.exit(2);
              }
              appImageCompare = comparePdfiumLibs({
                vendorDynamic: v.dyn,
                packagedDynamic: p.dyn,
                vendorDynSyms: parseDynSyms(v.syms),
                packagedDynSyms: parseDynSyms(p.syms),
                vendorSections: parseSectionNames(v.secs),
                packagedSections: parseSectionNames(p.secs),
                vendorSize: statSync(vendorLib).size,
                packagedSize: statSync(packagedLib).size,
              });
            }
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
    appImageCompare,
  });

  console.log(`[check-linux-bundle] bundle=${bundleDir}`);
  console.log(`  deb：${debNames.join("、") || "(无)"}`);
  console.log(`  AppImage：${appImageNames.join("、") || "(无)"}`);
  console.log(
    `  ${PDFIUM_LIB}：deb ${libPathsInDeb.length > 0 ? `${libPathsInDeb.join("、")}（${(pdfiumDebSha ?? "").slice(0, 12)}…）` : "(不在包里)"}` +
      ` · AppImage ${libPathsInAppImage === null ? "(问不到)" : libPathsInAppImage.join("、") || "(不在包里)"}` +
      ` · vendor 源：${pdfiumVendorSha ? pdfiumVendorSha.slice(0, 12) + "…" : "(缺)"}`,
  );
  if (pdfiumAppImageSha && pdfiumAppImageSha !== pdfiumVendorSha) {
    console.log(
      `  AppImage 那份：${pdfiumAppImageSha.slice(0, 12)}… ≠ 源那份（预期：linuxdeploy 打 RUNPATH）` +
        (appImageCompare ? ` ⇒ 结构比对：${appImageCompare.facts.join(" · ")}` : " ⇒ **结构比对没做**"),
    );
  }
  if (problems.length > 0) {
    console.error("[check-linux-bundle] ❌ 不通过：");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log("[check-linux-bundle] ✅ 通过");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
