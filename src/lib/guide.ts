// M25 P1 — built-in「使用指南」page. The guide is itself an editable note: created
// on demand from `openGuide()` (or /帮助), searchable via content_text, and re-creatable
// if the user deletes it. Content is generated from `SHORTCUTS` so the shortcut list
// stays in sync with the single source of truth.
import { SHORTCUTS, shortcutLabel, shortcutGroups } from "./shortcuts";
import { GUIDE_COVER } from "./covers";
import { api } from "./api";
import { useNotes } from "../store/notes";

export const GUIDE_TITLE = "使用指南";
export const GUIDE_ICON = "📖";

type Block = Record<string, any>;

function text(t: string) { return { type: "text", text: t, version: 1 } as any; }
function para(t: string): Block {
  return { type: "paragraph", version: 1, children: [text(t)], direction: "ltr", format: "", indent: 0, style: "", mode: "normal", textFormat: 0, textStyle: "" } as any;
}
function h(t: string, tag: "h1" | "h2" | "h3"): Block {
  return { type: "heading", tag, version: 1, children: [text(t)], direction: "ltr", format: "", indent: 0, style: "", mode: "normal", textFormat: 0, textStyle: "" } as any;
}
function callout(t: string): Block {
  return { type: "callout", version: 1, children: [para(t)], direction: "ltr", format: "", indent: 0, style: "" } as any;
}
function bullet(items: string[]): Block {
  return {
    type: "list", tag: "ul", listType: "bullet", start: 1, version: 1, direction: "ltr", format: "", indent: 0, style: "",
    children: items.map((it) => ({ type: "listitem", version: 1, value: 1, direction: "ltr", format: "", indent: 0, style: "", children: [text(it)] })),
  } as any;
}
function rule(): Block {
  return { type: "horizontalrule", version: 1, direction: "ltr", format: "", indent: 0, style: "" } as any;
}

function guideBlocks(): Block[] {
  const blocks: Block[] = [];
  blocks.push(h("ShuyoNote 使用指南", "h1"));
  blocks.push(callout("本地优先 · 类 Notion 的笔记应用。数据全在本机（SQLite + 附件目录），离线可用。这篇指南本身是一篇可编辑的笔记，可删可改；删了也能通过 /帮助 重建。"));
  blocks.push(h("快速开始", "h2"));
  blocks.push(bullet([
    "新建页面：Ctrl+N，或左侧栏 ＋。",
    "插入内容：输入 / 打开块菜单；分栏用 /分栏，绘图用 /绘图。",
    "自动保存：无保存按钮，改动即存；版本历史 / 回收站 / 整库备份在「存储」或命令面板 Ctrl+K。",
  ]));
  blocks.push(rule());
  blocks.push(h("核心能力", "h2"));
  blocks.push(bullet([
    "知识组织：页面树 / 文件夹 / 标签 / 双向链接 [[标题]] / 块引用 ((id)) / 块嵌入 {{id}}。",
    "结构化：属性 + 数据库视图（表格 / 画廊 / 看板 / 列表 / 日历 / 时间轴 / 目录）；看板拖拽。",
    "富媒体：表格、图片 / 附件、网址书签、mermaid 流程图、Excalidraw 绘图、AI 文生图。",
    "检索：FTS5 全文 + 语义检索；Ctrl+K 命令面板、Ctrl+Shift+F 聚焦搜索。",
    "AI：右侧 ✦ 助手（可选、默认关、本地优先）＋ 空行按空格的「内联 AI 起草」。",
    "数据安全：端到端加密（可选）、版本历史、回收站、整库备份 / 导出。",
    "多设备：自建 sync-server（outbox + LWW + 附件增量）可同步；多工作空间物理隔离。",
  ]));
  blocks.push(rule());
  blocks.push(h("快捷键", "h2"));
  for (const g of shortcutGroups()) {
    blocks.push(h(g, "h3"));
    blocks.push(bullet(SHORTCUTS.filter((s) => s.group === g).map((s) => `${s.label}　${shortcutLabel(s)}`)));
  }
  blocks.push(rule());
  blocks.push(h("更多", "h2"));
  blocks.push(callout("在命令面板 Ctrl+K 输入「关于」，可访问项目主页 / 文档 / 发布 / 问题（外链在「关于」里可关闭，不影响离线使用）。"));
  return blocks;
}

export function guideJson(): string {
  return JSON.stringify({ root: { children: guideBlocks(), direction: "ltr", format: "", indent: 0, type: "root", version: 1 } as any });
}

function blockText(b: any): string {
  if (!b) return "";
  if (Array.isArray(b)) return b.map(blockText).join(" ");
  if (typeof b === "string") return b;
  if (b.type === "text") return b.text ?? "";
  if (Array.isArray(b.children)) return b.children.map(blockText).join("");
  return "";
}

export function guideText(): string {
  return guideBlocks().map(blockText).filter(Boolean).join("\n");
}

/** Open the guide page (create it on first use), so it's discoverable via /帮助 too. */
export async function openGuide(): Promise<void> {
  const notes = useNotes.getState();
  const existing = notes.pages.find((p) => p.title === GUIDE_TITLE);
  const id = existing
    ? existing.id
    : await notes.createPage(null, { title: GUIDE_TITLE, content_json: guideJson(), content_text: guideText() });
  if (!id) return;
  // The guide is a system page: keep its cover/icon on the canonical defaults so
  // it always looks right (re-applied on open, incl. upgrading an older guide).
  await api.setPageCover(id, GUIDE_COVER);
  await api.setPageIcon(id, GUIDE_ICON);
  await notes.openPage(id);
}
