// 版本号一致性检查：比对 development.md §5 定义的版本号文件。
// 用法：node scripts/check-versions.mjs  （任何一处不一致即非零退出）
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => {
  try {
    return readFileSync(resolve(root, p), "utf8");
  } catch {
    return "";
  }
};

const errors = [];

// 1. package.json —— 版本事实源
let ver = "";
try {
  ver = JSON.parse(read("package.json")).version;
} catch {
  /* handled below */
}
if (!ver) {
  console.error("package.json 缺少 version");
  process.exit(1);
}

// 2. src-tauri/Cargo.toml
const cargoVer = read("src-tauri/Cargo.toml").match(/^version\s*=\s*"([^"]+)"/m)?.[1];
if (cargoVer !== ver) errors.push(`src-tauri/Cargo.toml: ${cargoVer} != ${ver}`);

// 3. src-tauri/tauri.conf.json
let confVer = "";
try {
  confVer = JSON.parse(read("src-tauri/tauri.conf.json")).version;
} catch {
  /* handled below */
}
if (confVer !== ver) errors.push(`src-tauri/tauri.conf.json: ${confVer} != ${ver}`);

// 4. README.md 徽章 version-X.Y.Z-
const readmeVer = read("README.md").match(/version-([0-9]+(?:\.[0-9]+)+)-/)?.[1];
if (readmeVer !== ver) errors.push(`README.md badge: ${readmeVer} != ${ver}`);

// 5. docs/README.md 当前 `vX.Y.Z`
const docsVer = read("docs/README.md").match(/当前\s*`v([0-9]+(?:\.[0-9]+)+)`/)?.[1];
if (docsVer && docsVer !== ver) errors.push(`docs/README.md: ${docsVer} != ${ver}`);

// 6. CHANGELOG.md 顶部 ## [X.Y.Z]
const changelogVer = read("CHANGELOG.md").match(/^##\s*\[([0-9]+(?:\.[0-9]+)+)\]/m)?.[1];
if (changelogVer && changelogVer !== ver) errors.push(`CHANGELOG.md top: ${changelogVer} != ${ver}`);

// 7. src-tauri/Cargo.lock —— shuyonote package 的 version
const lockVer = read("src-tauri/Cargo.lock").match(/name\s*=\s*"shuyonote"\s*\nversion\s*=\s*"([^"]+)"/)?.[1];
if (lockVer && lockVer !== ver) errors.push(`src-tauri/Cargo.lock: ${lockVer} != ${ver}`);

if (errors.length) {
  console.error(`版本号不一致（期望 ${ver}）：`);
  for (const e of errors) console.error("  - " + e);
  process.exit(1);
}
console.log(`版本号一致：${ver}`);
