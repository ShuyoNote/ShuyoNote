import { create } from "zustand";
import { api } from "../lib/api";
import { platform } from "../lib/platform";
import { toast } from "../store/toast";

// M24 — PDF reader modal state. `openPdf(attachmentId, name)` fetches the PDF
// bytes (via the platform asset URL — works on web blob URLs and desktop) and
// hands them to the pdf.js engine inside `PdfReader`.
interface PdfReaderState {
  open: boolean;
  attachmentId: string | null;
  name: string;
  bytes: Uint8Array | null;
  openPdf: (attachmentId: string, name: string) => Promise<void>;
  close: () => void;
}

export const usePdfReader = create<PdfReaderState>((set, get) => ({
  open: false,
  attachmentId: null,
  name: "",
  bytes: null,
  async openPdf(attachmentId: string, name: string) {
    if (get().open) return;
    try {
      const meta = await api.getAttachment(attachmentId);
      const url = platform.asset.convertFileSrc((meta as { path?: string }).path ?? "");
      const resp = await fetch(url);
      const ab = await resp.arrayBuffer();
      set({ open: true, attachmentId, name, bytes: new Uint8Array(ab) });
    } catch (e) {
      toast("无法读取 PDF，请在文件夹中打开查看", "error");
    }
  },
  close: () => set({ open: false, attachmentId: null, name: "", bytes: null }),
}));
