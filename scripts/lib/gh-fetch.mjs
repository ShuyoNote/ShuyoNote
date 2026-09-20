// 取远端文件（GitHub API / release 资产 / 频道清单）的**唯一一条路**：直连为主，**只在网络类失败时**
// 才退到"钉 IP"（本机实测：`api.github.com` 与 `objects.githubusercontent.com` 的直连有时不可达，
// 而钉 IP 可达；`github.com` 完全不可达）。
//
// 为什么抽成模块（与 windows 商定的六条约束，2026-09-19）：
//   ① **默认不钉 IP**（钉 IP 是例外手段，不是常态；常量 IP 会悄悄过期）;
//   ② 兜底**只对网络类失败**（DNS/连接/超时），HTTP 4xx/5xx **不兜底**；
//   ③ **404 绝不兜底**（"资源不存在"与"网络到不了"是两件事，混起来会把缺件读成网络问题）；
//   ④ 走过的路要**如实记进日志**（哪一种尝试、为什么退过去、最终哪条成功）；
//   ⑤ 两条路都给 sha256（调用方要能核对字节）；
//   ⑥ 纯函数为主 ＋ 判据（`gh-fetch.test.mjs`），搬完删 `.tools/` 里的重复实现。
//
// ⚠️ 为什么不把 `--require` 的 DNS shim 当解法：本机实测它**不作用于 Node 内置的 `fetch`/undici**
//   （那只影响 `http.get`/`dns.lookup` 的旧路径）⇒ 用 shim 会得到"看起来配了、其实没生效"的假绿。
//   真正有效的只有两条：改 `dns` 之外的**连接目标**（钉 IP ＋ `Host` 头 / SNI），或者走可达的镜像/API。

import { createHash } from "node:crypto";

/** 网络类失败（**可以**兜底）与"结果类"失败（**不可以**兜底）的分界。 */
export const NETWORK_ERROR_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
]);

/**
 * 把一个抛出来的错误分类成 `network` / `other`。
 * 判据只在**这**一处：别在调用点再写 `catch` 兜底，否则"404 不兜底"那条会从侧门漏掉。
 */
export function classifyError(err) {
  const code = err?.code || err?.cause?.code || "";
  if (NETWORK_ERROR_CODES.has(code)) return { kind: "network", code };
  // `fetch` 在 DNS 失败时常把原因塞在 `cause`，且 `code` 可能是 `UND_ERR_...` 之外的字符串
  const msg = String(err?.message || "");
  if (/getaddrinfo|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|network/i.test(msg)) {
    return { kind: "network", code: code || "fetch-failed" };
  }
  return { kind: "other", code: code || "unknown" };
}

/** `Response.status` 分类：只有 5xx 与 429 值得重试一次；4xx（含 404）**永不**换路。 */
export function classifyStatus(status) {
  if (status === 404) return { kind: "notfound", retryable: false };
  if (status >= 500 || status === 429) return { kind: "server", retryable: true };
  if (status >= 400) return { kind: "client", retryable: false };
  return { kind: "ok", retryable: false };
}

export function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * 计划要走的尝试序列（**纯函数**，判据直接断言它）。
 *
 * @param {string} url
 * @param {{pinnedIp?: string, host?: string}} opts
 * @returns {Array<{label:"direct"|"pinned-ip", url:string, host?:string, why:string}>}
 */
export function planAttempts(url, { pinnedIp, host } = {}) {
  const attempts = [{ label: "direct", url, why: "默认：直连（不钉 IP）" }];
  if (!pinnedIp) return attempts;
  const u = new URL(url);
  const targetHost = host || u.hostname;
  // 只有显式给了 pinnedIp 才排第二条；`Host` 头保持原主机名，SNI/证书校验才不会被 IP 打乱
  attempts.push({
    label: "pinned-ip",
    url: `${u.protocol}//${pinnedIp}${u.port ? `:${u.port}` : ""}${u.pathname}${u.search}`,
    host: targetHost,
    why: `直连失败且是网络类失败 ⇒ 退到钉 IP ${pinnedIp}（Host 仍为 ${targetHost}）`,
  });
  return attempts;
}

/**
 * 取一份远端内容。**唯一的网络入口**（`fetchImpl` 可注入 ⇒ 判据不需要真网络）。
 *
 * @returns {Promise<{ok:boolean, status:number|null, body:Buffer|null, sha256:string|null,
 *                    how:"direct"|"pinned-ip"|"none", log:string[], failure?:{kind:string,code:string}|null}>}
 */
export async function fetchWithFallback(url, {
  pinnedIp,
  host,
  headers = {},
  fetchImpl = globalThis.fetch,
  timeoutMs = 25000,
} = {}) {
  const log = [];
  const attempts = planAttempts(url, { pinnedIp, host });

  for (const [i, a] of attempts.entries()) {
    const first = i === 0;
    // ★ 约束②③：只有**第一次**（直连）失败且原因是"网络类"时，才允许走第二条
    if (!first) log.push(a.why);
    let res = null;
    try {
      res = await fetchImpl(a.url, {
        headers: a.host ? { ...headers, Host: a.host } : headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const cls = classifyError(e);
      log.push(`${a.label}: 抛错（${cls.kind}/${cls.code}）`);
      if (cls.kind === "network" && i < attempts.length - 1) continue;
      return { ok: false, status: null, body: null, sha256: null, how: "none", log, failure: cls };
    }

    const cls = classifyStatus(res.status);
    log.push(`${a.label}: HTTP ${res.status}（${cls.kind}）`);
    if (!res.ok) {
      // ★ 约束③：404 与其它 4xx **不换路**；5xx/429 也不换路（换 IP 不会把 5xx 变成 200）
      log.push(`${a.label}: 不兜底（HTTP ${res.status} 属「结果类」而非网络类）`);
      return { ok: false, status: res.status, body: null, sha256: null, how: a.label === "direct" ? "direct" : "pinned-ip", log, failure: null };
    }

    const buf = Buffer.from(await res.arrayBuffer());
    return { ok: true, status: res.status, body: buf, sha256: sha256Hex(buf), how: a.label, log, failure: null };
  }

  log.push("所有尝试都走完仍失败");
  return { ok: false, status: null, body: null, sha256: null, how: "none", log, failure: { kind: "network", code: "exhausted" } };
}
