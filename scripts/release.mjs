// Auto-update release pipeline — sign + build installers + emit `latest.json` (the
// Tauri updater manifest) so the in-app "检查更新 → 下载并安装" can find new
// releases. Requires the signing private key (env), generated once with:
//   pnpm tauri signer generate -w ~/.tauri/shuyonote.key   # keep secret
// and the PUBLIC key written to src-tauri/tauri.conf.json → plugins.updater.pubkey.
//
// Usage:
//   TAURI_SIGNING_PRIVATE_KEY=<...> TAURI_SIGNING_PRIVATE_KEY_PASSWORD=<...> \
//     UPDATE_BASE_URL=https://<your-host>/shuyonote/updates node scripts/release.mjs
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, basename } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.version;

// ---- prerequisites ----
const key = process.env.TAURI_SIGNING_PRIVATE_KEY;
if (!key) {
  console.error("[release] 缺少 TAURI_SIGNING_PRIVATE_KEY。");
  console.error("  ① 生成签名私钥（保密）：pnpm tauri signer generate -w ~/.tauri/shuyonote.key");
  console.error("  ② 把公钥写进 src-tauri/tauri.conf.json 的 plugins.updater.pubkey");
  console.error("  ③ 设置环境变量后重跑本脚本。");
  process.exit(1);
}
const confPath = join(root, "src-tauri", "tauri.conf.json");
const conf = JSON.parse(readFileSync(confPath, "utf8"));
const pubKey = conf?.plugins?.updater?.pubkey ?? "";
if (!pubKey) {
  console.error("[release] tauri.conf.json 缺 plugins.updater.pubkey（写入用 tauri signer generate 生成的公钥）。");
  process.exit(1);
}
if (pubKey.includes("RWQxMjM0NTY3")) {
  console.warn("[release] ⚠️ 当前 plugins.updater.pubkey 仍是占位符，请替换为你的真实公钥，否则无法校验更新签名。");
}

// ---- sign + build installers (createUpdaterArtifacts -> .sig next to bundles) ----
console.log(`[release] 构建 v${version}（签名）…`);
execSync(`pnpm tauri build`, { stdio: "inherit", env: process.env });

// ---- collect bundle artifacts + their .sig ----
const bundleDir = join(root, "src-tauri", "target", "release", "bundle");
const found = [];
for (const plat of ["nsis", "msi", "dmg", "appimage", "deb", "rpm"]) {
  const dir = join(bundleDir, plat);
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir)) {
    const full = join(dir, f);
    if (/\.(exe|msi|dmg|appimage|deb|rpm)$/i.test(f)) {
      const sigFile = full + ".sig";
      const sig = existsSync(sigFile) ? readFileSync(sigFile, "utf8").trim() : "";
      if (!sig) console.warn(`[release] ⚠️ 缺少签名文件：${f}.sig（检查签名密钥/产物）`);
      found.push({ file: full, name: f, size: statSync(full).size, sig });
    }
  }
}
if (found.length === 0) {
  console.error("[release] 未找到安装包产物。");
  process.exit(1);
}

// ---- emit latest.json (Tauri updater manifest) ----
const base = (process.env.UPDATE_BASE_URL || "https://gitcode.com/shuyo-cn/ShuyoNote/releases/latest/download").replace(/\/$/, "");
const platformKeyFor = (name) => {
  if (/\.(exe|msi)$/i.test(name)) return "windows-x86_64";
  if (/\.dmg$/i.test(name)) return /aarch64|arm64/i.test(name) ? "darwin-aarch64" : "darwin-x86_64";
  if (/\.appimage$/i.test(name)) return /aarch64|arm64/i.test(name) ? "linux-aarch64" : "linux-x86_64";
  if (/\.(deb|rpm|tar\.gz|tar\.xz)$/i.test(name)) return "linux-x86_64";
  return null;
};
const platforms = {};
for (const a of found) {
  const keyy = platformKeyFor(a.name);
  if (!keyy) continue;
  platforms[keyy] = { signature: a.sig, url: `${base}/${a.name}` };
}
const manifest = { version, notes: `ShuyoNote v${version}`, pub_date: new Date().toISOString(), platforms };
const manifestPath = join(root, "latest.json");
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

// ---- summary ----
console.log("\n[release] 完成 ✅");
console.log(`  版本：v${version}`);
console.log(`  产物：${found.map((a) => `${a.name} (${(a.size / 1024 / 1024).toFixed(1)}MB${a.sig ? ", 已签名" : ", 缺签名"})`).join("；")}`);
console.log(`  更新清单：${manifestPath}`);
console.log("\n发布步骤：");
console.log("  1) 上传产物 + latest.json 到你的更新托管（如 gitcode releases / CDN / 自建静态服务器）。");
console.log("  2) 把 tauri.conf.json 的 plugins.updater.endpoints 指向该 latest.json 的实际URL。");
console.log("  3) 若用 gitcode releases，把 UPDATE_BASE_URL 设为可下载直链前缀。");
