// ShuyoNote 桌面版自动发布脚本（gitcode）。
//
// 完整流水线：校验签名密钥/公钥 → `pnpm tauri build`（签名）→ 收集安装包+.sig
//           → 逐项校验（版本号整词匹配 / 同平台歧义 / 缺签名 / .sig 与字节互验 /
//             线上 latest.json 的平台覆盖）→ 生成 latest.json（Tauri updater 清单）
//           → 发布到 gitcode：建 release v<version>、上传 installer/.sig/latest.json、
//             更新「latest」auto-update 通道。
// 检查明细见 docs/RELEASING.md ⑥；纯逻辑与单测在 scripts/lib/releaseArtifacts.mjs。
//
// 用法：
//   GITCODE_TOKEN=<令牌> TAURI_SIGNING_PRIVATE_KEY=<...> \
//   TAURI_SIGNING_PRIVATE_KEY_PASSWORD=<...> RELEASE_NOTES="ShuyoNote v1.64.x" \
//   node scripts/release.mjs [--dry-run] [--body <文件.md>] [--artifacts a.exe,b.deb]
//
// 可选参数：
//   --dry-run               只收集/校验/写清单，不发布
//   --no-build              跳过 `pnpm tauri build`（产物已就绪时用）
//   --artifacts <名字,…>    显式指定要发布的产物（替代「文件名含版本号」自动挑选）
//   --allow-platform-drop   允许本次清单丢掉线上已有的平台键（默认禁止）
//   --skip-sig-verify       跳过「.sig 确实是这些字节的签名」校验（不建议）
//
// 密钥一次性生成（保密）：pnpm tauri signer generate -w ~/.tauri/shuyonote.key
// 公钥写入 src-tauri/tauri.conf.json → plugins.updater.pubkey。
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import {
  INSTALLER_DIRS,
  coverageProblems,
  fmtSize,
  fmtTime,
  manifestPicks,
  selectArtifacts,
  sha256File,
  verifyArtifactSignature,
} from "./lib/releaseArtifacts.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.version;
const TAG = "v" + version;
const DRY = process.argv.includes("--dry-run");
const NO_BUILD = process.argv.includes("--no-build");

// ---- 前置：git tag vX.Y.Z 必须已存在并推到远程 ----
// gitcode 的 release 创建 API 用 tag_name 定位 tag；tag 不存在会「静默失败」
// （release 未建、latest.json 不更新，客户端就查不到更新——曾实际踩坑）。
// 这里在发布前尽早拦住，而不是等发布后才发现查不到更新。
try {
  execSync(`git rev-parse --verify --quiet refs/tags/${TAG}`, { stdio: "ignore" });
} catch {
  console.error(`[release] 本地缺少 git tag ${TAG}。请先：git tag ${TAG} && git push origin ${TAG} 再发布。`);
  process.exit(1);
}
try {
  const remote = execSync(`git -c http.proxy= -c https.proxy= ls-remote --tags origin ${TAG}`, { encoding: "utf8" }).trim();
  if (!remote) {
    console.error(`[release] 远程缺少 git tag ${TAG}。请先：git push origin ${TAG} 再发布。`);
    process.exit(1);
  }
} catch {
  console.error(`[release] 无法确认远程 tag ${TAG}（网络/认证）。请先：git push origin ${TAG} 再发布。`);
  process.exit(1);
}


