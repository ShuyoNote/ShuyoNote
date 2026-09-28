// 取 GitHub Release 资产的**纯逻辑**（选择、路由、校验）—— CLI 在 `scripts/fetch-gh-asset.mjs`。
//
// ## 为什么这半要单独一个模块
//
// 这一族的历史是"两台机器各写一份 `.tools/` 脚本"（`gh-api-asset.mjs` / `fetch-pdfium-via-api.mjs`），
// 结果同一条路有两份实现、且**只在某台机器的网络下才跑得通**。收进仓里的做法：
//   · **纯函数在这里**（可判据、不碰网络、不碰文件系统）；
//   · **网络与落盘在 CLI**（复用 `lib/gh-fetch.mjs` 的直连路径 ＋ **一条显式的 curl `--resolve` 兜底**）。
//
// ## ⚠️ 这条 curl 兜底是**故意的第二条 transport**，理由要写清（免得被当"重复实现"删掉）
//
// `lib/gh-fetch.mjs` 的 `--pinned-ip` 兜底**在 HTTPS 上不成立**（`Host` 头管不了 SNI ⇒ 证书主机名不匹配，
// 实测 `ERR_TLS_CERT_ALTNAME_INVALID`）；而 `curl --resolve host:port:ip` 的设计正是把"连到哪个 IP"
// 与"URL 里的主机名"分开 —— 主机名照样用于 SNI/证书校验，只是不查 DNS。
// ⇒ 在"直连超时/DNS 不可达"的机器上（本机就是），**curl 那条是唯一能通的路**，而它也正是
// `docs/RELEASING.md` 发版当天写着的做法。所以这里不是"第二份实现"，是"另一条已被文档承认的路"。
// Node 侧要真做到同样的事，只能引 `undici` 自定义 dispatcher —— 三方已裁定**不加**（见 `gh-fetch.mjs`）。

/** Release 元数据端点（`tag === "latest"` 时走 `releases/latest`）。 */
export function releaseApiUrl(repo, tag) {
  const t = String(tag ?? "").trim();
  return `https://api.github.com/repos/${repo}/${!t || t === "latest" ? "releases/latest" : `releases/tags/${t}`}`;
}

/** 某个资产 id 的 API 下载端点（配 `Accept: application/octet-stream` ⇒ 302 到 objects.githubusercontent.com）。 */
export function assetApiUrl(repo, assetId) {
  return `https://api.github.com/repos/${repo}/releases/assets/${assetId}`;
}

/**
 * 按**名字子串**挑资产（纯）。
 *
 * 为什么要显式告诉调用方"有多个候选"：只取第一个会让"我以为是那份"变成**静默取错**，
 * 而资产名里带版本/平台前缀时这种误取很常见。所以多命中 ⇒ 返回全部候选让调用方自己决定。
 */
export function pickAsset(assets, match) {
  const list = Array.isArray(assets) ? assets : [];
  const m = String(match ?? "");
  const hits = list.filter((a) => typeof a?.name === "string" && a.name.includes(m));
  if (hits.length === 0) {
    return { ok: false, reason: "none", names: list.map((a) => a.name), message: `没有匹配 "${m}" 的资产；现有：${list.map((a) => a.name).join(", ") || "（一个都没有）"}` };
  }
  if (hits.length > 1) {
    return { ok: false, reason: "many", hits: hits.map((a) => a.name), message: `"${m}" 命中了 ${hits.length} 个资产（${hits.map((a) => a.name).join(", ")}）—— 换一个更精确的子串` };
  }
  return { ok: true, asset: hits[0] };
}

/**
 * 直连失败后**该不该**退到 curl `--resolve`（纯）。
 *
 * 只有"网络类失败"才退（与 `gh-fetch.mjs` 约束②③同口径）：
 * HTTP 404 是**事实**（资产/发布不存在）⇒ 不退、照原样报；401/403 是凭据问题 ⇒ 也一样不退
 * （换个 IP 不会让"没权限"变成"有权限"）。
 */
export function shouldFallbackToCurl(fetchResult) {
  if (!fetchResult || fetchResult.ok) return false;
  const status = typeof fetchResult.status === "number" ? fetchResult.status : null;
  if (status !== null) return false; // 有任何 HTTP 状态码 ⇒ 是"结果类"，不换路
  const kind = fetchResult.failure?.kind ?? "network";
  return kind === "network";
}

/**
 * curl 的 argv（纯）—— 三条硬约束都在这里，别在 CLI 里现拼：
 *
 * 1. **按名字找 `curl`，不硬编码 `curl.exe`**（macOS 侧 2026-09-22 就因为写死 `curl.exe` 修过一次门禁）；
 * 2. `--resolve host:443:ip` ⇒ 只改"连到哪"，URL 里的主机名不变（SNI/证书照旧）；
 * 3. **token 绝不进 argv**：argv 会被 `ps`/`Get-Process` 与错误信息捞到（本仓 2026-09-16 出过一次
 *    "Bearer token 打进 CI 公开日志"）。要带凭据就用 `--config <文件>`（调用方建临时文件并自己删）。
 *
 * ⚠️ 第 4 条是 2026-09-23 补的：**`curl -s` 不看状态码** ⇒ 不加 `--fail*` 或 `-w` 的话，404 的
 * `{"message":"Not Found"}` 会被当成功体读进来，于是"这个 tag 不存在"被读成"这个 release 一个资产都没有"
 * —— 正是本仓禁止的"结果类冒充事实"。所以给 `writeOut` 时用 `-w` 把**状态码带回 stdout**，由调用方判。
 */
