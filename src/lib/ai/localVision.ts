// 抽取用的**视觉通道**：只允许**本机端点**。
//
// ## 这条红线的来历
// 用户 2026-09-17 明确：**不允许用远程 provider**（对应方案 §13 第 7 项由"待拍板"变为**已定**）。
// 于是"图片 / 扫描件 / 音视频抽取"只能跑在**本机推理**上 —— 在那台机器装好运行时与模型之前，
// 这类抽取器**只会返回 `provider_error`**（契约 §15.3-7 本来就这么要求，这里是把政策也钉死）。
//
// ## 为什么要点成一个可执行的拒绝，而不是写在文档里
// 写在文档里的红线会随着"顺手加个云端兜底"消失，而且**消失时不会有任何信号**。
// 这个文件把它变成一句**在构造注入点时就会拒绝**的代码：非 loopback 的 baseUrl ⇒ **不给 `vision`**
// ⇒ 下游拿到的就是"未注入"，按契约走 `provider_error`。**没有第二条路能偷偷出网。**
//
// ## 判断依据是**地址**，不是 provider 名字
// 规则要表达的是"**不出网**"，而不是"别用某个厂"：
// - `provider: "ollama"` + `http://127.0.0.1:11434` ⇒ 允许；
// - `provider: "openai"` + `http://127.0.0.1:8080/v1`（本机跑 llama.cpp / vLLM）⇒ **也允许**；
// - `provider: "openai"` + `https://api.deepseek.com`（`llm.ts` 的默认值之一）⇒ **拒绝**。
//
// ## ⚠️ 一处**默认从严**的取舍，请你确认
// `192.168.x.x` 这类**局域网**地址同样被拒（它不是 loopback）。
// 方案里 "AMD 是全库抽取实跑机" 指的是**整套抽取跑在那台机器上**（那时端点是它自己的 loopback），
// 所以默认从严不影响那条路。但如果你确实想让 Windows/Mac **跨网访问** AMD 的推理服务，
// 这条默认就要放宽 —— **我没有擅自放宽，因为那是政策不是技术选择**。

import type { ExtractDeps } from "../extract/types";
import type { ProviderConfig } from "./llm";
import { blobToDataUrl, ocrWithVision } from "./ocrVision";

export interface LocalVisionResult {
  /** 可注入 `deps.vision` 的函数。**被拒时没有这个字段**（下游按"未注入"处理 ⇒ `provider_error`）。 */
  vision?: NonNullable<ExtractDeps["vision"]>;
  /** 被拒的原因（用于给用户一句能看懂的话）。**接受时没有这个字段**。 */
  refusal?: string;
}

/**
 * 这个 baseUrl 是否指向**本机**（loopback）。
 *
 * 允许：`localhost`、`127.0.0.0/8` 任意地址、IPv6 `::1`（含 `[::1]` 写法）。
 * 其余一律**拒绝**，包括解析不出来的字符串 —— **默认从严**：宁可拒绝一个其实本地的地址，
 * 也不要放过一个其实远程的地址（前者的代价是一句明确的拒绝，后者是数据出网）。
 */
export function isLoopbackBaseUrl(url: string): boolean {
  const raw = String(url ?? "").trim();
  if (!raw) return false;
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return false; // 解析不出来 ⇒ 不当作本机
  }
  // URL.hostname 对 IPv6 会带方括号（`[::1]`）
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host === "localhost" || host === "::1") return true;
  // 整个 127.0.0.0/8 都是 loopback（不只是 127.0.0.1）
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return false;
}

/**
 * 用**本机** provider 配置造一个 `deps.vision`。
 *
 * 非本机 ⇒ 返回 `{ refusal }`（**不抛**）：调用方据此给用户看一句"为什么不能用"，
 * 而不是让抽取悄悄失败成一句 `provider_error`（那会让人以为"模型没装好"）。
 */
export function localVision(
  config: ProviderConfig,
  opts: { timeoutMs?: number } = {},
): LocalVisionResult {
  if (!isLoopbackBaseUrl(config?.baseUrl)) {
    return {
      refusal:
        `按红线，抽取不得使用远程 provider（你配的是 ${config?.baseUrl || "（空）"}）。` +
        `请把模型跑在本机（例如 ${"http://127.0.0.1:11434"}），抽取才会启用；` +
        `在此之前，图片/扫描件这类需要视觉的抽取器会返回 provider_error。`,
    };
  }
  const timeoutMs = opts.timeoutMs ?? 90_000;
  return {
    vision: async (prompt, image, mime) => {
      // 复用既有的 data URL 辅助（不手搓 base64：大图用 String.fromCharCode 会爆栈）
      const dataUrl = await blobToDataUrl(new Blob([image as BlobPart], { type: mime }));
      const r = await ocrWithVision(config, dataUrl, prompt, timeoutMs);
      // `text: null` = 调用失败（网络/端点/模型错）⇒ **抛**，让抽取器按契约转成 `provider_error`；
      // `text: ""` = 调用成功但这张图没有文字 ⇒ 如实返回空串（那是"没内容"，不是"出错"）。
      if (r.text === null) throw new Error(r.error || "vision 调用失败");
      return r.text;
    },
  };
}
