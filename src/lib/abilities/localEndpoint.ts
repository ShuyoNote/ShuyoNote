// 「看图识字（VLM）」那一件的**本机端点探测**（2026-10-18，owner：「把 qwen2.5vl:3b 加到能力下载中心」）。
//
// ## 为什么是"探测"而不是"下载"
// 视觉抽取这条红线要求**本机端点**（`localVision.ts`：非 loopback 一律不给 vision），
// 而本程序**不启动**任何推理进程 ⇒ 这一件真实的形态是：
// **能力在、模型由用户在自己机器上拉**（Ollama / llama.cpp 都行）。
// ⇒ 面板给一颗「检查本机模型」，把"有没有、缺什么、跑哪条命令"如实说出来 ✓。
//
// ## 口径（别在这里松）
// · 只探 **loopback**：`127.0.0.1` / `localhost` / `[::1]`（与 `localVision.isLoopbackBaseUrl` 同一条红线 ✓）；
// · 探不到就**如实说探不到**（⛔ 不许把"没装"写成"已装"，也不许把"不知道"写成"没有" ✗）；
// · 只读 `GET /api/tags`（Ollama）／`GET /v1/models`（llama.cpp、vLLM）：⛔ 不下载、⛔ 不加载模型 ✗。

/** Ollama 的默认端点（面板与 `localVision` 都认它 ✓）。 */
export const OLLAMA_DEFAULT_BASE = "http://127.0.0.1:11434";

/** 推荐的那个视觉模型（≈3.2 GB；6 GB 显存的机器上放得下 ✓）。 */
export const RECOMMENDED_VISION_MODEL = "qwen2.5vl:3b";

/** 名字里带这些词 ⇒ 当成视觉模型（Ollama 的 tag 命名约定，⛔ 不猜家族，只按名字 ✓）。 */
const VISION_NAME_HINTS = [/\bvl\b/i, /qwen[\d.]*-?vl/i, /llava/i, /vision/i, /minicpm-v/i, /moondream/i, /pixtral/i, /granite.*vision/i];

/** 这个名字看起来是不是视觉模型（纯函数，判据直接喂 ✓）。 */
export function looksLikeVisionModel(name: string): boolean {
  const s = String(name ?? "");
  return VISION_NAME_HINTS.some((re) => re.test(s));
}

/** `http(s)://…` 的 host 是不是本机（与 `localVision` 同一条口径 ✓）。 */
export function isLoopbackUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  const bare = host.replace(/^\[|\]$/g, "");
  return bare === "localhost" || bare === "::1" || /^127\./.test(bare);
}

export type VisionProbe =
  | { ok: true; baseUrl: string; models: string[]; vision: string[] }
  | { ok: false; baseUrl: string; reason: string };

/**
 * 探本机端点上有哪些模型、其中哪些像视觉模型。
 * ⚠️ 失败**只报原因**（连不上 / 超时 / 形状不认识）—— ⛔ 不抛异常：调用方是界面，它要能显示"为什么没探到" ✓。
 */
export async function probeVisionModels(opts: {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
} = {}): Promise<VisionProbe> {
  const baseUrl = (opts.baseUrl ?? OLLAMA_DEFAULT_BASE).replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? (typeof fetch === "function" ? fetch : undefined);
  if (!doFetch) return { ok: false, baseUrl, reason: "这个运行环境里没有 fetch" };
  if (!isLoopbackUrl(baseUrl)) {
    return { ok: false, baseUrl, reason: `按红线只探本机端点（你给的是 ${baseUrl}）` };
  }

  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), opts.timeoutMs ?? 2500) : null;
  try {
    // ① Ollama：GET /api/tags ⇒ { models: [{ name, model }] }
    const url = `${baseUrl}/api/tags`;
    const res = await doFetch(url, ctl ? { signal: ctl.signal } : undefined);
    if (!res.ok) return { ok: false, baseUrl, reason: `本机端点回了 HTTP ${res.status}（${url}）` };
    const j = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
    const list = Array.isArray(j?.models) ? j.models : null;
    if (!list) return { ok: false, baseUrl, reason: "本机端点回了，但不是 Ollama 的 /api/tags 形状" };
    const names = list.map((m) => String(m?.name ?? m?.model ?? "").trim()).filter(Boolean);
    return { ok: true, baseUrl, models: names, vision: names.filter(looksLikeVisionModel) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const aborted = /abort/i.test(msg);
    return { ok: false, baseUrl, reason: aborted ? `连本机端点超时（${baseUrl}）` : `连不上本机端点（${baseUrl}）：${msg}` };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 给界面那一行的**人话结论**（纯函数，判据直接喂读数 ✓）。 */
export function visionProbeText(p: VisionProbe): string {
  if (!p.ok) return `${p.reason}。装好后在终端跑：ollama pull ${RECOMMENDED_VISION_MODEL}`;
  if (p.models.length === 0) return `本机端点（${p.baseUrl}）上一个模型都没有 ⇒ 先跑：ollama pull ${RECOMMENDED_VISION_MODEL}`;
  if (p.vision.length === 0) {
    return `本机有 ${p.models.length} 个模型，但**没有视觉模型** ⇒ 跑：ollama pull ${RECOMMENDED_VISION_MODEL}`;
  }
  return `本机视觉模型：${p.vision.join("、")}（共 ${p.models.length} 个模型）`;
}
