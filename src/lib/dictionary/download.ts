// 词库 pack 的**首次下载**（owner 2026-10-10 拍 A：首次使用时联网下一份，校验 sha256）。
//
// ## 为什么下载在前端、落盘却走 Rust 的 `save_ability_pack`
//
// ⛔ `src-tauri/src/lib.rs` 是**别人的写域**（本轮不许碰）⇒ 不能新增 Tauri 命令。
// ⭐ 而仓里**已经有**落盘那条链：`abilities::save_ability_pack(pack_id, base64)`
//    —— 白名单 ＋ 钉死 sha256 ＋ 体积上限，**全部校验通过之后才写盘**（fail-closed ✓）。
// ⇒ 所以本模块只做"取回来 ＋ **自己先核一遍** ＋ 交给那条链"，⛔ 不自己写文件。
//
// ## 两道 sha256（不是重复劳动）
//
// · 这里核：**危险方向优先** —— 不匹配就**根本不调** `savePack`（磁盘上不留半个字节）；
// · Rust 再核：⛔ **不信任 webview**（`abilities.rs:4` 的口径）—— 页面上那次校验是"给用户看的"。
//
// ## 可注入（判据不用联网）
//
// `url` / `fetchImpl` / `savePack` 全是**参数**（⛔ 不读全局），所以判据能喂夹具响应、
// 也能喂 `file://` 或假地址；真实地址没托管时，`resolvePackUrl()` 返回 `null`，
// 结果是一条**可读**的失败原因（⛔ 不是静默失败）。

/** 词库 pack 的 id（与 `abilities.rs::ECDICT_PACK_ID`、`AbilitiesPane` 清单**同源**）。 */
export const ECDICT_PACK_ID = "ecdict-en-zh";

/**
 * 词库 pack 的**托管地址** —— ⚠️ **目前是空的：还没有托管**（❌ 真地址＝未做，见交接报告）。
 *
 * ⛔ 不写一个"看起来能用"的假地址：那样用户点了下载会拿到 404，而错误会像是"网络坏了"。
 * 空 ⇒ `resolvePackUrl()` 返回 `null` ⇒ 界面说"还没有托管地址"（如实 ✓）。
 * 托管之后**只改这一行**即可（判据不变）。
 */
export const ECDICT_PACK_URL = "";

/** 进度读数：`total`/`percent` 在服务端没给 `Content-Length` 时是 `null`（⛔ 不猜）。 */
export interface PackDownloadProgress {
  phase: "downloading" | "verifying" | "saving";
  received: number;
  total: number | null;
  percent: number | null;
}

/** 三种结局**互斥**，没有"大概成了"这种第四态。 */
export type PackDownloadResult =
  | { kind: "saved"; bytes: number; sha256: string; saved: unknown }
  | { kind: "refused"; reason: string; gotBytes?: number; gotSha256?: string }
  | { kind: "failed"; reason: string };

export interface DownloadPackOptions {
  url: string;
  packId: string;
  /** 清单里钉住的 sha256（空 ⇒ **拒绝**：不核指纹就不许落盘）。 */
  expectedSha256: string;
  /** 清单里钉住的字节数（0/未给 ⇒ 不核；⚠️ 给了就能挡住截断的半包）。 */
  expectedBytes?: number;
  /** 注入点：判据喂夹具；生产用默认 `fetch`。 */
  fetchImpl?: typeof fetch;
  /** 注入点：生产传 `api.saveAbilityPack`（⛔ 本模块不 import 平台层，便于单测）。 */
  savePack: (packId: string, base64: string) => Promise<unknown>;
  onProgress?: (p: PackDownloadProgress) => void;
  signal?: AbortSignal;
}

/** 解析该从哪下：显式覆盖（判据/联调）优先，否则用清单里那一行（未托管 ⇒ `null`）。 */
export function resolvePackUrl(override?: string | null): string | null {
  const v = (override ?? ECDICT_PACK_URL ?? "").trim();
  return v ? v : null;
}

/** sha256（小写十六进制）。`crypto.subtle` 在浏览器/Tauri webview 里都有。 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("这个运行环境没有 crypto.subtle ⇒ 无法核 sha256（拒绝在没核过的情况下落盘）");
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const d = await subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(d))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** base64 编码（**手写**，不用 btoa：判据环境与 webview 的 `btoa` 行为/大字符串上限不一致）。 */
export function bytesToBase64(bytes: Uint8Array): string {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += A[b0 >> 2];
    out += A[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? A[((b1 & 15) << 2) | (b2 >> 6)] : "=";
    out += i + 2 < bytes.length ? A[b2 & 63] : "=";
  }
  return out;
}

/** 掐一个可读的短指纹（报错里用；⛔ 不把整串倒进界面）。 */
const short = (s: string) => (s ? `${s.slice(0, 12)}…` : "（空）");

function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return String(e);
}

/**
 * 下载 + 校验 + 交落盘。**失败/拒绝都在返回值里**（⛔ 不靠抛异常让调用方漏掉）。
 */
