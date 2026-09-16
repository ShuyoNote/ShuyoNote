import { create } from "zustand";
import { api } from "../lib/api";
import { ensureAttachmentBytes } from "../lib/attachmentBytes";
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
      const hash = (meta as { hash?: string }).hash ?? "";
      // 桌面端走 IPC 读字节（和 Markdown/图片预览同一条路：命令里会按需解密）。
      //
      // **不要**用 `fetch(convertFileSrc(path))`：那条路受 CSP 的 `connect-src` 管，
      // 而自定义附件协议只被放进了 `img-src`（`<img src>` 能用、`fetch` 会被拒）——
      // 桌面上表现就是"无法读取 PDF，请在文件夹中打开查看"，而 Web 平台因为换成
      // blob: URL（blob: 在 connect-src 里）反而是好的。这个问题只在桌面端出现。
      const readBytes = async (): Promise<Uint8Array> =>
        isDesktopPlatform()
          ? new Uint8Array(await api.readAttachmentBytes(hash))
          : new Uint8Array(
              await (await fetch(platform.asset.convertFileSrc((meta as { path?: string }).path ?? ""))).arrayBuffer(),
            );
      let bytes: Uint8Array;
      try {
        bytes = await readBytes();
      } catch (first) {
        // P6.3 续：读不到字节时**先试着按需取回来**，再读第二次。
        //
        // 修在这里而不是那 10 个调用点：`openPdf` 是所有入口的必经之路
        // （文件管理器 / 页面树 / 附件面板 / 内联附件引用 / PDF 引用 / 插件命令…）。
        // 取不回来就抛**最初那个错**——那才是真正的原因（离线 / 服务端也没有这份字节）。
        if (!hash || !(await ensureAttachmentBytes(hash))) throw first;
        bytes = await readBytes();
      }
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
