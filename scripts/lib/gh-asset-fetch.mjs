// 取 GitHub release 元数据 / 资产的**网络层**（纯逻辑在选择、路由、校验：`gh-asset.mjs`）。
//
// ## 为什么要有这一层（而不是把网络代码留在 CLI 里）
//
// 这一族的历史是"两台机器各写一份 `.tools/` 脚本"（`gh-api-asset.mjs` / `fetch-pdfium-via-api.mjs`），
// 同一条路两份实现。收进仓里的分工是：
//   · **纯逻辑** in `gh-asset.mjs`（可判据、不碰网络/文件系统）；
//   · **网络与落盘** in 这里（两条 transport：Node 直连 → 网络类失败才退 `curl --resolve`）；
//   · **薄 CLI** 在 `scripts/fetch-gh-asset.mjs`（只解析参数、打印、定退出码）。
// 这样 `scripts/fetch-pdfium.mjs` 也能**调同一份**，而不必再抄一遍（它原先另有一条
// `github.com/releases/download` 的 curl 路 —— 那条在本机 DNS 下不通，正是 `.tools` 脚本存在的原因）。
//
// ⚠️ 两条 transport 的分工与理由写在 `gh-asset.mjs`（含"Node fetch 的钉 IP 在 HTTPS 上不成立、
// 但 `curl --resolve` 成立"的实测）；凭据只经 `--config` 临时文件，**绝不进 argv**。

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assetApiUrl,
  curlBinName,
  curlResolveArgs,
  describeHttpStatus,
  pickAsset,
  releaseApiUrl,
  shouldFallbackToCurl,
  verifySha,
} from "./gh-asset.mjs";
import { fetchWithFallback, sha256Hex } from "./gh-fetch.mjs";

/** 实测在本机可达的 `api.github.com`；可被 `GH_API_IP` / `DSH_GITHUB_API_IP` 覆盖。 */
export const DEFAULT_API_IP = "140.82.113.6";

/** `curl -w` 把状态码追加在 stdout 尾部；这里把它切回来（`-o` 时 stdout 里只有这一段）。 */
export const STATUS_MARK = "\n__FETCH_GH_ASSET_STATUS__";

export function resolveApiIp(env = process.env) {
  return env.GH_API_IP || env.DSH_GITHUB_API_IP || DEFAULT_API_IP;
}

/** 只读 `~/.git-credentials` 里那把经典 token（读不到就不带凭据 —— 公开仓匿名也能取）。 */
export function readToken(env = process.env) {
  if (env.GITHUB_TOKEN) return env.GITHUB_TOKEN;
  const home = env.USERPROFILE ?? env.HOME ?? "";
  if (!home) return "";
  try {
    const creds = readFileSync(join(home, ".git-credentials"), "utf8");
    return (creds.match(/ghp_[A-Za-z0-9]{36}/) ?? [])[0] ?? "";
  } catch {
    return "";
  }
}

