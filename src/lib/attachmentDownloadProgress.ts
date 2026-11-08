// ⭐ P3-4 第三小步（task-50）：附件下载进度事件的前端契约与纯展示函数。
//
// 事件由 Rust `download_attachment` 命令发出（`src-tauri/src/sync.rs` 的
// `AttachmentDownloadProgress`，serde camelCase）：
//   { spaceId, hash, downloaded, total | null, done, error | null }
// · 中间态：`done=false`，按 256 KiB / 200 ms 节流；
// · **终态**：完成或失败都发一次 `done=true`（失败带 `error`）⇒ UI 必须据此**收起**进度。
//
// ⚠️ 这里只做"怎么显示"：⛔ 不猜总大小（`total=null` 时显示「已 X MB」而不是假百分比）。

export const ATTACHMENT_DOWNLOAD_PROGRESS_EVENT = "attachment-download-progress";

export interface AttachmentDownloadProgressPayload {
  spaceId: string;
  hash: string;
  /** 已落盘（`.part`）的**完整文件**字节数（含续传起点）。 */
  downloaded: number;
  /** 期望总大小；元数据没有 ⇒ `null`（不编百分比）。 */
  total: number | null;
  /** 终态（完成/失败都 `true`；失败看 `error`）。 */
  done: boolean;
  /** 失败原因（成功/中间态 ⇒ `null`/缺省）。 */
  error?: string | null;
}

/** 下载百分比（`total` 未知/0 ⇒ `null`；夹在 0..=100，不虚报 >100%）。 */
export function downloadProgressPercent(
  downloaded: number,
  total: number | null | undefined,
): number | null {
  if (total == null || !Number.isFinite(total) || total <= 0) return null;
  if (!Number.isFinite(downloaded) || downloaded <= 0) return 0;
  return Math.min(100, Math.round((downloaded / total) * 100));
}

/** 已下载字节 → 「X.Y MB」（总大小未知时用；⛔ 不假设 MB 就是整数）。 */
export function formatDownloadedMB(downloaded: number): string {
  const mb = Math.max(0, downloaded) / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

/**
 * 行内文案：知道总量 ⇒ 「下载中 42%」；不知道 ⇒ 「下载中（已 1.5 MB）」。
 * ⚠️ 与 Rust 侧 `download_progress_percent` 同一口径（未知总量不编百分比）。
 */
export function attachmentDownloadLabel(
  downloaded: number,
  total: number | null | undefined,
): string {
  const percent = downloadProgressPercent(downloaded, total);
  if (percent == null) return `下载中（已 ${formatDownloadedMB(downloaded)}）`;
  return `下载中 ${percent}%`;
}
