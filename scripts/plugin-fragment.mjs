// 第一方插件 → **索引片段**：打包、算哈希、签发布者签名，产出一份能被社区合并的片段。
//
// 为什么要有这个工具（社区互动方案里商定的长期形状）：
//   **社区不写条目、不碰包字节、也不持有我们的发布者私钥**；它只做"合并片段 + 签索引 + 托管"。
//   所以供给侧必须在发版时产出字段齐全的片段：`downloadUrl / size / sha256 / publisherKey /
//   signature / permissions / minAppVersion`。
//
// 三条口径（都是有理由的，不是随手定的）：
//   1. **先过作者 CLI**：打包前必须 `plugin-cli.mjs validate` 通过——脚手架/示例产出的废品
//      不该被发出去（发出去之后，用户那边表现为"装了但什么也没有"）。
//   2. **`downloadUrl` 带版本号**：条目里的 size/sha256 必须与实际字节一致，所以资源**不可覆盖重传**；
//      带版本号是唯一稳妥的命名法（社区侧收到这个地址后会长期引用它）。
//   3. **`minAppVersion` 默认取当前应用版本**：随 N 版发布的插件只保证 N+ 能用；
//      应用对低于它的版本会明确显示"需要应用 X+"并拒绝安装。要放宽就显式 `--min-app-version`。
//
// 用法：
//   # 正式（用 minisign 本体签名）
//   node scripts/plugin-fragment.mjs --plugins examples/plugins/md-outline \
//     --out /tmp/frag --minisign "$(which minisign)" --key ~/.minisign/shuyonote.key --pub ~/.minisign/shuyonote.pub
//
//   # 本机自检（一次性密钥，只用来验证"打包 → 签名 → 索引片段"这条流水线本身）
//   node scripts/plugin-fragment.mjs --plugins examples/plugins/md-outline --out /tmp/frag --ephemeral-key
//
// 产出（都在 --out 下）：
//   <id>-<version>.zip                     插件包（包内根目录就是插件目录，应用会自动下钻）
//   <id>-<version>.zip.minisig             发布者签名（内容填进条目的 signature）
//   publisher.pub / publisher.sig          自检模式：一次性公钥与"索引签名"公钥（正式模式由 --pub 提供）
//   plugin-index.fragment.json             给社区合并的片段
//   plugin-index.preview.json[.minisig]    一份**完整可用**的索引（占位 owner），用来本机验签与试装
//
// 产出后请务必用应用真正的解析器验一遍（本仓库里有现成的忽略测试）：
//   SHUYONOTE_INDEX_FIXTURE=<out>/plugin-index.preview.json cargo test --lib external_index -- --ignored --nocapture

import { createHash } from "node:crypto";
import { zipSync } from "fflate";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fingerprintOf, generateEphemeralKeypair, signBytes } from "./lib/minisign.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(name);

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = flag("--version", pkg.version);
const outDir = resolve(flag("--out", join(root, "src-tauri", "target", "plugin-fragment")));
const urlBase = flag("--url-base", `https://gitcode.com/shuyo-cn/ShuyoNote/releases/download/v${version}`);
const minAppVersion = flag("--min-app-version", version);
const dryRun = has("--dry-run");
const ephemeral = has("--ephemeral-key");
const minisignBin = flag("--minisign", null);
const keyPath = flag("--key", null);
const pubPath = flag("--pub", null);

const pluginArgs = flag("--plugins", null);
const pluginDirs = (pluginArgs ? pluginArgs.split(",") : [join(root, "examples", "plugins")])
  .map((p) => resolve(p.trim()))
  .filter(Boolean);

function die(msg) {
  console.error(`[fragment] ${msg}`);
  process.exit(1);
}
function info(msg) {
  console.log(`[fragment] ${msg}`);
}

if (!dryRun && !ephemeral && !minisignBin) {
  die(
    [
      "没有可用的签名方式。正式发布请给 --minisign <可执行文件> --key <私钥> [--pub <公钥>]，",
      "只想验证流水线请加 --ephemeral-key（一次性密钥，**不要用于正式发布**），",
      "或者用 --dry-run 只打包与算哈希。",
    ].join("\n"),
  );
}
if (minisignBin && !existsSync(minisignBin)) die(`找不到 minisign：${minisignBin}`);
if (minisignBin && !keyPath) die("用 --minisign 时必须同时给 --key <私钥文件>");

