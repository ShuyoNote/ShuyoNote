// ⭐ P3-4 第四步（task-71）：附件下载取消 —— 契约/UI 接线判据。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(p, "utf8");

describe("附件下载取消", () => {
  const commands = read("src/lib/platform/commands.ts");
  const api = read("src/lib/api.ts");
  const web = read("src/lib/platform/web.ts");
  const view = read("src/components/FileManagerView.tsx");

  it("① 契约/api/web 桩：命令存在、api 走 invoke、Web 不假装成功", () => {
    expect(commands).toContain(
      "cancel_attachment_download: { args: { hash: string }; result: boolean }",
    );
    expect(api).toContain('cancelAttachmentDownload: (hash: string) =>');
    expect(api).toContain('invoke("cancel_attachment_download", { hash })');
    const at = web.indexOf('if (cmd === "cancel_attachment_download")');
    expect(at).toBeGreaterThan(-1);
    expect(web.slice(at, at + 300)).toContain("return false as T");
  });

  it("② 下载中显示取消按钮；点击按 hash 调命令", () => {
    expect(view).toContain('data-testid="attachment-download-cancel"');
    expect(view).toContain("void cancelDownload(row.file!.hash)");
    const handler = view.slice(
      view.indexOf("const cancelDownload"),
      view.indexOf("// Streaming import progress"),
    );
    expect(handler).toContain("await api.cancelAttachmentDownload(hash)");
    expect(handler).toContain("setDownloadProgress");
    expect(handler).toContain("delete next[hash]");
    expect(handler).toContain("setCancelledHash(hash)");
    expect(handler, "取消不是失败 ⇒ 不弹 error toast").not.toContain('toast(');
  });

  it("③ 取消后清 progress、行内提示可重试续传（.part 保留）", () => {
    expect(view).toContain('data-testid="attachment-download-cancelled"');
    expect(view).toContain("已取消，可重试续传");
    expect(view).toContain("保留 .part");
    // 命令返回的取消错误不弹错误 toast。
    const fetch = view.slice(view.indexOf("const fetchBytes"), view.indexOf("const cancelDownload"));
    expect(fetch).toContain("/已取消/.test(String(e))");
    expect(fetch).toContain("setCancelledHash(f.hash)");
    expect(fetch).toContain('toast(attachmentFetchHint(e), "error")');
    // 重新取字节先清掉旧提示。
    expect(fetch).toContain("setCancelledHash(null)");
  });
});
