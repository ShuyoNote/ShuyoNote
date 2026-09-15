#!/usr/bin/env node
// 从一次 **Release 流水线**里取产物、校验字节指纹、解包、并按 `release.mjs` 期望的目录落位。
//
// 为什么要有这条命令：这一步原先全手工（runbook ⑤ 给的是 GitHub API + jq + unzip 的几行），
// 2026-09-15 发 1.91.1 时手工做踩了三个坑，每个都让流程卡住：
//   ① GitHub 单连接 ~40KB/s，330MB 的 Linux bundle 要几十分钟，而工具调用有 10 分钟上限；
//   ② 分片下载被中断后要能**续传**（第一版把不完整的分片删了重下）；
//   ③ 拼装/解包的辅助 .ps1 因编码问题在 PowerShell 5.1 里解析失败（无 BOM 的 UTF-8 中文）。
// 于是这里用 Node 自己走完整流程：分片并行 + 断点续传 + 按 digest 校验 + 零依赖解包
// （scripts/lib/zip.mjs）。取完 APK **立刻验字节**（v1.91.0 闪退的产物级判据）。
//
// 用法：
//   node scripts/fetch-release-artifacts.mjs --tag v1.91.1            # 自动找该 tag 的 run
//   node scripts/fetch-release-artifacts.mjs --run 34919151353
//   node scripts/fetch-release-artifacts.mjs --tag v1.91.1 --stage    # 顺带落位到 bundle/
// 产物落在 `tmp/release-<tag 或 run>/`；`--stage` 把 nsis/deb/appimage 复制进
// `src-tauri/target/release/bundle/`（`release.mjs` 就从那里按版本号整词匹配挑产物）。
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  openSync,
  readSync,
  writeSync,
  closeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join, basename, dirname } from "node:path";
import { listZipEntries, readZipEntry } from "./lib/zip.mjs";