/** 找到真正是插件的目录（含 manifest.json）。 */
function expand(dirs) {
  const out = [];
  for (const d of dirs) {
    if (existsSync(join(d, "manifest.json"))) {
      out.push(d);
      continue;
    }
    // 目录集合（例如 examples/plugins）：只收下一层里含 manifest.json 的
    const listed = existsSync(d) ? execFileSync("ls", ["-1", d], { encoding: "utf8" }).split("\n").filter(Boolean) : [];
    for (const name of listed) {
      const child = join(d, name);
      if (existsSync(join(child, "manifest.json"))) out.push(child);
    }
  }
  if (!out.length) die(`没有找到任何插件目录（给的是：${dirs.join(", ")}）`);
  return out;
}

/** 打包前必须过作者 CLI：发出去的包不能是"装了但什么也没有"的废品。 */
function validate(dir) {
  try {
    execFileSync("node", [join(root, "scripts", "plugin-cli.mjs"), "validate", dir], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
  } catch (e) {
    const detail = (e.stdout ?? "") + (e.stderr ?? "");
    die(`插件校验不通过，拒绝打包：${dir}\n${detail.trim()}`);
  }
}

/**
 * 打包（包内根目录就是插件目录——规范允许"多一层同名目录"，应用会自动下钻）。
 *
 * **为什么不用命令行的 `zip`**：Windows 上没有它。之前这里 shell out 到 `zip`，
 * 于是在 Windows 侧 `pnpm test` 有 3 条红（`spawnSync zip ENOENT`），而且其中一条
 * 「找不到插件目录」是被连带打死的——它本该测的东西在那边**永远测不到**（报这个的是 Windows 侧，
 * 附了原始栈）。现在改用仓库里**已有的** `fflate`（浏览器侧的备份/工作区导出就是它）：
 * 零新依赖、两平台一致、且不依赖 PATH 上有什么。
 *
 * 写入时间固定为常量：同样的输入产出同样的字节，sha256 才能复现
 * （发布产物要能事后对账，别让"打包时间"跑进哈希里）。
 */
const FIXED_MTIME = new Date(Date.UTC(2020, 0, 1, 0, 0, 0));
function pack(dir, zipPath) {
  const root = basename(dir);
  const files = {};
  const walk = (abs, rel) => {
    for (const name of readdirSync(abs)) {
      if (name === ".DS_Store") continue;
      const childAbs = join(abs, name);
      const childRel = `${rel}/${name}`;
      if (statSync(childAbs).isDirectory()) walk(childAbs, childRel);
      else files[childRel] = [new Uint8Array(readFileSync(childAbs)), { mtime: FIXED_MTIME }];
    }
  };
  walk(dir, root);
  writeFileSync(zipPath, Buffer.from(zipSync(files, { level: 6 })));
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

mkdirSync(outDir, { recursive: true });

// 签名方式的准备：一次性密钥（自检）或 minisign 本体（正式）。
let key = null;
let pubText = "";
if (ephemeral) {
  key = generateEphemeralKeypair();
  pubText = key.pubText;
  info("⚠️ 自检模式：用一次性密钥签名。产物**不可用于正式发布**（公钥每次都变）。");
} else if (minisignBin) {
  const derivedPub = pubPath ?? keyPath.replace(/\.key$/, ".pub");
  if (!existsSync(derivedPub)) die(`找不到公钥文件：${derivedPub}（用 --pub 指定）`);
  pubText = readFileSync(derivedPub, "utf8");
  info(`用 minisign 签名：${minisignBin}（公钥 ${derivedPub}）`);
} else {
  info("dry-run：只打包与算哈希，不签名。");
}

const dirs = expand(pluginDirs).sort();
info(`共 ${dirs.length} 个插件，输出到 ${outDir}`);

const entries = [];
for (const dir of dirs) {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const id = manifest.id;
  const pluginVersion = manifest.version ?? "0.0.0";
  validate(dir);

  const zipName = `${id}-${pluginVersion}.zip`;
  const zipPath = join(outDir, zipName);
  pack(dir, zipPath);
  const bytes = readFileSync(zipPath);
  const size = statSync(zipPath).size;

  const entry = {
    id,
    name: manifest.name ?? id,
    version: pluginVersion,
    apiVersion: manifest.apiVersion ?? "1.0.0",
    minAppVersion,
    runtime: "logic",
    description: manifest.description ?? "",
    publisher: flag("--publisher", "ShuyoNote"),
    license: manifest.license ?? flag("--license", "AGPL-3.0"),
    permissions: (manifest.permissions ?? []).map((p) => ({
      id: p.id,
      // 权限理由是**给用户看的**：作者没写就如实说明，不留空（空着会被读成"不要权限"）
      reason: p.reason || "（作者没写理由）",
    })),
    downloadUrl: `${urlBase}/${zipName}`,
    size,
    sha256: sha256(bytes),
    publisherKey: pubText,
    signature: "",
  };

  if (!dryRun) {
    if (ephemeral) {
      entry.signature = signBytes(bytes, { privateKey: key.privateKey, keyId: key.keyId, fileName: zipName });
    } else {
      execFileSync(minisignBin, ["-Sm", zipPath, "-s", keyPath], { stdio: ["ignore", "pipe", "pipe"] });
      const sigPath = `${zipPath}.minisig`;
      if (!existsSync(sigPath)) die(`minisign 没有产出签名：${sigPath}`);
      entry.signature = readFileSync(sigPath, "utf8");
    }
    writeFileSync(`${zipPath}.minisig`, entry.signature, "utf8");
  }

  entries.push(entry);
  info(
    `  ${id} v${pluginVersion} → ${zipName}（${size} 字节，sha256 ${entry.sha256.slice(0, 12)}…，` +
      `${entry.permissions.length} 项权限${dryRun ? "，未签名" : ""}）`,
  );
}

const fragment = {
  fragmentVersion: 1,
  generatedAt: new Date().toISOString(),
  appVersion: version,
  urlBase,
  minAppVersion,
  plugins: entries,
};
const fragmentPath = join(outDir, "plugin-index.fragment.json");
writeFileSync(fragmentPath, JSON.stringify(fragment, null, 2) + "\n", "utf8");

// 一份**完整可用**的索引（占位 owner）：用来本机验签与试装。
// 注意正式索引由**社区**用自己的密钥签，这份只是为了本机验证。
const preview = {
  indexVersion: 1,
  owner: { id: "preview", name: "本机验证（占位 owner）", url: "https://example.com/" },
  generatedAt: fragment.generatedAt,
  plugins: entries,
};
const previewPath = join(outDir, "plugin-index.preview.json");
writeFileSync(previewPath, JSON.stringify(preview, null, 2) + "\n", "utf8");
if (!dryRun) {
  const indexBytes = readFileSync(previewPath);
  const sig = ephemeral
    ? signBytes(indexBytes, { privateKey: key.privateKey, keyId: key.keyId, fileName: "plugin-index.preview.json" })
    : (() => {
        execFileSync(minisignBin, ["-Sm", previewPath, "-s", keyPath], { stdio: ["ignore", "pipe", "pipe"] });
        return readFileSync(`${previewPath}.minisig`, "utf8");
      })();
  writeFileSync(`${previewPath}.minisig`, sig, "utf8");
  if (pubText) {
    const fp = fingerprintOf(pubText);
    writeFileSync(join(outDir, "publisher.pub"), pubText, "utf8");
    info(`发布者公钥指纹：${fp}`);
  }
}

info(`片段：${fragmentPath}`);
info(`预览索引：${previewPath}`);
info(
  [
    "交出去之前请用应用真正的解析器验一遍：",
    `  SHUYONOTE_INDEX_FIXTURE=${previewPath} cargo test --lib external_index -- --ignored --nocapture`,
    "再把 preview 索引的地址粘进应用的插件管理面板走一遍「订阅 → 安装」（那份索引只用于本机验证，别对外托管）。",
  ].join("\n"),
);