export async function downloadPack(opts: DownloadPackOptions): Promise<PackDownloadResult> {
  const { url, packId, expectedSha256, expectedBytes = 0, savePack, onProgress, signal } = opts;
  const doFetch = opts.fetchImpl ?? fetch;

  if (!expectedSha256) {
    // fail-closed：清单没钉指纹 ⇒ 不落盘（否则"没核过"会变成"装上了"）。
    return { kind: "refused", reason: "清单里没有钉 sha256 ⇒ 拒绝落盘（不核指纹就不算校验过）" };
  }

  let res: Response;
  try {
    res = await doFetch(url, { signal });
  } catch (e) {
    return { kind: "failed", reason: `连不上下载地址（${url}）：${describeError(e)}` };
  }
  if (!res.ok) {
    return { kind: "failed", reason: `下载失败：HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}（${url}）` };
  }

  const lenHeader = res.headers?.get?.("content-length") ?? null;
  const total = lenHeader && /^\d+$/.test(lenHeader) ? Number(lenHeader) : null;
  const chunks: Uint8Array[] = [];
  let received = 0;
  onProgress?.({ phase: "downloading", received: 0, total, percent: total ? 0 : null });

  const reader = res.body?.getReader?.();
  if (!reader) {
    // 没有流式 body ⇒ 一次性读（进度就只有"开始/结束"两个读数，如实如此）。
    const buf = new Uint8Array(await res.arrayBuffer());
    chunks.push(buf);
    received = buf.length;
    onProgress?.({ phase: "downloading", received, total, percent: total ? 100 : null });
  } else {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length) {
          chunks.push(value);
          received += value.length;
          onProgress?.({
            phase: "downloading",
            received,
            total,
            percent: total ? Math.min(100, Math.round((received / total) * 100)) : null,
          });
        }
      }
    } catch (e) {
      return { kind: "failed", reason: `下载中断（已收到 ${received} 字节）：${describeError(e)}` };
    }
  }

  const bytes = new Uint8Array(received);
  {
    let off = 0;
    for (const c of chunks) {
      bytes.set(c, off);
      off += c.length;
    }
  }

  if (expectedBytes > 0 && bytes.length !== expectedBytes) {
    // 截断的包**不进校验**：先把"不完整"说清楚（长度是便宜且确定的判据）。
    return {
      kind: "refused",
      reason: `下载不完整：收到 ${bytes.length} 字节 ≠ 清单里钉的 ${expectedBytes} 字节 ⇒ 拒绝落盘`,
      gotBytes: bytes.length,
    };
  }

  onProgress?.({ phase: "verifying", received: bytes.length, total: total ?? bytes.length, percent: 100 });
  let gotSha256: string;
  try {
    gotSha256 = await sha256Hex(bytes);
  } catch (e) {
    return { kind: "failed", reason: `算 sha256 失败：${describeError(e)}` };
  }

  // ⭐⭐ 强制校验（owner 2026-10-10 拍 A 的第 ② 条）：**不匹配就拒绝使用**，
  //     ⛔ 不是"提示一下继续用" ✗ —— 而且**在调落盘之前**返回 ⇒ 磁盘上一个字节都不写。
  //     （Rust 侧还会再核一遍：⛔ 不信任 webview，见 `abilities.rs:4`。）
  if (gotSha256 !== expectedSha256) {
    return {
      kind: "refused",
      reason:
        `sha256 不匹配 ⇒ 拒绝使用（算出 ${short(gotSha256)} ≠ 清单里钉的 ${short(expectedSha256)}）` +
        `—— 这次**没有写进你的目录**，请稍后重试或报告这个地址的内容被换过`,
      gotSha256,
      gotBytes: bytes.length,
    };
  }

  onProgress?.({ phase: "saving", received: bytes.length, total: total ?? bytes.length, percent: 100 });
  try {
    const saved = await savePack(packId, bytesToBase64(bytes));
    return { kind: "saved", bytes: bytes.length, sha256: gotSha256, saved };
  } catch (e) {
    return { kind: "failed", reason: `校验过了但落盘失败：${describeError(e)}` };
  }
}

/** 给界面用的一句话（三种结局各有各的话；⛔ 不许把"拒绝"说成"失败"）。 */
export function describeDownloadResult(r: PackDownloadResult): string {
  switch (r.kind) {
    case "saved":
      return `已下载并校验通过：${r.bytes} 字节 · sha256 ${short(r.sha256)}`;
    case "refused":
      return `拒绝使用：${r.reason}`;
    case "failed":
      return `下载没成：${r.reason}`;
  }
}

/** 产品入口（界面调它）：先把"有没有托管地址"这一步走掉，再走下载。 */
export interface DictionaryPackDeps {
  /** 清单里钉的 sha256 / 字节数（由 `AbilitiesPane` 那份清单传进来 ⇒ 清单只有一份）。 */
  expectedSha256: string;
  expectedBytes: number;
  /** 判据/联调用：覆盖地址（`file://` 或夹具都行）。生产不传 ⇒ 用清单那一行。 */
  urlOverride?: string | null;
  packId?: string;
  fetchImpl?: typeof fetch;
  savePack: (packId: string, base64: string) => Promise<unknown>;
  onProgress?: (p: PackDownloadProgress) => void;
}

export async function downloadDictionaryPack(deps: DictionaryPackDeps): Promise<PackDownloadResult> {
  const url = resolvePackUrl(deps.urlOverride);
  if (!url) {
    // ⭐ 反向判据就落在这里：**没有托管地址 ⇒ 不许假装能下载**（也不是静默失败）。
    return {
      kind: "failed",
      reason: "还没有托管地址：词库 pack 尚未上传到稳定地址（❌ 真地址＝未做）。开发/判据可用 urlOverride 注入夹具或 file://。",
    };
  }
  return downloadPack({
    url,
    packId: deps.packId ?? ECDICT_PACK_ID,
    expectedSha256: deps.expectedSha256,
    expectedBytes: deps.expectedBytes,
    fetchImpl: deps.fetchImpl,
    savePack: deps.savePack,
    onProgress: deps.onProgress,
  });
}