// ---- 前置：签名私钥 + 公钥 ----
// 私钥只在**本机构建并签名**时才用得到（`pnpm tauri build` 从 env 读它）。
// `--no-build` 走的正是 docs/RELEASING.md ⑤/⑥ 那条路：产物已由 GitHub Actions
// （或 Windows 机器）用同一把密钥签好，本机只负责「发布」——此时本机没有私钥是正常的，
// 不该因此拦住发布。缺私钥 + 需要构建 = 真问题；缺私钥 + 不构建 = 正常。
const key = process.env.TAURI_SIGNING_PRIVATE_KEY;
if (!key && !NO_BUILD) {
  console.error("[release] 缺 TAURI_SIGNING_PRIVATE_KEY（保密私钥）。");
  process.exit(1);
}
if (!key && NO_BUILD) {
  console.log("[release] --no-build：本机不签名，跳过私钥检查（产物必须自带 .sig）。");
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
console.log(`[release] ${NO_BUILD ? "跳过构建（--no-build，产物须已就绪）" : `构建 v${version}（签名）`}…`);
if (!DRY && !NO_BUILD) execSync(`pnpm tauri build`, { stdio: "inherit", env: process.env });

// ---- 收集候选产物 ----
const argOf = (flag) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const explicit = (argOf("--artifacts") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const SKIP_SIG = process.argv.includes("--skip-sig-verify");
const ALLOW_DROP = process.argv.includes("--allow-platform-drop");

const bundleDir = join(root, "src-tauri", "target", "release", "bundle");
const entries = [];
for (const dir of INSTALLER_DIRS) {
  const d = join(bundleDir, dir);
  if (!existsSync(d)) continue;
  for (const name of readdirSync(d)) {
    const file = join(d, name);
    const st = statSync(file);
    if (!st.isFile()) continue; // AppDir/、解包目录等中间产物
    const sigPath = file + ".sig";
    const hasSig = existsSync(sigPath);
    entries.push({
      dir,
      name,
      file,
      size: st.size,
      mtimeMs: st.mtimeMs,
      sigPath: hasSig ? sigPath : null,
      sigText: hasSig ? readFileSync(sigPath, "utf8") : null,
    });
  }
}

const { picked, problems, warnings } = selectArtifacts({ entries, version, explicit });
for (const w of warnings) console.warn(`[release] ⚠️ ${w}`);
// 一次列全所有问题再中止（歧义/缺签名/什么都没找到），不用反复试
if (problems.length > 0) {
  console.error(`[release] 产物检查未通过（${problems.length} 项）：`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error("[release] 未做任何发布。");
  process.exit(1);
}
console.log(`[release] 选中 ${picked.length} 个产物：${picked.map((a) => a.name).join("、")}`);

// ---- 校验 .sig 确实是这些字节的签名（Tauri 更新器做的就是这件事）----
// 拦的是「安装包与 .sig 不是同一次构建的一对」——这种事故发布时毫无征兆，
// 只在用户点「检查更新」时才炸。Tauri 用 minisign 预哈希模式：BLAKE2b-512 + ed25519。
if (!SKIP_SIG) {
  console.log("[release] 校验签名…");
  const bad = [];
  for (const a of picked) {
    const r = await verifyArtifactSignature({ filePath: a.file, sigText: a.sigText, publicKey: pubKey });
    if (r.status === "ok") console.log(`  ✓ ${a.name}`);
    else if (r.status === "unsupported") console.warn(`  ⚠️ ${a.name}：${r.detail}（跳过校验，不阻断）`);
    else {
      console.error(`  ✗ ${a.name}：${r.detail}`);
      bad.push(a.name);
    }
  }
  if (bad.length > 0) {
    console.error(`[release] ${bad.length} 个产物的签名校验失败，已中止（发布出去会让用户更新时报校验错误）。`);
    process.exit(1);
  }
} else {
  console.warn("[release] ⚠️ --skip-sig-verify：跳过签名校验（发布风险自负）。");
}

// ---- 指纹（事后可与 CI 产物逐个比对）----
console.log("[release] 产物指纹（sha256）：");
for (const a of picked) {
  a.sha256 = await sha256File(a.file);
  console.log(`  ${a.sha256}  ${fmtSize(a.size).padStart(9)}  ${fmtTime(a.mtimeMs)}  ${a.name}`);
}

// ---- 生成 latest.json（updater 清单）----
// 同一平台键只能留一个 url：取哪个由 manifestPicks 写死偏好，不靠遍历顺序。
const { picks, notes } = manifestPicks(picked);
for (const n of notes) console.log(`[release] ${n}`);
const notes_ = process.env.RELEASE_NOTES ?? `ShuyoNote v${version}`;
const platforms = {};
for (const [key, a] of picks) {
  platforms[key] = {
    signature: a.sigText.trim(),
    url: `https://gitcode.com/${OWNER}/${REPO}/releases/download/${TAG}/${a.name}`,
  };
}

// ---- 平台覆盖检查：别把线上已有的平台键悄悄砍掉 ----
// 少一个键 = 该平台用户从此收不到更新，而且没有任何报错。
const prevManifestUrl = `https://gitcode.com/${OWNER}/${REPO}/releases/download/latest/latest.json`;
let prevKeys = [];
try {
  const r = await fetch(prevManifestUrl, { headers: { "User-Agent": "ShuyoNote-release" } });
  if (r.status === 404) {
    console.log("[release] 线上还没有 latest 清单（首次发布），跳过平台覆盖检查。");
  } else if (!r.ok) {
    throw new Error(`${r.status} GET latest.json`);
  } else {
    const prev = JSON.parse(await r.text());
    prevKeys = Object.keys(prev.platforms ?? {});
    console.log(`[release] 线上清单 v${prev.version}：${prevKeys.join(", ") || "(无平台)"}`);
  }
} catch (e) {
  if (DRY) console.warn(`[release] ⚠️ 读不到线上 latest.json（${e.message}），--dry-run 下跳过覆盖检查。`);
  else {
    console.error(`[release] 读不到线上 latest.json（${e.message}）：无法确认不会砍掉某个平台的更新通道。`);
    console.error("[release] 网络确实不通时可用 --allow-platform-drop 明确接受风险。");
    process.exit(1);
  }
}
const dropped = coverageProblems({ previousKeys: prevKeys, nextKeys: Object.keys(platforms) });
if (dropped.length > 0) {
  if (ALLOW_DROP) for (const d of dropped) console.warn(`[release] ⚠️ --allow-platform-drop：${d}`);
  else {
    for (const d of dropped) console.error(`  ✗ ${d}`);
    console.error(`[release] 本次清单只有 ${Object.keys(platforms).join(", ")}，已中止；确认要这样发就加 --allow-platform-drop。`);
    process.exit(1);
  }
}

const manifestPath = join(root, "src-tauri", "target", "release", "latest.json");
writeFileSync(manifestPath, JSON.stringify({ version, notes: notes_, pub_date: new Date().toISOString(), platforms }, null, 2) + "\n");
console.log(`[release] latest.json → ${manifestPath}（${Object.keys(platforms).join(", ")}）`);
const auditPath = join(root, "src-tauri", "target", "release", "release-artifacts.json");
writeFileSync(
  auditPath,
  JSON.stringify({ version, tag: TAG, at: new Date().toISOString(), artifacts: picked.map(({ name, size, sha256, dir }) => ({ name, dir, size, sha256 })) }, null, 2) + "\n",
);
console.log(`[release] 产物指纹清单 → ${auditPath}`);

// ---- 发布到 gitcode ----
if (DRY) {
  console.log("[release] --dry-run：跳过发布。产物与清单已就绪。");
  console.log(`  平台：${Object.keys(platforms).join(", ")}`);
  process.exit(0);
}
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
  : `# ShuyoNote v${version}\n\n${notes_}\n\n## 安装（Windows x64）\n下载 \`ShuyoNote_${version}_x64-setup.exe\` 运行即可。`;

try {
  await apiFetch("GET", `${API}/releases/tags/${TAG}`);
} catch {
  await apiFetch("POST", `${API}/releases`, JSON.stringify({ tag_name: TAG, name: `ShuyoNote v${version}`, body, prerelease: false }));
  console.log(`  创建 release ${TAG}`);
}
for (const a of picked) {
  await uploadFile(TAG, a.name, a.file);
  await uploadFile(TAG, a.name + ".sig", a.sigPath);
}
await uploadFile(TAG, "latest.json", manifestPath);
// 确保 `latest`（auto-update 通道）release 存在：首次发布时 gitcode 可能只有
// `latest` 这个 git tag、尚无对应 release，`GET /releases/tags/latest` 会 404，
// 导致 deleteAttach 报错中断。不存在则先创建，再更新其 latest.json。
try {
  await apiFetch("GET", `${API}/releases/tags/latest`);
} catch {
  await apiFetch("POST", `${API}/releases`, JSON.stringify({ tag_name: "latest", name: "ShuyoNote latest", body: "最新版本（auto-update 通道）", prerelease: false }));
  console.log("  创建 release latest");
}
await deleteAttach("latest", "latest.json");
await uploadFile("latest", "latest.json", manifestPath);
await apiFetch("PATCH", `${API}/releases/${TAG}`, JSON.stringify({ name: `ShuyoNote v${version}`, body }));
console.log(`[release] 完成 ✅ v${version}（含 latest 通道）`);

console.log("\n发布后：git tag v" + version + " && git push origin v" + version + " && git push origin main");