export function curlResolveArgs(url, ip, { out, configPath, extraHeaders = [], writeOut } = {}) {
  const u = new URL(url);
  const args = ["-sSL", "--noproxy", "*", "--resolve", `${u.hostname}:${u.port || 443}:${ip}`];
  if (configPath) args.push("--config", configPath);
  for (const h of extraHeaders) args.push("-H", h);
  if (out) args.push("-o", out);
  if (writeOut) args.push("-w", writeOut);
  args.push(url);
  return args;
}

/** `curl` 可执行文件名（纯）：Windows 上 `curl.exe` 也在 PATH 里，但**名字就用 `curl`**。 */
export function curlBinName() {
  return "curl";
}

/**
 * 把 HTTP 状态码翻成**人话 + 该不该换路**（纯）。
 *
 * 与 `shouldFallbackToCurl` 同一条口径：**任何有状态码的答复都是「结果类」**——404 是"远端说没有"，
 * 401/403 是"凭据/权限不对"，5xx 是"远端坏了"。这三种换 IP 都不会变好，所以都不兜底。
 * （判据在 `gh-asset.test.mjs`：404/401/403/5xx 一律 `fallback:false`。）
 */
export function describeHttpStatus(status) {
  const s = Number(status);
  if (s === 404) return { ok: false, reason: "notfound", fallback: false, message: "远端说「不存在」（HTTP 404）—— 这是事实不是网络故障：tag / 仓库名 / 资产名对不上就是真的没有" };
  if (s === 401 || s === 403) return { ok: false, reason: "auth", fallback: false, message: `没有权限或凭据无效（HTTP ${s}）—— 换 IP 不会让它变有权限，检查 token` };
  if (s >= 500 || s === 429) return { ok: false, reason: "server", fallback: false, message: `远端暂时坏了或被限流（HTTP ${s}）—— 换 IP 没用，过一会儿再试` };
  if (s >= 400) return { ok: false, reason: "client", fallback: false, message: `请求被拒（HTTP ${s}）` };
  if (s >= 300) return { ok: false, reason: "redirect", fallback: false, message: `意外的重定向（HTTP ${s}）—— 资产端点应自带 302 跟随` };
  if (s >= 200) return { ok: true, reason: "ok", fallback: false, message: `HTTP ${s}` };
  return { ok: false, reason: "unknown", fallback: false, message: `没拿到可用状态码（${status === null || status === undefined ? "缺" : status}）` };
}

/**
 * curl 的**退出码**分类（纯）—— 给"第一条路是 curl"的调用方用（`scripts/fetch-pdfium.mjs`）。
 *
 * 为什么要另立一条：`lib/gh-fetch.mjs` 的 `classifyError` 判的是 **Node 的 `fetch`** 抛出的错误，
 * 而 curl 子进程的失败是**退出码**，两套码表不同。判据同一条口径：**只有网络类才准换路**。
 *   · 6 域名解析不了 / 7 连不上 / 28 超时 / 35 TLS 握手失败 / 52 空回复 / 55-56 收发中断 / 18 传了一半
 *     ⇒ **网络类**（换一条路有意义）；
 *   · 22 是 `--fail` 的 HTTP ≥400 ⇒ **结果类**（换 IP 不会把 404 变成 200）；60 证书不受信、47 重定向过多
 *     也**不换路**（那是配置/信任问题，换路只会把问题藏起来）。
 */
export const CURL_NETWORK_EXITS = new Set([6, 7, 18, 28, 35, 52, 55, 56]);

export function classifyCurlExit(code) {
  const c = Number(code);
  if (CURL_NETWORK_EXITS.has(c)) return { kind: "network", code: c, fallback: true, message: `curl 退出码 ${c}（网络类）⇒ 可以换一条路` };
  if (c === 22) return { kind: "http", code: c, fallback: false, message: "curl 退出码 22（`--fail`：HTTP ≥ 400）⇒ 结果类，不换路" };
  if (c === 60) return { kind: "tls", code: c, fallback: false, message: "curl 退出码 60（证书不受信）⇒ 不换路（换路只会把信任问题藏起来）" };
  if (c === 47) return { kind: "redirect", code: c, fallback: false, message: "curl 退出码 47（重定向过多）⇒ 不换路" };
  return { kind: "other", code: c, fallback: false, message: `curl 退出码 ${Number.isFinite(c) ? c : code}（未归类）⇒ 不换路，如实报` };
}

/**
 * 期望哈希校验（纯）：
 * · 没给期望值 ⇒ `skipped`（**如实说"没校验"**，不要假装通过）；
 * · 给了 ⇒ 大小写不敏感地比 64-hex；不一致 ⇒ 失败并**两边都打印前 12 位**（便于人眼对）。
 */
export function verifySha(got, want) {
  const g = String(got ?? "").toLowerCase();
  const w = String(want ?? "").trim().toLowerCase();
  if (!w) return { ok: true, kind: "skipped", message: "没有给期望 sha256 ⇒ 未校验（只报了实际值）" };
  if (!/^[0-9a-f]{64}$/.test(w)) return { ok: false, kind: "bad-expectation", message: `期望值不是 64 位 hex：${w.slice(0, 20)}` };
  if (g === w) return { ok: true, kind: "match", message: `哈希一致（${w.slice(0, 12)}…）` };
  return { ok: false, kind: "mismatch", message: `哈希不一致：实际 ${g.slice(0, 12)}… / 期望 ${w.slice(0, 12)}…` };
}
