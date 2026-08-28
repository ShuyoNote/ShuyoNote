// M25 P1 — built-in「使用指南」page. The guide is itself an editable note: created
// on demand from `openGuide()` (or /帮助), searchable via content_text, and re-creatable
// if the user deletes it. Content is generated from `SHORTCUTS` so the shortcut list
// stays in sync with the single source of truth.
import { SHORTCUTS, shortcutLabel } from "./shortcuts";
import { api } from "./api";
import { useNotes } from "../store/notes";

export const GUIDE_TITLE = "使用指南";
export const GUIDE_COVER = "linear-gradient(135deg, #667eea 0%, #764ba2 100%)";
export const GUIDE_ICON = "📖";

function text(t: string) { return { type: "text", text: t, version: 1 } as any; }
function para(t: string) {
  return { type: "paragraph", version: 1, children: [text(t)], direction: "ltr", format: "", indent: 0, style: "", mode: "normal", textFormat: 0, textStyle: "" } as any;
}
function h(t: string, tag: "h1" | "h2") {
  return { type: "heading", tag, version: 1, children: [text(t)], direction: "ltr", format: "", indent: 0, style: "", mode: "normal", textFormat: 0, textStyle: "" } as any;
}

function guideBlocks(): any[] {
  const blocks: any[] = [
    h("ShuyoNote 使用指南", "h1"),
    para("本地优先 · 类 Notion 的笔记应用。数据全在本机（SQLite + 附件目录），离线可用。这篇指南本身是一篇可编辑的笔记，可删可改，删了也能通过 /帮助 重建。"),
    h("快速开始", "h2"),
    para("· 新建页面：Ctrl+N，或左侧栏 +。"),
    para("· 插入块：输入 / ，或悬停空块点开 +。分栏用 /分栏，绘图用 /绘图。"),
    para("· 自动保存：无保存按钮，改动即存；版本历史 / 回收站 / 整库备份在左侧「存储」或命令面板 Ctrl+K。"),
    h("快捷键", "h2"),
    ...SHORTCUTS.map((s) => para(`· ${s.group}｜${s.label}　${shortcutLabel(s)}`)),
    h("核心能力", "h2"),
    para("· 知识组织：页面树 / 文件夹 / 标签 / 双向链接 [[标题]] / 块引用 ((id)) / 块嵌入 {{id}}。"),
    para("· 结构化：属性 + 数据库视图（表格 / 画廊 / 看板 / 列表 / 日历 / 时间轴 / 目录）；看板拖拽。"),
    para("· 富媒体：表格交互、图片 / 附件、网址书签、mermaid 流程图、Excalidraw 绘图、AI 文生图。"),
    para("· 检索：FTS5 全文 + 语义检索；Ctrl+K 命令面板、Ctrl+Shift+F 聚焦搜索。"),
    para("· AI：右侧 ✦ 助手（可选、默认关、本地优先）＋ 空行按空格的「内联 AI 起草」。"),
    para("· 数据安全：端到端加密（可选）、版本历史、回收站、整库备份 / 导出。"),
    para("· 多设备：自建 sync-server（outbox + LWW + 附件增量）可同步；多工作空间物理隔离。"),
  ];
  return blocks;
}

export function guideJson(): string {
  return JSON.stringify({ root: { children: guideBlocks(), direction: "ltr", format: "", indent: 0, type: "root", version: 1 } as any });
}

export function guideText(): string {
  return guideBlocks()
    .map((b: any) => (b.children ?? []).map((c: any) => c.text ?? "").join(""))
    .filter(Boolean)
    .join("\n");
}

/** Open the guide page (create it on first use), so it's discoverable via /帮助 too. */
export async function openGuide(): Promise<void> {
  const notes = useNotes.getState();
  const existing = notes.pages.find((p) => p.title === GUIDE_TITLE);
  if (existing) {
    await notes.openPage(existing.id);
    // Fill in default cover/icon for a guide created before this feature (never
    // override values the user set).
    const cur = useNotes.getState().current;
    if (cur) {
      const hadCover = !!cur.cover;
      const hadIcon = !!cur.icon;
      if (!hadCover) await api.setPageCover(cur.id, GUIDE_COVER);
      if (!hadIcon) await api.setPageIcon(cur.id, GUIDE_ICON);
      if (!hadCover || !hadIcon) await notes.openPage(cur.id);
    }
    return;
  }
  const id = await notes.createPage(null, { title: GUIDE_TITLE, content_json: guideJson(), content_text: guideText() });
  if (id) {
    await api.setPageCover(id, GUIDE_COVER);
    await api.setPageIcon(id, GUIDE_ICON);
    // Re-open so the current page detail carries the cover/icon and renders them immediately.
    await notes.openPage(id);
  }
}
