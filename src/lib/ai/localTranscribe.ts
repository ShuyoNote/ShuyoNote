// 抽取用的**语音转写通道**：与 `localVision` 同一条红线 —— **只允许本机端点**。
//
// ## 为什么单开一个文件，而不是塞进 `localVision.ts`
// 两条通道的**形状完全不同**：视觉是「提问 + 编码图」，转写是「音频 + 模型 +（可选）语言」，
// 而且传输方式也不一样（视觉发 JSON，转写发 `multipart/form-data`）。
// 混在一个文件里，读代码的人会以为"都是调模型"，于是把标点/时间戳这类**转写专有**的口径
// 顺手塞进视觉那边（契约 §15.8 裁定"不蹭 `vision`"就是这个理由）。
//
// ## 端点与默认模型
// · 端点＝`POST <base>/v1/audio/transcriptions`（OpenAI 兼容；Herdsman 已实现，见 `docs/development.md §10.7`）。
//   ⚠️ **没有 ollama 分支**：Ollama 不提供转写端点 ⇒ 配 ollama 的用户会拿到 404，
//   那是一条**如实**的失败（不是"我们没接"），错误文本里会写清端点与默认模型。
// · 默认模型＝`funasr-nano`（owner 2026-09-22 拍板；**带标点**）。
//   ⚠️ 刻意**不用 `config.model`**：那是**文本对话模型**的名字，拿去打转写端点必然 404
//   （两个模型空间本来就不是一回事）。要换 ASR 模型必须**显式**传 `model`。
//
// ## 传输走 `coreFetch`（这一点顺便回答了 Windows 提的 CORS 疑问）
// 桌面端 `coreFetch` 用 `@tauri-apps/plugin-http`（**原生请求**，不经 WebView）⇒
// **桌面根本没有 CORS 这一关**；且 `capabilities/default.json` 的 http 作用域含 `http://**`
// ⇒ `127.0.0.1:8080` 在允许范围内。Web 端走浏览器 fetch，那里才需要服务端放行来源
// （Windows 2026-09-22 提醒的"CORS 未验"只作用在 Web 上，桌面这条不适用 —— 但 Web 那条仍未实测，
//  见本节末尾的边界）。
//
// ## 边界（写出来，免得被读成"全平台都验过了"）
// 1. **没有真模型读数**：本机 / 验收机上 herdsman 当下没在跑（Windows 侧实测 `curl` exit=7）
//    ⇒ 这条通道的 live 冒烟**还没跑过**，判据全是"注入假端点"那一层；
// 2. **CORS（Web 端）未验**：桌面端不受影响，Web 端要等服务起来才能看 `Access-Control-Allow-Origin`；
// 3. **时间戳分段取决于服务端**：Herdsman 现在只回 `{text}`（模板见 §10.7）⇒
//    `segments` 拿不到时抽取器按契约退成**一段、`loc=""`**（不编造定位）。

import type { ExtractDeps } from "../extract/types";
import { DEFAULT_ASR_MODEL } from "../extract/avTranscript";
import { coreFetch } from "../coreHttp";
import type { ProviderConfig } from "./llm";
import { describeFetchError } from "./llm";
import { isLoopbackBaseUrl } from "./localVision";

export interface LocalTranscribeResult {
  /** 可注入 `deps.transcribe` 的函数。**被拒时没有这个字段**（下游按"未注入"走 `provider_error`）。 */
  transcribe?: NonNullable<ExtractDeps["transcribe"]>;
  /** 被拒的原因（给用户一句能看懂的话）。**接受时没有这个字段**。 */
  refusal?: string;
}

/**
 * 纯函数：转写端点。
 *
 * 与 `ocrVision.appendV1` 同一条口径：base 已经以 `/v1` 结尾就**不重复加** ——
 * 这一点踩过一次（`http://127.0.0.1:8080/v1` 拼成 `/v1/v1/audio/…` ⇒ 404）。
 */
export function transcribeEndpoint(baseUrl: string): string {
  const b = String(baseUrl ?? "").trim().replace(/\/+$/, "");
  return b.endsWith("/v1") ? `${b}/audio/transcriptions` : `${b}/v1/audio/transcriptions`;
}

/**
 * 纯函数：给 multipart 的 `file` 部分配一个文件名。
 *
 * 为什么必须有扩展名：有些服务端**按扩展名**猜容器（whisper.cpp 系列尤其），
 * 文件名丢了会变成"能收到字节但解不出来"——那是最难查的一种 400。
 */
export function filenameForAudioMime(mime: string): string {
  const m = String(mime ?? "").toLowerCase().split(";")[0].trim();
  const map: Record<string, string> = {
    "audio/wav": "audio.wav",
    "audio/x-wav": "audio.wav",
    "audio/wave": "audio.wav",
    "audio/mpeg": "audio.mp3",
    "audio/mp3": "audio.mp3",
    "audio/mp4": "audio.m4a",
    "audio/x-m4a": "audio.m4a",
    "audio/aac": "audio.aac",
    "audio/ogg": "audio.ogg",
    "audio/opus": "audio.opus",
    "audio/flac": "audio.flac",
    "audio/x-flac": "audio.flac",
    "audio/webm": "audio.webm",
    "video/mp4": "video.mp4",
    "video/quicktime": "video.mov",
    "video/webm": "video.webm",
    "video/x-matroska": "video.mkv",
  };
  return map[m] ?? "audio.bin";
}

