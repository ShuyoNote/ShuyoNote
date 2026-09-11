// 社区帖子抓取（`save?url=` 这条路的"把内容拿进来"那一半）。
//
// 分工：`deepLink.ts` 判定"这是什么动作"；**这里**负责"怎么安全地把那篇帖子取回来"。
// 抓回来的东西**不会**直接进编辑器或落库——`save` 的语义永远是"先弹预览、人确认后才写"，
// 那是下一步的事；这里只负责把它变成一个结构清楚、体积有上限的对象。
//
// 四条硬约束（对应社区方案第七节的三条 + 我们商定的白名单）：
//   1. **地址由 `checkCommunityUrl` 判定**（与深链解析同一条策略，不在这里另写一遍）；
//   2. **落地地址要复查**：重定向可能把我们带到别处，跟过去之前先看它落在哪；
//   3. **读字节时也守上限**：只看 Content-Length 会被"不报长度、慢慢灌"的服务器绕过；
//   4. **只认 JSON**：应用不内置 HTML 正文抽取（随社区改版就坏、巨大页面能拖死），
//      所以拿到 text/html 直接报错，而不是"尽力抽一抽"。
//
// 为什么不用后端的 reqwest（插件索引那条路）：那条路的产物要落盘、要校验签名，
// 属于"装东西"；这条路的产物是一篇**要给人看、由人确认**的文本。放在前端做，
// 同一份实现 Web 与桌面都能跑，安全策略也只有一处（`checkCommunityUrl`）。
// 桌面端的 CSP 已经允许 `connect-src https:`，所以两条平台都走得通。

import { checkCommunityUrl } from "./deepLink";

/** 帖子 JSON 的体积上限（读字节时就守着）。 */
export const MAX_POST_JSON_BYTES = 256 * 1024;

/** 标题上限（只用于界面与落库前的理智检查，正文由字节上限兜住）。 */
export const MAX_POST_TITLE = 300;

/** 标签数量上限（多余的直接不显示，不因此拒绝整篇帖子）。 */
export const MAX_POST_TAGS = 20;

/** 抓取超时。比插件索引的 30 秒短：这是"用户点了一下等结果"的交互。 */
export const POST_FETCH_TIMEOUT_MS = 15_000;

/** 社区帖子的稳定形状（社区侧契约：`GET /api/posts/{id}.json`）。 */
export interface CommunityPost {
  id: string;
  title: string;
  /** 落库的那份 Markdown 源码（社区侧直接吐，不做正文抽取）。 */
  bodyMarkdown: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  tags: string[];
  /** 原帖地址（会写进笔记的"来源"里，所以也必须过同一条地址策略）。 */
  url: string;
}

export type PostFetchResult = { ok: true; post: CommunityPost } | { ok: false; reason: string };

const asString = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

/**
 * 解析帖子 JSON（**纯函数**，可单测）。
 *
 * 缺字段是**报错**而不是填空：一个没有标题、没有正文、也没有来源地址的"帖子"，
 * 落库只会变成一篇说不清来路的空笔记——那种东西比失败更糟。
 * 多出来的字段一律忽略（社区将来加字段不该让老应用抓不动）。
 */
export function parseCommunityPost(raw: unknown): PostFetchResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "帖子接口返回的不是一个 JSON 对象" };
  }
  const o = raw as Record<string, unknown>;
  const id = asString(o.id).trim();
  const title = asString(o.title).trim();
  const bodyMarkdown = asString(o.body_markdown ?? o.bodyMarkdown);
  const url = asString(o.url).trim();
  if (!id) return { ok: false, reason: "帖子 JSON 缺少 id（社区侧约定用 id 当稳定键）" };
  if (!title) return { ok: false, reason: "帖子 JSON 缺少 title" };
  if (!bodyMarkdown.trim()) return { ok: false, reason: "帖子 JSON 缺少 body_markdown（正文源码）" };
  if (title.length > MAX_POST_TITLE) {
    return { ok: false, reason: `帖子标题过长（${title.length} 字，上限 ${MAX_POST_TITLE}）` };
  }
  // 来源地址要与抓取时那条同一策略：它是写进笔记里的"来源"，不能指向别处。
  const checked = checkCommunityUrl(url);
  if (!checked.ok) return { ok: false, reason: `帖子里的 url 不可信：${checked.reason}` };
  const tagsRaw = Array.isArray(o.tags) ? o.tags : [];
  const tags = tagsRaw
    .map((t) => asString(t).trim())
    .filter(Boolean)
    .slice(0, MAX_POST_TAGS);
  return {
    ok: true,
    post: {
      id,
      title,
      bodyMarkdown,
      author: asString(o.author).trim(),
      createdAt: asString(o.created_at ?? o.createdAt).trim(),
      updatedAt: asString(o.updated_at ?? o.updatedAt).trim(),
      tags,
      url: checked.url,
    },
  };
}

