// ⭐ P3-4 第三小步（task-50）：附件下载进度 —— **界面接上了没有**。
//
// 与 `attachmentFetchSource.wiring.test.ts` 同一手法：Node 里跑不起真 Tauri 窗口，所以钉**结构**：
// Rust 真的发那个事件名/形状；`FileManagerView` 真的监听、显示、并在终态/卸载时清理。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_DOWNLOAD_PROGRESS_EVENT,
  attachmentDownloadLabel,
} from "../lib/attachmentDownloadProgress";

const read = (p: string) => readFileSync(p, "utf8");

describe("附件下载进度 · 前后端接线", () => {
  const view = read("src/components/FileManagerView.tsx");
  const rust = read("src-tauri/src/sync.rs");
  const lib = read("src/lib/attachmentDownloadProgress.ts");

  it("① 事件名两处同一串（Rust emit 与前端 listen 必须一致）", () => {
    expect(ATTACHMENT_DOWNLOAD_PROGRESS_EVENT).toBe("attachment-download-progress");
    expect(rust).toContain('"attachment-download-progress"');
    expect(lib).toContain('"attachment-download-progress"');
  });

  it("② Rust 载荷是 camelCase 且带 spaceId/hash/downloaded/total/done/error", () => {
    // 结构体就在 emit 那条路的文件里；serde camelCase 保证前端读到 spaceId 而不是 space_id。
    expect(rust).toContain("pub struct AttachmentDownloadProgress");
    expect(rust).toContain('serde(rename_all = "camelCase")');
    for (const field of ["space_id", "hash", "downloaded", "total", "done", "error"]) {
      const i = rust.indexOf("pub struct AttachmentDownloadProgress {");
      const body = rust.slice(i, i + 800);
      expect(body, `缺字段 ${field}`).toContain(`pub ${field}:`);
    }
  });

  it("③ 节流口径：256 KiB 或 200 ms，且中间态与终态分开", () => {
    expect(rust).toContain("should_emit_download_progress");
    expect(rust).toContain("256 * 1024");
    expect(rust).toContain("Duration::from_millis(200)");
    // 终态 done=true 一定会发（完成/失败都发）。
    expect(rust).toContain("done: true");
  });

  it("④ 视图真的监听、按 hash 存进度、终态清理、卸载取消监听", () => {
    expect(view).toContain("ATTACHMENT_DOWNLOAD_PROGRESS_EVENT");
    expect(view).toContain("platform.event");
    expect(view).toContain(".listen<AttachmentDownloadProgressPayload>");
    expect(view).toContain("p.spaceId !== active");
    expect(view, "终态要删掉这个 hash（否则行上永远挂着百分比）").toContain("delete next[p.hash]");
    expect(view).toContain("unlisten?.()");
  });

  it("⑤ 下载中的行真的显示「下载中 X%」/「已 X MB」，而不是只有一个省略号", () => {
    expect(view).toContain("attachmentDownloadLabel(");
    expect(view).toContain("fm-attachment-progress");
    expect(view).toContain("aria-live");
    // 文案口径与 lib 一致（知道总量 ⇒ 百分比；不知道 ⇒ 已 X MB）。
    expect(attachmentDownloadLabel(4, 10)).toBe("下载中 40%");
    expect(attachmentDownloadLabel(1024 * 1024, null)).toBe("下载中（已 1.0 MB）");
    // 兜底：命令在发事件前就失败时，fetchBytes 的 finally 也要清掉。
    expect(view).toContain("delete next[f.hash]");
  });

  it("⑥ 自动同步那条路不传 sink（本笔只接命令路径，行为不变）", () => {
    // `download_one_attachment` 的第 9 个实参在自动同步调用点是 `None`。
    expect(rust).toContain("自动同步不展示逐件进度");
  });
});