/**
 * 纯函数：解析转写响应体。
 *
 * 只认契约要的两样东西：`text`（必需，可为空串）与 `segments`（可选）。
 * **不猜**别的形状：拿不到 `text` 就**抛**（那说明服务端不是 OpenAI 兼容的那一支，
 * 而"猜一个字段名"会让错误以"内容为空"的样子出现 —— 那会让人去查音频）。
 */
export function parseTranscription(raw: string): {
  text: string;
  segments?: { start: number; end: number; text: string }[];
} {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`转写返回的不是 JSON（前 200 字符：${String(raw ?? "").slice(0, 200)}）`);
  }
  const obj = (data ?? {}) as Record<string, unknown>;
  if (typeof obj.text !== "string") {
    const keys = Object.keys(obj);
    throw new Error(`转写返回里没有 text 字段（拿到的键：${keys.length ? keys.join("/") : "（空对象）"}）`);
  }
  const rawSegs = obj.segments;
  if (!Array.isArray(rawSegs)) return { text: obj.text };
  const segments = rawSegs
    .map((s) => (s ?? {}) as Record<string, unknown>)
    .filter((s) => typeof s.text === "string" && Number.isFinite(s.start) && Number.isFinite(s.end))
    .map((s) => ({ start: Number(s.start), end: Number(s.end), text: String(s.text) }));
  // ⚠️ 空数组**不返回** `segments: []`：契约里"没有分段"与"分段为空"对下游是同一件事
  //   （都退成一段、`loc=""`），返回空数组只会让每个消费者都写一遍 `?.length`。
  return segments.length > 0 ? { text: obj.text, segments } : { text: obj.text };
}

/**
 * 用**本机** provider 配置造一个 `deps.transcribe`。
 *
 * 非本机 ⇒ 返回 `{ refusal }`（**不抛**）：调用方据此给用户看一句"为什么不能用"。
 * 这条红线与 `localVision` 共用同一个判据（`isLoopbackBaseUrl`），不另写一份 ——
 * 两份判据必然漂移，而这条漂移的代价是**数据出网**。
 */
export function localTranscribe(
  config: ProviderConfig,
  opts: { model?: string; language?: string; timeoutMs?: number } = {},
): LocalTranscribeResult {
  if (!isLoopbackBaseUrl(config?.baseUrl)) {
    return {
      refusal:
        `按红线，抽取不得使用远程 provider（你配的是 ${config?.baseUrl || "（空）"}）。` +
        `语音转写同样要求模型跑在本机（例如 http://127.0.0.1:8080/v1）；` +
        `在此之前，音视频这类需要转写的抽取器会返回 provider_error。`,
    };
  }
  const timeoutMs = opts.timeoutMs ?? 300_000; // 转写比视觉慢得多（分钟级音频），默认给 5 分钟
  return {
    transcribe: async (audio, mime, o) => {
      if (!audio || audio.byteLength === 0) {
        // 空音频**不是**模型问题：说明取字节那一环没产出内容。分开说，否则排查方向直接跑偏
        // （与 `ocrWithVision` 对空图的处置同一条口径）。
        throw new Error("音频为空（0 字节）—— 问题在取字节，不在模型。");
      }
      // 模型优先级：本次调用 > 构造时给的 > 默认（**不用 `config.model`**，理由见文件头）。
      const model = (o?.model || opts.model || DEFAULT_ASR_MODEL).trim();
      const language = o?.language || opts.language;
      const url = transcribeEndpoint(config.baseUrl);

      // ⚠️ 用 `FormData` 而不是手搓 boundary：桌面端 `plugin-http` 会把 Request 序列化成字节，
      //   boundary 由 WebView/原生实现生成并写进 Content-Type —— 自己拼反而更容易错。
      const form = new FormData();
      form.set("file", new Blob([audio as BlobPart], { type: mime || "application/octet-stream" }), filenameForAudioMime(mime));
      form.set("model", model);
      if (language) form.set("language", language);

      const headers: Record<string, string> = {};
      if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
      // ⚠️ 刻意**不设** `Content-Type`：multipart 的 boundary 必须由实现生成，
      //   手写一个没有 boundary 的 `multipart/form-data` 会让服务端解析失败。

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let resp: Response;
      try {
        resp = await coreFetch(url, { method: "POST", headers, body: form, signal: ctrl.signal });
      } catch (e) {
        const aborted = String((e as Error)?.message ?? "").toLowerCase().includes("abort");
        if (aborted) throw new Error(`连接 ${url} 超时（${timeoutMs / 1000}s）。长音频请先分段或调大超时。`);
        throw new Error(describeFetchError(e, url));
      } finally {
        clearTimeout(timer);
      }

      const body = await resp.text();
      if (!resp.ok) {
        // 404 单独给一句能指路的：最常见成因就是"模型名不是这台机器上装的那个"。
        const hint =
          resp.status === 404
            ? `（这台机器上装了哪个 ASR 模型，看 GET /v1/models；默认写的是 ${DEFAULT_ASR_MODEL}）`
            : "";
        throw new Error(
          `转写请求失败（${resp.status}）${hint}：${body.slice(0, 200) || "（响应体为空）"}`,
        );
      }
      return parseTranscription(body);
    },
  };
}