/** 抓取依赖注入点：测试里换成假 fetch（这里只用到最朴素的三件事）。 */
export interface FetchLike {
  (url: string, init?: { signal?: AbortSignal }): Promise<{
    ok: boolean;
    status: number;
    url: string;
    headers: { get(name: string): string | null };
    body: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> } } | null;
    text(): Promise<string>;
  }>;
}

/**
 * 把一个社区地址抓成 `CommunityPost`。
 *
 * 返回**结果对象**而不是抛异常：调用方（预览 UI）需要把原因原样显示给人看，
 * 而不是把异常吞掉——"链接无效 / 地址取不到 / 不是 JSON"这三种必须说得出是哪一种。
 */
export async function fetchCommunityPost(
  url: string,
  opts: { fetchImpl?: FetchLike; timeoutMs?: number; maxBytes?: number } = {},
): Promise<PostFetchResult> {
  const target = checkCommunityUrl(url);
  if (!target.ok) return { ok: false, reason: target.reason };
  const doFetch = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  if (typeof doFetch !== "function") return { ok: false, reason: "这个平台没有可用的网络请求能力" };
  const maxBytes = opts.maxBytes ?? MAX_POST_JSON_BYTES;
  const timeoutMs = opts.timeoutMs ?? POST_FETCH_TIMEOUT_MS;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    let resp;
    try {
      resp = await doFetch(target.url, { signal: ac.signal });
    } catch (e) {
      const why = e instanceof Error && e.name === "AbortError" ? `请求超时（${timeoutMs / 1000} 秒）` : String(e);
      return { ok: false, reason: `取不到这篇帖子：${why}` };
    }
    // 重定向可能把我们带到别处：**跟过去之前先看它落在哪**。
    const landed = checkCommunityUrl(resp.url || target.url);
    if (!landed.ok) {
      return { ok: false, reason: `这个地址被重定向到了不允许的地方（${resp.url}）：${landed.reason}` };
    }
    if (!resp.ok) {
      return { ok: false, reason: `取不到这篇帖子：HTTP ${resp.status}` };
    }
    const ctype = (resp.headers.get("content-type") ?? "").toLowerCase();
    if (!ctype.includes("json")) {
      // 不内置 HTML 抽取：拿到网页就说清"这不是 JSON"，而不是尽力抽一抽。
      return { ok: false, reason: `这个地址返回的不是 JSON（Content-Type: ${ctype || "未提供"}）` };
    }
    const read = await readCapped(resp, maxBytes);
    if (!read.ok) return read;
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(read.bytes));
    } catch (e) {
      return { ok: false, reason: `帖子 JSON 解析失败：${e instanceof Error ? e.message : String(e)}` };
    }
    return parseCommunityPost(parsed);
  } finally {
    clearTimeout(timer);
  }
}

/** 流式读取并在**读的过程中**守上限（只看 Content-Length 会被"慢慢灌"绕过）。 */
async function readCapped(
  resp: { body: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> } } | null; text(): Promise<string> },
  maxBytes: number,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; reason: string }> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (!resp.body) {
    // 没有流的能力（极老的实现）：退回整体读取，但读完仍要量一次体积。
    const text = await resp.text();
    const bytes = new TextEncoder().encode(text);
    if (bytes.byteLength > maxBytes) return { ok: false, reason: `帖子 JSON 超过体积上限（${maxBytes / 1024} KiB）` };
    return { ok: true, bytes };
  }
  const reader = resp.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      return { ok: false, reason: `帖子 JSON 超过体积上限（${maxBytes / 1024} KiB）` };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    bytes.set(c, off);
    off += c.byteLength;
  }
  return { ok: true, bytes };
}