export function curlAvailable() {
  try {
    execFileSync(curlBinName(), ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** `curl -w` 的尾巴切回 `{body, status}`（`-o` 时 body 为空）。 */
export function splitStatus(stdout) {
  const raw = String(stdout);
  const at = raw.lastIndexOf(STATUS_MARK);
  if (at < 0) return { body: raw, status: null };
  return { body: raw.slice(0, at), status: Number(raw.slice(at + STATUS_MARK.length).trim()) };
}

/** JSON 解析（先剥 BOM —— 本机 `.cargo/config.toml` 那次 BOM 事故之后，解析远端文本一律先剥）。 */
export function parseJson(text) {
  const t = String(text).replace(/^\uFEFF/, "").trimStart();
  try {
    return JSON.parse(t);
  } catch {
    throw new Error(`远端返回的不是 JSON（前 120 字）：${t.slice(0, 120)}`);
  }
}

/**
 * 跑一次 curl（`--resolve` 路线）。`out` 给了就落盘，否则 body 从 stdout 返回。
 * **状态码一律带回**：`curl -s` 不看状态码 ⇒ 404 体会被当成功读进来（2026-09-23 实测）。
 * 凭据写成临时 `--config` 并在 `finally` 里删掉。
 */
function curlGet(url, { ip, out, token, headers = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gh-asset-fetch-"));
  let configPath;
  try {
    if (token) {
      configPath = join(dir, "curl.cfg");
      writeFileSync(configPath, `header = "Authorization: Bearer ${token}"\nheader = "User-Agent: ShuyoNote-fetch-gh-asset"\n`, "utf8");
    }
    const argv = curlResolveArgs(url, ip, {
      out,
      configPath,
      extraHeaders: headers,
      writeOut: `${STATUS_MARK}%{http_code}`,
    });
    let stdout;
    try {
      stdout = execFileSync(curlBinName(), argv, {
        encoding: "utf8",
        maxBuffer: 64 << 20,
        timeout: 60 * 60_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      // 只报错误摘要；**不要**把 argv 打出来
      const stderr = String(e?.stderr ?? "").slice(0, 300);
      return { ok: false, body: "", status: null, message: stderr || String(e?.message ?? e).slice(0, 200) };
    }
    return { ok: true, ...splitStatus(stdout) };
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 删不掉不该让取件失败 */
    }
  }
}

/** 直连失败那句话（状态码优先，否则给网络错误码 —— 两者是不同类的事实）。 */
function whyDirectFailed(res) {
  if (typeof res.status === "number") return describeHttpStatus(res.status).message;
  return `网络类失败（${res.failure?.code ?? "?"}）`;
}

/**
 * 取一个 release 的元数据 JSON（`tag` 传 `latest`/空 即最新）。
 * 直连优先，**只有网络类失败**才退 `curl --resolve`。
 *
 * @returns {Promise<{ok:boolean, json?:object, how:"direct"|"curl", steps:string[], message?:string}>}
 */
export async function fetchReleaseJson({ repo, tag, ip = resolveApiIp(), token = readToken(), fetchImpl } = {}) {
  const url = releaseApiUrl(repo, tag);
  const steps = [];
  const accept = "Accept: application/vnd.github+json";
  const headers = token ? { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } : { Accept: "application/vnd.github+json" };

  const direct = await fetchWithFallback(url, { headers, fetchImpl });
  if (direct.ok) {
    steps.push("[direct] Node fetch 成功");
    // 解析失败也要**如实报成失败**（代理塞回来的 HTML 错误页就走这里），不许抛出去让调用方崩
    try {
      return { ok: true, json: parseJson(direct.body.toString("utf8")), how: "direct", steps };
    } catch (e) {
      const message = String(e?.message ?? e);
      steps.push(message);
      return { ok: false, how: "direct", steps, message };
    }
  }
  if (!shouldFallbackToCurl(direct)) {
    const message = `直连被拒：${whyDirectFailed(direct)}`; // 结果类 ⇒ 不换路
    steps.push(message);
    return { ok: false, how: "direct", steps, message };
  }
  steps.push(`[direct] ${whyDirectFailed(direct)} ⇒ 退到 curl --resolve ${ip}`);
  if (!curlAvailable()) {
    const message = `直连失败（网络类：${direct.failure?.code ?? "?"}）且本机没有 ${curlBinName()} ⇒ 这条兜底不可用（如实报，不假装成功）`;
    steps.push(message);
    return { ok: false, how: "none", steps, message };
  }
  const r = curlGet(url, { ip, token, headers: [accept] });
  if (!r.ok) {
    const message = `curl --resolve 也失败：${r.message}`;
    steps.push(message);
    return { ok: false, how: "curl", steps, message };
  }
  const verdict = describeHttpStatus(r.status);
  if (!verdict.ok) {
    steps.push(`[curl --resolve ${ip}] 该路通了但答案是「结果类」：${verdict.message}`);
    return { ok: false, how: "curl", status: r.status, steps, message: verdict.message };
  }
  steps.push(`[curl --resolve ${ip}] Node 直连不通，这条通了`);
  try {
    return { ok: true, json: parseJson(r.body), how: "curl", steps };
  } catch (e) {
    const message = String(e?.message ?? e);
    steps.push(message);
    return { ok: false, how: "curl", steps, message };
  }
}

/**
 * 取**一个** release 资产到 `out`，并按需校验 sha256（下载 → 落盘 → 读回落盘字节算哈希，只有一处）。
 *
 * @returns {Promise<{ok:boolean, how?, asset?, bytes?, sha256?, verdict?, steps:string[], message?}>}
 */
export async function fetchAssetTo({
  repo,
  tag,
  match,
  out,
  wantSha,
  ip = resolveApiIp(),
  token = readToken(),
  fetchImpl,
} = {}) {
  const steps = [];

  const meta = await fetchReleaseJson({ repo, tag, ip, token, fetchImpl });
  steps.push(...meta.steps);
  if (!meta.ok) return { ok: false, how: meta.how, steps, message: meta.message };
  if (!Array.isArray(meta.json?.assets)) {
    return { ok: false, how: meta.how, steps, message: `远端 JSON 里没有 assets 数组（${JSON.stringify(meta.json).slice(0, 160)}）` };
  }

  const picked = pickAsset(meta.json.assets, match);
  if (!picked.ok) return { ok: false, how: meta.how, steps, message: picked.message };
  const asset = picked.asset;
  steps.push(`release ${meta.json.tag_name} ⇒ ${asset.name}（${asset.size} 字节，id=${asset.id}）`);

  // 落盘：直连优先（拿 Buffer 后写文件）；网络类失败才退 curl（curl 直接 -o，避免在 Node 里堆大 Buffer）
  const url = assetApiUrl(repo, asset.id);
  const directHeaders = { Accept: "application/octet-stream", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  const direct = await fetchWithFallback(url, { headers: directHeaders, fetchImpl });
  if (direct.ok) {
    steps.push("[direct] Node fetch 成功");
    writeFileSync(out, direct.body);
  } else if (shouldFallbackToCurl(direct)) {
    if (!curlAvailable()) {
      const message = `直连失败（网络类：${direct.failure?.code ?? "?"}）且本机没有 ${curlBinName()} ⇒ 这条兜底不可用`;
      steps.push(message);
      return { ok: false, how: "none", steps, message };
    }
    steps.push(`[direct] ${whyDirectFailed(direct)} ⇒ 退到 curl --resolve ${ip}`);
    const r = curlGet(url, { ip, out, token, headers: ["Accept: application/octet-stream"] });
    if (!r.ok) {
      const message = `curl --resolve 下载失败：${r.message}`;
      steps.push(message);
      return { ok: false, how: "curl", steps, message };
    }
    // ★ 非 200 ⇒ 落盘的是错误页：**删掉**（别让错误页混进 sha256 校验）并如实报
    const httpVerdict = describeHttpStatus(r.status);
    if (!httpVerdict.ok) {
      try {
        rmSync(out, { force: true });
      } catch {
        /* 删不掉也要报 */
      }
      const message = `${httpVerdict.message}（已删掉落盘的错误页）`;
      steps.push(message);
      return { ok: false, how: "curl", status: r.status, steps, message };
    }
    steps.push(`[curl --resolve ${ip}] 这条通了`);
  } else {
    const message = `下载失败：${whyDirectFailed(direct)}（结果类，不换路）`;
    steps.push(message);
    return { ok: false, how: "direct", status: direct.status ?? null, steps, message };
  }

  const bytes = statSync(out).size;
  const sha256 = sha256Hex(readFileSync(out));
  const verdict = verifySha(sha256, wantSha);
  return { ok: verdict.ok, how: steps.at(-1)?.startsWith("[curl") ? "curl" : "direct", asset, bytes, sha256, verdict, steps, message: verdict.ok ? undefined : verdict.message };
}
