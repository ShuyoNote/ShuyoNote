// 拖拽落点判定的纯函数（与 DOM 解耦的部分）—— 判据在 `pageAttachmentDrop.test.ts`。
//
// 来由（owner 2026-11-09 选 A+）：外部文件拖进窗口后，要分**两个区**：
//   · 正文区（`data-drop-zone="page-editor"`）⇒ 挂到当前页 **＋ 正文插附件卡片**；
//   · 附件区（`data-drop-zone="attachments"`）⇒ **只挂附件**，不碰正文。
// ⚠️ 桌面壳的 HTML5 拖拽被 `dragDropEnabled` 抑制 ⇒ 坐标来自 Tauri 事件（**物理像素**），
//   必须换算成 CSS 像素才能喂 `elementFromPoint`（见 `toCssPoint`）。

export type PageDropZone = "editor" | "attachments";

const ZONE_ATTR = "data-drop-zone";

/**
 * 从命中元素往上找落点区。
 * - `page-editor` ⇒ `editor`；`attachments` ⇒ `attachments`；
 * - 都没有（拖到侧栏/空白处）⇒ `fallback`（默认正文：拖进页面最常见的意图就是放进正文）。
 */
export function resolveDropZone(el: Element | null, fallback: PageDropZone = "editor"): PageDropZone {
  let cur: Element | null = el;
  while (cur) {
    const zone = typeof cur.getAttribute === "function" ? cur.getAttribute(ZONE_ATTR) : null;
    if (zone === "page-editor") return "editor";
    if (zone === "attachments") return "attachments";
    cur = cur.parentElement;
  }
  return fallback;
}

/** Tauri 拖拽坐标是物理像素；`elementFromPoint`/`clientX` 是 CSS 像素 ⇒ 除以 dpr。 */
export function toCssPoint(
  pos: { x: number; y: number } | null | undefined,
  dpr: number,
): { x: number; y: number } | null {
  if (!pos) return null;
  const ratio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const x = pos.x / ratio;
  const y = pos.y / ratio;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

/** 落点提示文案（两个区说法不同，避免用户以为"只挂附件"也会插正文）。 */
export function dropHintText(zone: PageDropZone): string {
  return zone === "editor" ? "松开：挂到本页，并在正文插入附件卡片" : "松开：只加到附件区（正文不动）";
}
