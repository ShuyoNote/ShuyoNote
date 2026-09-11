import { create } from "zustand";
import { api } from "../lib/api";
import { isDesktopPlatform, platform } from "../lib/platform";
import { toast } from "../store/toast";
import { useFilePreview } from "../store/filePreview";

// M24 — PDF reader modal state. `openPdf(attachmentId, name)` fetches the PDF
// bytes (via the platform asset URL — works on web blob URLs and desktop) and
// hands them to the pdf.js engine inside `PdfReader`.
interface PdfReaderState {
  open: boolean;
  attachmentId: string | null;
  name: string;
  bytes: Uint8Array | null;
  targetPage: number;
  openPdf: (attachmentId: string, name: string, pageIndex?: number) => Promise<void>;
  close: () => void;
}

export const usePdfReader = create<PdfReaderState>((set, get) => ({
  open: false,
  attachmentId: null,
  name: "",
  bytes: null,
  targetPage: 0,
  async openPdf(attachmentId: string, name: string, pageIndex = 0) {
    // Opening a PDF replaces any MD/image/video preview that is still open, so the
    // two "viewers" never stack on top of each other.
    useFilePreview.getState().close();
    if (get().open) return;
    try {
      const meta = await api.getAttachment(attachmentId);
      // 桌面端走 IPC 读字节（和 Markdown/图片预览同一条路：命令里会按需解密）。
      //
      // **不要**用 `fetch(convertFileSrc(path))`：那条路受 CSP 的 `connect-src` 管，
      // 而自定义附件协议只被放进了 `img-src`（`<img src>` 能用、`fetch` 会被拒）——
      // 桌面上表现就是"无法读取 PDF，请在文件夹中打开查看"，而 Web 平台因为换成
      // blob: URL（blob: 在 connect-src 里）反而是好的。这个问题只在桌面端出现。
      const bytes = isDesktopPlatform()
        ? new Uint8Array(await api.readAttachmentBytes((meta as { hash?: string }).hash ?? ""))
        : new Uint8Array(
            await (await fetch(platform.asset.convertFileSrc((meta as { path?: string }).path ?? ""))).arrayBuffer(),
          );
      set({
        open: true,
        attachmentId,
        name: name || (meta as { name?: string }).name || "PDF",
        bytes,
        targetPage: Math.max(0, pageIndex),
      });
    } catch (e) {
      // 失败要把**原因**说出来：以前这里只吞掉异常、弹一句笼统的话，于是
      // "文件不在盘上""解密失败""命令报错"看起来一模一样，只能靠猜。
      const why = e instanceof Error ? e.message : String(e);
      console.error("openPdf failed", { attachmentId, error: e });
      toast(`无法读取 PDF：${why}`, "error");
    }
  },
  close: () => set({ open: false, attachmentId: null, name: "", bytes: null, targetPage: 0 }),
}));
