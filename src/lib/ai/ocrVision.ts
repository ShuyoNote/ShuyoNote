// 用「视觉大模型（VLM）」识别页面图片中的文字——对中文/复杂/低清扫描件通常远优于 tesseract。
// 直接向已配置的 provider 发多模态请求（Ollama / OpenAI 兼容），复用 ProviderConfig。
// 这是独立的视觉调用（不走 runAiLoop/transport 的纯文本通道）。
import type { ProviderConfig } from "./llm";
import { describeFetchError } from "./llm";
import { coreFetch } from "../coreHttp";

export interface VisionOcrResult {
  text: string | null;
  error: "none" | "timeout" | "error";
  /**
   * **具体原因（给人看）**：失败时必须带上。
   *
   * 为什么单开一个字段：此前失败只回一个 `"error"`，界面只能一律喊
   * 「请确认已配置支持图像的模型」—— 而真因可能是 **404**（模型名/路径不对）、**401**（key 不对）、
   * 服务端 5xx、取图是空 Blob……**报错把人指向了错的方向**（2026-09-20 用户报「AI 识别出错」时
   * 卡的就是这条：拿到的只有一句笼统话，谁也判不出该改什么）。
   */
  message?: string;
}

const PROMPT =
  "请识别这张图片中的所有文字，按阅读顺序原样输出，保留段落与换行。只输出文字本身，不要任何解释、标题或格式标记。";

function baseUrlOf(u: string): string {
  return String(u ?? "").replace(/\/$/, "");
}
function appendV1(base: string, path: string): string {
  const b = baseUrlOf(base);
  return b.endsWith("/v1") ? b + path : b + "/v1" + path;
}

async function postJson(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await coreFetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal });
  } catch (e) {
    const timeout = String((e as Error)?.message ?? "").toLowerCase().includes("abort");
    if (timeout) throw new Error(`连接 ${url} 超时（${timeoutMs / 1000}s）。`);
    throw new Error(describeFetchError(e, url));
  } finally {
    clearTimeout(t);
  }
}

/** 让视觉模型识别图片中的文字。imageDataUrl 为 `data:image/...;base64,...`；
 *  prompt 可自定义（默认转录全文）。 */
export async function ocrWithVision(
  config: ProviderConfig,
  imageDataUrl: string,
  prompt: string = PROMPT,
  timeoutMs = 90000,
): Promise<VisionOcrResult> {
  if (!imageDataUrl) {
    // 空图 **不是**模型问题：说明取图/渲染环节没产出字节。分开说，否则排查方向直接跑偏。
    return {
      text: null,
      error: "error",
      message: "页面图像为空（0 字节）—— 问题在取图/渲染，不在模型。请先确认这一页在阅读器里能正常显示。",
    };
  }
  try {
    let text = "";
    if (config.provider === "ollama") {
      const b64 = imageDataUrl.replace(/^data:[^;]+;base64,/, "");
      const url = `${baseUrlOf(config.baseUrl)}/api/chat`;
      const resp = await postJson(
        url,
        { model: config.model, messages: [{ role: "user", content: prompt, images: [b64] }], stream: false },
        { "Content-Type": "application/json" },
        timeoutMs,
      );
      if (!resp.ok) throw new Error(`Ollama 视觉请求失败 (${resp.status})，请确认已配置支持图像的模型（如 llava / qwen2.5-vl）。`);
      const data = await resp.json();
      text = String(data?.message?.content ?? "").trim();
    } else {
      const url = appendV1(baseUrlOf(config.baseUrl), "/chat/completions");
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (config.apiKey) headers["Authorization"] = `Bearer ${config.apiKey}`;
      const resp = await postJson(
        url,
        {
          model: config.model,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                { type: "image_url", image_url: { url: imageDataUrl } },
              ],
            },
          ],
          max_tokens: 4096,
        },
        headers,
        timeoutMs,
      );
      if (!resp.ok) throw new Error(`AI 视觉请求失败 (${resp.status})，请确认已配置支持图像的模型（如 gpt-4o / qwen-vl）。`);
      const data = await resp.json();
      text = String(data?.choices?.[0]?.message?.content ?? "").trim();
    }
    if (!text) {
      return {
        text: null,
        error: "error",
        message: "模型返回了空文本：可能这个模型不支持图像输入（需 llava / qwen-vl / gpt-4o 这类视觉模型），也可能这一页确实没有文字。",
      };
    }
    return { text, error: "none" };
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    // `msg` 从此**跟着结果一起回**（此前只用来判超时，用完就丢 —— 界面因此永远说不出原因）。
    return { text: null, error: msg.includes("超时") ? "timeout" : "error", message: msg };
  }
}

/** 把 Blob 转成 data URL（视觉模型需要 base64/data URL）。 */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ""));
    r.onerror = () => reject(new Error("读取图片失败"));
    r.readAsDataURL(blob);
  });
}
