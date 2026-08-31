// ShuyoNote 桌面版自动发布脚本（gitcode）。
//
// 完整流水线：校验签名密钥/公钥 → `pnpm tauri build`（签名）→ 收集安装包+.sig
//           → 生成 latest.json（Tauri updater 清单）→ 发布到 gitcode：
//             建 release v<version>、上传 installer/.sig/latest.json、
//             更新「latest」auto-update 通道、UTF-8 修正正文。
//
// 用法：
//   GITCODE_TOKEN=<令牌> TAURI_SIGNING_PRIVATE_KEY=<...> \
//   TAURI_SIGNING_PRIVATE_KEY_PASSWORD=<...> RELEASE_NOTES="ShuyoNote v1.64.x" \
//   node scripts/release.mjs [--dry-run] [--body <文件.md>]
//
// 密钥一次性生成（保密）：pnpm tauri signer generate -w ~/.tauri/shuyonote.key
// 公钥写入 src-tauri/tauri.conf.json → plugins.updater.pubkey。
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, basename } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.version;
const DRY = process.argv.includes("--dry-run");

// ---- 前置：签名私钥 + 公钥 ----
const key = process.env.TAURI_SIGNING_PRIVATE_KEY;
if (!key) {
  console.error("[release] 缺 TAURI_SIGNING_PRIVATE_KEY（保密私钥）。");
  process.exit(1);
}
const conf = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const pubKey = conf?.plugins?.updater?.pubkey ?? "";
if (!pubKey) { console.error("[release] tauri.conf.json 缺 plugins.updater.pubkey。"); process.exit(1); }
if (pubKey.includes("RWQxMjM0NTY3")) console.warn("[release] ⚠️ pubkey 仍是占位符，请替换为真实公钥。");

const token = process.env.GITCODE_TOKEN;
if (!token && !DRY) { console.error("[release] 发布需 GITCODE_TOKEN（--dry-run 可跳过）。"); process.exit(1); }
const OWNER = process.env.GITCODE_OWNER ?? "shuyo-cn";
const REPO = process.env.GITCODE_REPO ?? "ShuyoNote";
const API = `https://gitcode.com/api/v5/repos/${OWNER}/${REPO}`;
const GH = { "PRIVATE-TOKEN": token, Authorization: `Bearer ${token}` };
const J = { ...GH, "Content-Type": "application/json; charset=utf-8" };

async function apiFetch(method, url, body) {
  const opts = { method, headers: method === "GET" ? GH : J };
  if (body !== undefined) opts.body = body;
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`${r.status} ${method} ${url}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

// ---- 构建 + 签名 ----
console.log(`[release] 构建 v${version}（签名）…`);
if (!DRY) execSync(`pnpm tauri build`, { stdio: "inherit", env: process.env });

// ---- 收集安装包 + .sig ----
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
      if (!sig) console.warn(`[release] ⚠️ 缺签名文件：${f}.sig`);
      found.push({ file: full, name: f, size: statSync(full).size, sig });
    }
  }
}
if (found.length === 0) { console.error("[release] 未找到安装包产物。"); process.exit(1); }

const platformKeyFor = (name) => {
  if (/\.(exe|msi)$/i.test(name)) return "windows-x86_64";
  if (/\.dmg$/i.test(name)) return /aarch64|arm64/i.test(name) ? "darwin-aarch64" : "darwin-x86_64";
  if (/\.appimage$/i.test(name)) return /aarch64|arm64/i.test(name) ? "linux-aarch64" : "linux-x86_64";
  if (/\.(deb|rpm|tar\.gz|tar\.xz)$/i.test(name)) return "linux-x86_64";
  return null;
};

// ---- 生成 latest.json（updater 清单）----
const notes = process.env.RELEASE_NOTES ?? `ShuyoNote v${version}`;
const platforms = {};
for (const a of found) {
  const keyy = platformKeyFor(a.name);
  if (!keyy) continue;
  const url = `https://gitcode.com/${OWNER}/${REPO}/releases/download/v${version}/${a.name}`;
  platforms[keyy] = { signature: a.sig, url };
}
const manifestPath = join(root, "src-tauri", "target", "release", "latest.json");
writeFileSync(manifestPath, JSON.stringify({ version, notes, pub_date: new Date().toISOString(), platforms }, null, 2) + "\n");
console.log(`[release] latest.json → ${manifestPath}`);

// ---- 发布到 gitcode ----
if (DRY) {
  console.log("[release] --dry-run：跳过发布。产物与清单已就绪。");
  console.log(`  平台：${Object.keys(platforms).join(", ")}`);
  process.exit(0);
}
const TAG = "v" + version;
async function uploadFile(releaseTag, name, path) {
  const up = await apiFetch("GET", `${API}/releases/${releaseTag}/upload_url?file_name=${encodeURIComponent(name)}`);
  const r = await fetch(up.url, { method: "PUT", headers: up.headers ?? {}, body: readFileSync(path) });
  if (!r.ok) throw new Error(`${r.status} PUT ${name}`);
  console.log(`  上传 ${name}`);
  await new Promise((res) => setTimeout(res, 500)); // 等 OBS 回调
}
async function deleteAttach(releaseTag, name) {
  const rel = await apiFetch("GET", `${API}/releases/tags/${releaseTag}`);
  for (const a of rel.assets ?? []) {
    if (a.type === "attach" && a.name === name) {
      await apiFetch("DELETE", `${API}/releases/${releaseTag}/attach_files/${a.id}`);
      console.log(`  删除 ${name}@${releaseTag}`);
      return;
    }
  }
}
const bi = process.argv.indexOf("--body");
const body = bi >= 0 && process.argv[bi + 1]
  ? readFileSync(process.argv[bi + 1], "utf8")
  : `# ShuyoNote v${version}\n\n${notes}\n\n## 安装（Windows x64）\n下载 \`ShuyoNote_${version}_x64-setup.exe\` 运行即可。`;

try {
  await apiFetch("GET", `${API}/releases/tags/${TAG}`);
} catch {
  await apiFetch("POST", `${API}/releases`, JSON.stringify({ tag_name: TAG, name: `ShuyoNote v${version}`, body, prerelease: false }));
  console.log(`  创建 release ${TAG}`);
}
for (const a of found) {
  if (a.sig) {
    await uploadFile(TAG, a.name, a.file);
    await uploadFile(TAG, a.name + ".sig", a.file + ".sig");
  }
}
await uploadFile(TAG, "latest.json", manifestPath);
await deleteAttach("latest", "latest.json");
await uploadFile("latest", "latest.json", manifestPath);
await apiFetch("PATCH", `${API}/releases/${TAG}`, JSON.stringify({ name: `ShuyoNote v${version}`, body }));
console.log(`[release] 完成 ✅ v${version}（含 latest 通道）`);

console.log("\n发布后：git tag v" + version + " && git push origin v" + version + " && git push origin main");
