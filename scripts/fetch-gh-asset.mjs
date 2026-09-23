// 取 GitHub Release 资产的**唯一一条路**（本机 `github.com`/`codeload.github.com` 不可达，
// 只有 `api.github.com` 可达，而它的 assets 端点会 302 到 `objects.githubusercontent.com`）。
//
// ## 用法
//
//   node scripts/fetch-gh-asset.mjs --list <owner/repo> [tag|latest]
//   node scripts/fetch-gh-asset.mjs <owner/repo> <tag|latest> <资产名子串> <输出路径> [期望 sha256]
//
// ## 实现分工（薄 CLI，不在这里做网络/判断）
//
//   · 选择 / 路由 / 校验的**纯逻辑** ⇒ `lib/gh-asset.mjs`
//   · 两条 transport（Node 直连 → **只有网络类失败**才退 `curl --resolve`）与落盘 ⇒ `lib/gh-asset-fetch.mjs`
//   · 这里只：解析参数、把走过的路打印出来、定退出码。`scripts/fetch-pdfium.mjs` 调的是同一份 fetch。
//
// ## 四条硬约束（判据在 `lib/gh-asset.test.mjs`，都钉住了）
//
//   · 按名字找 `curl`（**不写死 `curl.exe`**）；找不到就**如实报错**，别假装"没这条兜底"；
//   · **凭据绝不进 argv**：带 token 时写进 `--config` 的临时文件（`Authorization: Bearer …`），
//     用完即删（argv 会被 `ps`/错误信息捞到 —— 本仓 2026-09-16 出过 token 进公开日志的事故）；
//   · 走过的路**如实打出来**（`[direct]` / `[curl --resolve <ip>]`），不要让调用方猜。
//   · **状态码必须判**（2026-09-24 实测补的第 4 条）：`curl -s` 不看状态码 ⇒ 不带 `-w` 的话
//     `releases/tags/<不存在的 tag>` 的 404 体会被当成功读进来，于是"这个 tag 不存在"被读成
//     "这个 release 一个资产都没有"。现在两条路都按状态码判：404/401/403/5xx 一律**如实报、不换路**，
//     curl 路下载到非 200 时还会**把落盘的错误页删掉**（别让错误页混进 sha256 校验）。
//
// 环境：`GH_API_IP` / `DSH_GITHUB_API_IP` 覆盖钉的 IP；`GITHUB_TOKEN` 或 `~/.git-credentials` 供凭据。

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { fetchAssetTo, fetchReleaseJson, resolveApiIp } from "./lib/gh-asset-fetch.mjs";

const die = (msg, code = 1) => {
  console.error(`fetch-gh-asset: ❌ ${msg}`);
  process.exit(code);
};

const args = process.argv.slice(2);
const IP = resolveApiIp();

/** 逐行打印"走过的路"（越靠后越过 = 最后成功的那条）。 */
const show = (steps) => {
  for (const s of steps) console.log(`  · ${s}`);
};

try {
  // ---- `--list`：列出一个 release 的资产 ----
  if (args[0] === "--list") {
    const [repo, tag] = args.slice(1);
    if (!repo) die("用法：--list <owner/repo> [tag|latest]");
    const rel = await fetchReleaseJson({ repo, tag, ip: IP });
    show(rel.steps);
    if (!rel.ok) die(rel.message);
    if (!Array.isArray(rel.json.assets)) die(`远端 JSON 里没有 assets 数组（拿到的是：${JSON.stringify(rel.json).slice(0, 160)}）`);
    console.log(`tag = ${rel.json.tag_name}（route=${rel.how}）`);
    for (const a of rel.json.assets) console.log(`  ${a.name}  ${a.size} 字节  id=${a.id}`);
    process.exit(0);
  }

  // ---- 下载一个资产 ----
  const [repo, tag, match, out, wantSha] = args;
  if (!repo || !tag || !match || !out) {
    die("用法：<owner/repo> <tag|latest> <资产名子串> <输出路径> [期望 sha256]（或 --list <owner/repo> [tag]）");
  }

  console.log(`取 ${repo}@${tag} 里名字含 "${match}" 的资产`);
  // 输出目录不存在就建（否则 curl 报 "(23) client returned ERROR on write"，像网络故障其实不是 —— 2026-09-24 踩过）
  mkdirSync(dirname(out), { recursive: true });

  const r = await fetchAssetTo({ repo, tag, match, out, wantSha, ip: IP });
  show(r.steps);
  if (!r.ok) die(r.message);

  console.log(`落盘 ${out}：${r.bytes} 字节`);
  console.log(`sha256 = ${r.sha256}`);
  console.log(`${r.verdict.ok ? "⇒ ✅" : "⇒ ❌"} ${r.verdict.message}`);
  process.exit(r.verdict.ok ? 0 : 1);
} catch (e) {
  die(`未预期错误：${String(e?.message ?? e).slice(0, 300)}`);
}