const argOf = (f) => {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const STAGE = process.argv.includes("--stage");
const RUN = argOf("--run");
const TAG = argOf("--tag") ? `v${String(argOf("--tag")).replace(/^v/, "")}` : null;
const PARTS = Number(argOf("--parts") ?? 8);
const WANT = /^(bundle-|android-release-apk)/;
const SUBS = ["nsis", "deb", "appimage", "rpm", "dmg", "msi"];

if (!RUN && !TAG) {
  console.error("用法: node scripts/fetch-release-artifacts.mjs --tag v1.91.1 [--stage] 或 --run <id>");
  process.exit(2);
}

function token() {
  try {
    const creds = readFileSync(`${process.env.USERPROFILE ?? process.env.HOME}/.git-credentials`, "utf8");
    const tk = (creds.match(/ghp_[A-Za-z0-9]{36}/) ?? [])[0];
    if (!tk) throw new Error("文件里没有 ghp_ 开头的 token");
    return tk;
  } catch (e) {
    console.error(`✗ 读不到 GitHub token（~/.git-credentials）：${e.message}`);
    process.exit(1);
  }
}
const H = { Authorization: `Bearer ${token()}`, Accept: "application/vnd.github+json" };
const REPO = "ShuyoNote/ShuyoNote";

async function api(path) {
  const r = await fetch(`https://api.github.com/repos/${REPO}${path}`, { headers: H });
  if (!r.ok) throw new Error(`GitHub API ${path} → HTTP ${r.status}`);
  return r.json();
}

/** 分片并行 + 断点续传下载，并按期望 sha256 校验整包。 */
async function fetchVerified(url, size, expectSha, destFile, partsDir) {
  const shaOf = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
  if (existsSync(destFile) && shaOf(destFile) === expectSha) {
    console.log(`  · 已存在且指纹一致，跳过下载：${basename(destFile)}`);
    return;
  }
  mkdirSync(partsDir, { recursive: true });
  const chunk = Math.ceil(size / PARTS);
  const jobs = [];
  for (let i = 0; i < PARTS; i++) {
    const start = i * chunk;
    const end = Math.min(start + chunk - 1, size - 1);
    if (start > end) continue;
    const file = join(partsDir, `${String(i).padStart(2, "0")}.part`);
    const want = end - start + 1;
    const have = existsSync(file) ? statSync(file).size : 0;
    jobs.push({ i, file, from: start + have, end, want, have, got: have });
  }
  let done = jobs.reduce((a, j) => a + j.got, 0);
  await Promise.all(
    jobs.map(async (j) => {
      if (j.have === j.want) return;
      if (j.have === 0) writeFileSync(j.file, Buffer.alloc(0));
      const r = await fetch(url, { headers: { ...H, Range: `bytes=${j.from}-${j.end}` } });
      if (!r.ok && r.status !== 206) throw new Error(`分片 ${j.i} HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (j.have === 0) writeFileSync(j.file, buf);
      else writeFileSync(j.file, Buffer.concat([readFileSync(j.file), buf]));
      done += buf.length;
      process.stdout.write(`\r  下载 ${basename(destFile)}：${Math.round((done / size) * 100)}%   `);
    }),
  );
  process.stdout.write("\n");
  // 拼装：用 fd + 分块写，不用 pipeline —— 8 个并发 pipeline 会堆出 EventEmitter 监听器警告，
  // 而且这里本来就是"顺序追加"，一个 fd 更直白。
  const fd = openSync(destFile, "w");
  try {
    const CH = 8 * 1024 * 1024;
    for (const j of [...jobs].sort((a, b) => a.i - b.i)) {
      const sz = statSync(j.file).size;
      if (sz !== j.want) throw new Error(`分片 ${j.i} 长度不对：${sz} != ${j.want}`);
      const rfd = openSync(j.file, "r");
      const buf = Buffer.alloc(CH);
      let pos = 0;
      while (pos < sz) {
        const n = readSync(rfd, buf, 0, Math.min(CH, sz - pos), pos);
        if (n <= 0) break;
        writeSync(fd, buf, 0, n);
        pos += n;
      }
      closeSync(rfd);
    }
  } finally {
    closeSync(fd);
  }
  const got = shaOf(destFile);
  if (got !== expectSha) throw new Error(`${basename(destFile)} 指纹不符：${got} != ${expectSha}`);
  console.log(`  ✓ ${basename(destFile)} 指纹一致（${expectSha.slice(0, 12)}…）`);
}

/** 零依赖解包（scripts/lib/zip.mjs）。 */
function unzipTo(zipPath, dest) {
  if (existsSync(dest)) return false;
  const buf = readFileSync(zipPath);
  let n = 0;
  for (const e of listZipEntries(buf)) {
    const target = join(dest, e.name);
    if (e.isDir) {
      mkdirSync(target, { recursive: true });
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readZipEntry(buf, e));
    n++;
  }
  console.log(`  ✓ 解包 ${n} 个文件 → ${dest}`);
  return true;
}

const runId = RUN ?? (await api("/actions/runs?per_page=40")).workflow_runs.find((r) => r.head_branch === TAG && /Release/i.test(r.name))?.id;
if (!runId) {
  console.error(`✗ 找不到 ${TAG} 的 Release run`);
  process.exit(1);
}
console.log(`[fetch] run ${runId}${TAG ? `（tag ${TAG}）` : ""}`);
const outRoot = join("tmp", `release-${RUN ?? TAG}`);
mkdirSync(outRoot, { recursive: true });

const arts = (await api(`/actions/runs/${runId}/artifacts?per_page=50`)).artifacts ?? [];
const wanted = arts.filter((a) => WANT.test(a.name) && !a.expired);
if (wanted.length === 0) {
  console.error(`✗ 没有匹配的 artifact（看到的是：${arts.map((a) => a.name).join(", ") || "空"}）`);
  process.exit(1);
}
console.log(`[fetch] 取 ${wanted.length} 个：${wanted.map((a) => a.name).join(", ")}`);

for (const a of wanted) {
  console.log(`== ${a.name}（${(a.size_in_bytes / 1048576).toFixed(1)} MB）`);
  const zip = join(outRoot, `${a.name}.zip`);
  const expect = String(a.digest ?? "").replace(/^sha256:/, "");
  await fetchVerified(a.archive_download_url, a.size_in_bytes, expect, zip, join(outRoot, `parts-${a.name}`));
  unzipTo(zip, join(outRoot, a.name));
  // APK 一取到就验（不等到最后）：这个包是"用户真正会装的那一个"，
  // 验的是 v1.91.0 那次闪退的产物级判据（见 check-apk-contents.mjs 文件头）。
  if (a.name === "android-release-apk") {
    const f = readdirSync(join(outRoot, a.name)).find((n) => /\.apk$/.test(n));
    if (!f) {
      console.error("✗ artifact 里没有 .apk");
      process.exit(1);
    }
    const apkPath = join(outRoot, a.name, f);
    console.log(`\n[fetch] 发版 APK：${apkPath}`);
    try {
      const out = execFileSync(process.execPath, [join("scripts", "check-apk-contents.mjs"), apkPath], {
        encoding: "utf8",
      });
      process.stdout.write(out.split("\n").map((l) => (l ? `  ${l}` : l)).join("\n") + "\n");
    } catch (e) {
      process.stdout.write(String(e.stdout ?? ""));
      console.error("✗ APK 内容检查失败 —— 这个包不能发（逐条原因见上）");
      process.exit(1);
    }
  }
}

// ---- 发版 APK 路径（已经在上面取到时就验过了） ----
const apkDir = join(outRoot, "android-release-apk");
let apkFile = null;
if (existsSync(apkDir)) {
  const f = readdirSync(apkDir).find((n) => /\.apk$/.test(n));
  if (f) apkFile = join(apkDir, f);
}
if (!apkFile) {
  console.error("✗ 没取到发版 APK（artifact `android-release-apk` 里没有 .apk）");
  process.exit(1);
}

// ---- 落位 ----
if (STAGE) {
  const bundleDir = join("src-tauri", "target", "release", "bundle");
  let staged = 0;
  for (const a of wanted.filter((x) => x.name.startsWith("bundle-"))) {
    const dir = join(outRoot, a.name);
    if (!existsSync(dir)) continue;
    for (const sub of readdirSync(dir)) {
      if (!SUBS.includes(sub)) continue;
      const from = join(dir, sub);
      const to = join(bundleDir, sub);
      mkdirSync(to, { recursive: true });
      for (const f of readdirSync(from)) {
        const src = join(from, f);
        // ⚠️ 只搬**文件**：appimage/ 底下还有 `ShuyoNote.AppDir/` 这种中间目录
        // （第一版直接 readFileSync 它 ⇒ EISDIR）。`release.mjs` 也只认顶层安装包。
        if (!statSync(src).isFile()) continue;
        writeFileSync(join(to, f), readFileSync(src));
        staged++;
      }
    }
  }
  console.log(`[fetch] 落位 ${staged} 个文件 → ${bundleDir}`);
}

console.log("\n下一步（⑥ 发布到 GitCode）：");
console.log(
  `  GITCODE_TOKEN=… RELEASE_NOTES='一句话更新说明' node scripts/release.mjs --no-build ` +
    `--android-apk "${apkFile}" --body <从 CHANGELOG 对应版本段生成，标题降一级>`,
);
console.log("发布后跑：pnpm check:release-state（通道版本 / 指纹互证 / 两个 Web 入口）");
