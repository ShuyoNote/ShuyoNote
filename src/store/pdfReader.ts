import { create } from "zustand";
import { api } from "../lib/api";
import { platform } from "../lib/platform";
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
      const url = platform.asset.convertFileSrc((meta as { path?: string }).path ?? "");
      const resp = await fetch(url);
      const ab = await resp.arrayBuffer();
      set({ open: true, attachmentId, name: name || (meta as { name?: string }).name || "PDF", bytes: new Uint8Array(ab), targetPage: Math.max(0, pageIndex) });
    } catch (e) {
      toast("无法读取 PDF，请在文件夹中打开查看", "error");
    }
  },
  close: () => set({ open: false, attachmentId: null, name: "", bytes: null, targetPage: 0 }),
}));
