import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_DOWNLOAD_PROGRESS_EVENT,
  attachmentDownloadLabel,
  downloadProgressPercent,
  formatDownloadedMB,
} from "./attachmentDownloadProgress";

describe("attachmentDownloadProgress：下载进度的显示口径", () => {
  it("事件名是 Rust 发出的那一个（两处必须同一串）", () => {
    expect(ATTACHMENT_DOWNLOAD_PROGRESS_EVENT).toBe("attachment-download-progress");
  });

  it("知道总大小 ⇒ 百分比；0/未知/非法 ⇒ null（⛔ 不编百分比）", () => {
    expect(downloadProgressPercent(0, 10)).toBe(0);
    expect(downloadProgressPercent(4, 10)).toBe(40);
    expect(downloadProgressPercent(10, 10)).toBe(100);
    expect(downloadProgressPercent(4, null)).toBeNull();
    expect(downloadProgressPercent(4, 0)).toBeNull();
    expect(downloadProgressPercent(4, Number.NaN)).toBeNull();
    // 异常读数不虚报 >100%
    expect(downloadProgressPercent(20, 10)).toBe(100);
  });

  it("总大小未知 ⇒ 「已 X MB」，知道 ⇒ 「下载中 42%」", () => {
    expect(formatDownloadedMB(0)).toBe("0.0 MB");
    expect(formatDownloadedMB(1024 * 1024 * 1.5)).toBe("1.5 MB");
    expect(attachmentDownloadLabel(4, 10)).toBe("下载中 40%");
    expect(attachmentDownloadLabel(1024 * 1024, null)).toBe("下载中（已 1.0 MB）");
    // 总大小为 0 也按"未知"处理（不显示 0%）
    expect(attachmentDownloadLabel(0, 0)).toBe("下载中（已 0.0 MB）");
  });
});
