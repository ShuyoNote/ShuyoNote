// AI 生成的目录持久化：本地（localStorage）按 PDF 附件 id 保存，重开 PDF 时恢复。
// 这样"AI 生成目录"的结果不会在重新打开/离开再进入阅读器时丢失。
import type { OutlineItem } from "./pdfRender";

const KEY = (id: string) => `shuyonote.pdf.aioutline.${id}`;

export function saveAiOutline(attachmentId: string, items: OutlineItem[]): void {
  try {
    localStorage.setItem(KEY(attachmentId), JSON.stringify(items));
  } catch {
    /* 忽略：localStorage 不可用/超限 */
  }
}

export function loadAiOutline(attachmentId: string): OutlineItem[] | null {
  try {
    const raw = localStorage.getItem(KEY(attachmentId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as OutlineItem[];
    if (!Array.isArray(parsed)) return null;
    // 轻量校验：每项至少 title + pageIndex。
    return parsed.filter((p) => p && typeof p.title === "string" && Number.isFinite(p.pageIndex));
  } catch {
    return null;
  }
}

export function clearAiOutline(attachmentId: string): void {
  try {
    localStorage.removeItem(KEY(attachmentId));
  } catch {
    /* 忽略 */
  }
}
